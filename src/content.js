// content.js — x.com / twitter.com のタイムラインで、リンク単位に判定してカードへ表示する。
// ※ MV3のcontent scriptはESモジュール不可のため、ここだけは自己完結（rules.jsをimportしない）。

// cover:true  … 画像/カードを覆う（開く前に必ず気付いてほしいもの）
// cover:false … 覆わず小さいバッジだけ（知っておくと良いが、危険ではないもの）
const BADGE = {
  caution:   { emoji: "⚠️", text: "注意",   cover: true,  cls: "lr-caution",   tip: "自分で登録したドメイン" },
  adult:     { emoji: "🔞", text: "R18",    cover: true,  cls: "lr-adult",     tip: "アダルトサイトの可能性" },
  spam:      { emoji: "🚨", text: "連投",   cover: true,  cls: "lr-spam",      tip: "同じリンクが複数のポストに投稿されています" },
  bait:      { emoji: "🎣", text: "誘導",   cover: true,  cls: "lr-bait",      tip: "中継カードの確認できた行き先" },
  paid:      { emoji: "🔒", text: "有料",   cover: true,  cls: "lr-paid",      tip: "有料記事の可能性" },
  download:  { emoji: "📦", text: "DL",     cover: true,  cls: "lr-download",  tip: "クリックでファイルが直接ダウンロードされます" },
  ads:       { emoji: "📊", text: "広告多", cover: false, cls: "lr-ads",       tip: "広告枠が多いページ" },
  login:     { emoji: "🔑", text: "登録",   cover: false, cls: "lr-login",     tip: "閲覧に登録/ログインが必要" },
  farm:      { emoji: "🏭", text: "まとめ", cover: false, cls: "lr-farm",      tip: "まとめ/転載サイト" },
  pr:        { emoji: "📣", text: "広告",   cover: false, cls: "lr-pr",        tip: "PR/広告・広告ネットワーク経由" },
  affiliate: { emoji: "💰", text: "アフィ", cover: false, cls: "lr-affiliate", tip: "アフィリエイトリンク" },
  invite:    { emoji: "🎁", text: "招待",   cover: false, cls: "lr-invite",    tip: "招待/紹介リンク(登録すると投稿者に報酬が入ります)" },
  shortener: { emoji: "🔗", text: "短縮",   cover: false, cls: "lr-shortener", tip: "短縮URL(行き先が隠れています)" }
};

// 表示優先度（BADGEの定義順＝重要度の高い順）。上限を超えたら後ろを落とす。
const BADGE_ORDER = Object.keys(BADGE);

const SPAM_REPEAT_MIN = 3;   // リプ欄で同一ドメインがこの件数以上のポストに出たら「連投」

let settings = { maxBadges: 4, cat_spam: true };
try {
  chrome.storage.sync.get({ maxBadges: 4, cat_spam: true }, v => {
    if (v) settings = { ...settings, ...v };
  });
} catch {}

// カード内に追加した自分のバッジをリンクの表示テキストに混ぜない。
function readLinkText(anchor) {
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement?.closest(".lr-inline, .lr-overlay, .lr-cover")
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent);
  return parts.join(" ").trim();
}

/**
 * テキストから「URLらしいトークン」を取り出す。
 * 引用元コンテナ自体がリンクのため、Xは引用元本文のURLを <a> にせず素のテキストで描くことがある。
 * その場合アンカーが1つも無いので、テキストから拾って判定に回す。
 * ※ 空白区切りで「先頭から末尾までがホスト(+パス)」のトークンだけを採る
 *   （見出しを繋げると日本語がホスト名扱いされて誤判定になるため。classifier.js と同じ考え方）
 */
function urlLikeToken(text) {
  if (!text) return null;
  for (const raw of String(text).split(/\s+/)) {
    const tok = raw.replace(/[……]+$/, "").replace(/[、。，．,)\]】」』〉>]+$/, "");
    if (/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(tok)) return tok;
  }
  return null;
}

function isExternalAnchor(a) {
  const href = a.getAttribute("href") || "";
  if (!href) return false;
  let u;
  try { u = new URL(a.href, location.href); } catch { return false; }
  const h = u.hostname.toLowerCase();
  if (h === "t.co") return true;
  if (/(^|\.)(x\.com|twitter\.com|mobile\.twitter\.com)$/.test(h)) return false;
  return /^https?:$/.test(u.protocol);
}

function sortAndCap(badges) {
  const out = [...badges].sort(
    (a, b) => BADGE_ORDER.indexOf(a.kind) - BADGE_ORDER.indexOf(b.kind)
  );
  const cap = Number(settings.maxBadges) || 4;
  return out.slice(0, cap);
}

// ------------------------------------------------------------------
// 描画先の決定
//
// 「引用元コンテナを正しく見つける」ことに依存すると、Xのマークアップ変更で簡単に壊れる。
// 代わりに **リンクごと** に「そのリンクが属する画像/カード」を探す方式にしてある。
// 引用元のカードリンクは、アンカー自身がそのカードの中にあるので、引用ポストかどうかを
// 判定しなくても自然に引用元のカードが描画先になる。
// ------------------------------------------------------------------
// リンクカード＝それ自体がリンク。クリックすると外部サイトに飛ぶ。
// このリンクを判定したのだから、ここを覆うのは常に正しい。
const LINK_CARD_SEL = '[data-testid="card.wrapper"], ' +
                      '[data-testid="card.layoutLarge.media"], [data-testid="card.layoutSmall.media"]';

// 投稿者が添付した画像/動画。**リンクとは別物**。
// 実機で確認: tweetPhoto のアンカーは /user/status/<id>/photo/1 で、Xの画像ビューアに飛ぶだけ。
// 本文にリンクがあるからといってこの画像を覆うと、無関係な写真を隠すことになる
// （実例: ニュース媒体の「本文にリンク＋別途スクショを添付」したポスト）。
const MEDIA_SEL = '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], ' +
                  '[data-testid="previewInterstitial"]';

const CARD_SEL = LINK_CARD_SEL + ", " + MEDIA_SEL;

// 添付画像まで覆ってよいカテゴリ。
// 「その画像自体が誘導の一部」であるものに限る。リプ欄のアダルト誘導や連投スパムは
// 釣り画像＋本文リンクの組み合わせが典型で、画像を覆うことにこそ意味がある。
// 一方 🔒有料 や 📦DL は「リンク先の性質」の話なので、投稿者の写真を隠す理由が無い。
const BAIT_COVER_KINDS = new Set(["adult", "spam", "caution"]);

/**
 * 引用元ブロックを探す。
 *
 * Xは引用元を `div[role="link"]` で包むが、それに依存すると属性が変わった瞬間に
 * 引用元が丸ごと処理対象から外れる（実際にこれで表示できていなかった）。
 * そこで属性に依存しない構造的な手掛かりを第2の方法として持たせる:
 *   「作者表示(User-Name)が2つある＝引用あり」で、
 *   「2つ目の作者表示を含み、1つ目の作者表示を含まない最大のブロック」が引用元。
 * @returns {Element|null}
 */
function findQuoteRoot(tweet) {
  if (tweet.__lrQuote !== undefined) return tweet.__lrQuote;   // 今回の変更確認の中では一度だけ計算

  let found = null;

  // 方法1: role="link" かつ中に作者表示を持つブロック
  for (const d of tweet.querySelectorAll('div[role="link"]')) {
    if (d.querySelector('[data-testid="User-Name"]')) { found = d; break; }
  }

  // 方法2: 作者表示の位置関係から構造的に割り出す（属性に依存しない）
  if (!found) {
    const names = tweet.querySelectorAll('[data-testid="User-Name"]');
    if (names.length >= 2) {
      const first = names[0];
      let el = names[1].parentElement;
      while (el && el !== tweet) {
        if (!el.contains(first)) found = el;   // 引用元だけを含む最大のブロックまで広げる
        el = el.parentElement;
      }
    }
  }

  tweet.__lrQuote = found;
  return found;
}

/** node が引用元ブロックの中にあるなら、そのブロックを返す */
function quoteRootOf(node, tweet) {
  const q = findQuoteRoot(tweet);
  return q && q !== node && q.contains(node) ? q : null;
}

/**
 * このリンクの表示先（覆う対象の画像/カード）を返す。無ければ null（＝リンク脇に出す）。
 */
function renderTargetFor(anchor, tweet) {
  // 1) アンカー自身がカード/画像の中にある＝カードリンク。引用元でも本体でもこれで当たる。
  const inCard = anchor.closest(CARD_SEL);
  if (inCard) return inCard;

  // 2) 本文中のテキストリンク。引用元の中のリンクなら、引用元の中のカードだけを対象にする。
  const quote = quoteRootOf(anchor, tweet);
  if (quote) return quote.querySelector(LINK_CARD_SEL);

  // 3) 本体のテキストリンク。**リンクカードだけ**を対象にする。
  //    添付画像はこのリンクとは無関係なので、ここでは選ばない（BAIT_COVER_KINDS のときだけ別途使う）。
  //    引用元のカードを誤って覆わないよう、引用元の外にあるものに限る。
  for (const c of tweet.querySelectorAll(LINK_CARD_SEL)) {
    if (!quoteRootOf(c, tweet)) return c;
  }
  return null;
}

/**
 * 「釣り画像」として覆ってよい添付メディアを探す。
 * リンクカードが無く、かつ 🔞/🚨/⚠️ が出るときだけ使う。
 */
function baitMediaFor(anchor, tweet) {
  const quote = quoteRootOf(anchor, tweet);
  if (quote) return quote.querySelector(MEDIA_SEL);
  for (const m of tweet.querySelectorAll(MEDIA_SEL)) {
    if (!quoteRootOf(m, tweet)) return m;
  }
  return null;
}

// ------------------------------------------------------------------
// 描画
// ------------------------------------------------------------------
function makePill(bd, small) {
  const b = BADGE[bd.kind];
  if (!b) return null;
  const el = document.createElement("span");
  el.className = "lr-pill " + b.cls + (small ? " lr-pill-sm" : "");
  // 絵文字とラベルは別のスパンにする。まとめて1つのテキストノードにすると、
  // 絵文字フォントの指定がラベルにも効いて "R18" の数字の字形が崩れる。
  const emo = document.createElement("span");
  emo.className = "lr-pill-emo";
  emo.textContent = b.emoji;
  el.append(emo, bd.kind === "bait" && bd.label ? bd.label : b.text);
  el.title = bd.label ? `${b.tip}｜${bd.label}` : b.tip;
  return el;
}

/** 覆う対象がある場合の描画。cover対象が無ければ画像は覆わずバッジだけ重ねる。 */
function renderOnCard(card, covers, pills, isQuote) {
  const cs = getComputedStyle(card);
  if (cs.position === "static") card.style.position = "relative";

  if (!covers.length) {
    // 短縮/アフィ等だけ → 画像は覆わない
    const ov = document.createElement("div");
    ov.className = "lr-overlay";
    for (const bd of pills) { const p = makePill(bd); if (p) ov.appendChild(p); }
    if (ov.childNodes.length) card.appendChild(ov);
    return;
  }

  const top = BADGE[covers[0].kind];
  const cover = document.createElement("div");
  cover.className = "lr-cover " + top.cls + (isQuote ? " lr-cover-quote" : "");

  for (const bd of covers) {
    const b = BADGE[bd.kind];
    const row = document.createElement("div");
    row.className = "lr-cover-row";
    row.title = bd.label ? `${b.tip}｜${bd.label}` : b.tip;
    const ico = document.createElement("span");
    ico.className = "lr-cover-ico";
    ico.textContent = b.emoji;
    const txt = document.createElement("span");
    txt.className = "lr-cover-txt";
    txt.textContent = bd.kind === "bait" && bd.label ? bd.label : b.text;
    row.append(ico, txt);
    cover.appendChild(row);
  }
  if (pills.length) {
    const sub = document.createElement("div");
    sub.className = "lr-cover-sub";
    for (const bd of pills) { const p = makePill(bd, true); if (p) sub.appendChild(p); }
    cover.appendChild(sub);
  }
  card.appendChild(cover);
}

function render(target, anchor, badges, tweet) {
  const shown = sortAndCap(badges || []);
  const covers = shown.filter(b => BADGE[b.kind] && BADGE[b.kind].cover);
  const pills = shown.filter(b => !covers.includes(b));

  // リンクカードが無いポスト（本文にリンク＋添付画像、など）。
  // 添付画像はリンクとは別物なので原則は「リンクの脇にバッジ」だが、
  // 釣り画像そのものを見せたくないカテゴリのときだけ画像を覆う。
  if (!target && covers.some(b => BAIT_COVER_KINDS.has(b.kind))) {
    target = baitMediaFor(anchor, tweet);
  }

  // 前回の描画を消す。
  // 描画先は「リンク脇 → 画像の上」に後から変わりうる（画像が遅れて挿入されるため）ので、
  // 今回使う側だけでなく両方を消さないと、リンク脇の小バッジが残ったまま画像も覆われる。
  if (target) target.querySelectorAll(":scope > .lr-cover, :scope > .lr-overlay").forEach(n => n.remove());
  const inlineHost = anchor && (anchor.parentElement || anchor);
  if (inlineHost && inlineHost.querySelectorAll) {
    inlineHost.querySelectorAll(":scope > .lr-inline").forEach(n => n.remove());
  }

  if (!shown.length) return;
  if (target) {
    renderOnCard(target, covers, pills, !!quoteRootOf(target, tweet));
  } else {
    const wrap = document.createElement("span");
    wrap.className = "lr-inline";
    for (const bd of shown) { const p = makePill(bd); if (p) wrap.appendChild(p); }
    if (wrap.childNodes.length) inlineHost.appendChild(wrap);
  }
}

// ------------------------------------------------------------------
// 連投リンクの検出（リプ欄でのアダルト誘導/スパムの主要な手口）
//   個々のURLは無害に見えても、「同じ行き先が別々のリプに何件も出る」こと自体が事実として異常。
//   言語や文面に依存しないので、文言を変えてくるスパムにも効く。
//   ※ 会話ページ(/status/)限定。TLでバズ記事が何度も流れてくるのは正常なので対象外。
//   ※ サブドメインを回して回避されないよう、登録可能ドメイン単位で数える（background側で算出）。
// ------------------------------------------------------------------
const domainRecords = new Map();   // domain -> [{target, anchor, badges, tweet}]

function isConversationPage() {
  return /\/status\/\d+/.test(location.pathname);
}

function trackForSpam(rec) {
  if (settings.cat_spam === false) return;
  if (!isConversationPage() || !rec.domain || rec.safe) return;

  // 引用元のリンクは数えない。
  //
  // 引用タブ(/status/<id>/quotes)を開くと、並んでいる全ポストが**同じ引用元**を抱えている。
  // 引用元の中のリンクをそのまま数えると、1つの投稿がポスト数ぶん重複カウントされて
  // 必ず閾値を超え、無関係な引用元に🚨連投が付く。会話ページで同じポストが何度も
  // 引用されている場合も同じことが起きる。
  // 検出したいのは「別々の人が同じリンクを貼っている」ことなので、
  // 同一投稿の複製である引用元は、そもそも証拠にならない。
  if (rec.fromQuote) return;

  let list = domainRecords.get(rec.domain);
  if (!list) { list = []; domainRecords.set(rec.domain, list); }
  if (list.some(r => r.tweet === rec.tweet)) return;
  list.push(rec);

  if (list.length < SPAM_REPEAT_MIN) return;

  // 閾値到達 → そのドメインの全ポスト（過去に描画済みのものも含む）に付け直す
  const label = `${rec.domain} が ${list.length} 件のポストに出現`;
  for (const r of list) {
    if (!r.tweet.isConnected) continue;
    const existing = r.badges.find(b => b.kind === "spam");
    if (existing) existing.label = label;
    else r.badges.push({ kind: "spam", label });
    render(r.target, r.anchor, r.badges, r.tweet);
  }
}

// URL変更はDOM監視・判定・応答の各入口で確認する。1秒後の確認が新しい
// ページの pending を消すと、先に届いた簡易判定のまま詳細判定が失われる。
let lastPath = location.pathname;
let routeRevision = 0;
function syncRoute() {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  routeRevision++;
  domainRecords.clear();
  prunePending();
  scan(document);
}
setInterval(syncRoute, 1000); // DOMが変わらない履歴操作の補助。判定開始は待たせない。
addEventListener("popstate", syncRoute);

const tweetStates = new WeakMap();
function prunePending(tweet) {
  for (const [key, slots] of pending) {
    const alive = slots.filter(s => s.tweet.isConnected && s.tweet !== tweet);
    if (alive.length) pending.set(key, alive); else pending.delete(key);
  }
}
function sameLink(a, b) {
  return a.anchor === b.anchor && a.target === b.target && a.media === b.media &&
    a.fromQuote === b.fromQuote && a.item.text === b.item.text;
}

// ------------------------------------------------------------------
// ポスト処理
// ------------------------------------------------------------------
function processTweet(tweet) {
  syncRoute();
  if (!tweet.isConnected) return;
  // 引用元も遅れて挿入・差し替えられるため、変更を確認するたびに取り直す。
  delete tweet.__lrQuote;
  const anchors = [...tweet.querySelectorAll("a[href]")].filter(isExternalAnchor);

  // 同じリンクが「カードのアンカー」と「本文中のテキストアンカー」で二重に出ることがあるので、
  // href ごとに1つへまとめる（画像がある方＝カードを優先）。
  const byHref = new Map();
  for (const a of anchors) {
    const target = renderTargetFor(a, tweet);
    const text = readLinkText(a);
    // Xのカード見出しと「example.comから」は別々のアンカーになりうる。
    // 描画先はカードを選びつつ、同じhrefの表示ドメインも簡易判定へ渡す。
    const displayUrl = urlLikeToken(text.replace(/から$/, ""));
    const fromQuote = !!quoteRootOf(a, tweet);
    const prev = byHref.get(a.href);
    if (!prev) { byHref.set(a.href, { anchor: a, target, fromQuote, text: displayUrl || text, displayUrl }); continue; }
    if (!prev.target && target) { prev.anchor = a; prev.target = target; }
    if (!prev.displayUrl && displayUrl) { prev.text = displayUrl; prev.displayUrl = displayUrl; }
    // 本体にも同じリンクがあるなら、それは引用元由来ではない＝連投カウントの対象
    if (!fromQuote) prev.fromQuote = false;
  }

  // 引用元にアンカーが1つも無い場合の補完。
  // 引用元コンテナ自体がリンクなので、Xは引用元本文のURLを <a> にせず素のテキストで描くことがある。
  // その場合ここで拾わないと、引用元は永久に判定されない。
  const quote = findQuoteRoot(tweet);
  if (quote && !anchors.some(a => quote.contains(a))) {
    const tok = urlLikeToken(quote.innerText || quote.textContent || "");
    if (tok) {
      byHref.set("text:" + tok, {
        anchor: quote,                                  // 描画先が無いときの挿入位置
        target: quote.querySelector(CARD_SEL) || quote, // 画像が無ければ引用元ブロック自体を覆う
        textOnly: tok,
        fromQuote: true                                 // 引用元そのものなので連投カウントしない
      });
    }
  }

  const next = new Map();
  for (const u of byHref.values()) {
    const item = u.textOnly
      ? { href: "", text: u.textOnly }
      : { href: u.anchor.href, text: u.text };
    next.set(item.href || item.text, { ...u, item, tweet,
      media: baitMediaFor(u.anchor, tweet), fromQuote: !!u.fromQuote });
  }
  const identity = tweet.querySelector('time')?.closest('a')?.getAttribute('href') || "";
  const prev = tweetStates.get(tweet);
  if (prev && prev.route === routeRevision && prev.identity === identity &&
      prev.links.size === next.size && [...next].every(([k, v]) =>
        prev.links.has(k) && sameLink(prev.links.get(k), v))) return;

  if (prev) {
    prunePending(tweet);
    tweet.querySelectorAll(".lr-cover, .lr-overlay, .lr-inline").forEach(n => n.remove());
    for (const [domain, records] of domainRecords) {
      const alive = records.filter(r => r.tweet !== tweet && r.tweet.isConnected);
      if (alive.length) domainRecords.set(domain, alive); else domainRecords.delete(domain);
    }
  }
  const state = { links: next, route: routeRevision, identity };
  tweetStates.set(tweet, state);
  tweet.dataset.lrDone = next.size ? "1" : ""; // 状態表示用。再処理を止めるゲートにはしない。

  for (const [key, slot] of next) {
    const old = prev?.links.get(key);
    if (old && old.item.text === slot.item.text && !old.failed) {
      slot.result = old.result;
      if (old.inFlight) { slot.inFlight = true; addPending(key, slot); }
      if (slot.result) displayResult(slot, slot.result);
      continue;
    }
    requestClassification(key, slot);
  }
}

function requestClassification(key, slot) {
  slot.inFlight = true;
  slot.failed = false;
  addPending(key, slot);
  try {
    chrome.runtime.sendMessage({ type: "classify", item: slot.item }, resp => {
      if (chrome.runtime.lastError || !resp) { retrySlot(key, slot); return; }
      applyResult(key, resp);
    });
  } catch { retrySlot(key, slot); }
}

function retrySlot(key, slot) {
  const current = tweetStates.get(slot.tweet)?.links.get(key);
  if (!current || !current.tweet.isConnected) return;
  current.inFlight = false;
  current.failed = true;
  // 一時的な通信失敗だけを再試行する。失敗中もURLから分かるバッジは残す。
  if (current.retryTimer) return;
  current.retries = (current.retries || 0) + 1;
  if (current.retries > 2) return;
  current.retryTimer = setTimeout(() => {
    current.retryTimer = null;
    if (tweetStates.get(current.tweet)?.links.get(key) === current && current.tweet.isConnected)
      requestClassification(key, current);
  }, 1000 * current.retries);
}

// ------------------------------------------------------------------
// 判定結果の適用
//   backgroundは2段階で返す:
//     1回目 … URLだけで分かる分（即座。partial:true）
//     2回目 … リンク先を取得して分かる分（classifyUpdate で後から届く）
//   こうしないと、取得が終わるまでバッジが1つも出ず「遅い」と感じる。
// ------------------------------------------------------------------
// key -> [{target, anchor, tweet}, ...]
//
// ここは必ず配列にすること。リプ欄では「同じURLが複数のポストに貼られる」のが普通
// （それ自体が連投スパムの手口なので、まさに判定したいケース）。
// key ごとに1つしか覚えないと、同じURLの2件目以降が控えを上書きし、
// 先に処理されたポスト＝リプ欄の上のほうが描画されないまま残っていた。
// backgroundへの問い合わせは全ポスト分が同期的に発行されて応答だけが後から来るため、
// 「最後に登録したポストにだけバッジが付く」という形で出る。
const pending = new Map();

function addPending(key, slot) {
  let list = pending.get(key);
  if (!list) { list = []; pending.set(key, list); }
  // 同じポストの同じ位置を二重に持たない（リトライで再処理されたとき用）
  const i = list.findIndex(s => s.tweet === slot.tweet && s.anchor === slot.anchor);
  if (i >= 0) list[i] = slot; else list.push(slot);
}

function displayResult(slot, resp) {
  // リンクの位置とカードは processTweet で取り直す。応答直前の差し替えにも対応する。
  if (slot.anchor.tagName === "A") slot.target = renderTargetFor(slot.anchor, slot.tweet);
  const badges = resp.badges ? [...resp.badges] : [];
  render(slot.target, slot.anchor, badges, slot.tweet);
  if (!resp.partial) trackForSpam({ ...slot, badges,
    domain: resp.domain, safe: !!resp.safe });
}

function applyResult(key, resp) {
  syncRoute();
  const list = pending.get(key);
  if (!list?.length) return;
  const alive = list.filter(s => s.tweet.isConnected && s.anchor.isConnected &&
    tweetStates.get(s.tweet)?.links.get(key) === s);
  const reason = resp.paywall?.reason;
  const failed = resp.retryable || reason === "fetch-failed" || reason === "resolve-miss" || !!resp.error;
  for (const slot of alive) {
    // 最終結果の後に簡易結果が届く順序でも、表示を簡易判定に戻さない。
    if (resp.partial && slot.result && !slot.result.partial) continue;
    slot.result = resp;
    slot.inFlight = !!resp.partial;
    displayResult(slot, resp);
    if (failed) retrySlot(key, slot);
  }
  if (resp.partial && alive.length) pending.set(key, alive);
  else pending.delete(key);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "classifyUpdate" && msg.key) applyResult(msg.key, msg.result || {});
});

// 交差監視を継続して、見えているポストの内部変更はmicrotaskでまとめて処理する。
// DOMの通常更新でgetBoundingClientRect等を繰り返す必要はない。
const visibleTweets = new WeakSet();
const observedTweets = new WeakSet();
const queuedTweets = new Set();
function queueTweet(tweet) {
  if (!observedTweets.has(tweet)) {
    observedTweets.add(tweet);
    io.observe(tweet);
  }
  if (!visibleTweets.has(tweet) || queuedTweets.has(tweet)) return;
  queuedTweets.add(tweet);
  queueMicrotask(() => {
    queuedTweets.delete(tweet);
    processTweet(tweet);
  });
}
const io = new IntersectionObserver(entries => {
  syncRoute();
  for (const e of entries) {
    if (e.isIntersecting) { visibleTweets.add(e.target); processTweet(e.target); }
    else visibleTweets.delete(e.target);
  }
}, { rootMargin: "150px" });

const TWEET_SEL = 'article[data-testid="tweet"], article[role="article"]';
const RADAR_UI_SEL = ".lr-inline, .lr-overlay, .lr-cover";
function scan(root) {
  const base = root instanceof Element ? root : document;
  // 内部のリンク/カードだけが追加された場合も、所属するポストを拾う。
  if (base instanceof Element) {
    const tweet = base.closest(TWEET_SEL);
    if (tweet) queueTweet(tweet);
  }
  base.querySelectorAll(TWEET_SEL).forEach(queueTweet);
}
function retire(root) {
  if (!(root instanceof Element)) return;
  const tweets = root.matches(TWEET_SEL) ? [root] : [...root.querySelectorAll(TWEET_SEL)];
  for (const tweet of tweets) {
    if (tweet.isConnected) continue;
    io.unobserve(tweet);
    observedTweets.delete(tweet);
    visibleTweets.delete(tweet);
    queuedTweets.delete(tweet);
    prunePending(tweet);
    // Xが同じarticleを再利用するとき、失ったpendingをinFlightのまま継承しない。
    // 再挿入時は登録し直す。background側のキャッシュ/実行中リクエストは共有される。
    tweetStates.delete(tweet);
  }
}

const mo = new MutationObserver(muts => {
  syncRoute();
  const changed = new Set();
  for (const m of muts) {
    const target = m.target instanceof Element ? m.target : m.target.parentElement;
    if (!target || target.closest(RADAR_UI_SEL)) continue;
    if (m.type === "childList") {
      const nodes = [...m.addedNodes, ...m.removedNodes];
      // 自分が追加/削除したバッジだけの変更は再判定の原因にしない。
      if (nodes.length && nodes.every(n => n instanceof Element && n.matches(RADAR_UI_SEL))) continue;
      const tweet = target.closest(TWEET_SEL);
      if (tweet) changed.add(tweet);
      for (const n of m.addedNodes) if (n instanceof Element && !n.matches(RADAR_UI_SEL)) scan(n);
      for (const n of m.removedNodes) retire(n);
    } else if (m.type === "attributes" || target.closest('a, [data-testid="tweetText"], div[role="link"]')) {
      const tweet = target.closest(TWEET_SEL);
      if (tweet) changed.add(tweet);
    }
  }
  changed.forEach(queueTweet);
});
mo.observe(document.body, { childList: true, subtree: true,
  attributes: true, attributeFilter: ["href"], characterData: true });
scan(document);
