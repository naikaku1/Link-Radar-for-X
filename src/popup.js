// popup.js — 設定UI。カテゴリのON/OFFは rules.js の CATEGORIES から自動生成する
// （＝新しい判定を rules.js に足せば、UIにも自動で出る）。
import {
  CATEGORIES, DEFAULT_SETTINGS, normalizeDomain, normalizeDomainList, USER_LIST_MAX
} from "./rules.js";

const EMOJI = {
  paid: "🔒", affiliate: "💰", invite: "🎁", shortener: "🔗", pr: "📣", farm: "🏭",
  adult: "🔞", spam: "🚨", download: "📦", caution: "⚠️",
  ads: "📊", login: "🔑"
};

const catsEl = document.getElementById("cats");
const deepEl = document.getElementById("deepScan");

chrome.storage.sync.get(DEFAULT_SETTINGS, (v) => {
  const s = { ...DEFAULT_SETTINGS, ...v };

  // --- カテゴリのチェックボックス ---
  for (const c of CATEGORIES) {
    const label = document.createElement("label");
    label.className = "row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s["cat_" + c.kind] !== false;
    cb.addEventListener("change", () => {
      chrome.storage.sync.set({ ["cat_" + c.kind]: cb.checked });
    });
    const emo = document.createElement("span");
    emo.className = "emo";
    emo.textContent = EMOJI[c.kind] || "•";
    const txt = document.createElement("span");
    txt.textContent = c.label + (c.needsFetch ? "（要ページ取得）" : "");
    label.append(cb, emo, txt);
    catsEl.appendChild(label);
  }

  // --- リンク先の取得（既定ON）---
  deepEl.checked = s.deepScan !== false;
});

// ------------------------------------------------------------------
// 自分で登録したドメイン
//   caution … ⚠️を出したいドメイン（同梱リストではなく利用者の設定なので断定してよい）
//   exclude … 誤検出されたので判定対象から完全に外したいドメイン
//   公開後に利用者が打てる唯一の手なので、消すのもワンクリックでできるようにする。
// ------------------------------------------------------------------
const domainEl = document.getElementById("userDomain");
const errEl = document.getElementById("userErr");
const LIST_EL = { userCaution: document.getElementById("listCaution"),
                  userExclude: document.getElementById("listExclude") };

function showErr(msg) {
  errEl.textContent = msg || "";
  if (msg) setTimeout(() => { if (errEl.textContent === msg) errEl.textContent = ""; }, 4000);
}

function renderList(key, domains) {
  const el = LIST_EL[key];
  el.replaceChildren();
  if (!domains.length) {
    const s = document.createElement("span");
    s.className = "empty";
    s.textContent = "（なし）";
    el.appendChild(s);
    return;
  }
  for (const d of domains) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(d);
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = d + " を削除";
    x.addEventListener("click", () => removeDomain(key, d));
    chip.appendChild(x);
    el.appendChild(chip);
  }
}

/**
 * 判定側 (setUserRules) と同じ正規化を通して読む。
 * そうしないと「表示されている文字列」と「実際に効いている値」がずれる
 * （別端末からsyncで来た値や、古いバージョンが書いた値が生のまま入りうる）。
 */
function readLists() {
  return new Promise(res => {
    chrome.storage.sync.get({ userCaution: [], userExclude: [] }, v => {
      res({
        userCaution: normalizeDomainList(v.userCaution),
        userExclude: normalizeDomainList(v.userExclude)
      });
    });
  });
}

async function addDomain(key) {
  const d = normalizeDomain(domainEl.value);
  if (!d) { showErr("ドメインとして読めませんでした（例: example.com）"); return; }

  const lists = await readLists();
  const other = key === "userCaution" ? "userExclude" : "userCaution";
  if (lists[key].includes(d)) { showErr(`${d} は既に登録済みです`); return; }
  if (lists[key].length >= USER_LIST_MAX) { showErr(`登録は${USER_LIST_MAX}件までです`); return; }

  // 同じドメインを「注意」と「除外」の両方に入れると挙動が矛盾するので、片方から外す
  const next = { [key]: [...lists[key], d] };
  if (lists[other].includes(d)) next[other] = lists[other].filter(x => x !== d);

  chrome.storage.sync.set(next, () => {
    if (chrome.runtime.lastError) { showErr("保存できませんでした: " + chrome.runtime.lastError.message); return; }
    domainEl.value = "";
    showErr("");
    refreshLists();
  });
}

async function removeDomain(key, d) {
  const lists = await readLists();
  chrome.storage.sync.set({ [key]: lists[key].filter(x => x !== d) }, refreshLists);
}

async function refreshLists() {
  const lists = await readLists();
  renderList("userCaution", lists.userCaution);
  renderList("userExclude", lists.userExclude);
}

document.getElementById("addCaution").addEventListener("click", () => addDomain("userCaution"));
document.getElementById("addExclude").addEventListener("click", () => addDomain("userExclude"));
domainEl.addEventListener("keydown", (e) => { if (e.key === "Enter") addDomain("userCaution"); });
refreshLists();

// ------------------------------------------------------------------
// 動作テスト: URLを background に投げて、Xで出るのと同じ判定結果を見る
// ------------------------------------------------------------------
const LABELS = Object.fromEntries(CATEGORIES.map(c => [c.kind, c.label]));
const outEl = document.getElementById("testOut");
const urlEl = document.getElementById("testUrl");

const PRESETS = [
  ["🔞 アダルト",  "https://missav.com/ja/abc-123"],
  ["💰 アフィ",    "https://www.amazon.co.jp/dp/B0CXXX?tag=test-22"],
  ["🎁 招待",      "https://lite.tiktok.com/t/ZSabcdefg/"],
  ["🔗 短縮",      "https://bit.ly/3abcXYZ"],
  ["📦 DL",        "https://cdn.example.info/app.apk"],
  ["🔒 有料(日経)", "https://www.nikkei.com/article/DGXZQOUB23B6M0T20C26A7000000/"],
  ["🏭 まとめ",    "https://togetter.com/li/1000000"],
  ["🔒 有料(実物)", "https://www.asahi.com/"],
  ["✅ 普通",      "https://gigazine.net/"]
];

const presetsEl = document.getElementById("presets");
for (const [name, url] of PRESETS) {
  const b = document.createElement("button");
  b.textContent = name;
  b.addEventListener("click", () => { urlEl.value = url; runTest(); });
  presetsEl.appendChild(b);
}

function runTest() {
  const url = urlEl.value.trim();
  if (!url) return;
  outEl.textContent = "判定中…";
  // content script と同じ形で投げる（href と表示テキストの両方にURLを入れる）
  chrome.runtime.sendMessage({ type: "classify", item: { href: url, text: url } }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      outEl.textContent = "エラー: " + (chrome.runtime.lastError?.message || "応答なし");
      return;
    }
    outEl.replaceChildren();
    if (resp.excluded) {
      const s = document.createElement("div");
      s.className = "none";
      s.textContent = "⛔ 除外登録済みのドメインです（判定しません）";
      outEl.appendChild(s);
      return;
    }
    if (!resp.badges || !resp.badges.length) {
      const s = document.createElement("div");
      s.className = "none";
      s.textContent = "✅ バッジなし（普通のリンク）";
      outEl.appendChild(s);
    } else {
      for (const b of resp.badges) {
        const pill = document.createElement("span");
        pill.className = "b";
        pill.textContent = LABELS[b.kind] || b.kind;
        outEl.appendChild(pill);
        const why = document.createElement("div");
        why.className = "why";
        why.textContent = "└ " + b.label;
        outEl.appendChild(why);
      }
    }
    const meta = document.createElement("div");
    meta.className = "why";
    const bits = [];
    if (resp.host) bits.push("host: " + resp.host);
    if (resp.paywall) bits.push("paywall: " + resp.paywall.status + (resp.paywall.reason ? `(${resp.paywall.reason})` : ""));
    if (resp.finalUrl) bits.push("解決先あり");
    meta.textContent = bits.join(" / ");
    outEl.appendChild(meta);
  });
}

// 判定結果は6時間キャッシュされる。ルールを直した直後や、判定がおかしいときに手動で捨てる。
document.getElementById("clearCache").addEventListener("click", (e) => {
  chrome.runtime.sendMessage({ type: "clearCache" }, () => {
    e.target.textContent = "消しました（Xのタブを再読み込み）";
    setTimeout(() => { e.target.textContent = "判定キャッシュを消す"; }, 2500);
  });
});

document.getElementById("testBtn").addEventListener("click", runTest);
urlEl.addEventListener("keydown", (e) => { if (e.key === "Enter") runTest(); });

deepEl.addEventListener("change", () => {
  chrome.storage.sync.set({ deepScan: deepEl.checked });
});
