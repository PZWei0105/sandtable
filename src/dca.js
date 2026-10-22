/* 沙盤 — 定期定額（照國泰證券的規則，跟冷眼記錄真實定期定額用的是同一套規則）。純函式。
   國泰官方說明：https://istockapp.cathaysec.com.tw/Marketing/DCA/
   - 每月 1～31 號任選、可多選；遇休市順延到下一個交易日；那個月沒有的日期（例如 2/30）那一期不買。
   - 每筆金額已含手續費（2026/12/31 前每筆 1 元），以百元為單位、最低 100 元；買零股、不設價格。
   - 申請、變更、終止都是 1 個交易日後生效，最晚要在扣款日前 2 天送出（送出日之後第 2 個交易日起才照新設定扣）。
   - 扣款失敗（餘額不足）不補扣；連續 3 次失敗自動終止全部台股定期定額。股票停止交易（例如分割）那幾天不扣也不補。
   沙盤的成交價：扣款日（成交日）的官方收盤價（真實是盤中、盤後分批買零股，收盤價是最接近的公開價格）。 */
import { tw, atTW, addDays, isTradingDay, nextTradingDay, addTradingDays, amountOf } from './rules.js';
import { ledger } from './engine.js';

export const DCA_PROMO_UNTIL = 20261231;   // 國泰定期定額每筆手續費 1 元的優惠到這天
export const DCA_MIN = 100;
export const DCA_FAILS_STOP = 3;

/** 送出（申請、變更、終止）之後，第一個照新設定扣款的交易日 */
export function cutover(cal, d) { return addTradingDays(cal, d, 2); }

function daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** 某個計畫在 [from, to]（成交日）之間的每一期：{ s: 原本扣款日, d: 成交日 } */
export function schedule(plan, cal, from, to) {
  const out = [];
  if (!(from <= to)) return out;
  let y = Math.floor(from / 10000);
  let m = Math.floor(from / 100) % 100;
  // 往前多看一個月：月底的扣款日可能順延到下個月
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  for (let k = 0; k < 600; k++) {
    const first = y * 10000 + m * 100 + 1;
    if (first > to) break;
    for (const day of [...plan.days].sort((a, b) => a - b)) {
      if (day > daysIn(y, m)) continue;                   // 2/30 這種日期：那一期不買
      const s = y * 10000 + m * 100 + day;
      const d = isTradingDay(cal, s) ? s : nextTradingDay(cal, s);
      if (d < from || d > to) continue;
      if (d < plan.start || (plan.end && d > plan.end)) continue;
      out.push({ s, d });
    }
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out.sort((a, b) => a.d - b.d || a.s - b.s);
}

export function feeFor(plan, d) {
  if (d <= DCA_PROMO_UNTIL) return 1;
  return Math.max(0, Math.round(plan.fee ?? 1));
}

/**
 * 把定期定額推進到現在：每一期在成交日收盤後，用官方收盤價買零股（股數＝(金額－手續費)÷收盤價，無條件捨去）。
 * 回傳 { newFills, log: {期別 key: {st, d, why}}, stopAt: 連續失敗 3 次時的停扣日 }。
 * mkt.close(code, d) 要回傳那天的官方收盤價（沒有成交回傳 null；資料還沒到回傳 undefined）。
 */
export function runDca(run, mkt, nowMs) {
  const { d: today, hm } = tw(nowMs);
  const plans = run.plans || [];
  const log = { ...(run.dcaLog || {}) };
  const newFills = [];
  if (!plans.length) return { newFills, log, stopAt: null };
  const lastDone = hm >= 1430 ? today : addDays(today, -1);   // 今天收盤價 14:30 以後才算確定
  // 依時間順序處理所有計畫的每一期（扣款要看當時的可用額度）
  const periods = [];
  for (const p of plans) {
    for (const x of schedule(p, mkt.cal, Math.max(p.start, run.start.d), Math.min(lastDone, p.end || lastDone))) {
      periods.push({ p, ...x, key: `${p.id}:${x.s}` });
    }
  }
  periods.sort((a, b) => a.d - b.d || a.s - b.s || (a.p.id < b.p.id ? -1 : 1));
  let fills = [...(run.fills || [])];
  let fails = 0;
  const ordered = Object.values(log).filter((x) => x.st === 'ok' || x.st === 'fail').sort((a, b) => a.d - b.d);
  for (const x of ordered) fails = x.st === 'fail' ? fails + 1 : 0;
  let stopAt = null;
  for (const per of periods) {
    if (log[per.key]) continue;
    if (stopAt) break;
    const px = mkt.close(per.p.c, per.d);
    if (px === undefined) {
      // 資料還沒到：最多等 10 天，之後當成沒辦法扣
      if (per.d < addDays(today, -10)) log[per.key] = { st: 'skip', d: per.d, why: '沒有那天的收盤資料' };
      continue;
    }
    if (px === null || !(px > 0)) { log[per.key] = { st: 'halt', d: per.d, why: '那天沒有成交（停止交易），這期不扣也不補' }; continue; }
    const fee = feeFor(per.p, per.d);
    const qty = Math.floor((per.p.amt - fee) / px);
    if (qty < 1) { log[per.key] = { st: 'fail', d: per.d, why: `金額不夠買 1 股（收盤 ${px}）` }; fails++; }
    else {
      // 用「那個時間點」的帳戶算可用額度：之後才有的成交、之後才下的委託都不算
      const T = atTW(per.d, 1430);
      const L = ledger({ ...run, fills: fills.filter((f) => f.t <= T), orders: (run.orders || []).filter((o) => o.at <= T) }, mkt, T);
      if (L.avail < per.p.amt) {
        log[per.key] = { st: 'fail', d: per.d, why: `扣款失敗：可用額度 ${Math.floor(L.avail).toLocaleString()} 不夠 ${per.p.amt.toLocaleString()}（不補扣）` };
        fails++;
      } else {
        const amt = amountOf(qty, px);
        const f = {
          id: `dca:${per.key}`, oid: `dca:${per.p.id}`, t: atTW(per.d, 1430), d: per.d, code: per.p.c, side: 'B', sess: 'dca',
          qty, px, amt, fee, fin: fee, tax: 0, how: 'dca', s: per.s,
        };
        newFills.push(f);
        fills = [...fills, f];
        log[per.key] = { st: 'ok', d: per.d, qty, px };
        fails = 0;
      }
    }
    if (fails >= DCA_FAILS_STOP) stopAt = per.d;
  }
  return { newFills, log, stopAt };
}

/** 下一次扣款（成交日），沒有就 null */
export function nextRun(plan, cal, today) {
  const to = addDays(today, 70);
  const s = schedule(plan, cal, today, plan.end ? Math.min(plan.end, to) : to);
  return s.length ? s[0] : null;
}
