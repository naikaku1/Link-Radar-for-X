// test/test-background.js — background.js の統合テスト。
// chrome API と fetch をスタブして、content script が受け取る応答を実際に検証する。
//
// 主な目的は回帰防止:
//   t.co経由のリンクで最終ホストが "t.co" のまま返ってしまうと、t.co は SAFE_HOSTS なので
//   連投判定が一度も発火しなくなる（実際に起きていたバグ）。ここで固定する。

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

// ---- chrome API スタブ ----
const messageListeners = [];
let deepScanOn = false;
globalThis.chrome = {
  storage: {
    sync: { get: async (defaults) => ({ ...defaults, deepScan: deepScanOn }) },
    local: { get: async () => ({}), set: async () => {}, clear: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} }
  },
  permissions: {
    contains: async () => deepScanOn,
    onAdded: { addListener() {} },
    onRemoved: { addListener() {} }
  },
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener() {} },
    getManifest: () => ({ version: "test" })
  }
};

// ---- fetch スタブ（t.co中継ページと、その先の本文を返す）----
const PAGES = {
  "https://t.co/GIGA":  tco("https://gigazine.net/news/20260101-real-article/"),
  "https://t.co/ADULT": tco("https://brand-new-domain.example/lp/1"),
  "https://t.co/ASAHI": tco("https://www.asahi.com/articles/ASV1.html"),
  "https://t.co/SHORT": tco("https://bit.ly/xyz123"),
  "https://t.co/MISTY": {
    html: '<html><body>' + 'x'.repeat(4500) + '<img src="https://ads.example/banner.png"></body></html>',
    finalUrl: "https://linkmisty.com/c/fxfa1pu/"
  },
  "https://gigazine.net/news/20260101-real-article/":
    '<html>' + Array.from({ length: 12 }, (_, i) => `<div id="div-gpt-ad-slot${i}"></div>`).join("") + '</html>',
  "https://brand-new-domain.example/lp/1":
    '<html><body><div>あなたは18歳以上ですか？ はい / いいえ</div></body></html>',
  "https://www.asahi.com/articles/ASV1.html":
    '<html><p>有料会員になると続きをお読みいただけます</p></html>',
  // 短縮URL。fetchはリダイレクトを追って最終URLを返す（finalUrl が別ドメイン）
  "https://bit.ly/xyz123": { html: '<html><body>動画</body></html>', finalUrl: "https://missav.com/ja/abc-123" },
  "https://linkmisty.com/c/fxfa1pu/": '<html><body>' + 'x'.repeat(4500) +
    '<a href="/create/?utm_medium=referral">作成</a><div onclick="location.href=\'https://linkmisty.com/c/fxfa1pu/?lm_go=1\'">カード</div></body></html>',
  "https://linkmisty.com/c/fxfa1pu/?lm_go=1": {
    html: "", ok: false,
    finalUrl: "https://www.tiktok.com/ug/incentive/share/pro_scan_code?ug_launch_category=referral"
  },
  "https://linkmisty.com/c/normal/": '<div onclick="location.href=\'https://linkmisty.com/c/normal/?lm_go=1\'">カード</div>',
  "https://linkmisty.com/c/normal/?lm_go=1": { html: "", finalUrl: "https://example.com/" },
  "https://bio.linkcdn.cc/upload/lnkcmpts/onlyapp1.json": JSON.stringify({
    cmpts: JSON.stringify([{ link: "https://lite.tiktok.com/t/ZSabcdefg/" }])
  }),
  "https://bio.linkcdn.cc/upload/lnkcmpts/onlyshort.json": JSON.stringify({
    cmpts: JSON.stringify([{ link: "https://bit.ly/xyz123" }])
  })
};
function tco(target) {
  return `<head><noscript><META http-equiv="refresh" content="0;URL=${target}"></noscript></head>` +
         `<script>location.replace("${target}")</script>`;
}
globalThis.fetch = async (url) => {
  const page = PAGES[url];
  if (page == null) throw new Error("not stubbed: " + url);
  const html = typeof page === "string" ? page : page.html;
  const finalUrl = typeof page === "string" ? url : page.finalUrl;   // リダイレクト後のURL
  return { ok: page.ok !== false, url: finalUrl, headers: { get: () => "text/html" }, text: async () => html };
};

await import("../src/background.js");
await new Promise(r => setTimeout(r, 10));   // 起動時の loadSettings を待つ

function classify(item) {
  return new Promise((resolve) => {
    for (const fn of messageListeners) fn({ type: "classify", item }, {}, resolve);
  });
}
const kinds = (r) => r.badges.map(b => b.kind);

// ==================================================================
console.log("t.co経由のホスト解決（連投判定の前提）");

let r = await classify({ href: "https://t.co/ABC", text: "gigazine.net/news/2026010…" });
ok("表示テキストのホストを最終ホストとして返す", r.host === "gigazine.net");
ok("t.co を最終ホストにしない",                  r.host !== "t.co");
ok("大手でないホストは safe:false（連投カウント対象）", r.safe === false);
ok("連投カウント用のドメインを返す",             r.domain === "gigazine.net");

r = await classify({ href: "https://t.co/DEF", text: "www.asahi.com/articles/AS…" });
ok("SAFE_HOSTSのホストは safe:true（連投カウント対象外）", r.safe === true);

r = await classify({ href: "https://t.co/SUB", text: "a1.spam-site.top/lp" });
ok("サブドメインを落として登録可能ドメインで数える", r.domain === "spam-site.top");
r = await classify({ href: "https://t.co/SUB2", text: "www.example.co.jp/x" });
ok("属性型JPドメインを正しく扱う",               r.domain === "example.co.jp");

r = await classify({ href: "https://t.co/GHI", text: "" });
ok("行き先不明なら host/domain を返さない", !r.host && !r.domain);
ok("行き先不明は safe:true（全リンクが同一ホスト扱いされるのを防ぐ）", r.safe === true);

console.log("URLのみの判定（fetchなし）");
r = await classify({ href: "https://t.co/JKL", text: "missav.com/ja/abc-123" });
ok("表示ホストがアダルト既知ドメイン → adult", kinds(r).includes("adult"));
ok("fetchせずに判定できている",                r.finalUrl === undefined);

r = await classify({ href: "https://amzn.to/xyz", text: "amzn.to/xyz" });
ok("直リンクのアフィを判定",                    kinds(r).includes("affiliate"));

console.log("登録媒体の有料判定（deepScan OFF でも動く）");
r = await classify({ href: "https://t.co/ASAHI", text: "www.asahi.com/articles/AS…" });
ok("t.coを解決して本URLを取得",  r.finalUrl === "https://www.asahi.com/articles/ASV1.html");
ok("有料記事を検出",             kinds(r).includes("paid"));
ok("paywall.status が paid",     r.paywall.status === "paid");

console.log("deepScan OFF では登録媒体以外を取得しない");
r = await classify({ href: "https://linkmisty.com/c/fxfa1pu/", text: "linkmisty.com/c/fxfa1pu/" });
ok("LinkMisty は取得OFFでも短縮だけ表示", kinds(r).includes("shortener") && !kinds(r).includes("invite"));
ok("取得OFFでは中継先の強調をしない", !kinds(r).includes("bait"));
r = await classify({ href: "https://t.co/GIGA", text: "gigazine.net/news/2026010…" });
ok("未登録ドメインはfetchしない", r.finalUrl === undefined);
ok("広告過多は出ない",           !kinds(r).includes("ads"));

console.log("deepScan ON で未登録ドメインも判定できる");
// 設定はSW起動時に読むので、deepScan:true の状態でモジュールを読み直して検証する
// （クエリ違いは別モジュール扱いになるので、まっさらな状態で再評価される）
deepScanOn = true;
messageListeners.length = 0;
await import("../src/background.js?deepScan=1");
await new Promise(res => setTimeout(res, 10));
r = await classify({ href: "https://linkmisty.com/c/fxfa1pu/", text: "linkmisty.com/c/fxfa1pu/" });
ok("LinkMisty のクリック転送先から招待を検出", kinds(r).includes("invite"));
ok("LinkMisty の確認済み招待先を強調", r.badges.find(b => b.kind === "bait")?.label === "TikTok Lite 招待");
ok("LinkMisty の最終ホストを返す", r.host === "www.tiktok.com" && r.finalUrl.includes("ug_launch_category=referral"));
r = await classify({ href: "https://t.co/MISTY", text: "linkmisty.com/c/fxfa1pu/" });
ok("Xの t.co 経由でも招待先を強調", kinds(r).includes("invite") && kinds(r).includes("bait"));
r = await classify({ href: "https://linkmisty.com/c/normal/", text: "linkmisty.com/c/normal/" });
ok("普通の転送先を招待誘導扱いしない", !kinds(r).includes("bait"));
r = await classify({ href: "https://linkbio.co/onlyapp1/", text: "linkbio.co/onlyapp1/" });
ok("単一招待先のプロフィールカードを強調", r.badges.find(b => b.kind === "bait")?.label === "TikTok Lite 招待");
ok("プロフィールのhostも確認した行き先へ更新する", r.host === "lite.tiktok.com");
ok("プロフィールのdomainも実際の行き先で数える", r.domain === "tiktok.com");
ok("通常のTikTok招待をLinkBioの連投として数えない", r.safe === true);
r = await classify({ href: "https://linkbio.co/onlyshort/", text: "linkbio.co/onlyshort/" });
ok("単一短縮URLだけでは招待誘導と断定しない", !kinds(r).includes("bait"));
r = await classify({ href: "https://t.co/GIGA", text: "gigazine.net/news/2026010…" });
ok("未登録ドメインを取得して広告枠を数える", kinds(r).includes("ads"));
ok("広告枠数がラベルに出る",
   /広告枠\d+個/.test((r.badges.find(b => b.kind === "ads") || {}).label || ""));

r = await classify({ href: "https://t.co/ADULT", text: "brand-new-domain.example/lp/1" });
ok("URLに手掛かりが無くても年齢確認ページなら adult", kinds(r).includes("adult"));

// 報告されたケース: 引用元が「短縮URL＋R18」
r = await classify({ href: "https://t.co/SHORT", text: "bit.ly/xyz123" });
ok("短縮URLとして検出する",                 kinds(r).includes("shortener"));
ok("短縮の先を解決してアダルトを検出する",   kinds(r).includes("adult"));
ok("最終ホストを着地先に更新する",           r.host === "missav.com");
ok("連投カウントも着地先ドメインで数える",   r.domain === "missav.com");

console.log("URLだけで結論が出るものは取得しない（IPを渡さないため）");
// ページ取得は「クリックしていないのに相手のサーバーに自分のIPが載る」ことを意味する。
// すでにURLだけで答えが出ているなら、その代償を払う理由がない。
{
  let fetches = 0;
  const raw = globalThis.fetch;
  globalThis.fetch = async (u) => { fetches++; return raw(u); };

  r = await classify({ href: "https://jp.pornhub.com/view?v=1", text: "jp.pornhub.com/view" });
  ok("既知アダルトドメインは adult が出る", kinds(r).includes("adult"));
  ok("既知アダルトドメインは取得しない",     fetches === 0);

  fetches = 0;
  r = await classify({ href: "https://cdn.example.info/app.apk", text: "cdn.example.info/app.apk" });
  ok("直ダウンロードは download が出る", kinds(r).includes("download"));
  ok("直ダウンロードは取得しない",       fetches === 0);

  // 一方、URLに手掛かりが無いものは今までどおり取得して判定する（縮退させない）
  // ※ 同じURLを前のテストで判定済みなのでキャッシュを捨ててから測る
  await new Promise(res => { for (const fn of messageListeners) fn({ type: "clearCache" }, {}, res); });
  fetches = 0;
  r = await classify({ href: "https://t.co/ADULT", text: "brand-new-domain.example/lp/1" });
  ok("URLに手掛かりが無ければ従来どおり取得する", fetches > 0 && kinds(r).includes("adult"));

  globalThis.fetch = raw;
}

console.log("転送先の一時的な取得失敗からの回復");
r = await classify({href:"https://t.co/RECOVER", text:"カードの見出し"});
ok("t.co解決失敗は再試行可能として返す", r.retryable === true);
PAGES["https://t.co/RECOVER"] = tco("https://linkmisty.com/c/fxfa1pu/");
r = await classify({href:"https://t.co/RECOVER", text:"カードの見出し"});
ok("失敗した空の判定をキャッシュせず次回は招待を検出する", kinds(r).includes("bait"));
ok("回復後は再試行不要になる", r.retryable === false);

PAGES["https://linkmisty.com/c/flaky/"] = '<div onclick="location.href=\'https://linkmisty.com/c/flaky/?lm_go=1\'">カード</div>';
r = await classify({href:"https://linkmisty.com/c/flaky/", text:"linkmisty.com"});
ok("LinkMistyのクリック転送取得失敗も再試行可能", r.retryable === true);
PAGES["https://linkmisty.com/c/flaky/?lm_go=1"] = {
  html:"", ok:false,
  finalUrl:"https://www.tiktok.com/ug/incentive/share/pro_scan_code?ug_launch_category=referral"
};
r = await classify({href:"https://linkmisty.com/c/flaky/", text:"linkmisty.com"});
ok("LinkMistyも失敗を固定せず次回は正体を検出する", kinds(r).includes("bait") && r.retryable === false);

console.log("転送先URLと本文取得の成否を区別する");
PAGES["https://bit.ly/blockednews"] = {html:"",ok:false,finalUrl:"https://www.asahi.com/articles/ASV1.html"};
r = await classify({href:"https://bit.ly/blockednews",text:"bit.ly/blockednews"});
ok("HTTP403の空本文を無料記事と確定しない", r.paywall.status === "unknown" && r.paywall.confirmed !== true);
ok("本文取得失敗でも最終URLを保持する", r.host === "www.asahi.com" && r.finalUrl.includes("/articles/"));
ok("本文が読めなかった結果は再試行可能", r.retryable === true);
PAGES["https://bit.ly/blockednews"] = {html:"<p>有料会員になると続きをお読みいただけます</p>",finalUrl:"https://www.asahi.com/articles/ASV1.html"};
r = await classify({href:"https://bit.ly/blockednews",text:"bit.ly/blockednews"});
ok("HTTP403の結果を固定せず次回は有料判定できる", kinds(r).includes("paid") && r.retryable === false);

console.log("リンク集CDNの一時的な失敗からの回復");
PAGES["https://linkbio.co/flakyapi/"] = "<html><body>読み込み用のページ</body></html>";
r = await classify({href:"https://linkbio.co/flakyapi/",text:"linkbio.co/flakyapi/"});
ok("LinkBio公開JSON取得失敗は再試行可能", r.retryable === true);
PAGES["https://bio.linkcdn.cc/upload/lnkcmpts/flakyapi.json"] = JSON.stringify({cmpts:JSON.stringify([{link:"https://lite.tiktok.com/t/recovered/"}])});
r = await classify({href:"https://linkbio.co/flakyapi/",text:"linkbio.co/flakyapi/"});
ok("LinkBioの失敗をキャッシュせず次回は正体を表示する", kinds(r).includes("bait") && r.retryable === false);

console.log("ユーザー登録ドメイン（自分で登録 / 除外）");
// rules.js はシングルトンなので、テストから差し込めば background 側にもそのまま効く
// （リモート取得を入れるときも同じ口を使う）。
const { setUserRules } = await import("../src/rules.js");
setUserRules({ caution: ["brand-new-domain.example"], exclude: ["missav.com"] });
// ルールを変えたら判定キャッシュを捨てる（拡張本体では storage.onChanged がこれを行う）
await new Promise(res => { for (const fn of messageListeners) fn({ type: "clearCache" }, {}, res); });

let fetches = 0;
const rawFetch = globalThis.fetch;
globalThis.fetch = async (u) => { fetches++; return rawFetch(u); };

r = await classify({ href: "https://t.co/SHORT", text: "bit.ly/xyz123" });
ok("短縮の着地先が除外ドメインならバッジを出さない", r.badges.length === 0 && r.excluded === true);
ok("除外ドメインは連投カウントに乗せない",           r.domain === undefined && r.safe === true);

r = await classify({ href: "https://t.co/ADULT", text: "brand-new-domain.example/lp/1" });
ok("自分で登録したドメインに caution が出る", kinds(r).includes("caution"));

fetches = 0;
r = await classify({ href: "https://missav.com/ja/abc-123", text: "missav.com/ja/abc-123" });
ok("除外ドメインは直リンクでも判定しない", r.badges.length === 0);
ok("除外ドメインはページを取得もしない",   fetches === 0);

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
