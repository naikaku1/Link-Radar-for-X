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

/** <script>/<style>を除去し、残りのタグを剥がしてテキスト化 */
export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/** 構造シグナル（媒体非依存）だけを見る。ヒットしたルールIDを返す。 */
export function detectPaywallMeta(html) {
  for (const { re, id } of PAYWALL_META_RE) {
    if (re.test(html)) return id;
  }
  return null;
}

/**
 * 生HTMLとホスト名から有料判定。
 * @param {string} html
 * @param {string} hostname
 * @param {{generic?:boolean}} [opts] generic:true で未登録ドメインも汎用ルールで判定する
 * @returns {{status:"paid"|"free"|"unknown", label:string, reason?:string, matched?:string, confirmed?:boolean}}
 */
export function detectPaywallFromHtml(html, hostname, opts = {}) {
  const site = matchPaywallSite(hostname);

  if (!site) {
    // 未登録ドメイン。generic モードでなければ従来どおり判定しない。
    if (!opts.generic) return { status: "unknown", label: "", reason: "not-target" };
    const meta = detectPaywallMeta(html);
    if (meta) return { status: "paid", label: "有料記事", matched: meta, confirmed: true, generic: true };
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
  const hit = matchAny(html, [...(site.paidRe || []), ...GENERIC_PAYWALL_RE]);
  if (hit) {
    return { status: "paid", label: "有料記事", matched: hit, confirmed: !!site.confirmed };
  }

  // 有料マーカーが生HTMLに見つからない = 無料、またはJSでのみ有料化する媒体（その場合は取りこぼす=誤警告は出さない）
  return { status: "free", label: "", confirmed: !!site.confirmed };
}

// 生HTML（鍵アイコンやclass由来の文字列用）とタグ除去後テキスト（残りN文字用）の両方で照合
function matchAny(html, rules) {
  const text = stripTags(html);
  for (const re of rules) {
    if (re.test(html) || re.test(text)) return re.toString();
  }
  return null;
}
