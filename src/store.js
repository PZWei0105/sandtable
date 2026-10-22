/* 沙盤 — 存檔：全部只存在這支手機（localStorage 的 sandtable.v1），不會送到任何伺服器。
   注意：冷眼、玩真的…都在同一個網址底下，共用同一個儲存空間；沙盤只碰自己的 key，絕不讀寫別的 App 的資料。
   寫入一律「先讀最新的、再改、再存」，好幾個分頁同時開也不會蓋掉彼此。 */
import { DEFAULT_FEES, tw } from './rules.js';
import { laterProg } from './engine.js';

const KEY = 'sandtable.v1';
// 預設的自選：台股最多人持有的幾檔熱門 ETF（和冷眼預設的關注一樣；不是讀冷眼的資料）
export const DEFAULT_WATCH = ['0050', '00878', '00662', '0056', '00919', '00679B'];
export const DEFAULT_SETTINGS = {
  sound: true, haptics: true, fx: true, quality: 'auto', fees: { ...DEFAULT_FEES }, ignite: true, watch: [...DEFAULT_WATCH],
};

function blank() {
  return { v: 1, cur: null, runs: {}, order: [], settings: { ...DEFAULT_SETTINGS, watch: [...DEFAULT_WATCH] }, seq: 0, restores: [] };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const db = JSON.parse(raw);
    if (!db || db.v !== 1 || typeof db.runs !== 'object') return blank();
    db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), fees: { ...DEFAULT_FEES, ...((db.settings || {}).fees || {}) } };
    if (!Array.isArray(db.settings.watch)) db.settings.watch = [...DEFAULT_WATCH];
    db.order = Array.isArray(db.order) ? db.order : Object.keys(db.runs);
    db.restores = Array.isArray(db.restores) ? db.restores : [];
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

/** 跨分頁互斥（有支援就用）：撮合後寫入成交、送單時用，避免兩個分頁同時寫 */
export async function withLock(fn) {
  if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
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

/** 把撮合結果併進最新的存檔（成交依 id 去重、結束狀態只增不減、進度取走得比較前面的那一份） */
export function mergeEngine(db, runId, res) {
  const r = db.runs[runId];
  if (!r || r.end) return false;
  const byId = new Map(r.fills.map((f) => [f.id, f]));
  let changed = false;
  for (const f of res.newFills) if (!byId.has(f.id)) { byId.set(f.id, f); changed = true; }
  r.fills = [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  for (const [k, v] of Object.entries(res.finals || {})) if (!r.finals[k]) { r.finals[k] = v; changed = true; }
  // 進度：結束的委託不用再留進度；另一個分頁可能用比較舊的行情算過，取走得比較前面的
  const prog = {};
  for (const k of new Set([...Object.keys(r.prog || {}), ...Object.keys(res.prog || {})])) {
    if (r.finals[k]) continue;
    const p = laterProg((r.prog || {})[k], (res.prog || {})[k]);
    if (p) prog[k] = p;
  }
  if (JSON.stringify(prog) !== JSON.stringify(r.prog || {})) changed = true;
  r.prog = prog;
  return changed;
}

/** 定期定額的結果併進最新的存檔：每一期只記一次（id 固定）；連續失敗 3 次就把全部計畫停掉 */
export function mergeDca(db, runId, res) {
  const r = db.runs[runId];
  if (!r || r.end) return false;
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
async function sha256(str) {
  const c = globalThis.crypto && globalThis.crypto.subtle;
  if (!c) return null;
  const buf = await c.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function exportBackup(serverAt) {
  const db = load();
  const body = JSON.stringify(db);
  const h = await sha256(body);
  const payload = `{"app":"sandtable","v":2,"at":${Number(serverAt) || 0},"h":${JSON.stringify(h)},"db":${body}}`;
  const z = await gz(payload);
  return z ? `ST1Z:${z}` : `ST1J:${btoa(unescape(encodeURIComponent(payload)))}`;
}

// ---- 備份碼可能被改過：每一欄重新檢查、重建，不認得的東西一律丟掉（畫面上輸出的字串另外都會跳脫）
const ID = /^[A-Za-z0-9:@._-]{1,80}$/;
const CODE = /^[0-9A-Z]{4,8}$/;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isInt = (x) => Number.isInteger(x);
const isDay = (x) => isInt(x) && x >= 20000101 && x <= 21001231;
const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');
const arr = (x) => (Array.isArray(x) ? x : []);
const numOr = (x, d = null) => (isNum(x) ? x : d);
const SESS = ['reg', 'odd', 'oddpm', 'fix'];
const ST = ['wait', 'queued', 'live', 'part', 'filled', 'cancelled', 'expired', 'rejected'];

function cleanFees(f) {
  const x = f || {};
  return {
    disc: isNum(x.disc) && x.disc > 0 && x.disc <= 1 ? x.disc : DEFAULT_FEES.disc,
    min: isNum(x.min) && x.min >= 0 ? x.min : DEFAULT_FEES.min,
    minOdd: isNum(x.minOdd) && x.minOdd >= 0 ? x.minOdd : DEFAULT_FEES.minOdd,
    rebate: x.rebate === 'instant' ? 'instant' : 'daily',
  };
}
function cleanOrder(o) {
  if (!o || !ID.test(o.id) || !isNum(o.at) || !CODE.test(o.code) || !['B', 'S'].includes(o.side) || !SESS.includes(o.sess)
    || !['L', 'M', 'C'].includes(o.type) || !['ROD', 'IOC', 'FOK'].includes(o.tif) || !isInt(o.qty) || o.qty <= 0 || !isDay(o.day)) return null;
  const ref = {};
  for (const k of ['z', 'a1', 'b1', 'oa1', 'ob1', 'qAt']) ref[k] = numOr(o.ref && o.ref[k]);
  return {
    id: o.id, at: o.at, code: o.code, side: o.side, sess: o.sess, type: o.type, tif: o.tif, px: numOr(o.px), qty: o.qty, day: o.day,
    phase: str(o.phase, 20), resPx: numOr(o.resPx), ref, prev: typeof o.prev === 'string' && ID.test(o.prev) ? o.prev : null,
  };
}
function cleanMod(m) {
  if (!m || !ID.test(m.id) || !ID.test(m.oid) || !isNum(m.at) || !['cancel', 'reduce'].includes(m.kind)) return null;
  return { id: m.id, oid: m.oid, at: m.at, kind: m.kind, qty: isInt(m.qty) && m.qty >= 0 ? m.qty : 0 };
}
function cleanFill(f) {
  if (!f || !ID.test(f.id) || !ID.test(f.oid) || !isNum(f.t) || !isDay(f.d) || !CODE.test(f.code) || !['B', 'S'].includes(f.side)
    || ![...SESS, 'dca'].includes(f.sess) || !isInt(f.qty) || f.qty <= 0 || !isNum(f.px) || f.px <= 0 || !isNum(f.amt)) return null;
  const out = {
    id: f.id, oid: f.oid, t: f.t, d: f.d, code: f.code, side: f.side, sess: f.sess, qty: f.qty, px: f.px, amt: f.amt,
    fee: numOr(f.fee, 0), fin: numOr(f.fin, numOr(f.fee, 0)), tax: numOr(f.tax, 0), how: str(f.how, 12),
  };
  if (isDay(f.s)) out.s = f.s;
  return out;
}
function cleanFinal(x) {
  if (!x || !ST.includes(x.st)) return null;
  return { st: x.st, why: str(x.why, 200), t: numOr(x.t) };
}
function cleanProg(p) {
  if (!p || !['wait', 'live', 'done'].includes(p.st)) return null;
  const out = { st: p.st };
  for (const k of ['act', 'L', 'H', 'zt0', 'cut', 'v', 'zp']) out[k] = numOr(p[k]);
  if (p.co === true) out.co = true;
  if (p.full === true) out.full = true;
  return out;
}
function cleanMap(x, fn, keyOk = (k) => ID.test(k)) {
  const out = {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    if (!keyOk(k)) continue;
    const c = fn(v);
    if (c) out[k] = c;
  }
  return out;
}
function cleanNote(n) {
  if (!n || typeof n !== 'object') return null;
  return { t: str(n.t, 200), tags: arr(n.tags).map((t) => str(t, 12)).filter(Boolean).slice(0, 8) };
}
function cleanPlan(p) {
  if (!p || !ID.test(p.id) || !CODE.test(p.c) || !isDay(p.start) || !isNum(p.amt) || p.amt <= 0) return null;
  const days = arr(p.days).filter((d) => isInt(d) && d >= 1 && d <= 31);
  if (!days.length) return null;
  const out = { id: p.id, c: p.c, days: [...new Set(days)].sort((a, b) => a - b), amt: p.amt, fee: numOr(p.fee, 1), start: p.start, end: isDay(p.end) ? p.end : null, at: numOr(p.at) };
  if (isNum(p.stopAt)) out.stopAt = p.stopAt;
  if (p.why) out.why = str(p.why, 120);
  return out;
}
function cleanDcaEntry(x) {
  if (!x || !['ok', 'fail', 'halt', 'skip'].includes(x.st) || !isDay(x.d)) return null;
  const out = { st: x.st, d: x.d };
  if (x.why) out.why = str(x.why, 160);
  if (isInt(x.qty)) out.qty = x.qty;
  if (isNum(x.px)) out.px = x.px;
  return out;
}
function cleanEnd(e) {
  if (!e || typeof e !== 'object') return null;
  const out = { at: numOr(e.at, 0), d: isDay(e.d) ? e.d : null };
  for (const k of ['equity', 'ret', 'bench', 'mdd']) out[k] = numOr(e[k]);
  if (isInt(e.fills)) out.fills = e.fills;
  if (e.parked === true) out.parked = true;
  if (e.why) out.why = str(e.why, 120);
  return out;
}
function cleanRestore(x) {
  if (!x || !isNum(x.at)) return null;
  return { at: x.at, from: numOr(x.from) };
}
function cleanRun(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !/^r[A-Za-z0-9]{1,30}$/.test(r.id)) return null;
  const s = r.start || {};
  if (!isNum(s.at) || !isDay(s.d) || !isNum(r.capital) || r.capital <= 0) return null;
  return {
    v: 1, id: r.id, no: isInt(r.no) ? r.no : 0, name: str(r.name, 40) || '還原的一局',
    start: { at: s.at, d: s.d, bench: numOr(s.bench) }, capital: r.capital, fees: cleanFees(r.fees),
    orders: arr(r.orders).map(cleanOrder).filter(Boolean),
    mods: arr(r.mods).map(cleanMod).filter(Boolean),
    fills: arr(r.fills).map(cleanFill).filter(Boolean),
    prog: cleanMap(r.prog, cleanProg), finals: cleanMap(r.finals, cleanFinal), notes: cleanMap(r.notes, cleanNote),
    restores: arr(r.restores).map(cleanRestore).filter(Boolean), cash: [],
    signed: isNum(r.signed && r.signed.lev) ? { lev: r.signed.lev } : {},
    end: r.end ? cleanEnd(r.end) : null,
    plans: arr(r.plans).map(cleanPlan).filter(Boolean),
    dcaLog: cleanMap(r.dcaLog, cleanDcaEntry, (k) => /^[A-Za-z0-9]{1,40}:\d{8}$/.test(k)),
  };
}

const unionBy = (a, b, key = (x) => x.id) => {
  const m = new Map(a.map((x) => [key(x), x]));
  for (const x of b) if (!m.has(key(x))) m.set(key(x), x);
  return [...m.values()];
};
/** 同一局的兩份紀錄合併：委託、刪改單、成交都只增不減（聯集），不會因為還原而少掉任何一筆 */
function mergeRun(a, b) {
  a.orders = unionBy(a.orders || [], b.orders).sort((x, y) => x.at - y.at);
  a.mods = unionBy(a.mods || [], b.mods).sort((x, y) => x.at - y.at);
  a.fills = unionBy(a.fills || [], b.fills).sort((x, y) => x.t - y.t || (x.id < y.id ? -1 : 1));
  a.finals = { ...b.finals, ...(a.finals || {}) };
  const prog = {};
  for (const k of new Set([...Object.keys(a.prog || {}), ...Object.keys(b.prog || {})])) {
    if (a.finals[k]) continue;
    const p = laterProg((a.prog || {})[k], b.prog[k]);
    if (p) prog[k] = p;
  }
  a.prog = prog;
  a.notes = { ...b.notes, ...(a.notes || {}) };
  a.signed = { ...b.signed, ...(a.signed || {}) };
  const plans = new Map((a.plans || []).map((p) => [p.id, p]));
  for (const p of b.plans) {
    const x = plans.get(p.id);
    if (!x) plans.set(p.id, p);
    else if (p.end && (!x.end || p.end < x.end)) Object.assign(x, { end: p.end, stopAt: p.stopAt ?? x.stopAt, why: p.why || x.why });
  }
  a.plans = [...plans.values()];
  a.dcaLog = { ...b.dcaLog, ...(a.dcaLog || {}) };
  a.restores = unionBy(a.restores || [], b.restores, (x) => `${x.at}|${x.from}`);
  if (!a.end && b.end) { a.end = b.end; a.prog = {}; }
}

/**
 * 還原備份＝把備份「合併」進這支手機：
 * - 手機上已經有的局：委託、成交、刪改單都取聯集（只增不減），還原不會讓任何一筆交易消失。
 * - 手機上沒有的局（換手機）：整局加進來。手機上有、備份沒有的局：原封不動。
 * - 進行中的局只能有一個：手機上本來進行中的那一局優先，其他還沒封存的局封存起來（標成「還原時捨棄」，戰役紀錄看得到）。
 * - 每一局、整個存檔都留下還原紀錄（什麼時候、用哪一天的備份），戰報上一直看得到。
 */
export async function importBackup(text, serverAt) {
  const t = String(text || '').trim();
  let json;
  if (t.startsWith('ST1Z:')) json = await gunzip(t.slice(5));
  else if (t.startsWith('ST1J:')) json = decodeURIComponent(escape(atob(t.slice(5))));
  else throw new Error('這不是沙盤的備份碼');
  const obj = JSON.parse(json);
  if (!obj || obj.app !== 'sandtable' || !obj.db || typeof obj.db.runs !== 'object') throw new Error('備份內容不完整');
  let signed = false;
  if (obj.v >= 2) {
    const h = await sha256(JSON.stringify(obj.db));
    if (h && obj.h !== h) throw new Error('這個備份碼被改過，不能還原');
    signed = !!h;
  }
  const inc = [];
  for (const r of Object.values(obj.db.runs)) {
    const c = cleanRun(r);
    if (c) inc.push(c);
  }
  if (!inc.length) throw new Error('備份裡沒有任何一局');
  const at = Number(serverAt) || 0;
  const from = numOr(obj.at);
  const log = { at, from, signed, added: [], merged: [], parked: [] };
  const db = update((x) => {
    for (const r of inc) {
      if (x.runs[r.id]) { mergeRun(x.runs[r.id], r); log.merged.push(r.id); }
      else { x.runs[r.id] = r; x.order = [...(x.order || []), r.id]; log.added.push(r.id); }
      const rr = x.runs[r.id];
      rr.restores = [...(rr.restores || []), { at, from }];
    }
    const incCur = typeof obj.db.cur === 'string' ? obj.db.cur : null;
    const alive = (id) => id && x.runs[id] && !x.runs[id].end;
    let cur = alive(x.cur) ? x.cur : alive(incCur) ? incCur : null;
    const active = Object.values(x.runs).filter((r) => !r.end).sort((a, b) => b.start.at - a.start.at);
    if (!cur && active.length) cur = active[0].id;
    for (const r of active) {
      if (r.id === cur) continue;
      r.end = { at, d: tw(at).d, parked: true, why: '還原備份時已經有另一局在進行，這一局封存（還原時捨棄）' };
      r.prog = {};
      log.parked.push(r.id);
    }
    x.cur = cur;
    x.restores = [...(x.restores || []), log];
  });
  return { db, log };
}

/** 清除全部沙盤資料（只清自己的 key） */
export function wipeAll() {
  try { localStorage.removeItem(KEY); } catch { /* 沒辦法也沒關係 */ }
}
