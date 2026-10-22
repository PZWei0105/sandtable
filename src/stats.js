/* 沙盤 — 戰報：每天收盤的總資產、和「同期間一直抱著 0050（含息）」比較、最大回撤、勝率。
   純函式。hist(code) 回傳冷眼的 hist/{代號}.json：{d:[日期], p:[原始收盤], splits:[[日,倍]], divs:[[除息日,現金]]}。 */
import { atTW, tw } from './rules.js';
import { ledger } from './engine.js';

export const BENCH = '0050';

export function closeOn(h, d) {
  if (!h || !h.d || !h.d.length) return null;
  let lo = 0;
  let hi = h.d.length - 1;
  if (h.d[0] > d) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (h.d[mid] <= d) lo = mid; else hi = mid - 1;
  }
  return h.p[lo];
}

/** 0050 含息報酬指數（配息再投入、分割調整），從 startPx（開局當下的價格）起算 */
export function benchIndex(h, startD, startPx, days, liveToday) {
  const out = [];
  if (!h || !h.d) return out;
  const splits = new Map((h.splits || []).map(([d, k]) => [d, k]));
  const divs = new Map((h.divs || []).map(([d, c]) => [d, c]));
  let idx = 1;
  let prev = startPx || closeOn(h, startD);
  for (const d of days) {
    let px = d === liveToday?.d && liveToday.px ? liveToday.px : closeOn(h, d);
    if (!(px > 0) || !(prev > 0)) { out.push(idx); continue; }
    let adj = px;
    if (splits.has(d)) prev = prev / splits.get(d);          // 分割：前一天的價格換成新基準
    if (divs.has(d) && d > startD) adj = px + divs.get(d);    // 除息：配息加回
    idx *= adj / prev;
    prev = px;
    out.push(idx);
  }
  return out;
}

/**
 * 每個交易日收盤的總資產（今天用即時價）。days：開局那天到今天的交易日。
 * 每一天只算到那天收盤為止的成交與委託（ledger 依時間切），不會把之後的交易算進以前的淨值。
 * 回傳 { days, nav:[元], ret:[報酬], bench:[同期 0050 報酬], mdd, maxNav }
 */
export function navSeries(run, mkt, hist, nowMs, days) {
  const today = tw(nowMs).d;
  const nav = [];
  for (const d of days) {
    const isToday = d === today;
    const m = {
      ...mkt,
      last: (c) => (isToday ? mkt.last(c) : closeOn(hist(c), d) ?? mkt.last(c)),
    };
    const L = ledger(run, m, isToday ? nowMs : atTW(d, 2359));
    nav.push(L.equity);
  }
  const cap = run.capital;
  const ret = nav.map((x) => x / cap - 1);
  const bh = hist(BENCH);
  const startPx = run.start.bench || null;
  const live0050 = mkt.last(BENCH);
  const bi = benchIndex(bh, run.start.d, startPx, days, { d: today, px: live0050 });
  const bench = bi.map((x) => x - 1);
  let peak = -Infinity;
  let mdd = 0;
  for (const x of nav) {
    peak = Math.max(peak, x);
    if (peak > 0) mdd = Math.min(mdd, x / peak - 1);
  }
  return { days, nav, ret, bench, mdd, maxNav: peak };
}

/** 戰報數字 */
export function report(run, L, series) {
  const sells = L.sells || [];
  const wins = sells.filter((s) => s.pnl > 0).length;
  const losses = sells.filter((s) => s.pnl < 0).length;
  const fills = (run.fills || []).length;
  const ret = L.equity / run.capital - 1;
  const bench = series && series.bench.length ? series.bench[series.bench.length - 1] : null;
  const avgEq = series && series.nav.length ? series.nav.reduce((s, x) => s + x, 0) / series.nav.length : run.capital;
  const realized = L.holdings.reduce((s, h) => s + h.realized, 0);
  const unreal = L.holdings.reduce((s, h) => s + (h.mv != null && h.sh > 0 ? h.mv - h.cost : 0), 0);
  const divs = L.divItems.reduce((s, x) => s + x.net, 0);
  return {
    ret, bench, excess: bench == null ? null : ret - bench,
    mdd: series ? series.mdd : 0,
    fills, sells: sells.length, wins, losses, winRate: sells.length ? wins / sells.length : null,
    best: sells.reduce((b, s) => (!b || s.pnl > b.pnl ? s : b), null),
    worst: sells.reduce((b, s) => (!b || s.pnl < b.pnl ? s : b), null),
    fees: L.feesPaid, taxes: L.taxesPaid, divs, realized, unreal,
    turnover: avgEq > 0 ? L.buyAmt / avgEq : 0,
    exposure: L.equity > 0 ? L.mv / L.equity : 0,
  };
}

/**
 * 一天的戰報（今日戰報卡）：prevDay 收盤 → day 收盤（day 是今天就用即時價、算到 nowMs）。
 * 每一檔的貢獻＝今天的市值－昨天的市值－買進花的錢＋賣出拿回的錢＋除息的配息，全部加起來就是總資產的變化
 * （手續費用最後實收的、日退的退款在成交當下就算進總資產，和 ledger 一致）；對不上的部分放在 other（例如入金出金）。
 * 和 0050 比：同一天 0050 含息的漲跌（開局當天從開局那一刻的價格算）。
 */
export function dayReport(run, mkt, hist, nowMs, prevDay, day) {
  const today = tw(nowMs).d;
  const live = day === today;
  const priceOn = (d, isLive) => (c) => (isLive ? mkt.last(c) : closeOn(hist(c), d) ?? mkt.last(c));
  const t1 = live ? nowMs : atTW(day, 2359);
  const L0 = ledger(run, { ...mkt, last: priceOn(prevDay, false) }, atTW(prevDay, 2359));
  const L1 = ledger(run, { ...mkt, last: priceOn(day, live) }, t1);
  const rows = new Map();
  const row = (c) => {
    if (!rows.has(c)) rows.set(c, { code: c, sh0: 0, px0: null, sh1: 0, px1: null, buy: 0, sell: 0, div: 0, pnl: 0 });
    return rows.get(c);
  };
  for (const h of L0.holdings) if (h.sh > 0) Object.assign(row(h.code), { sh0: h.sh, px0: h.px });
  for (const h of L1.holdings) if (h.sh > 0) Object.assign(row(h.code), { sh1: h.sh, px1: h.px });
  let fills = 0; let buyAmt = 0; let sellAmt = 0; let fees = 0; let taxes = 0;
  for (const f of run.fills || []) {
    if (f.d !== day || f.t > t1) continue;
    const x = row(f.code);
    const fee = f.fin ?? f.fee ?? 0;
    fills++;
    fees += fee;
    taxes += f.tax || 0;
    if (f.side === 'B') { x.buy += f.amt + fee; buyAmt += f.amt; } else { x.sell += f.amt - fee - (f.tax || 0); sellAmt += f.amt; }
  }
  for (const it of L1.divItems) if (it.ex === day) row(it.code).div += it.net;
  let sum = 0;
  for (const x of rows.values()) {
    x.pnl = x.sh1 * (x.px1 || 0) - x.sh0 * (x.px0 || 0) - x.buy + x.sell + x.div;
    sum += x.pnl;
  }
  const eq0 = L0.equity;
  const eq1 = L1.equity;
  const started = prevDay < run.start.d;      // 這一天才開局：從開局那一刻算
  const bi = benchIndex(hist(BENCH), started ? run.start.d : prevDay, started ? run.start.bench || null : null, [day], { d: today, px: mkt.last(BENCH) });
  return {
    day, prevDay, live, started, eq0, eq1, pnl: eq1 - eq0, ret: eq0 > 0 ? eq1 / eq0 - 1 : null,
    bench: bi.length ? bi[0] - 1 : null,
    rows: [...rows.values()].filter((x) => Math.abs(x.pnl) >= 0.5 || x.sh1 > 0).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)),
    other: eq1 - eq0 - sum, fills, buyAmt, sellAmt, fees, taxes,
  };
}
