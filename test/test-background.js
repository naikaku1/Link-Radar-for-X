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
    local: { get: async () => ({}), set: async () => {}, clear: async () => {} },
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
  "https://gigazine.net/news/20260101-real-article/":
    '<html>' + Array.from({ length: 12 }, (_, i) => `<div id="div-gpt-ad-slot${i}"></div>`).join("") + '</html>',
  "https://brand-new-domain.example/lp/1":
    '<html><body><div>あなたは18歳以上ですか？ はい / いいえ</div></body></html>',
  "https://www.asahi.com/articles/ASV1.html":
    '<html><p>有料会員になると続きをお読みいただけます</p></html>',
  // 短縮URL。fetchはリダイレクトを追って最終URLを返す（finalUrl が別ドメイン）
  "https://bit.ly/xyz123": { html: '<html><body>動画</body></html>', finalUrl: "https://missav.com/ja/abc-123" }
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
  return { ok: true, url: finalUrl, headers: { get: () => "text/html" }, text: async () => html };
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

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
