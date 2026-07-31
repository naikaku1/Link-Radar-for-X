// test/verify-url.js — 実URLをfetchして各判定を確認するツール。
// 使い方: node test/verify-url.js "https://www.asahi.com/articles/xxxx.html"
// 目的: 実測して rules.js のルール（有料CTA/広告ネットワーク等）をハードニングする。
import { detectPaywallFromHtml, stripTags } from "../src/paywall.js";
import { classifyByUrl, isSafeHost, registrableDomain, parseUrl } from "../src/classifier.js";
import { detectAdLoad, detectAdultFromHtml, detectLoginWall } from "../src/pagesignals.js";

const url = process.argv[2];
if (!url) { console.error('URLを渡してください: node test/verify-url.js "<url>"'); process.exit(1); }

const res = await fetch(url, { redirect: "follow" });
const html = await res.text();
const finalUrl = res.url || url;
const host = new URL(finalUrl).hostname;

console.log("URL      :", finalUrl);
console.log("host     :", host);
console.log("status   :", res.status, "| htmlLen:", html.length);

// --- URLだけの判定 ---
console.log("\n--- URL判定 ---");
console.log("byUrl    :", JSON.stringify(classifyByUrl(finalUrl)));
// ヒューリスティック(連投/アダルト語)を適用するかどうかの分かれ目
const parsed = parseUrl(finalUrl);
console.log("SAFE_HOST:", parsed && isSafeHost(parsed) ? "はい（ヒューリスティックは適用しない）" : "いいえ");
console.log("連投単位 :", registrableDomain(host));

// --- ページ内容の判定 ---
console.log("\n--- ページ内容判定 ---");
console.log("paywall(登録媒体):", JSON.stringify(detectPaywallFromHtml(html, host)));
console.log("paywall(汎用)    :", JSON.stringify(detectPaywallFromHtml(html, host, { generic: true })));
const ads = detectAdLoad(html);
console.log("広告     :", ads.heavy ? ads.label : `非heavy (${ads.networks.length}社/${ads.refs}件)`);
if (ads.networks.length) console.log("  内訳   :", ads.networks.join(", "));
console.log("アダルト :", detectAdultFromHtml(html) || "なし");
console.log("登録必須 :", detectLoginWall(html) || "なし");

// 有料CTA候補が生HTMLに含まれるかのヒント表示（新しいルール発見用）
const text = stripTags(html);
const hints = ["有料", "会員限定", "残り", "続きを読む", "ログインして", "この記事は", "無料登録", "購読", "プレミアム",
               "Subscribe", "subscribers", "Sign up"];
console.log("\nHTML内に出現する有料/登録っぽい語:");
let found = 0;
for (const h of hints) {
  const i = text.indexOf(h);
  if (i >= 0) { found++; console.log(`  [${h}] …${text.slice(i, i + 40).replace(/\s+/g, " ")}…`); }
}
if (!found) console.log("  （なし）");
