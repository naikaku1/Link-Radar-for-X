// test/test.js — 依存なしの簡易テストハーネス。`npm test` で実行。
import { classifyByUrl, extractTcoTarget, detectAdult, parseUrl,
         urlFromDisplayText, registrableDomain } from "../src/classifier.js";
import { detectPaywallFromHtml } from "../src/paywall.js";
import { detectAdLoad, countAdSlots, detectAdultFromHtml, detectLoginWall, analyzeHtml } from "../src/pagesignals.js";
import { DEFAULT_SETTINGS, CATEGORIES } from "../src/rules.js";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

// ---- 朝日: 実記事から採取した有料マーカーを含むHTML断片 ----
const asahiPaid = `<div class="foo"><span class="Zgt88">残り<b>210</b>文字</span>
  <span class="hideFromApp">有料会員になると続きをお読みいただけます。</span></div>
  <img src="//www.asahicom.jp/images/icon/top/icon__keyGold.svg" alt="有料会員記事" width="16">`;
const asahiFree = `<div class="article"><p>本文が最後まで全部あります。これは無料記事です。</p>
  <footer>会員登録はこちら ログイン</footer></div>`; // ナビ語だけ→有料CTAではない

console.log("URL分類 (アフィ/短縮/PR)");
ok("amzn.to は affiliate",        classifyByUrl("https://amzn.to/3abcXYZ").affiliate);
ok("amazon ?tag= は affiliate",   classifyByUrl("https://www.amazon.co.jp/dp/B0/?tag=foo-22").affiliate);
ok("amazon tag無しは非affiliate", !classifyByUrl("https://www.amazon.co.jp/dp/B0/").affiliate);
ok("楽天afl は affiliate",        classifyByUrl("https://hb.afl.rakuten.co.jp/hgc/xxx/").affiliate);
ok("a.r10.to は affiliate",       classifyByUrl("https://a.r10.to/xxxx").affiliate);
ok("a8.net は affiliate",         classifyByUrl("https://px.a8.net/svt/ejp?a8mat=x").affiliate);
ok("もしも は affiliate",          classifyByUrl("https://af.moshimo.com/af/c/click?a_id=1").affiliate);
ok("CJ(anrdoezrs) は affiliate",  classifyByUrl("https://www.anrdoezrs.net/links/123/type/dlg").affiliate);
ok("utm_medium=affiliate 検出",   classifyByUrl("https://example.com/x?utm_medium=affiliate").affiliate);
ok("bit.ly は shortener",         classifyByUrl("https://bit.ly/abcd").shortener);
ok("tinyurl は shortener",        classifyByUrl("https://tinyurl.com/abcd").shortener);
ok("lit.link は shortener",       classifyByUrl("https://lit.link/foo").shortener);
ok("prtimes は pr",               classifyByUrl("https://prtimes.jp/main/html/rd/p/000.html").pr);
ok("taboola は 広告(pr)",         classifyByUrl("https://trc.taboola.com/x/redirect?item=1").pr);
ok("outbrain は 広告(pr)",        classifyByUrl("https://www.outbrain.com/what-is/abc").pr);
ok("togetter は farm",            classifyByUrl("https://togetter.com/li/123456").farm);
ok("通常ドメインは farm/caution 無し", !classifyByUrl("https://www.asahi.com/articles/AS.html").farm && !classifyByUrl("https://example.com/").caution);
ok("通常ニュースURLは無印",        Object.keys(classifyByUrl("https://www.asahi.com/articles/AS123.html")).length === 0);

console.log("アダルト判定");
ok("既知ドメインは adult",         classifyByUrl("https://jp.pornhub.com/view?v=1").adult);
ok("missav は adult",             classifyByUrl("https://missav.com/ja/abc-123").adult);
ok("FANZA(dmm digital) は adult", classifyByUrl("https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=x/").adult);
ok("DMM通販(非アダルト)は非adult", !classifyByUrl("https://www.dmm.com/mono/book/-/detail/").adult);
ok(".xxx TLD は adult",           classifyByUrl("https://foo.xxx/a").adult);
ok("ホスト名のporn は adult",      classifyByUrl("https://free-porn-site.top/x").adult);
ok("パスのエロ は adult",          classifyByUrl("https://kaisetu-site.info/エロ動画まとめ").adult);
ok("日本語パスのアダルト は adult", classifyByUrl("https://example-blog.info/アダルト/1").adult);
ok("SAFE_HOSTSは語があってもadult扱いしない",
   !detectAdult(parseUrl("https://note.com/user/n/エロ本の話")));
ok("普通の記事は非adult",          !classifyByUrl("https://www.asahi.com/articles/AS1.html").adult);
ok("javascript等は無視(パース失敗)", Object.keys(classifyByUrl("javascript:void(0)")).length === 0);

console.log("Xの表示テキストからのURL組み立て");
// カードリンクのアンカーは "ホスト\n見出し\n説明" が連なる。丸ごとURL化すると
// 日本語がホスト名扱いされ punycode ホストが生成され、ほぼ全リンクが「不審」になっていた。
ok("見出し付きカードはホストだけ採る",
   urlFromDisplayText("gigazine.net\n【朗報】新型ゲーム機が発表される") === "https://gigazine.net");
ok("見出し付きでもバッジが出ない",
   Object.keys(classifyByUrl(urlFromDisplayText("gigazine.net\n【朗報】新型ゲーム機が発表される"))).length === 0);
ok("属性型JPドメイン＋見出しでもバッジが出ない",
   Object.keys(classifyByUrl(urlFromDisplayText("www.itmedia.co.jp\nAIが変える働き方とは"))).length === 0);
ok("SAFE_HOSTSが見出しで壊れない",
   urlFromDisplayText("note.com\nエンジニアの転職について") === "https://note.com");
ok("省略記号付きパスを保つ",
   urlFromDisplayText("asahi.com/articles/AS…\n速報") === "https://asahi.com/articles/AS");
ok("パス付き短縮URLを保つ",
   urlFromDisplayText("amzn.to/3abcXYZ") === "https://amzn.to/3abcXYZ");
ok("スキーム付きもそのまま扱える",
   urlFromDisplayText("https://example.com/a?b=1") === "https://example.com/a?b=1");
ok("ホストが無いテキストは null",
   urlFromDisplayText("詳細はプロフのリンクから") === null);
ok("見出しだけのテキストは null",  urlFromDisplayText("【速報】〇〇が決定しました") === null);
ok("表示テキスト経由でもアダルトは検出する",
   classifyByUrl(urlFromDisplayText("missav.com/ja/abc-123\n無料動画")).adult);

console.log("登録可能ドメインの抽出（連投カウント単位）");
ok("サブドメインを落とす",     registrableDomain("a1.spam-site.top") === "spam-site.top");
ok("属性型JPドメインを保つ",   registrableDomain("www.example.co.jp") === "example.co.jp");
ok("2ラベルはそのまま",        registrableDomain("gigazine.net") === "gigazine.net");
ok("深いサブドメインも1つに",  registrableDomain("a.b.c.example.com") === "example.com");

console.log("ダウンロード判定");
ok("apk直リンクは download",       classifyByUrl("https://cdn.example.info/app.apk").download);
ok("exe直リンクは download",       classifyByUrl("https://dl.example.info/setup.exe?v=2").download);
ok("html は非download",            !classifyByUrl("https://example.co.jp/a.html").download);

console.log("有料判定 (生HTML)");
ok("朝日 有料記事 → paid",   detectPaywallFromHtml(asahiPaid, "www.asahi.com").status === "paid");
ok("朝日 有料記事 confirmed", detectPaywallFromHtml(asahiPaid, "www.asahi.com").confirmed === true);
ok("朝日 無料記事 → free",   detectPaywallFromHtml(asahiFree, "www.asahi.com").status === "free");
ok("日経 有料CTA → paid",
   detectPaywallFromHtml("<p>この記事は有料会員限定記事です</p>", "www.nikkei.com").status === "paid");
ok("日経 CTA無し → free（ナビの『有料会員』では誤検出しない）",
   detectPaywallFromHtml('<footer>有料会員 会員限定 無料登録</footer><div class="mainPaywall_x"></div>', "www.nikkei.com").status === "free");
ok("対象外ドメイン → unknown", detectPaywallFromHtml("<html>x</html>", "example.com").status === "unknown");
ok("汎用CTA(ここから先は有料) → paid",
   detectPaywallFromHtml("<p>ここから先は有料会員限定です</p>", "toyokeizai.net").status === "paid");
ok("ノイズ語(単独の有料会員記事) → free扱い",
   detectPaywallFromHtml("<img alt=\"有料会員記事\"><p>全文無料の本文</p>", "www.asahi.com").status === "free");
ok("残りN文字(タグ跨ぎ) → paid",
   detectPaywallFromHtml("<span>残り<b>436</b>文字</span>", "www.yomiuri.co.jp").status === "paid");
ok("東洋経済 有料CTA → paid",
   detectPaywallFromHtml("<p>この記事は有料会員限定です<span>残り2656文字</span></p>", "toyokeizai.net").status === "paid");
ok("ダイヤモンド 有料CTA → paid",
   detectPaywallFromHtml("<p>続きを読むには会員登録が必要です</p>", "diamond.jp").status === "paid");
ok("JSON-LD isAccessibleForFree:false → paid",
   detectPaywallFromHtml('<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>', "www.yomiuri.co.jp").status === "paid");
ok("読売 無料記事(フラグ無し) → free",
   detectPaywallFromHtml('<script type="application/ld+json">{"@type":"NewsArticle"}</script><p>全文無料</p>', "www.yomiuri.co.jp").status === "free");

console.log("有料判定の汎用化 (未登録ドメイン)");
ok("未登録＋genericなし → unknown",
   detectPaywallFromHtml('<p>ここから先は有料です</p>', "unknown-media.example").status === "unknown");
ok("未登録＋generic＋CTA → paid",
   detectPaywallFromHtml('<p>ここから先は有料です</p>', "unknown-media.example", { generic: true }).status === "paid");
ok("未登録＋generic＋文字列isAccessibleForFree → paid",
   detectPaywallFromHtml('{"isAccessibleForFree":"False"}', "unknown-media.example", { generic: true }).status === "paid");
ok("content_tier=locked → paid",
   detectPaywallFromHtml('<meta property="article:content_tier" content="locked">', "unknown-media.example", { generic: true }).status === "paid");
ok("hasPart cssSelector .paywall → paid",
   detectPaywallFromHtml('{"hasPart":{"@type":"WebPageElement","cssSelector":".paywalled-content"}}', "unknown-media.example", { generic: true }).status === "paid");
ok("英語CTA(Subscribe to continue reading) → paid",
   detectPaywallFromHtml('<div>Subscribe to continue reading</div>', "unknown-media.example", { generic: true }).status === "paid");
ok("英語ナビ語(Already a subscriber?)だけ → free",
   detectPaywallFromHtml('<a>Already a subscriber? Log in</a><p>full text</p>', "unknown-media.example", { generic: true }).status === "free");
ok("未登録＋generic＋無料 → free",
   detectPaywallFromHtml('<p>全文無料の本文です</p>', "unknown-media.example", { generic: true }).status === "free");

console.log("ページシグナル (広告量/アダルト自己申告/登録必須)");
// 広告"枠"を数える。社数では測れない（GAM/AdSenseは初期HTMLにローダーが1〜2本あるだけで、
// 枠は実行時に生成される。実測でgigazineは2社しか出ないのに枠は12個ある）
const slots = (n) => Array.from({ length: n }, (_, i) => `<div id="div-gpt-ad-slot${i}"></div>`).join("");
ok("GAM枠12個 → heavy(gigazine相当)", detectAdLoad(slots(12)).heavy === true);
ok("GAM枠8個 → 非heavy(新聞記事相当)", detectAdLoad(slots(8)).heavy === false);
ok("heavyは枠数ラベルを返す",      /広告枠\d+個/.test(detectAdLoad(slots(12)).label));
ok("id属性とdefineSlotを二重に数えない",
   countAdSlots(slots(3) + 'googletag.defineSlot("/x/slot0");googletag.defineSlot("/x/slot1");') === 3);
ok("AdSenseの<ins>も枠として数える",
   countAdSlots(Array.from({ length: 10 }, () => '<ins class="adsbygoogle"></ins>').join("")) === 10);
ok("広告ネットワーク6社 → heavy", detectAdLoad(`
  <script src="//pagead2.googlesyndication.com/x.js"></script>
  <script src="//securepubads.g.doubleclick.net/tag.js"></script>
  <iframe src="//ads.adnxs.com/if"></iframe>
  <script src="//cdn.taboola.com/libtrc/x.js"></script>
  <script src="//static.criteo.net/js/ld.js"></script>
  <script src="//c.pubmatic.com/x.js"></script>`).heavy === true);
ok("広告1社 → 非heavy",           detectAdLoad('<script src="//pagead2.googlesyndication.com/x.js"></script>').heavy === false);
ok("広告なし → 非heavy",          detectAdLoad("<p>本文だけ</p>").heavy === false);
ok("空HTML → 非heavy",            detectAdLoad("").heavy === false);
ok("RTAラベル → adult",           detectAdultFromHtml('<meta name="RATING" content="RTA-5042-1996-1400-1577-RTA">'));
ok("meta rating=adult → adult",   detectAdultFromHtml('<meta name="rating" content="adult">'));
ok("年齢確認ゲート(日本語) → adult", detectAdultFromHtml("<div>あなたは18歳以上ですか？</div>"));
ok("18歳未満お断り → adult",       detectAdultFromHtml("<p>18歳未満の方はご遠慮ください</p>"));
ok("年齢確認ゲート(英語) → adult", detectAdultFromHtml("<button>I am 18 or older - Enter</button>"));
ok("普通のページ → 非adult",       !detectAdultFromHtml("<p>今日の天気</p>"));
ok("年齢制限の話題を書いた記事 → 非adult",
   !detectAdultFromHtml("<p>飲酒は20歳から。18歳未満の喫煙も禁止されている。</p>"));
ok("無料会員登録CTA → login",      detectLoginWall("<p>続きを読むには無料会員登録が必要です</p>"));
ok("英語 Sign up to continue → login", detectLoginWall("<div>Sign up to continue reading</div>"));
ok("ただのログインリンク → 非login", !detectLoginWall('<a href="/login">ログイン</a>'));
ok("analyzeHtmlが束ねて返す",      (() => { const r = analyzeHtml(slots(12) + '<meta name="rating" content="adult">'); return !!r.ads && !!r.adult; })());

console.log("t.co中継ページの本URL抽出");
const tcoReal = `<head><noscript><META http-equiv="refresh" content="0;URL=https://www.asahi.com/articles/ASV7S1VT7V7SUTIL01LM.html?ref=tw_asahi"></noscript><title>https://www.asahi.com/articles/ASV7S1VT7V7SUTIL01LM.html?ref=tw_asahi</title></head><script>window.opener = null; location.replace("https://www.asahi.com/articles/ASV7S1VT7V7SUTIL01LM.html?ref=tw_asahi")</script>`;
ok("meta refresh から本URL抽出",
   extractTcoTarget(tcoReal) === "https://www.asahi.com/articles/ASV7S1VT7V7SUTIL01LM.html?ref=tw_asahi");
ok("location.replace(エスケープ)から抽出",
   extractTcoTarget(`<script>location.replace("https:\\/\\/www.yomiuri.co.jp\\/economy\\/x.html")</script>`)
     === "https://www.yomiuri.co.jp/economy/x.html");
ok("抽出したURLのhostは対象媒体",
   new URL(extractTcoTarget(tcoReal)).hostname === "www.asahi.com");

console.log("既定値");
ok("全カテゴリが既定でON",     CATEGORIES.every(c => DEFAULT_SETTINGS["cat_" + c.kind] === true));
ok("リンク先の取得が既定でON", DEFAULT_SETTINGS.deepScan === true);
ok("既定の見せ方は画像を覆う", DEFAULT_SETTINGS.badgeStyle === "cover");

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
