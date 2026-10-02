// MV3の起動直後に来るメッセージと、Chromeの非同期応答チャネルを検証する。
// 初期化を待ってから呼ぶ既存のbackgroundテストでは、この競合を再現できない。
import assert from 'node:assert/strict';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const messageListeners = [], settingListeners = [], permissionAdded = [], permissionRemoved = [];
const store = { __lrRulesVersion: 'old-version' };
const oldKey = 'https://linkmisty.com/c/old-cache/';
store[oldKey] = {ts: Date.now(), result: {badges:[], safe:true}};
let savedSettings = {deepScan:true,cat_shortener:false};
let granted = true, fetches = 0, pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log('  ✓ ' + name); };
globalThis.chrome = {
  storage: {
    sync: {get: async defaults => { await delay(20); return {...defaults,...savedSettings}; }},
    local: {
      get: async key => {
        if (key === '__lrRulesVersion') await delay(70);
        if (key == null) return {...store};
        return {[key]:store[key]};
      },
      set: async values => Object.assign(store, values),
      clear: async () => {for (const key of Object.keys(store)) delete store[key];},
      remove: async keys => {for (const key of [keys].flat()) delete store[key];}
    },
    onChanged: {addListener: fn => settingListeners.push(fn)}
  },
  permissions: {
    contains: async () => {await delay(20); return granted;},
    onAdded: {addListener: fn => permissionAdded.push(fn)},
    onRemoved: {addListener: fn => permissionRemoved.push(fn)}
  },
  runtime: {
    getManifest: () => ({version:'startup-test'}),
    onMessage: {addListener: fn => messageListeners.push(fn)},
    onInstalled: {addListener(){}}
  },
  tabs: {sendMessage: async () => {}}
};
globalThis.fetch = async url => {
  fetches++;
  const go = url.includes('lm_go=1');
  return {ok:true,
    url:go ? 'https://www.tiktok.com/ug/incentive/share/pro_scan_code?ug_launch_category=referral' : url,
    headers:{get:()=> 'text/html'},
    text:async()=> go ? '' : `<div onclick="location.href='${url}?lm_go=1'">Card</div>`
  };
};
await import('../src/background.js');
const item = {href:'https://linkmisty.com/c/startup/', text:'linkmisty.com'};
const request = (item, sender = {}) => new Promise(resolve => {
  for (const fn of messageListeners) fn({type:'classify',item},sender,resolve);
});

// awaitせず、モジュール評価直後にタブとpopupの両方から問い合わせる。
let finishUpdate;
const update = new Promise(resolve => {finishUpdate = resolve;});
chrome.tabs.sendMessage = async (tabId,msg) => finishUpdate({tabId,...msg});
let replied = false;
const quick = new Promise(resolve => {
  const keptOpen = messageListeners[0]({type:'classify',item},{tab:{id:7}},r=>{replied=true;resolve(r);});
  ok('タブへの非同期応答チャネルを保持する', keptOpen === true);
});
const cached = request({href:oldKey,text:'linkmisty.com'});
ok('初期化前の既定設定で応答しない', replied === false);
const q = await quick;
ok('簡易判定も保存済みのカテゴリOFFを尊重する', q.partial === true && !q.badges.some(b=>b.kind==='shortener'));
const final = await update;
ok('初回のタブ判定で詳細結果を届ける', final.tabId===7 && final.result.badges.some(b=>b.kind==='bait'));
ok('起動時の旧バージョンの空キャッシュを読む前に破棄する', (await cached).badges.some(b=>b.kind==='invite'));
ok('初回からリンク先を取得する', fetches > 0);
const again = await request(item);
ok('初回の不完全な結果がキャッシュに残らない', again.badges.some(b=>b.kind==='bait'));

savedSettings = {...savedSettings,deepScan:false};
settingListeners.forEach(fn=>fn({deepScan:{newValue:false}},'sync'));
const before = fetches;
const off = await request(item);
ok('取得OFFへの変更後は前のディスクキャッシュを使わない', !off.badges.some(b=>b.kind==='invite'));
ok('取得OFFでは新たなページ取得をしない', fetches === before);
savedSettings = {...savedSettings,deepScan:true};
settingListeners.forEach(fn=>fn({deepScan:{newValue:true}},'sync'));
ok('取得ONへの変更後は空結果を再判定する', (await request(item)).badges.some(b=>b.kind==='bait'));

granted = false;
permissionRemoved.forEach(fn=>fn());
ok('権限が外れた場合も前のキャッシュを使わない', !(await request(item)).badges.some(b=>b.kind==='invite'));
granted = true;
permissionAdded.forEach(fn=>fn());
ok('権限が戻った直後も初期化完了後に再判定する', (await request(item)).badges.some(b=>b.kind==='bait'));
console.log(`\n結果: ${pass} passed, 0 failed`);
