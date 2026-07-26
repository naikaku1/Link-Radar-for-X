// classifier.js — URLだけで判定できる分類。fetch不要・同期・軽量。
// ここに入れてよいのは「URL文字列を見れば事実として言えること」だけ。
// ページ内容に依存する判定（有料/広告量/登録必須）は pagesignals.js 側。
import {
  AFFILIATE_RULES, SHORTENER_HOSTS, PR_RULES, FARM_HOSTS, CAUTION_HOSTS,
  SAFE_HOSTS, ADULT_HOSTS, ADULT_URL_RE, DOWNLOAD_EXT_RE
} from "./rules.js";

/**
 * URL文字列を安全にパースする。失敗時は null。
 */
export function parseUrl(raw) {
  try { return new URL(raw); } catch { return null; }
}

function hostMatches(re, hostname) {
  return re ? re.test(hostname) : false;
}

function paramExists(url, name) {
  return url.searchParams.has(name);
}

function paramReMatches(url, obj) {
  for (const [k, re] of Object.entries(obj)) {
    const v = url.searchParams.get(k);
    if (v != null && re.test(v)) return true;
  }
  return false;
}

// "utm_medium=affiliate" のような key=value 直書き、または単なるkey存在を許容
function paramAnyMatches(url, arr) {
  for (const spec of arr) {
    if (spec.includes("=")) {
      const [k, v] = spec.split("=");
      if (url.searchParams.get(k) === v) return true;
    } else if (url.searchParams.has(spec)) {
      return true;
    }
  }
  return false;
}

/**
 * host が list のいずれかに一致するか。サブドメインは許容する。
 * listの要素は "example.com" のほか "dmm.co.jp/digital" のようにパス前方一致も書ける
 * （同一ドメインで一般向け/アダルトが分かれているサイト用）。
 */
function hostInList(url, list) {
  const host = url.hostname.toLowerCase();
  const path = (url.pathname || "/").toLowerCase();
  return list.some(entry => {
    const e = entry.toLowerCase();
    const slash = e.indexOf("/");
    if (slash < 0) return host === e || host.endsWith("." + e);
    const h = e.slice(0, slash), p = e.slice(slash);
    return (host === h || host.endsWith("." + h)) && path.startsWith(p);
  });
}

/** 大手/正規ドメインか。ヒューリスティック系の判定はここに該当したらスキップする。 */
export function isSafeHost(url) {
  const host = url.hostname.toLowerCase();
  return SAFE_HOSTS.some(e => host === e || host.endsWith("." + e));
}

/** アフィリエイト判定。ヒットしたルールのlabelを返す（なければnull） */
export function detectAffiliate(url) {
  const host = url.hostname.toLowerCase();
  for (const r of AFFILIATE_RULES) {
    if (r.hostRe && hostMatches(r.hostRe, host)) {
      // hostRe系でparam条件も付くもの（amazon-tag）はparamも要求
      if (r.param && !paramExists(url, r.param)) continue;
      return r.label;
    }
    if (r.param && !r.hostRe && paramExists(url, r.param)) return r.label;
    if (r.paramRe && paramReMatches(url, r.paramRe)) return r.label;
    if (r.paramAny && paramAnyMatches(url, r.paramAny)) return r.label;
  }
  return null;
}

/** 短縮URL判定 */
export function detectShortener(url) {
  const host = url.hostname.toLowerCase();
  return SHORTENER_HOSTS.some(h => host === h || host.endsWith("." + h)) ? "短縮URL" : null;
}

/** PR/広告記事・広告ネットワーク判定 */
export function detectPR(url) {
  const host = url.hostname.toLowerCase();
  for (const r of PR_RULES) {
    if (r.hostRe && hostMatches(r.hostRe, host)) return r.label;
    if (r.paramAny && paramAnyMatches(url, r.paramAny)) return r.label;
  }
  return null;
}

/** まとめ/転載サイト判定 */
export function detectFarm(url) {
  return hostInList(url, FARM_HOSTS) ? "まとめ/転載" : null;
}

/** 要注意ドメイン判定（既知の報告あり。断定はしない） */
export function detectCaution(url) {
  return hostInList(url, CAUTION_HOSTS) ? "要注意(報告あり)" : null;
}

/**
 * アダルト判定。
 *  (a) 既知ドメイン → 確実
 *  (b) ホスト名/パスに明示的なアダルト語 → SAFE_HOSTS 以外にのみ適用
 * ラベルは中立に「アダルト」。良し悪しの判断はしない（開く前に分かることが目的）。
 */
export function detectAdult(url) {
  if (hostInList(url, ADULT_HOSTS)) return "アダルトサイト";
  if (isSafeHost(url)) return null;
  const target = decodeURIComponentSafe(url.hostname + url.pathname);
  for (const re of ADULT_URL_RE) {
    if (re.test(target) || re.test(url.hostname)) return "アダルト(URLに明示)";
  }
  return null;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// 属性型/汎用の第2レベルドメイン。"example.co.jp" を "co.jp" と誤認しないために使う。
const SECOND_LEVEL = ["co", "ne", "or", "ac", "go", "lg", "ed", "gr", "com", "net", "org", "gov", "edu"];

/**
 * 登録可能ドメインを取り出す（Public Suffix Listの簡易近似）。
 *   "a1.spam-site.top"    -> "spam-site.top"
 *   "www.example.co.jp"   -> "example.co.jp"
 * 連投カウントをホスト完全一致でやるとサブドメインを回すだけで回避されるため、この単位で数える。
 */
export function registrableDomain(host) {
  const p = String(host || "").toLowerCase().split(".").filter(Boolean);
  if (p.length <= 2) return p.join(".");
  const takeThree = p[p.length - 1].length === 2 && SECOND_LEVEL.includes(p[p.length - 2]);
  return p.slice(takeThree ? -3 : -2).join(".");
}

/** クリックするとファイルが落ちてくるリンク */
export function detectDownload(url) {
  const m = url.pathname.match(DOWNLOAD_EXT_RE);
  return m ? `${m[1].toLowerCase()} ファイル` : null;
}

/**
 * Xのリンク表示テキストから、判定に使えるURLを組み立てる。
 *
 * カードリンクのアンカーは innerText に「ホスト＋見出し＋説明」が改行で連なる:
 *     "gigazine.net\n【朗報】新型ゲーム機が発表される"
 * これを空白除去して "https://" に繋ぐと、日本語がホスト名の一部として解釈され、
 * URLパーサが punycode ホスト (gigazine.xn--net-w03bf…) を作ってしまう。
 * その結果ほぼ全てのカードリンクが「Punycode＝なりすまし注意」で誤検出されていた。
 *
 * 対策として、空白で区切ったトークンのうち「行頭から行末までがホスト(+パス)」に
 * なっているものだけを採用する。見出しが混ざったトークンは採用しない。
 *
 * @returns {string|null}
 */
export function urlFromDisplayText(text) {
  if (!text) return null;
  for (const raw of String(text).split(/\s+/)) {
    // 末尾の省略記号や句読点を落とす
    const tok = raw.replace(/[……]+$/, "").replace(/[、。，．,)\]】」』〉>]+$/, "");
    const m = tok.match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s]*)?$/i);
    if (!m) continue;
    return "https://" + m[1].toLowerCase() + (m[2] || "");
  }
  return null;
}

/** 表示テキストからホスト名だけを取り出す（取れなければ null） */
export function hostFromDisplayText(text) {
  const u = urlFromDisplayText(text);
  return u ? parseUrl(u)?.hostname ?? null : null;
}

/**
 * t.coの中継ページHTMLから本当の遷移先URLを取り出す。
 * t.coは30xを返さず200で meta refresh / location.replace に本URLを埋めた小さなHTMLを返すため、
 * redirect:"follow" では辿れない。ここでその本URLを抽出する。
 * @returns {string|null}
 */
export function extractTcoTarget(html) {
  if (!html) return null;
  // 1) <meta http-equiv="refresh" content="0;URL=...">
  let m = html.match(/URL=([^"'<>\s]+)/i);
  if (m) return m[1].replace(/\\\//g, "/");
  // 2) location.replace("https:\/\/...")
  m = html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
  if (m) return m[1].replace(/\\\//g, "/");
  // 3) 最初の t.co 以外の絶対URL
  m = html.match(/https?:\/\/(?!t\.co\/)[^\s"'<>\\)]+/i);
  return m ? m[0].replace(/\\\//g, "/") : null;
}

/**
 * URLのみの分類をまとめて返す。
 * @returns {{affiliate?:string, shortener?:string, pr?:string, farm?:string,
 *            caution?:string, adult?:string, download?:string}}
 */
export function classifyByUrl(raw) {
  const url = parseUrl(raw);
  if (!url) return {};
  const out = {};
  const aff = detectAffiliate(url);   if (aff) out.affiliate = aff;
  const sh = detectShortener(url);    if (sh) out.shortener = sh;
  const pr = detectPR(url);           if (pr) out.pr = pr;
  const farm = detectFarm(url);       if (farm) out.farm = farm;
  const caution = detectCaution(url); if (caution) out.caution = caution;
  const adult = detectAdult(url);     if (adult) out.adult = adult;
  const dl = detectDownload(url);     if (dl) out.download = dl;
  return out;
}
