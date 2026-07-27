// pagesignals.js — 背景fetchした生HTMLから取れる「ページ内容依存」のシグナル。
// fetchはbackground側で行い、ここは純粋関数だけ（=テストしやすい）。
// paywall判定は paywall.js、URLだけの判定は classifier.js に分離してある。
import {
  AD_SCRIPT_HOSTS, AD_SLOT_PATTERNS, AD_HEAVY_MIN_SLOTS, AD_HEAVY_MIN_NETWORKS,
  ADULT_META_RE, ADULT_TEXT_RE, LOGIN_WALL_RE
} from "./rules.js";
import { stripTags, extractStructured } from "./paywall.js";

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
 * サイト自身によるアダルトの申告。信頼度の違う2種類を分けて扱う。
 *
 *  (1) <meta> タグでの宣言（RTAラベル / rating=adult）… 機械可読なのでどこでも信用できる
 *  (2) 年齢確認ゲートの本文テキスト … 強力だが「年齢確認について書いた記事」にも一致する。
 *      そのため trustText=false（SAFE_HOSTS＝大手/正規ドメイン）では評価しない。
 *
 * ※ このプロジェクト自身のREADMEが「あなたは18歳以上ですか」を含んでいたため、
 *   GitHubのリポジトリページがアダルト判定される誤検出が実際に起きた。
 *
 * @param {string} html
 * @param {{trustText?:boolean}} [opts] trustText 既定 true
 * @returns {string|null}
 */
export function detectAdultFromHtml(html, opts = {}) {
  if (!html) return null;

  const structured = extractStructured(html);
  for (const re of ADULT_META_RE) {
    if (re.test(structured)) return "アダルト(サイトが宣言)";
  }

  if (opts.trustText === false) return null;

  const text = stripTags(html);
  for (const re of ADULT_TEXT_RE) {
    if (re.test(text)) return "アダルト(年齢確認あり)";
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
 * @param {string} html
 * @param {{trustText?:boolean}} [opts] 本文テキストベースの判定を信用してよいか
 * @returns {{ads?:string, adsDetail?:object, adult?:string, login?:string}}
 */
export function analyzeHtml(html, opts = {}) {
  const out = {};
  const ads = detectAdLoad(html);
  if (ads.label) { out.ads = ads.label; out.adsDetail = ads; }
  const adult = detectAdultFromHtml(html, opts); if (adult) out.adult = adult;
  if (opts.trustText !== false) {
    const login = detectLoginWall(html);        if (login) out.login = login;
  }
  return out;
}
