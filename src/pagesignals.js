// pagesignals.js — 背景fetchした生HTMLから取れる「ページ内容依存」のシグナル。
// fetchはbackground側で行い、ここは純粋関数だけ（=テストしやすい）。
// paywall判定は paywall.js、URLだけの判定は classifier.js に分離してある。
import {
  AD_SCRIPT_HOSTS, AD_SLOT_PATTERNS, AD_HEAVY_MIN_SLOTS, AD_HEAVY_MIN_NETWORKS,
  ADULT_HTML_RE, LOGIN_WALL_RE
} from "./rules.js";
import { stripTags } from "./paywall.js";

/**
 * ページに置かれている広告"枠"の数を数える。
 * GAMのスロットIDは id属性とJS内のdefineSlot呼び出しの両方に現れて二重に数えてしまうため、
 * ID重複排除した数と defineSlot 呼び出し数の大きい方を採り、AdSenseの<ins>を足す。
 * @returns {number}
 */
export function countAdSlots(html) {
  const ids = new Set();
  for (const m of html.matchAll(AD_SLOT_PATTERNS.gptSlotId)) ids.add(m[1]);
  const defines = (html.match(AD_SLOT_PATTERNS.gptDefine) || []).length;
  const adsense = (html.match(AD_SLOT_PATTERNS.adsense) || []).length;
  return Math.max(ids.size, defines) + adsense;
}

/**
 * 広告の量を測る。
 * 「広告が多い」は主観なので、閾値を超えたときだけ件数を添えた事実として返す。
 * @returns {{heavy:boolean, slots:number, networks:string[], refs:number, label:string|null}}
 */
export function detectAdLoad(html) {
  if (!html) return { heavy: false, slots: 0, networks: [], refs: 0, label: null };

  const slots = countAdSlots(html);

  const networks = new Set();
  let refs = 0;
  for (const h of AD_SCRIPT_HOSTS) {
    // ホスト名の出現回数を数える（script src / iframe src / preconnect すべて含む）
    const re = new RegExp(h.replace(/[.]/g, "\\."), "gi");
    const n = (html.match(re) || []).length;
    if (n > 0) { networks.add(h); refs += n; }
  }

  const heavy = slots >= AD_HEAVY_MIN_SLOTS || networks.size >= AD_HEAVY_MIN_NETWORKS;
  const label = heavy
    ? (slots >= AD_HEAVY_MIN_SLOTS ? `広告枠${slots}個` : `広告ネットワーク${networks.size}社`)
    : null;

  return { heavy, slots, networks: [...networks], refs, label };
}

/**
 * サイト自身によるアダルト自己申告（RTAラベル / meta rating）。
 * 自己申告なので誤検出が起きにくい＝強いシグナル。
 * @returns {string|null}
 */
export function detectAdultFromHtml(html) {
  if (!html) return null;
  for (const re of ADULT_HTML_RE) {
    if (re.test(html)) return "アダルト(サイト自己申告)";
  }
  return null;
}

/**
 * 「無料だが登録/ログインが必要」なウォール。
 * 有料判定が取れたときはそちらを優先するため、呼び出し側で後段に置く。
 * @returns {string|null}
 */
export function detectLoginWall(html) {
  if (!html) return null;
  const text = stripTags(html);
  for (const re of LOGIN_WALL_RE) {
    if (re.test(html) || re.test(text)) return "登録/ログインが必要";
  }
  return null;
}

/**
 * ページ全体のシグナルをまとめて返す。
 * @returns {{ads?:string, adsDetail?:object, adult?:string, login?:string}}
 */
export function analyzeHtml(html) {
  const out = {};
  const ads = detectAdLoad(html);
  if (ads.label) { out.ads = ads.label; out.adsDetail = ads; }
  const adult = detectAdultFromHtml(html); if (adult) out.adult = adult;
  const login = detectLoginWall(html);     if (login) out.login = login;
  return out;
}
