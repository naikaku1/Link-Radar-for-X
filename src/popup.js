// popup.js — 設定UI。カテゴリのON/OFFは rules.js の CATEGORIES から自動生成する
// （＝新しい判定を rules.js に足せば、UIにも自動で出る）。
import { CATEGORIES, DEFAULT_SETTINGS } from "./rules.js";

const EMOJI = {
  paid: "🔒", affiliate: "💰", shortener: "🔗", pr: "📣", farm: "🏭",
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

  // --- バッジの見せ方 ---
  document.querySelectorAll('input[name="badgeStyle"]').forEach(r => {
    r.checked = (r.value === s.badgeStyle);
    r.addEventListener("change", () => {
      if (r.checked) chrome.storage.sync.set({ badgeStyle: r.value });
    });
  });

  // --- リンク先の取得（既定ON）---
  deepEl.checked = s.deepScan !== false;
});

// ------------------------------------------------------------------
// 動作テスト: URLを background に投げて、Xで出るのと同じ判定結果を見る
// ------------------------------------------------------------------
const LABELS = Object.fromEntries(CATEGORIES.map(c => [c.kind, c.label]));
const outEl = document.getElementById("testOut");
const urlEl = document.getElementById("testUrl");

const PRESETS = [
  ["🔞 アダルト",  "https://missav.com/ja/abc-123"],
  ["💰 アフィ",    "https://www.amazon.co.jp/dp/B0CXXX?tag=test-22"],
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

document.getElementById("testBtn").addEventListener("click", runTest);
urlEl.addEventListener("keydown", (e) => { if (e.key === "Enter") runTest(); });

deepEl.addEventListener("change", () => {
  chrome.storage.sync.set({ deepScan: deepEl.checked });
});
