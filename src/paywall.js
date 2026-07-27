// paywall.js — 生HTML/テキストから有料記事を判定する純粋関数。
// fetchはbackground側で行い、ここは判定ロジックだけ（=テストしやすい）。
//
// 判定は3層。上ほど信頼度が高い:
//   1. 構造シグナル (JSON-LD isAccessibleForFree / meta content_tier) … 媒体非依存・確定的
//   2. 媒体別CTA (PAYWALL_SITES[domain].paidRe)                        … 実記事で確認済みのもの
//   3. 汎用CTA (GENERIC_PAYWALL_RE)                                    … 本文を塞ぐ固有フレーズのみ
//
// 未登録ドメインでも 1 と 3 だけで判定できるため、{ generic: true } を渡せば全サイトに使える。
import { matchPaywallSite, GENERIC_PAYWALL_RE, PAYWALL_META_RE } from "./rules.js";

/**
 * <script>/<style>/<pre>/<code> を除去し、残りのタグを剥がしてテキスト化。
 *
 * <pre>/<code> を落とすのが重要。技術記事やドキュメントは有料CTAの文字列を
 * コード例として引用することがあり、それを本文として扱うと誤検出になる
 * （このプロジェクト自身のREADMEで実際に起きた）。
 */
export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<pre[\s\S]*?<\/pre>/gi, " ")
    .replace(/<code[\s\S]*?<\/code>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * 機械可読な宣言部分だけを取り出す（<meta>タグ と JSON-LD ブロック）。
 *
 * 構造シグナルを文書全体の正規表現で探すと、ページが構造シグナルの"話をしている"だけで
 * 一致してしまう。実際、`isAccessibleForFree:false` と書いた解説ページ（このリポジトリの
 * README）が有料記事と誤判定された。宣言は宣言のある場所でだけ探す。
 */
export function extractStructured(html) {
  const parts = [];
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) parts.push(m[0]);
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) parts.push(m[1]);
  return parts.join("\n");
}

/** 構造シグナル（媒体非依存）だけを見る。ヒットしたルールIDを返す。 */
export function detectPaywallMeta(html) {
  const structured = extractStructured(html);
  if (!structured) return null;
  for (const { re, id } of PAYWALL_META_RE) {
    if (re.test(structured)) return id;
  }
  return null;
}

/**
 * 生HTMLとホスト名から有料判定。
 * @param {string} html
 * @param {string} hostname
 * @param {{generic?:boolean, trustText?:boolean}} [opts]
 *   generic   … 未登録ドメインも汎用ルールで判定する
 *   trustText … 本文テキストの汎用CTAを信用してよいか（既定 true）。
 *               大手/正規ドメイン(SAFE_HOSTS)では false を渡す。有料CTAの文字列を
 *               本文で引用しているだけのページを有料と誤判定しないため。
 * @returns {{status:"paid"|"free"|"unknown", label:string, reason?:string, matched?:string, confirmed?:boolean}}
 */
export function detectPaywallFromHtml(html, hostname, opts = {}) {
  const site = matchPaywallSite(hostname);
  const trustText = opts.trustText !== false;

  if (!site) {
    // 未登録ドメイン。generic モードでなければ従来どおり判定しない。
    if (!opts.generic) return { status: "unknown", label: "", reason: "not-target" };
    const meta = detectPaywallMeta(html);
    if (meta) return { status: "paid", label: "有料記事", matched: meta, confirmed: true, generic: true };
    if (!trustText) return { status: "free", label: "", confirmed: false, generic: true };
    const hit = matchAny(html, GENERIC_PAYWALL_RE);
    if (hit) return { status: "paid", label: "有料記事", matched: hit, confirmed: false, generic: true };
    return { status: "free", label: "", confirmed: false, generic: true };
  }

  if (site.enabled === false) {
    return { status: "unknown", label: "", reason: "dynamic-paywall", note: site.note };
  }

  // 1) 構造シグナル（媒体非依存の高信頼シグナル。出す媒体は確実に判定できる）
  const meta = detectPaywallMeta(html);
  if (meta) return { status: "paid", label: "有料記事", matched: meta, confirmed: true };

  // 2) 媒体別CTA → 3) 汎用CTA
  // 登録済み媒体は「その媒体が有料記事で出す文言」を検証済みなので、テキスト判定を信用してよい。
  const hit = matchAny(html, [...(site.paidRe || []), ...GENERIC_PAYWALL_RE]);
  if (hit) {
    return { status: "paid", label: "有料記事", matched: hit, confirmed: !!site.confirmed };
  }

  // 有料マーカーが生HTMLに見つからない = 無料、またはJSでのみ有料化する媒体（その場合は取りこぼす=誤警告は出さない）
  return { status: "free", label: "", confirmed: !!site.confirmed };
}

// タグ除去後テキストと、タグを跨ぐケース用に生HTMLの両方で照合する。
// ただし生HTML側は <script>/<style>/<pre>/<code> を落としてから見る。
function matchAny(html, rules) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<pre[\s\S]*?<\/pre>/gi, " ")
    .replace(/<code[\s\S]*?<\/code>/gi, " ");
  const text = stripTags(html);
  for (const re of rules) {
    if (re.test(cleaned) || re.test(text)) return re.toString();
  }
  return null;
}
