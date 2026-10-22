/* 沙盤 SANDTABLE — 真實交易規則（全部是純函式與常數）。
   規則來源：臺灣證券交易所「集中市場交易制度介紹」與「盤中全面逐筆交易專區」、
   證交所 2026/8/20 公告的盤中零股新制（2026/12/7 起與整股同步 09:00 開盤）。
   規則一改，就改這個檔案；畫面上的規則說明（src/guide.js）照這裡寫。 */

// ------------------------------------------------------------------ 時間（台灣時間，沒有日光節約）
const TZ = 8 * 3600e3;

/** 伺服器時間（毫秒）→ 台灣日期與時刻 */
export function tw(ms) {
  const t = new Date(ms + TZ);
  const d = t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
  const hm = t.getUTCHours() * 100 + t.getUTCMinutes();
  return { d, hm, hms: hm * 100 + t.getUTCSeconds(), dow: t.getUTCDay() };
}
/** 台灣某天某時刻（HHMM 或 HHMMSS）→ 毫秒 */
export function atTW(d, hhmm, sec = 0) {
  const y = Math.floor(d / 10000), m = Math.floor(d / 100) % 100, day = d % 100;
  const h = Math.floor(hhmm / 100), mi = hhmm % 100;
  return Date.UTC(y, m - 1, day, h, mi, sec) - TZ;
}
export function dow(d) {
  return new Date(Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100)).getUTCDay();
}
export function addDays(d, n) {
  const t = new Date(Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) + n * 86400e3);
  return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
}
export function daysBetween(a, b) {
  const ta = Date.UTC(Math.floor(a / 10000), Math.floor(a / 100) % 100 - 1, a % 100);
  const tb = Date.UTC(Math.floor(b / 10000), Math.floor(b / 100) % 100 - 1, b % 100);
  return Math.round((tb - ta) / 86400e3);
}

// ------------------------------------------------------------------ 交易日曆
/**
 * cal = { holidays: 平日休市的日期, open: 資料上確定有開市的日期, closed: 資料上確定沒開市的平日（颱風假）}
 * 證交所公布的休市表只有事先排定的假日；颱風假要看當天資料。
 */
export function makeCal(raw = {}) {
  return {
    holidays: new Set(raw.holidays || []),
    settleOnly: new Set(raw.settle_only || []),   // 不交易、但照常辦理交割的日子（例如春節前）
    open: new Set(raw.open || []),
    closed: new Set(raw.closed || []),
  };
}
export function isTradingDay(cal, d) {
  if (cal.open.has(d)) return true;
  if (cal.closed.has(d) || cal.holidays.has(d)) return false;
  const w = dow(d);
  return w !== 0 && w !== 6;
}
export function nextTradingDay(cal, d) {
  let x = addDays(d, 1);
  for (let i = 0; i < 40 && !isTradingDay(cal, x); i++) x = addDays(x, 1);
  return x;
}
export function prevTradingDay(cal, d) {
  let x = addDays(d, -1);
  for (let i = 0; i < 40 && !isTradingDay(cal, x); i++) x = addDays(x, -1);
  return x;
}
/** d 之後第 n 個交易日（d 本身不算） */
export function addTradingDays(cal, d, n) {
  let x = d;
  for (let i = 0; i < n; i++) x = nextTradingDay(cal, x);
  return x;
}
/** 交割日：成交日之後第 2 個「營業日」（只辦交割、不交易的日子也算） */
export function settleDay(cal, d, n = 2) {
  let x = d;
  for (let i = 0; i < n; i++) {
    x = addDays(x, 1);
    for (let k = 0; k < 40 && !(isTradingDay(cal, x) || (cal.settleOnly && cal.settleOnly.has(x))); k++) x = addDays(x, 1);
  }
  return x;
}

// ------------------------------------------------------------------ 交易時段
// 盤中零股新制：2026/12/7 起 08:30 開始接受委託、09:00 第一次撮合（之前是 09:00 接受委託、09:10 第一次撮合）
export const ODD_SYNC_FROM = 20261207;

export function windows(d) {
  const sync = d >= ODD_SYNC_FROM;
  return {
    regFrom: 830, regOpen: 900, regAuction: 1325, regClose: 1330,
    oddFrom: sync ? 830 : 900, oddFirst: sync ? 900 : 910, oddClose: 1330,
    oddpmFrom: 1340, oddpmTo: 1430,
    fixFrom: 1400, fixTo: 1430,
  };
}

export const SESS_NAME = { reg: '整股', odd: '盤中零股', fix: '盤後定價', oddpm: '盤後零股' };
export const PHASE_NAME = {
  closed: '休市', night: '收盤後', reserve: '預約單時段', preopen: '開盤前集合競價', continuous: '盤中逐筆交易',
  closing: '收盤前集合競價', post: '收盤後', oddpm: '盤後零股', afterhours: '盤後定價＋盤後零股', done: '今日交易結束',
};

/** 某個時間點的市場狀態（給畫面上的戰情鐘） */
export function marketPhase(cal, ms) {
  const { d, hm } = tw(ms);
  if (!isTradingDay(cal, d)) return { d, phase: 'closed' };
  const w = windows(d);
  if (hm < w.regFrom) return { d, phase: 'reserve' };
  if (hm < w.regOpen) return { d, phase: 'preopen' };
  if (hm < w.regAuction) return { d, phase: 'continuous' };
  if (hm < w.regClose) return { d, phase: 'closing' };
  if (hm < w.oddpmFrom) return { d, phase: 'post' };
  if (hm < w.fixFrom) return { d, phase: 'oddpm' };
  if (hm < w.fixTo) return { d, phase: 'afterhours' };
  return { d, phase: 'done' };
}

/**
 * 這個時間點下這種單，會進到哪一天、哪一個時段，可以用哪些委託條件。
 * kind：'lot'（整股）或 'odd'（零股）。回傳 null 表示這個時間不能下這種單（附原因）。
 */
export function orderWindow(cal, ms, kind) {
  const { d, hm } = tw(ms);
  const trading = isTradingDay(cal, d);
  const w = windows(d);
  const nextDay = () => nextTradingDay(cal, d);
  const LROD = { types: ['L'], tifs: ['ROD'] };
  if (kind === 'lot') {
    if (trading && hm < w.regFrom) return { sess: 'reg', day: d, phase: 'reserve', ...LROD, note: '預約單：今天 08:30 送進交易所，參加 09:00 開盤競價' };
    if (trading && hm < w.regOpen) return { sess: 'reg', day: d, phase: 'preopen', ...LROD, note: '開盤前集合競價：09:00 依最大成交量決定開盤價' };
    if (trading && hm < w.regAuction) return { sess: 'reg', day: d, phase: 'continuous', types: ['L', 'M'], tifs: ['ROD', 'IOC', 'FOK'], note: '盤中逐筆交易：委託送出後依價格、時間優先撮合' };
    if (trading && hm < w.regClose) return { sess: 'reg', day: d, phase: 'closing', ...LROD, note: '收盤前集合競價：13:30 一次撮合出收盤價' };
    if (trading && hm < w.fixFrom) return { blocked: true, why: '整股今天已收盤。14:00～14:30 可以下「盤後定價」（用今天收盤價成交），14:30 以後可以下明天的預約單。' };
    if (trading && hm < w.fixTo) return { sess: 'fix', day: d, phase: 'afterhours', types: ['C'], tifs: ['ROD'], note: '盤後定價：14:30 一律用今天的收盤價撮合' };
    return { sess: 'reg', day: nextDay(), phase: 'reserve', ...LROD, note: '預約單：下一個交易日 08:30 送進交易所' };
  }
  if (trading && hm < w.oddFrom) return { sess: 'odd', day: d, phase: 'reserve', ...LROD, note: `預約單：今天 ${fmtHM(w.oddFrom)} 送進交易所，${fmtHM(w.oddFirst)} 第一次撮合` };
  if (trading && hm < w.oddClose) {
    return { sess: 'odd', day: d, phase: hm < w.oddFirst ? 'preopen' : 'continuous', ...LROD, note: hm < w.oddFirst ? `盤中零股 ${fmtHM(w.oddFirst)} 第一次撮合` : '盤中零股：每 5 秒撮合一次' };
  }
  if (trading && hm < w.oddpmFrom) return { blocked: true, why: '盤中零股已收盤。13:40～14:30 可以下「盤後零股」（14:30 一次撮合），14:30 以後可以下明天的預約單。' };
  if (trading && hm < w.oddpmTo) return { sess: 'oddpm', day: d, phase: 'oddpm', ...LROD, note: '盤後零股：14:30 集合競價一次撮合' };
  return { sess: 'odd', day: nextDay(), phase: 'reserve', ...LROD, note: '預約單：下一個交易日盤中零股開始時送進交易所' };
}
export function fmtHM(hm) {
  return `${String(Math.floor(hm / 100)).padStart(2, '0')}:${String(hm % 100).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ 價格
/** ETF 升降單位：未滿 50 元 0.01 元，50 元以上 0.05 元 */
export function tick(p) { return p < 50 ? 0.01 : 0.05; }
export function r2(x) { return Math.round(x * 100) / 100; }
export function onTick(p) {
  if (!(p > 0)) return false;
  const t = tick(p);
  return Math.abs(Math.round(p / t) * t - p) < 1e-6;
}
/** 往上 n 檔：50 元以下每檔 0.01、50 元以上每檔 0.05（49.99 → 50.00 → 50.05） */
export function tickUp(p, n = 1) {
  let x = p;
  for (let i = 0; i < n; i++) x = r2(x + (x >= 50 - 1e-9 ? 0.05 : 0.01));
  return x;
}
/** 往下 n 檔（50.05 → 50.00 → 49.99） */
export function tickDown(p, n = 1) {
  let x = p;
  for (let i = 0; i < n; i++) x = r2(Math.max(0.01, x - (x > 50 + 1e-9 ? 0.05 : 0.01)));
  return x;
}
/** 對齊到合法價格（dir>0 往上、<0 往下、0 四捨五入） */
export function snapTick(p, dir = 0) {
  if (!(p > 0)) return null;
  const t = p >= 50 ? 0.05 : 0.01;
  const k = p / t;
  const n = dir > 0 ? Math.ceil(k - 1e-7) : dir < 0 ? Math.floor(k + 1e-7) : Math.round(k);
  return r2(n * t);
}
/** 漲跌停：MIS 提供 u／w；國外成分的 ETF 沒有漲跌幅限制（u＝9999.95、沒有 w）。 */
export function limitsOf(q) {
  if (!q) return { up: null, down: null, none: false };
  const up = q.u > 0 && q.u < 9999 ? q.u : null;
  const down = q.w > 0 ? q.w : null;
  return { up, down, none: !up && !down };
}

// ------------------------------------------------------------------ 數量
export const LOT = 1000;
export function qtyOk(sess, qty) {
  if (!Number.isInteger(qty) || qty <= 0) return false;
  if (sess === 'reg' || sess === 'fix') return qty % LOT === 0;
  return qty < LOT;   // 零股：1～999 股
}

// ------------------------------------------------------------------ 手續費與證交稅
export const FEE_RATE = 0.001425;
export const ETF_TAX = 0.001;
export const BOND_TAX_FREE_UNTIL = 20261231;   // 被動式債券 ETF 停徵證交稅到 2026/12/31（同冷眼 pf.js）
export const ACTIVE_BOND_FREE_FROM = null;     // 主動式債券 ETF（代號尾碼 D）目前照課；立法院三讀後改成 20270101
export const NHI_RATE = 0.0211;                // 二代健保補充保費
export const NHI_MIN = 20000;                  // 單次 2 萬元以上才扣
/**
 * 預設照國泰證券電子下單：2.8 折、日退（成交時先收原價手續費，下一個交易日退回折扣差額）；
 * 整股最低 20 元、零股最低 1 元。使用者可以在設定改成自己帳戶的條件。
 */
export const DEFAULT_FEES = { disc: 0.28, min: 20, minOdd: 1, rebate: 'daily' };

export function feeFull(amount, odd, cfg = DEFAULT_FEES) {
  if (!(amount > 0)) return 0;
  return Math.max(Math.floor(amount * FEE_RATE + 1e-9), odd ? cfg.minOdd : cfg.min);
}
export function feeFinal(amount, odd, cfg = DEFAULT_FEES) {
  if (!(amount > 0)) return 0;
  return Math.max(Math.floor(amount * FEE_RATE * cfg.disc + 1e-9), odd ? cfg.minOdd : cfg.min);
}
/** 成交當下扣的手續費（日退／月退：先收原價；即時折扣：直接收折扣後） */
export function feeCharged(amount, odd, cfg = DEFAULT_FEES) {
  return cfg.rebate === 'instant' ? feeFinal(amount, odd, cfg) : feeFull(amount, odd, cfg);
}
/** 證交稅類別：主動式債券 ETF（代號尾碼 D）和被動式債券 ETF 停徵範圍不同 */
export function taxCat(code, cat) {
  return cat === 'bond' && /D$/i.test(code || '') ? 'abond' : cat;
}
export function taxRate(code, cat, d) {
  const k = taxCat(code, cat);
  if (k === 'bond' && d <= BOND_TAX_FREE_UNTIL) return 0;
  if (k === 'abond' && ACTIVE_BOND_FREE_FROM && d >= ACTIVE_BOND_FREE_FROM && d <= BOND_TAX_FREE_UNTIL) return 0;
  return ETF_TAX;
}
export function taxOf(amount, rate) {
  return rate > 0 ? Math.floor(amount * rate + 1e-9) : 0;
}
/** 價金：股數 × 價格，取到元（無條件捨去） */
export function amountOf(qty, px) {
  return Math.floor(qty * px + 1e-6);
}

// ------------------------------------------------------------------ 當沖與槓反
// 現股當沖資格：開立受託買賣帳戶滿三個月，且最近一年內委託買賣成交達十筆（有價證券當日沖銷交易作業辦法第二條）
export const DAYTRADE_MONTHS = 3;
export const DAYTRADE_FILLS = 10;
export function daytradeStatus(startDay, today, fillsInYear) {
  const months = (Math.floor(today / 10000) - Math.floor(startDay / 10000)) * 12 + (Math.floor(today / 100) % 100 - Math.floor(startDay / 100) % 100)
    - ((today % 100) < (startDay % 100) ? 1 : 0);
  return { months, fills: fillsInYear, ok: months >= DAYTRADE_MONTHS && fillsInYear >= DAYTRADE_FILLS };
}

// ------------------------------------------------------------------ 配息
// 官方資料沒有發放日；沙盤一律在除息日後第 20 個交易日入帳（真實多半在除息後 3～5 週，以投信公告為準）
export const DIV_PAY_LAG = 20;
