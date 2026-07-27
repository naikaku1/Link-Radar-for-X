// background.js — service worker (module)
// content scriptから {href, text} を受け取り、以下を返す:
//   badges: [{kind,label}]  kind = "paid"|"affiliate"|"shortener"|"pr"|"farm"|"caution"
//                                 |"adult"|"download"|"ads"|"login"
//   paywall: {status:"paid"|"free"|"unknown", ...}
//   finalUrl: 解決できた最終URL（t.co/短縮の行き先開示用）
import {
  classifyByUrl, extractRelayTarget, parseUrl, isSafeHost, registrableDomain,
  urlFromDisplayText, hostFromDisplayText
} from "./classifier.js";
import { detectPaywallFromHtml } from "./paywall.js";
import { analyzeHtml } from "./pagesignals.js";
import { matchPaywallSite, DEFAULT_SETTINGS, SHORTENER_HOSTS } from "./rules.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_CONCURRENT = 8;           // 背景fetchの並列数。全リンクを取得するようになったので広げた
const ITEM_BUDGET_MS = 12000;       // 1リンクに使ってよい合計時間（中継を辿っても伸びすぎないように）
const MAX_HTML_BYTES = 1_500_000;   // 巨大ページで判定コストが跳ねるのを防ぐ
const MAX_RELAY_HOPS = 4;           // 中継ページを追う上限
const RELAY_MAX_BYTES = 4000;       // これより小さいHTMLは「中継ページ」の可能性がある

// 判定ルールを変更したのに古い結果が残り続けると、直したはずの誤検出が最大6時間消えない。
// 拡張機能のバージョンが変わったらキャッシュを丸ごと捨てる。
const RULES_VERSION = chrome.runtime.getManifest().version;
const VERSION_KEY = "__lrRulesVersion";

async function invalidateCacheOnUpdate() {
  try {
    const got = await chrome.storage.local.get(VERSION_KEY);
    if (got[VERSION_KEY] === RULES_VERSION) return;
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ [VERSION_KEY]: RULES_VERSION });
    memCache.clear();
  } catch {}
}

const memCache = new Map();     // key -> {result, ts}
const inflight = new Map();
let active = 0;
const queue = [];

// ------------------------------------------------------------------
// 設定（storage.syncにキャッシュ。変更は onChanged で反映）
// ------------------------------------------------------------------
let settings = { ...DEFAULT_SETTINGS };
let hasAllUrls = false;

async function loadSettings() {
  try {
    const v = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = { ...DEFAULT_SETTINGS, ...v };
  } catch {}
  try {
    hasAllUrls = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch { hasAllUrls = false; }
}
loadSettings();
invalidateCacheOnUpdate();
if (chrome.runtime.onInstalled) {
  // 更新直後は必ず作り直す（reason: "update" / "install" どちらも）
  chrome.runtime.onInstalled.addListener(() => { chrome.storage.local.clear().catch(() => {}); memCache.clear(); });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
  memCache.clear();   // 設定が変わったら判定結果を作り直す
});
if (chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => { loadSettings(); memCache.clear(); });
}
if (chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => { loadSettings(); memCache.clear(); });
}

function catOn(kind) { return settings["cat_" + kind] !== false; }

// deepScan（全サイト背景取得）が実際に使えるか
function deepScanEnabled() { return !!settings.deepScan && hasAllUrls; }

// ------------------------------------------------------------------
// fetchキュー
// ------------------------------------------------------------------
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    job().finally(() => { active--; pump(); });
  }
}
function schedule(fn) {
  return new Promise((res, rej) => { queue.push(() => fn().then(res, rej)); pump(); });
}

async function getCached(key) {
  const m = memCache.get(key);
  if (m && Date.now() - m.ts < CACHE_TTL_MS) return m.result;
  try {
    const s = await chrome.storage.local.get(key);
    const e = s[key];
    if (e && Date.now() - e.ts < CACHE_TTL_MS) { memCache.set(key, e); return e.result; }
  } catch {}
  return null;
}
async function setCached(key, result) {
  const e = { result, ts: Date.now() };
  memCache.set(key, e);
  try { await chrome.storage.local.set({ [key]: e }); } catch {}
}

// 表示テキストからのホスト/URL抽出は classifier.js に集約してある。
// （見出しが混ざったテキストを丸ごとURL化すると punycode ホストが生成され、
//   ほぼ全てのカードリンクが「不審」になる不具合があったため）

async function fetchWithBody(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit", redirect: "follow" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct)) return null;
    let html = await res.text();
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
    return { finalUrl: res.url || url, html };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function safeHost(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } }

/**
 * 中継ページを辿って実体ページまで到達する。
 *
 * 短縮URLの先が「200で小さなHTMLを返し、JSで次へ飛ばす」多段中継になっていることがある
 * （実例: is.gd → playstone.biz/redirect/… → applove.info/redirect/… → 実体）。
 * HTTPの30xではないので redirect:"follow" では辿れず、短縮URLの裏側が判定できなかった。
 *
 * @returns {{finalUrl:string, html:string}|null}
 */
async function fetchFollowingRelays(url) {
  let cur = url;
  const seen = new Set();
  const deadline = Date.now() + ITEM_BUDGET_MS;
  for (let hop = 0; hop < MAX_RELAY_HOPS; hop++) {
    if (seen.has(cur)) break;                 // ループ防止
    if (Date.now() > deadline) break;         // 1リンクに時間をかけすぎない
    seen.add(cur);
    const got = await fetchWithBody(cur);
    if (!got) return null;

    // 実体ページとみなせる大きさなら、そこで終わり
    if (got.html.length > RELAY_MAX_BYTES) return got;

    const next = extractRelayTarget(got.html);
    if (!next || !isHttpUrl(next) || next === got.finalUrl) return got;
    cur = next;
  }
  return await fetchWithBody(cur);
}

function isShortenerHost(host) {
  return !!host && SHORTENER_HOSTS.some(h => host === h || host.endsWith("." + h));
}

// http(s) 以外（intent:, javascript:, mailto: 等）は扱わない
function isHttpUrl(u) {
  const p = parseUrl(u);
  return !!p && /^https?:$/.test(p.protocol);
}

/**
 * URLだけで分かる判定を、fetchせずに即座に返す。
 *
 * 取得が要る判定（有料/広告量/登録必須/短縮の行き先）まで待つと、
 * その間ポストにバッジが1つも出ず「遅い」と感じる。まずこれを返して先に描画し、
 * 取得が終わったら差分を送って上書きする（classifyUpdate）。
 */
function classifyQuick({ href, text }) {
  const badges = [];
  const seen = new Set();
  const add = (kind, label) => {
    if (!label || seen.has(kind) || !catOn(kind)) return;
    seen.add(kind);
    badges.push({ kind, label });
  };
  const addBadges = (o) => {
    add("affiliate", o.affiliate); add("shortener", o.shortener); add("pr", o.pr);
    add("farm", o.farm); add("caution", o.caution); add("adult", o.adult); add("download", o.download);
  };

  const hrefHost = safeHost(href);
  const displayUrl = urlFromDisplayText(text);
  const displayHost = hostFromDisplayText(text);
  if (hrefHost && hrefHost !== "t.co") addBadges(classifyByUrl(href));
  if (displayUrl) addBadges(classifyByUrl(displayUrl));

  const host = (hrefHost && hrefHost !== "t.co") ? hrefHost : displayHost;
  const parsed = host ? parseUrl("https://" + host) : null;
  return {
    badges,
    partial: true,                     // まだ取得前の暫定結果
    host: host || undefined,
    domain: host ? registrableDomain(host) : undefined,
    safe: parsed ? isSafeHost(parsed) : true
  };
}

async function classifyItem({ href, text }) {
  const key = href || text;
  const cached = await getCached(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const badges = [];
    const seen = new Set();
    const add = (kind, label) => {
      if (!label || seen.has(kind) || !catOn(kind)) return;
      seen.add(kind);
      badges.push({ kind, label });
    };
    const addBadges = (obj) => {
      add("affiliate", obj.affiliate);
      add("shortener", obj.shortener);
      add("pr", obj.pr);
      add("farm", obj.farm);
      add("caution", obj.caution);
      add("adult", obj.adult);
      add("download", obj.download);
      add("ads", obj.ads);
      add("login", obj.login);
    };

    const hrefHost = safeHost(href);
    const displayUrl = urlFromDisplayText(text);      // 見出し混じりのテキストからは null が返る
    const displayHost = hostFromDisplayText(text);

    // 1) URLのみ分類。t.co自体はX標準ラッパなので短縮扱いしない。
    if (hrefHost && hrefHost !== "t.co") addBadges(classifyByUrl(href));
    if (displayUrl) addBadges(classifyByUrl(displayUrl));

    // 2) 最終URL/最終ホストの解決
    //    ここは2つを厳密に区別する:
    //      realUrl  … 本文を取得しても良い「信頼できる完全なURL」。無ければ null（fetchしない）
    //      realHost … ホスト単位の判定（連投カウント/アダルト/SAFE判定）に使うホスト
    //    Xの表示テキストは "gigazine.net/news/2026…" のようにパスが省略されうるので、
    //    ホストは信頼できるが、URLとしては信頼できない（＝fetchには使わない）。
    let realUrl = null;
    let realHost = null;
    let resolved = false;

    if (hrefHost && hrefHost !== "t.co" && isHttpUrl(href)) {
      realUrl = href;
      realHost = hrefHost;
    } else {
      realHost = displayHost || null;   // t.co の裏側は表示テキストのホストが手掛かり

      // t.co は30xでなく中継HTMLを返すので本URLを抽出する。
      // 毎回fetchすると重いので、解決する価値があるときだけ行う。
      const needsResolve =
        hrefHost === "t.co" &&
        (!displayHost                                 // 表示ホストが読めない（画像リプ等）
          || isShortenerHost(displayHost)             // 表示先がさらに短縮URL
          || !!matchPaywallSite(displayHost)          // 有料判定対象
          || deepScanEnabled());                      // 全サイト判定ON

      if (needsResolve) {
        const stub = await schedule(() => fetchWithBody(href));
        const target = stub ? extractRelayTarget(stub.html) : null;
        if (target && isHttpUrl(target)) {
          realUrl = target;
          realHost = safeHost(target) || realHost;
          resolved = true;
        }
      }

      // アンカーが無く表示テキストしか無い場合（引用元の素のテキストURL等）。
      // 短縮URLはパスが短く省略されにくいので、これだけは表示テキストから復元して追いかける。
      // 普通の記事URLはパスが省略されうるので対象にしない（404を踏むだけなので）。
      if (!realUrl && displayUrl && deepScanEnabled() && isShortenerHost(displayHost)) {
        realUrl = displayUrl;
      }
    }

    // 解決できた本URLで、URLのみの判定をやり直す（短縮の裏に隠れたアダルト/アフィ等を拾う）
    if (resolved && realUrl) addBadges(classifyByUrl(realUrl));

    // 3) ページ内容の判定（有料 / 広告量 / 登録必須 / アダルト自己申告）
    let paywall = null;
    const site = realHost ? matchPaywallSite(realHost) : null;
    const wantsFetch =
      realUrl && realHost && realHost !== "t.co" && isHttpUrl(realUrl) &&
      (site ? catOn("paid") : (deepScanEnabled() && (catOn("paid") || catOn("ads") || catOn("login"))));

    if (wantsFetch) {
      if (site && site.enabled === false) {
        paywall = { status: "unknown", reason: "dynamic-paywall" };
      } else {
        const got = await schedule(() => fetchFollowingRelays(realUrl));
        if (!got) {
          paywall = { status: "unknown", reason: "fetch-failed" };
        } else {
          // 中継を辿った結果、別ドメインに着地していることがある。判定は着地先で行う。
          const landedHost = safeHost(got.finalUrl) || realHost;
          const landedUrl = parseUrl(got.finalUrl || realUrl);
          // 大手/正規ドメインでは、本文テキストに依存する判定（年齢確認・汎用有料CTA）を信用しない。
          // 有料CTAやアダルトの文言を"引用しているだけ"のページを誤判定しないため。
          const trustText = landedUrl ? !isSafeHost(landedUrl) : true;

          paywall = detectPaywallFromHtml(got.html, landedHost, {
            generic: !matchPaywallSite(landedHost) && deepScanEnabled(),
            trustText
          });
          const sig = analyzeHtml(got.html, { trustText });
          // 有料が取れているときは「登録必須」は出さない（有料の方が強い情報）
          if (paywall.status === "paid") delete sig.login;
          addBadges(sig);
          // 着地先URLで再判定（短縮URL・多段中継の裏に隠れたアダルト/アフィ等はここで出る）
          addBadges(classifyByUrl(got.finalUrl || realUrl));
          // 連投カウントの単位とポップアップのホスト表示を、実際の着地先に合わせる
          if (landedHost && landedHost !== realHost) realHost = landedHost;
          if (got.finalUrl && got.finalUrl !== realUrl) { realUrl = got.finalUrl; resolved = true; }
        }
      }
      if (paywall && paywall.status === "paid") add("paid", "有料記事");
    } else if (site) {
      paywall = { status: "unknown", reason: "resolve-miss" };
    }

    // content script 側の連投判定用。
    // 行き先のホストが分からないもの（t.coのまま）は、まとめて同一ホスト扱いされると
    // 全リンクが連投判定に引っかかるので、hostを返さない＝カウント対象外にする。
    const countableHost = (realHost && realHost !== "t.co") ? realHost : null;
    const safeParsed = countableHost ? parseUrl("https://" + countableHost) : null;

    const result = {
      badges,
      paywall,
      finalUrl: resolved ? realUrl : undefined,
      host: countableHost || undefined,
      // 連投カウントはサブドメインを無視した単位で行う（a1.spam.top / a2.spam.top を同一視）
      domain: countableHost ? registrableDomain(countableHost) : undefined,
      safe: safeParsed ? isSafeHost(safeParsed) : true   // 不明なら安全側（＝連投カウントしない）
    };
    // 一時的な失敗(取得失敗)はキャッシュしない＝次回スクロールでリトライ。漏れの固定化を防ぐ。
    const transient = paywall && paywall.status === "unknown" &&
      (paywall.reason === "fetch-failed" || paywall.reason === "resolve-miss");
    if (!transient) await setCached(key, result);
    return result;
  })();

  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "classify" && msg.item) {
    const tabId = sender && sender.tab ? sender.tab.id : null;

    // ポップアップの動作テストなど、タブ以外からの問い合わせは完全な結果を待って返す
    if (tabId == null) {
      classifyItem(msg.item).then(sendResponse).catch(e => sendResponse({ error: String(e), badges: [] }));
      return true;
    }

    const key = msg.item.href || msg.item.text;
    const hit = memCache.get(key);
    const fresh = hit && Date.now() - hit.ts < CACHE_TTL_MS;

    // 1) まずURLだけの判定を即返す → バッジがすぐ出る
    sendResponse(fresh ? hit.result : classifyQuick(msg.item));

    // 2) 取得が要る判定は終わり次第、差分として送る
    if (!fresh) {
      classifyItem(msg.item)
        .then(result => chrome.tabs.sendMessage(tabId, { type: "classifyUpdate", key, result }))
        .catch(() => {});
    }
    return false;
  }
  if (msg && msg.type === "classifyBatch" && Array.isArray(msg.items)) {
    Promise.all(msg.items.map(it =>
      classifyItem(it).then(r => [it.href || it.text, r]).catch(() => [it.href || it.text, { badges: [] }])
    )).then(pairs => sendResponse(Object.fromEntries(pairs)));
    return true;
  }
  if (msg && msg.type === "clearCache") {
    memCache.clear();
    chrome.storage.local.clear()
      .then(() => chrome.storage.local.set({ [VERSION_KEY]: RULES_VERSION }))
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg && msg.type === "getSettings") {
    sendResponse({ settings, hasAllUrls });
    return false;
  }
});
