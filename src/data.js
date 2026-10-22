/* 沙盤 — 資料：全部來自冷眼後台抓的官方資料（同一個網站底下的 /coldeye-etf/data/），沙盤自己不抓、不送任何東西出去。
   伺服器時間：每次抓資料時讀回應的 Date（GitHub 的時鐘），委託時間一律用它，手機時鐘調快調慢都沒用。 */
import { atTW, tw, makeCal, isTradingDay, dow } from './rules.js';

const qs = new URLSearchParams(location.search);
export const BASE = new URL(qs.get('data') || '../coldeye-etf/data/', location.href).href;

export const S = {
  summary: null, rows: new Map(), live: null, quotes: null, calRaw: null, cal: makeCal(), divs: {}, after: {},
  news: null, version: null, skew: 0, skewAt: 0, offline: false, lastOk: 0,
  tape: new Map(), k: new Map(), hist: new Map(), detail: new Map(),
  closedToday: new Set(), err: null,
};

function noteDate(r) {
  const h = r.headers.get('Date');
  const ms = h ? Date.parse(h) : NaN;
  if (Number.isFinite(ms) && r.headers.get('X-Sandtable-Offline') !== '1') {
    // Date 只到秒：取這次與上次的較大值，避免時間倒退
    S.skew = ms + 500 - Date.now();
    S.skewAt = Date.now();
  }
}
/** 伺服器現在時間（毫秒）。還沒抓過資料時退回手機時鐘（只用來顯示，不拿來下單）。 */
export function serverNow() { return Date.now() + S.skew; }
export function hasServerTime() { return S.skewAt > 0; }

async function get(path, { fresh = false, tolerate404 = false } = {}) {
  const t = fresh ? Date.now() : Math.floor(Date.now() / 30000);
  const r = await fetch(`${BASE}${path}?t=${t}`, { cache: 'no-store' });
  if (tolerate404 && r.status === 404) return null;
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  noteDate(r);
  const off = r.headers.get('X-Sandtable-Offline') === '1';
  if (path === 'quotes.json' || path === 'version.json') S.offline = off;
  if (!off) S.lastOk = Date.now();
  return r.json();
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
    get('quotes.json').then((x) => { S.quotes = x; }).catch(() => {}),
    get('cal.json').then((x) => { S.calRaw = x; }).catch(() => {}),
    get('divs.json').then((x) => { S.divs = x || {}; }).catch(() => {}),
    get('after.json').then((x) => { S.after = x || {}; }).catch(() => {}),
    get('news.json').then((x) => { S.news = x; }).catch(() => {}),
    get('version.json').then((x) => { S.version = x; }).catch(() => {}),
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
  ];
  const { hm } = tw(now);
  if (!S.summary || hm >= 1400 || hm < 900) jobs.push(get('summary.json').then(indexSummary).catch(() => {}));
  if (hm >= 1435 || hm < 900) jobs.push(get('after.json').then((x) => { S.after = x || {}; }).catch(() => {}));
  if (hm >= 1400 || hm < 900) {
    jobs.push(get('divs.json').then((x) => { S.divs = x || {}; }).catch(() => {}));
    jobs.push(get('cal.json').then((x) => { S.calRaw = x; }).catch(() => {}));
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
  // 只看後台自己的判斷（live.json 的 at 是後台這一輪的時間）；後台沒跑不代表休市，不能亂判。
  const qd = quotesDay();
  const L = S.live;
  const at = L && L.at ? Date.parse(L.at) : NaN;
  if (Number.isFinite(at)) {
    const { d, hm } = tw(at);
    if (dow(d) > 0 && dow(d) < 6 && hm >= 915 && L.date && L.date < d && !cal.holidays.has(d)) S.closedToday.add(d);
  }
  for (const x of S.closedToday) cal.closed.add(x);
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

export async function loadTape(code) {
  try {
    const x = await get(`tape/${code}.json`, { tolerate404: true });
    S.tape.set(code, x || { c: code, cur: null, prev: null });
  } catch { if (!S.tape.has(code)) S.tape.set(code, { c: code, cur: null, prev: null }); }
  return S.tape.get(code);
}
export async function ensureTape(code) { return S.tape.has(code) ? S.tape.get(code) : loadTape(code); }
export async function ensureK(code) {
  if (S.k.has(code)) return S.k.get(code);
  try { S.k.set(code, await get(`k/${code}.json`, { tolerate404: true })); } catch { S.k.set(code, null); }
  return S.k.get(code);
}
export async function ensureHist(code) {
  if (S.hist.has(code)) return S.hist.get(code);
  try { S.hist.set(code, await get(`hist/${code}.json`, { tolerate404: true })); } catch { S.hist.set(code, null); }
  return S.hist.get(code);
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
  S.skew = T + 500 - Date.now();
  S.skewAt = Date.now();
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

// ------------------------------------------------------------------ 給撮合引擎的介面
function hmsMs(d, x) {
  if (x == null) return null;
  return atTW(d, Math.floor(x / 100), x % 100);
}
function tapeDay(code, d) {
  const tp = S.tape.get(code);
  if (!tp) return null;
  if (tp.cur && tp.cur.d === d) return tp.cur;
  if (tp.prev && tp.prev.d === d) return tp.prev;
  return null;
}
function ticksOf(rec, kind, d) {
  const s = rec && rec[kind];
  if (!s || !s.t || !s.t.length) return null;
  return s.t.map((t, i) => ({
    t: t * 1000, z: s.z[i], zt: hmsMs(d, s.zt[i]), h: s.h[i], l: s.l[i], v: s.v[i], a: s.a[i] || [], b: s.b[i] || [],
  }));
}
function kDay(code, d) {
  const k = S.k.get(code);
  if (!k || !k.d) return null;
  const i = k.d.indexOf(d);
  if (i < 0) return null;
  return { o: k.o[i], h: k.h[i], l: k.l[i], c: k.c_[i], v: k.v[i] };
}

export function mkt() {
  return {
    cal: S.cal,
    ticks: (c, d, kind) => ticksOf(tapeDay(c, d), kind, d),
    day: (c, d) => {
      const rec = tapeDay(c, d);
      const r = row(c);
      const official = r && r.d === d && S.summary && S.summary.asof >= d ? r.p : null;
      if (rec && rec.reg && rec.reg.t && rec.reg.t.length) {
        const s = rec.reg;
        const n = s.t.length - 1;
        const post = s.t[n] * 1000 >= atTW(d, 1331) ? s.z[n] : null;
        return { o: rec.o ?? null, h: s.h[n], l: s.l[n], v: s.v[n], u: rec.u ?? null, w: rec.w ?? null, y: rec.y ?? null, c: official ?? post };
      }
      const kd = kDay(c, d);
      if (kd) return { ...kd, u: null, w: null };
      if (official != null) return { c: official, v: 1, u: null, w: null };
      // 今天還沒有 tape（例如剛開盤）：用最新的快照
      const q = quoteOf(c);
      if (q && q.d === d) return { o: q.o, h: q.h, l: q.l, v: q.v, u: q.u, w: q.w, y: q.y, c: null };
      return null;
    },
    oddOpen: (c, d) => { const rec = tapeDay(c, d); return rec ? rec.oo ?? null : null; },
    closeAuction: (c, d, kind) => {
      const rec = tapeDay(c, d);
      const s = rec && rec[kind];
      if (s && s.t && s.t.length) {
        const n = s.t.length - 1;
        if (s.t[n] * 1000 >= atTW(d, 1331)) {
          const zt = hmsMs(d, s.zt[n]);
          return { known: true, px: zt != null && zt >= atTW(d, 1330) ? s.z[n] : null };
        }
        return { known: serverNow() > atTW(d, 1600), px: null };
      }
      if (kind === 'odd') {
        // 沒有零股資料：等到傍晚就當作收盤時零股沒撮合
        return { known: serverNow() > atTW(d, 1600), px: null };
      }
      const kd = kDay(c, d);
      const r = row(c);
      const px = kd ? kd.c : r && r.d === d ? r.p : null;
      return px != null ? { known: true, px } : { known: serverNow() > atTW(d, 1600), px: null };
    },
    after: (c, d) => {
      const r = row(c);
      if (r && r.m === 'otc') return undefined;
      const day = S.after && S.after[String(d)];
      if (!day) return undefined;
      return day[c] ?? null;
    },
    market: (c) => (row(c) || {}).m || 'tse',
    cat: (c) => (row(c) || {}).k || 'broad',
    // 某天的官方收盤價：null＝那天沒有成交（停止交易）、undefined＝資料還沒到
    close: (c, d) => {
      const r = row(c);
      if (r && r.d === d && S.summary && S.summary.asof >= d) return r.p;
      const kd = kDay(c, d);
      if (kd && kd.c > 0) return kd.c;
      const h = S.hist.get(c);
      if (h && h.d && h.d.length) {
        const i = h.d.indexOf(d);
        if (i >= 0) return h.p[i];
        if (h.d[h.d.length - 1] > d) return null;
      }
      if (S.summary && S.summary.asof > d && r && r.d >= d) return null;
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
