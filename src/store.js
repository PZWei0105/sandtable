/* 沙盤 — 存檔：全部只存在這支手機（localStorage 的 sandtable.v1），不會送到任何伺服器。
   注意：冷眼、玩真的…都在同一個網址底下，共用同一個儲存空間；沙盤只碰自己的 key，絕不讀寫別的 App 的資料。
   寫入一律「先讀最新的、再改、再存」，好幾個分頁同時開也不會蓋掉彼此。 */
import { DEFAULT_FEES } from './rules.js';

const KEY = 'sandtable.v1';
export const DEFAULT_SETTINGS = {
  sound: true, haptics: true, fx: true, quality: 'auto', fees: { ...DEFAULT_FEES }, ignite: true,
};

function blank() {
  return { v: 1, cur: null, runs: {}, order: [], settings: { ...DEFAULT_SETTINGS }, seq: 0 };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const db = JSON.parse(raw);
    if (!db || db.v !== 1 || typeof db.runs !== 'object') return blank();
    db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), fees: { ...DEFAULT_FEES, ...((db.settings || {}).fees || {}) } };
    db.order = Array.isArray(db.order) ? db.order : Object.keys(db.runs);
    return db;
  } catch {
    return blank();
  }
}

let lastErr = null;
export function storeError() { return lastErr; }

function write(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
    lastErr = null;
    return true;
  } catch (e) {
    lastErr = e && e.name === 'QuotaExceededError' ? '手機的儲存空間滿了：請到「設定」匯出備份' : '存檔失敗';
    return false;
  }
}

/** 讀最新的 → 改 → 存。fn 回傳 false 表示不用存。 */
export function update(fn) {
  const db = load();
  const r = fn(db);
  if (r === false) return db;
  write(db);
  return db;
}

/** 跨分頁互斥（有支援就用）：撮合後寫入成交時用，避免兩個分頁同時寫 */
export async function withLock(fn) {
  if (navigator.locks && navigator.locks.request) {
    return navigator.locks.request('sandtable-db', { ifAvailable: false }, async () => fn());
  }
  return fn();
}

export function curRun(db = load()) {
  return db.cur && db.runs[db.cur] && !db.runs[db.cur].end ? db.runs[db.cur] : null;
}

/** 開新的一局：起點＝伺服器時間，起始資金，手續費條件照目前設定 */
export function newRun(db, { capital, at, d, bench, fees }) {
  db.seq = (db.seq || 0) + 1;
  const no = Object.keys(db.runs).length + 1;
  const id = `r${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  db.runs[id] = {
    v: 1, id, no, name: `第 ${no} 局`, start: { at, d, bench: bench || null }, capital,
    fees: { ...(fees || db.settings.fees) }, orders: [], mods: [], fills: [], prog: {}, finals: {},
    notes: {}, restores: [], cash: [], signed: {}, end: null,
  };
  db.order = [...(db.order || []), id];
  db.cur = id;
  return db.runs[id];
}

/** 結束這一局（封存，不能刪） */
export function endRun(db, id, summary) {
  const r = db.runs[id];
  if (!r || r.end) return;
  r.end = summary;
  r.prog = {};
  if (db.cur === id) db.cur = null;
}

export function newId(prefix, at) {
  return `${prefix}${at.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 把撮合結果併進最新的存檔（成交依 id 去重、結束狀態只增不減） */
export function mergeEngine(db, runId, res) {
  const r = db.runs[runId];
  if (!r) return false;
  const byId = new Map(r.fills.map((f) => [f.id, f]));
  let changed = false;
  for (const f of res.newFills) if (!byId.has(f.id)) { byId.set(f.id, f); changed = true; }
  r.fills = [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  for (const [k, v] of Object.entries(res.finals || {})) if (!r.finals[k]) { r.finals[k] = v; changed = true; }
  // 進度：結束的委託不用再留進度
  const prog = {};
  for (const [k, v] of Object.entries(res.prog || {})) if (!r.finals[k]) prog[k] = v;
  if (JSON.stringify(prog) !== JSON.stringify(r.prog || {})) changed = true;
  r.prog = prog;
  return changed;
}

/** 定期定額的結果併進最新的存檔：每一期只記一次（id 固定）；連續失敗 3 次就把全部計畫停掉 */
export function mergeDca(db, runId, res) {
  const r = db.runs[runId];
  if (!r) return false;
  let changed = false;
  const byId = new Map(r.fills.map((f) => [f.id, f]));
  for (const f of res.newFills) if (!byId.has(f.id)) { byId.set(f.id, f); changed = true; }
  r.fills = [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  r.dcaLog = r.dcaLog || {};
  for (const [k, v] of Object.entries(res.log || {})) if (!r.dcaLog[k]) { r.dcaLog[k] = v; changed = true; }
  if (res.stopAt) {
    for (const p of r.plans || []) if (!p.end || p.end > res.stopAt) { p.end = res.stopAt; p.why = '連續 3 次扣款失敗，國泰自動終止全部台股定期定額'; changed = true; }
  }
  return changed;
}

// ------------------------------------------------------------------ 備份
async function gz(str) {
  if (typeof CompressionStream === 'undefined') return null;
  const s = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(s).arrayBuffer();
  let bin = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function gunzip(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}
export async function exportBackup(serverAt) {
  const db = load();
  const payload = JSON.stringify({ app: 'sandtable', v: 1, at: serverAt, db });
  const z = await gz(payload);
  return z ? `ST1Z:${z}` : `ST1J:${btoa(unescape(encodeURIComponent(payload)))}`;
}
/**
 * 還原備份：會蓋掉這支手機上的沙盤資料。還原是「回到過去」，所以每一局都會留下一筆還原紀錄，
 * 戰報上會一直看得到（可以用，但騙不了自己）。
 */
export async function importBackup(text, serverAt) {
  const t = String(text || '').trim();
  let json;
  if (t.startsWith('ST1Z:')) json = await gunzip(t.slice(5));
  else if (t.startsWith('ST1J:')) json = decodeURIComponent(escape(atob(t.slice(5))));
  else throw new Error('這不是沙盤的備份碼');
  const obj = JSON.parse(json);
  if (!obj || obj.app !== 'sandtable' || !obj.db || typeof obj.db.runs !== 'object') throw new Error('備份內容不完整');
  const db = obj.db;
  for (const r of Object.values(db.runs)) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.orders) || !Array.isArray(r.fills)) throw new Error('備份內容不完整');
    r.restores = [...(r.restores || []), { at: serverAt, from: obj.at || null }];
  }
  db.v = 1;
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  write(db);
  return db;
}

/** 清除全部沙盤資料（只清自己的 key） */
export function wipeAll() {
  try { localStorage.removeItem(KEY); } catch { /* 沒辦法也沒關係 */ }
}
