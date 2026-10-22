/* 沙盤 — 資料：全部來自冷眼後台抓的官方資料（同一個網站底下的 /coldeye-etf/data/，以及封存在冷眼 repo
   tape-days 分支的過去交易日快照），沙盤自己不抓官方網站、不送任何東西出去。

   伺服器時間：每次抓資料時讀回應的 Date（GitHub 的時鐘），之後經過的時間用 performance.now()（單調時鐘，
   改手機時間也不會跳）往後推。委託時間一律用它；撮合只在「拿到過新鮮的伺服器時間、而且不是離線」時才做。 */
import { atTW, tw, makeCal, isTradingDay, dow } from './rules.js';

const qs = new URLSearchParams(location.search);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const BASE = new URL(qs.get('data') || '../coldeye-etf/data/', location.href).href;
// 過去交易日的逐輪快照（冷眼 repo 的 tape-days 分支）；測試時可以用 ?arc= 指定
export const ARC = new URL(qs.get('arc') || 'https://raw.githubusercontent.com/PZWei0105/coldeye-etf/tape-days/', location.href).href;
// 舊的快照（2026/10/22 盤中以前）沒有證交所的資料時間：當成最多落後 10 分鐘
const LAG_MAX = 10 * 60e3;

export const S = {
  summary: null, rows: new Map(), live: null, quotes: null, calRaw: null, cal: makeCal(), divs: {}, after: {},
  afterDays: new Map(), spark: null, news: null, version: null, offline: false, lastOk: 0,
  tape: new Map(), arc: new Map(), k: new Map(), hist: new Map(), detail: new Map(),
  closedToday: new Set(), err: null,
};

// ------------------------------------------------------------------ 伺服器時間
const clk = { at: 0, perf: 0, ok: false };
const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
function setClock(ms) {
  clk.at = ms + 500;          // Date 只到秒：取那一秒的中間
  clk.perf = perfNow();
  clk.ok = true;
}
function noteDate(r) {
  const h = r.headers.get('Date');
  const ms = h ? Date.parse(h) : NaN;
  if (Number.isFinite(ms) && r.headers.get('X-Sandtable-Offline') !== '1') setClock(ms);
}
/** 伺服器現在時間（毫秒）。還沒從網站拿到過時間時退回手機時鐘（只用來顯示）。 */
export function serverNow() { return clk.ok ? clk.at + (perfNow() - clk.perf) : Date.now(); }
export function hasServerTime() { return clk.ok; }
/** 可以撮合、可以存結果嗎：拿到過伺服器時間，而且現在不是離線（用快取的舊資料） */
export function serverOk() { return clk.ok && !S.offline; }

async function get(path, o = {}) {
  return (await getX(path, o)).data;
}
/** 同 get，另外回傳這份是不是 service worker 給的離線舊資料（off） */
async function getX(path, { fresh = false, tolerate404 = false } = {}) {
  const t = fresh ? Date.now() : Math.floor(Date.now() / 30000);
  const r = await fetch(`${BASE}${path}?t=${t}`, { cache: 'no-store' });
  const off = r.headers.get('X-Sandtable-Offline') === '1';
  if (tolerate404 && r.status === 404) return { data: null, off };
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  noteDate(r);
  if (path === 'quotes.json' || path === 'version.json') S.offline = off;
  if (!off) S.lastOk = Date.now();
  return { data: await r.json(), off };
}

function indexSummary(s) {
  S.summary = s;
  S.rows = new Map((s.etfs || []).map((r) => [r.c, r]));
}

/** 開機：先載入一次所有基本資料 */
export async function boot() {
  const jobs = [
    get('summary.json').then(indexSummary),
    get('live.json').then((x) => { S.live = x; }).catch(() => {}),
    get('quotes.json').then((x) => { S.quotes = x; }).catch(() => { S.offline = true; }),
    get('cal.json').then((x) => { S.calRaw = x; }).catch(() => {}),
    get('divs.json').then((x) => { S.divs = x || {}; }).catch(() => {}),
    get('after.json').then((x) => { S.after = x || {}; }).catch(() => {}),
    get('news.json').then((x) => { S.news = x; }).catch(() => {}),
    get('version.json').then((x) => { S.version = x; }).catch(() => {}),
    get('spark.json', { tolerate404: true }).then((x) => { S.spark = x; }).catch(() => {}),
  ];
  await Promise.all(jobs);
  rebuildCal();
}

/** 看後台有沒有新資料；有才重新抓（後台盤中約 5 分鐘一輪） */
export async function refresh(force = false, tapeCodes = null) {
  let v;
  try { v = await get('version.json', { fresh: true }); } catch (e) { S.err = String(e); return false; }
  const changed = force || !S.version || v.built !== S.version.built;
  S.version = v;
  if (!changed) return false;
  const now = serverNow();
  const jobs = [
    get('live.json').then((x) => { S.live = x; }).catch(() => {}),
    get('quotes.json').then((x) => { S.quotes = x; }).catch(() => {}),
    get('news.json').then((x) => { S.news = x; }).catch(() => {}),
    get('spark.json', { tolerate404: true }).then((x) => { if (x) S.spark = x; }).catch(() => {}),
  ];
  const { hm } = tw(now);
  if (!S.summary || hm >= 1400 || hm < 900) jobs.push(get('summary.json').then(indexSummary).catch(() => {}));
  if (hm >= 1435 || hm < 900) jobs.push(get('after.json').then((x) => { S.after = x || {}; }).catch(() => {}));
  if (hm >= 1400 || hm < 900) {
    jobs.push(get('divs.json').then((x) => { S.divs = x || {}; }).catch(() => {}));
    jobs.push(get('cal.json').then((x) => { S.calRaw = x; }).catch(() => {}));
    // 收盤後的日 K 會更新：丟掉舊的，要用時再抓
    S.k.clear();
  }
  await Promise.all(jobs);
  // 有在用的 tape 重新抓（掛單的那幾檔＋正在看的那一檔）；其他的丟掉，要用時再抓
  const want = new Set(tapeCodes || S.tape.keys());
  for (const c of [...S.tape.keys()]) if (!want.has(c)) S.tape.delete(c);
  await Promise.all([...want].map((c) => loadTape(c)));
  rebuildCal();
  return true;
}

function rebuildCal() {
  const raw = S.calRaw || {};
  const cal = makeCal(raw);
  // 今天休市（颱風假）：後台今天 09:15 以後有跑，但證交所的資料還停在之前的日期。
  // 這是 App 自己的推測（cal.guess），只拿來顯示；要把委託作廢，得等證交所／後台確定（cal.closed）。
  const qd = quotesDay();
  const L = S.live;
  const at = L && L.at ? Date.parse(L.at) : NaN;
  if (Number.isFinite(at)) {
    const { d, hm } = tw(at);
    if (dow(d) > 0 && dow(d) < 6 && hm >= 915 && L.date && L.date < d && !cal.holidays.has(d)) S.closedToday.add(d);
  }
  for (const x of S.closedToday) cal.guess.add(x);
  if (qd) cal.open.add(qd);
  S.cal = cal;
}

/** 行情資料是哪一天的（多數 ETF 的日期） */
export function quotesDay() {
  const q = S.quotes && S.quotes.reg;
  if (!q) return null;
  const cnt = new Map();
  for (const x of Object.values(q)) if (x.d) cnt.set(x.d, (cnt.get(x.d) || 0) + 1);
  let best = null;
  let n = -1;
  for (const [k, v] of cnt) if (v > n) { best = k; n = v; }
  return best;
}
export function quotesAt() { return S.quotes ? S.quotes.at * 1000 : null; }

/**
 * 某一檔的 tape（今天 cur、前一個交易日 prev）。抓不到、或拿到的是 service worker 的離線舊資料，就記成「還不知道」（unk），
 * 撮合會等，不會把「沒抓到」當成「那天沒有快照」去用官方日 K 判斷（不然擋掉網址就能挑結果）。之前抓到過的新鮮版本照樣留著用。
 */
export async function loadTape(code) {
  try {
    const { data, off } = await getX(`tape/${code}.json`, { tolerate404: true });
    if (!off) S.tape.set(code, data || { c: code, cur: null, prev: null });
    else if (!S.tape.has(code)) S.tape.set(code, { c: code, cur: null, prev: null, unk: true });
  } catch { if (!S.tape.has(code)) S.tape.set(code, { c: code, cur: null, prev: null, unk: true }); }
  return S.tape.get(code);
}
export async function ensureTape(code) {
  const tp = S.tape.get(code);
  return tp && !tp.unk ? tp : loadTape(code);
}

/**
 * 某一檔某一天的逐輪快照：今天、前一個交易日在 tape/{代號}.json；更早的從封存（tape-days）抓。
 * 封存確定沒有（404：太久以前、或後台那天封存失敗）才記成 null，撮合改用官方日 K 保守判斷；
 * 連不上、被擋、429／5xx 都不記（還不知道），撮合會等到抓得到為止。
 */
export async function ensureTapeDay(code, d) {
  const tp = await ensureTape(code);
  if (tp && ((tp.cur && tp.cur.d === d) || (tp.prev && tp.prev.d === d))) return;
  // 還沒過去的日子（今天或之後）不會在封存裡
  const latest = Math.max(tp && tp.cur ? tp.cur.d : 0, tp && tp.prev ? tp.prev.d : 0, quotesDay() || 0);
  if (!(d < latest)) return;
  const key = `${d}/${code}`;
  if (S.arc.has(key)) return;
  try {
    const r = await fetch(`${ARC}${d}/${code}.json`, { cache: 'force-cache' });
    if (r.status === 404) { S.arc.set(key, null); return; }
    if (!r.ok) return;
    S.arc.set(key, await r.json());
  } catch { /* 連不上就下次再試 */ }
}
// 日 K、歷史檔：抓不到（連不上、離線舊資料）不記，下次再抓；只有 404 才記成 null（確定沒有）。
// 不然擋掉網址就能讓「那天的收盤價」變成「那天沒有成交」，定期定額就會跳過那一期。
// 給了 d（撮合、定期定額要用到那一天）：官方收盤資料已經到 d、手上這份卻還沒更新到 d，就重新抓
// （官方資料換日以後馬上抓一次，之後最多每 5 分鐘一次），App 一直開著也不會永遠等下去。
const refetched = new Map();
function staleFor(kind, code, x, d) {
  if (d == null || !x || !(S.summary && S.summary.asof >= d) || span(x, d) !== 'after') return false;
  const m = refetched.get(`${kind}/${code}`) || {};
  return m.asof !== S.summary.asof || Date.now() - (m.at || 0) > 5 * 60e3;
}
async function ensureSeries(kind, map, code, d) {
  if (map.has(code) && !staleFor(kind, code, map.get(code), d)) return map.get(code);
  const again = map.has(code);
  if (again) refetched.set(`${kind}/${code}`, { asof: S.summary.asof, at: Date.now() });
  try {
    const { data, off } = await getX(`${kind}/${code}.json`, { tolerate404: true, fresh: again });
    if (!off) map.set(code, data);
  } catch { /* 下次再抓 */ }
  return map.get(code);
}
export function ensureK(code, d = null) { return ensureSeries('k', S.k, code, d); }
export function ensureHist(code, d = null) { return ensureSeries('hist', S.hist, code, d); }
/** 某一天的盤後結果（after.json 只帶最近幾天，更早的在 after/{日期}.json） */
export async function ensureAfterDay(d) {
  const key = String(d);
  if ((S.after && S.after[key]) || S.afterDays.has(key)) return;
  const days = (S.after && S.after._days) || [];
  if (!days.includes(d)) return;
  try {
    const x = await get(`after/${key}.json`, { tolerate404: true });
    if (x) S.afterDays.set(key, x);
  } catch { /* 下次再試 */ }
}

/**
 * 下單前：重新抓一次行情，拿伺服器時間當委託時間。離線、抓不到就不能下單（跟真的一樣）。
 */
export async function freshForOrder(code) {
  const r = await fetch(`${BASE}quotes.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`行情 ${r.status}`);
  if (r.headers.get('X-Sandtable-Offline') === '1') throw new Error('離線');
  const h = r.headers.get('Date');
  const T = h ? Date.parse(h) : NaN;
  if (!Number.isFinite(T)) throw new Error('拿不到伺服器時間');
  setClock(T);
  S.quotes = await r.json();
  S.offline = false;
  S.lastOk = Date.now();
  // 委託時間不早於手上最新那筆快照（不會比你已經看到的行情還早）
  const at = Math.max(T, (S.quotes.at || 0) * 1000 + 1000);
  rebuildCal();
  return { at, q: quoteOf(code) };
}

// ------------------------------------------------------------------ 給畫面用
export function row(code) { return S.rows.get(code) || null; }
export function quoteOf(code, kind = 'reg') {
  const q = S.quotes && S.quotes[kind] && S.quotes[kind][code];
  return q || null;
}
export function liveOf(code) {
  const L = S.live;
  if (!L || !L.etfs || !L.etfs[code]) return null;
  const x = L.etfs[code];
  return { px: x[0], nav: x[1], prem: x[2], time: x[3], date: x[5] || L.date };
}
/** 最新價：今天的盤中價優先，沒有就用最近收盤 */
export function lastPx(code) {
  const q = quoteOf(code);
  const r = row(code);
  if (q && q.z > 0 && (!r || !r.d || q.d >= r.d)) return q.z;
  return r ? r.p : null;
}
/** 參考價（昨收）與漲跌 */
export function refPx(code) {
  const q = quoteOf(code);
  const r = row(code);
  if (q && q.y > 0 && (!r || q.d > r.d)) return q.y;
  if (q && q.y > 0 && r && q.d === r.d) return q.y;
  return r && r.p && r.ch != null ? r.p - r.ch : null;
}
export function changeOf(code) {
  const px = lastPx(code);
  const ref = refPx(code);
  if (!(px > 0) || !(ref > 0)) return { px, ref, ch: null, pct: null };
  return { px, ref, ch: px - ref, pct: (px / ref - 1) * 100 };
}
/**
 * 走勢線用的點：今天的盤中走勢（spark.json，[分鐘, 價]），還沒有就用最近 40 天的收盤（summary 的 sp）。
 * 回傳 { pts: [[x, 價]], ref: 參考價, intra: 是不是今天的盤中 }
 */
export function sparkOf(code) {
  const sp = S.spark;
  const r = row(code);
  const qd = quotesDay();
  if (sp && sp.s && sp.s[code] && (!qd || sp.d === qd)) {
    const a = sp.s[code];
    const pts = [];
    for (let i = 0; i + 1 < a.length; i += 2) pts.push([a[i], a[i + 1]]);
    const last = lastPx(code);
    if (pts.length && last > 0 && pts[pts.length - 1][1] !== last) pts.push([Math.max(pts[pts.length - 1][0] + 1, 0), last]);
    return { pts, ref: refPx(code), intra: true, x0: 0, x1: 270 };
  }
  if (r && Array.isArray(r.sp) && r.sp.length > 1) {
    return { pts: r.sp.map((p, i) => [i, p]), ref: null, intra: false, x0: 0, x1: r.sp.length - 1 };
  }
  return { pts: [], ref: null, intra: false, x0: 0, x1: 1 };
}
/** 今天的成交值（元）：官方收盤資料出來了就用官方的；盤中用最新快照的累計量×現價估（valueEst 會說是估的） */
export function valueOf(code) {
  const q = quoteOf(code);
  const r = row(code);
  if (q && q.d && (!r || q.d > r.d) && q.v > 0) {
    const px = q.z > 0 ? q.z : lastPx(code);
    if (px > 0) return q.v * px;
  }
  return r && r.val ? r.val : 0;
}
export function valueEst(code) {
  const q = quoteOf(code);
  const r = row(code);
  return !!(q && q.d && (!r || q.d > r.d) && q.v > 0);
}

/** 這一檔有沒有漲跌幅限制（國外成分的 ETF 沒有；沒有的不能下市價單） */
export function hasLimits(code) {
  const q = quoteOf(code);
  if (q) return q.u > 0 && q.u < 9999;
  const tp = S.tape.get(code);
  const rec = tp && (tp.cur || tp.prev);
  return !!(rec && rec.u > 0);
}

// ------------------------------------------------------------------ 給撮合引擎的介面
function hmsMs(d, x) {
  if (x == null) return null;
  return atTW(d, Math.floor(x / 100), x % 100);   // x＝HHMMSS
}
/**
 * 某一檔某一天的逐輪快照：有就回傳那一天的紀錄；null＝確定沒有（今天還沒開始記、或封存確定沒有）；
 * undefined＝還不知道（這一檔的 tape 還沒拿到新鮮的、或封存還沒讀到）。
 */
function tapeState(code, d) {
  const tp = S.tape.get(code);
  if (!tp || tp.unk) return undefined;
  if (tp.cur && tp.cur.d === d) return tp.cur;
  if (tp.prev && tp.prev.d === d) return { ...tp.prev, done: true };
  const latest = Math.max(tp.cur ? tp.cur.d : 0, tp.prev ? tp.prev.d : 0);
  if (!(d < latest)) return null;                    // 今天（tape 裡還沒有這一天）
  const key = `${d}/${code}`;
  if (!S.arc.has(key)) return undefined;             // 封存還沒讀到（或上次沒抓到）
  const a = S.arc.get(key);
  return a ? { ...a, done: true } : null;
}
function tapeDay(code, d) {
  return tapeState(code, d) || null;
}
/** 快照的資料時間：證交所那筆資料本身的時間（q）；舊快照沒有就用一定不晚於它的時間 */
function dataTime(s, i, d) {
  const q = s.q && s.q[i];
  if (q != null) return q * 1000;
  const asked = s.t[i] * 1000;
  const lb = asked - LAG_MAX;
  const zt = hmsMs(d, s.zt[i]);
  return zt != null && zt <= asked ? Math.max(zt, lb) : lb;
}
/** 逐輪快照，依資料時間排好；資料時間沒有往前的（同一筆資料重複、順序亂掉）不重複用 */
export function ticksOf(rec, kind, d) {
  const s = rec && rec[kind];
  if (!s || !s.t || !s.t.length) return null;
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < s.t.length; i++) {
    const t = dataTime(s, i, d);
    if (!(t > last)) continue;
    last = t;
    out.push({ t, z: s.z[i], zt: hmsMs(d, s.zt[i]), h: s.h[i], l: s.l[i], v: s.v[i], a: s.a[i] || [], b: s.b[i] || [] });
  }
  return out;
}
function kDay(code, d) {
  const k = S.k.get(code);
  if (!k || !k.d) return null;
  const i = k.d.indexOf(d);
  if (i < 0) return null;
  return { o: k.o[i], h: k.h[i], l: k.l[i], c: k.c_[i], v: k.v[i] };
}
/** 一份依日期排好的資料（日 K、歷史檔）有沒有涵蓋到 d：'in' 涵蓋、'before' d 比它最早的還早、'after' d 比它最新的還新（資料還沒更新到） */
function span(x, d) {
  if (!x || !x.d || !x.d.length) return null;
  if (d < x.d[0]) return 'before';
  if (d > x.d[x.d.length - 1]) return 'after';
  return 'in';
}
/**
 * 那一天的盤中行情是不是已經結束（不會再有新的快照）。拿不準就 false（撮合等）：
 * 這一檔的 tape 還沒拿到新鮮的、封存還沒讀到、有那一天的 tape 但後台還沒標「結束」。
 * 只有「確定沒有那一天的 tape」（後台那天沒跑、封存確定沒有）才看官方收盤資料出來了沒。
 */
export function finalDay(code, d) {
  const tp = S.tape.get(code);
  if (!tp || tp.unk) return false;
  const rec = tapeState(code, d);
  if (rec === undefined) return false;
  if (tp.cur && tp.cur.d > d) return true;
  if (rec) return !!rec.done;
  return !!(S.summary && S.summary.asof >= d);
}
/**
 * 官方那一天的日 K（收盤資料出來以後才有）：物件＝有；null＝確定沒有（那天沒有成交、還沒上市、沒有這檔的日 K）；
 * undefined＝還不知道（收盤資料還沒出來、日 K 還沒抓到或還沒更新到那一天）。
 */
function officialDay(code, d) {
  if (!(S.summary && S.summary.asof >= d)) return undefined;
  if (!S.k.has(code)) return undefined;
  const k = S.k.get(code);
  if (k === null) return null;
  const sp = span(k, d);
  if (sp === 'after') return undefined;
  if (sp !== 'in') return null;
  return kDay(code, d);
}
/** 官方收盤價：數字、null（確定沒有）、undefined（還不知道） */
function officialClose(code, d) {
  if (!(S.summary && S.summary.asof >= d)) return undefined;
  const r = row(code);
  if (r && r.d === d) return r.p;
  const od = officialDay(code, d);
  if (od === undefined) return undefined;
  return od && od.c > 0 ? od.c : null;
}
function closeAuctionOf(code, d, kind) {
  const tks = ticksOf(tapeDay(code, d), kind, d) || [];
  const c0 = atTW(d, 1330);
  for (const x of tks) if (x.t >= c0 && x.zt != null && x.zt >= c0) return { known: true, px: x.z };
  if (tks.some((x) => x.t >= atTW(d, 1331))) return { known: true, px: null };
  if (finalDay(code, d)) {
    if (kind === 'odd') return { known: true, px: null };
    const px = officialClose(code, d);
    return px === undefined ? { known: false, px: null } : { known: true, px };
  }
  return { known: false, px: null };
}

export function mkt() {
  return {
    cal: S.cal,
    ticks: (c, d, kind) => ticksOf(tapeDay(c, d), kind, d),
    final: (c, d) => finalDay(c, d),
    day: (c, d) => {
      const rec = tapeDay(c, d);
      const official = officialClose(c, d);
      const tks = rec ? ticksOf(rec, 'reg', d) : null;
      if (tks && tks.length) {
        const x = tks[tks.length - 1];
        const ca = closeAuctionOf(c, d, 'reg');
        // 收盤價：數字；null＝確定沒有；undefined＝還不知道（盤後定價會等）
        const cc = isNum(official) ? official : ca.known ? ca.px : official === null ? null : undefined;
        return { o: rec.o ?? null, h: x.h, l: x.l, v: x.v, u: rec.u ?? null, w: rec.w ?? null, y: rec.y ?? null, c: cc };
      }
      const kd = kDay(c, d);
      if (kd) return { ...kd, c: official ?? kd.c, u: null, w: null };
      if (isNum(official)) return { c: official, u: null, w: null };
      // 今天還沒有 tape（例如剛開盤）：用最新的快照
      const q = quoteOf(c);
      if (q && q.d === d) return { o: q.o, h: q.h, l: q.l, v: q.v, u: q.u, w: q.w, y: q.y, c: null };
      return null;
    },
    // 官方日 K：物件／null（確定沒有）／undefined（還不知道，撮合要等）
    official: (c, d) => officialDay(c, d),
    oddOpen: (c, d) => { const rec = tapeDay(c, d); return rec ? rec.oo ?? null : null; },
    closeAuction: (c, d, kind) => closeAuctionOf(c, d, kind),
    after: (c, d) => {
      const r = row(c);
      if (r && r.m === 'otc') return S.summary && S.summary.asof >= d ? null : undefined;   // 上櫃沒有盤後資料（下單時已經擋下）：官方收盤資料出來就確定沒有
      const A = S.after || {};
      const key = String(d);
      const day = A[key] || S.afterDays.get(key);
      if (day) return day[c] ?? null;
      const days = A._days || [];
      if (days.includes(d)) return undefined;                              // 有這一天，還沒抓
      if (days.length && (d < days[0] || days.some((x) => x > d))) return null;   // 確定沒有那一天的資料
      return undefined;                                                    // 還沒公布
    },
    market: (c) => (row(c) || {}).m || 'tse',
    cat: (c) => (row(c) || {}).k || 'broad',
    asof: () => (S.summary ? S.summary.asof : null),
    // 某天的官方收盤價：null＝確定那天沒有成交（停止交易、下市）、undefined＝資料還沒到
    // 確定沒有：日 K 或歷史檔涵蓋到那一天卻沒有那一天（停止交易）、那時候還沒上市、已經下市；
    // 日 K、歷史檔還沒抓到（或抓失敗）、還沒更新到那一天：undefined，定期定額會等，不會跳過那一期
    close: (c, d) => {
      if (!(S.summary && S.summary.asof >= d)) return undefined;
      const r = row(c);
      if (r && r.d === d) return r.p;
      if (r && r.d < d) return null;                // 官方資料已經到 d 以後，這檔最後一次成交在 d 之前：d 那天沒有成交
      const k = S.k.get(c);
      const h = S.hist.get(c);
      if (span(k, d) === 'in') { const kd = kDay(c, d); return kd && kd.c > 0 ? kd.c : null; }
      if (span(h, d) === 'in') { const i = h.d.indexOf(d); return i >= 0 && h.p[i] > 0 ? h.p[i] : null; }
      if (span(k, d) === 'before' || span(h, d) === 'before') return null;   // 那時候還沒上市
      if (!r && S.k.has(c) && S.hist.has(c)) return null;                      // 已經下市、兩份都沒有那一天
      return undefined;
    },
    divs: (c) => (S.divs[c] && S.divs[c].d) || [],
    splits: (c) => (S.divs[c] && S.divs[c].s) || [],
    last: (c) => lastPx(c),
  };
}

/** 今天是不是交易日（給畫面） */
export function tradingToday() {
  return isTradingDay(S.cal, tw(serverNow()).d);
}
