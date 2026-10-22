/* 沙盤 SANDTABLE — 撮合引擎與帳務（純函式：不碰畫面、不連網、不讀時鐘，同樣的輸入永遠得到同樣的結果）。

   核心原則：跟真的下單一樣，不能作弊。
   1. 委託時間＝伺服器時間（App 送單時向網站要的 HTTP Date），不是手機時鐘。
   2. 委託只會用「委託時間之後」才出現的行情成交：盤中單在下一筆快照成交（看那一刻的五檔），
      掛著的限價單要價格「穿過」才算（剛好碰到不算：真實世界要排隊），收盤集合競價、盤後也一樣保守。
   3. 成交一旦算出來就存進紀錄，之後資料怎麼補都不會改；不能修改、不能刪除，只能刪單、減量。

   行情介面 mkt（由 data.js 提供）：
     mkt.cal                         交易日曆（rules.makeCal）
     mkt.ticks(code, d, 'reg'|'odd') 那一天的逐輪快照 [{t, z, zt, h, l, v, a:[[價,股]], b:[[價,股]]}]，沒有就 null
     mkt.day(code, d)                那一天的 {o,h,l,c,v,u,w,y}（收盤價 c 要確定了才有），沒有就 null
     mkt.oddOpen(code, d)            盤中零股第一次撮合價
     mkt.closeAuction(code, d, kind) 13:30 收盤集合競價：{known: 能不能判斷了, px: 13:30 撮合成交價（沒成交是 null）}
     mkt.after(code, d)              證交所盤後結果 [盤後零股價, 股數, 盤後定價股數, 定價買量, 定價賣量]；
                                     undefined＝還沒公布，null＝公布了但這檔沒有
     mkt.market(code)                'tse'｜'otc'
     mkt.cat(code)                   類別（broad／div／bond…）
     mkt.divs(code)                  [[除息日, 每單位現金]]，mkt.splits(code) [[生效日, 倍數]]
     mkt.close(code, d)              某天收盤價（估值用），mkt.last(code) 目前最新價 */

import {
  tw, atTW, windows, isTradingDay, nextTradingDay, addTradingDays, settleDay, LOT,
  amountOf, feeCharged, feeFinal, taxOf, taxRate, NHI_RATE, NHI_MIN, DIV_PAY_LAG, r2,
} from './rules.js';

// ------------------------------------------------------------------ 小工具
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const SIDE_NAME = { B: '買進', S: '賣出' };
export const TYPE_NAME = { L: '限價', M: '市價', C: '收盤價' };
export const ST_NAME = {
  wait: '委託中', queued: '預約中', live: '委託中', part: '部分成交', filled: '全部成交', cancelling: '刪單中',
  cancelled: '已刪單', expired: '未成交', rejected: '退單',
};

/** 目前有效的委託數量（考慮減量、刪單）；t 之前（不含 t）送出的改單才算 */
export function qtyAt(o, mods, t) {
  let q = o.qty;
  let cancelled = false;
  for (const m of mods) {
    if (m.oid !== o.id || !(m.at < t)) continue;
    if (m.kind === 'cancel') cancelled = true;
    else if (m.kind === 'reduce') q = Math.max(0, q - m.qty);
  }
  return { q, cancelled };
}

// 掛著的委託在 t 時剩多少（減掉已成交）
function remainingAt(o, mods, t, filled) {
  const { q, cancelled } = qtyAt(o, mods, t);
  if (cancelled) return 0;
  return Math.max(0, q - filled);
}

/** 從五檔依價格吃單：side B 吃賣方（a 由低到高），S 吃買方（b 由高到低）。limit=null 表示市價。 */
export function walkBook(levels, side, qty, limit) {
  const fills = [];
  let left = qty;
  for (const [px, vol] of levels || []) {
    if (left <= 0) break;
    if (!(px > 0) || !(vol > 0)) continue;
    if (limit != null && (side === 'B' ? px > limit + 1e-9 : px < limit - 1e-9)) break;
    const n = Math.min(left, vol);
    fills.push({ px, qty: n });
    left -= n;
  }
  return { fills, filled: qty - left };
}

// 零股撮合以「股」為單位；整股要整張。可成交量取整張。
function roundLot(n, sess) {
  return sess === 'reg' || sess === 'fix' ? Math.floor(n / LOT) * LOT : Math.floor(n);
}

// ------------------------------------------------------------------ 單筆委託的推進
/**
 * 把一筆委託往前推進到目前資料能決定的地方。
 * prog（存起來的進度）：{ st, act, L, H, zt0, cut, filled, open }
 *   st：'wait' 還沒開始撮合／'live' 掛著／'done' 結束
 *   act：開始撮合的時間；L／H：開始撮合時的當日最低／最高（之後創新低／新高才算穿價）
 *   cut：已經處理到哪一筆快照；filled：已成交股數
 * 回傳 { prog, fills: [{t, px, qty, how}], done: {st, why, t} | null }
 */
export function advance(o, prog0, mods, mkt, nowMs) {
  const prog = { st: 'wait', act: null, L: null, H: null, zt0: null, cut: 0, filled: 0, ...prog0 };
  const out = { prog, fills: [], done: null };
  if (prog.st === 'done') return out;
  const D = o.day;
  const w = windows(D);
  const kind = o.sess === 'odd' ? 'odd' : 'reg';
  const isB = o.side === 'B';
  const remain = (t) => remainingAt(o, mods, t, prog.filled);
  const fill = (t, px, qty, how) => {
    if (!(qty > 0)) return;
    out.fills.push({ t, px: r2(px), qty, how });
    prog.filled += qty;
    if (prog.filled >= qtyAt(o, mods, Infinity).q) prog.full = true;   // 全部成交了（之後的刪單無效）
  };
  const finish = (st, why, t) => {
    prog.st = 'done';
    out.done = { st, why: why || '', t };
  };
  const nextOpen = () => atTW(nextTradingDay(mkt.cal, D), 900);
  const sessFrom = { reg: w.regFrom, odd: w.oddFrom, oddpm: w.oddpmFrom, fix: w.fixFrom }[o.sess] || w.regFrom;

  // 還沒開始撮合（預約單、開盤前、盤中零股第一次撮合前、盤後單 14:30 前）就刪單：不可能已經成交，馬上確定
  const startAt = o.sess === 'fix' || o.sess === 'oddpm' ? atTW(D, 1430) : atTW(D, o.sess === 'odd' ? w.oddFirst : w.regOpen);
  if (prog.st === 'wait' && o.at < startAt) {
    const c = mods.find((m) => m.oid === o.id && m.kind === 'cancel' && m.at < startAt && m.at <= nowMs);
    if (c) { finish('cancelled', '已刪單', c.at); return out; }
  }
  if (nowMs < atTW(D, sessFrom)) return out;           // 預約單：還沒到那一天
  if (!isTradingDay(mkt.cal, D)) {                      // 那天後來休市（颱風假）：預約單作廢
    if (nowMs > atTW(D, 1430)) finish('expired', `${fmtD(D)} 休市，委託失效`, atTW(D, 1430));
    return out;
  }
  const day = mkt.day(o.code, D) || {};
  const oddTicks = kind === 'odd' ? mkt.ticks(o.code, D, 'odd') : null;
  const usingRegForOdd = kind === 'odd' && !(oddTicks && oddTicks.length);
  // 只用「現在以前」的快照（資料不可能來自未來；測試或時鐘異常時也不會偷看答案）
  const ticksAll = ((kind === 'odd' && !usingRegForOdd ? oddTicks : mkt.ticks(o.code, D, 'reg')) || []).filter((x) => x.t <= nowMs);

  // ---------------- 盤後定價：14:30 一律用收盤價成交
  if (o.sess === 'fix') {
    const t = atTW(D, 1430);
    if (nowMs < t || !isNum(day.c)) return out;
    const q = remain(t);
    if (q <= 0) { finish('cancelled', '已刪單', t); return out; }
    const af = mkt.after(o.code, D);
    if (af === undefined && mkt.market(o.code) === 'tse' && nowMs < nextOpen()) return out;   // 等證交所公布盤後結果
    let ok = (day.v || 0) > 0;
    if (af) ok = af[2] > 0 || (isB ? af[4] > 0 : af[3] > 0);
    else if (af === null) ok = false;
    if (ok) fill(t, day.c, q, 'fix');
    finish(prog.filled ? 'filled' : 'expired', prog.filled ? '' : '盤後定價沒有對手單，未成交', t);
    return out;
  }

  // ---------------- 盤後零股：14:30 集合競價一次撮合
  if (o.sess === 'oddpm') {
    const t = atTW(D, 1430);
    if (nowMs < t) return out;
    const q = remain(t);
    if (q <= 0) { finish('cancelled', '已刪單', t); return out; }
    const af = mkt.after(o.code, D);
    let X = null;
    let src = '盤後零股成交價';
    if (af) X = af[0];
    else if (af === undefined) {
      if (mkt.market(o.code) === 'tse' && nowMs < nextOpen()) return out;
      X = day.c;
      src = '收盤價（沒有盤後零股資料時代替）';
      if (!isNum(X)) { if (nowMs > atTW(D, 1600)) finish('expired', '今天沒有成交價，盤後零股未成交', t); return out; }
    }
    if (!isNum(X)) { finish('expired', '盤後零股這檔沒有成交', t); return out; }
    if (isB ? o.px > X + 1e-9 : o.px < X - 1e-9) fill(t, X, q, 'oddpm');
    finish(prog.filled ? 'filled' : 'expired', prog.filled ? '' : `盤後零股撮合價 ${X}（${src}），你的價格${isB ? '沒有高於' : '沒有低於'}它，保守判定未成交`, t);
    return out;
  }

  // ---------------- 整股、盤中零股
  const limitP = o.type === 'L' ? o.px : null;
  const up = isNum(day.u) ? day.u : null;
  const down = isNum(day.w) ? day.w : null;
  // 市價單沒成交的部分，掛在漲停價（買）／跌停價（賣）等；沒有漲跌幅限制的就不設價
  const effP = limitP != null ? limitP : (isB ? up : down);
  const better = (px) => (effP == null ? true : isB ? px < effP - 1e-9 : px > effP + 1e-9);   // 嚴格穿價
  // 送單當下（照你看得到的最新五檔）是不是「馬上能成交」的單。不是的話，之後成交一律用你的委託價（掛著的單被吃掉），
  // 不會因為下一筆快照剛好跌更深而用更好的價格成交（那樣等於偷看了之後的行情）。
  const refA = kind === 'odd' ? o.ref && o.ref.oa1 : o.ref && o.ref.a1;
  const refB = kind === 'odd' ? o.ref && o.ref.ob1 : o.ref && o.ref.b1;
  const marketable = o.type === 'M' || (limitP != null && (isB ? isNum(refA) && refA <= limitP + 1e-9 : isNum(refB) && refB >= limitP - 1e-9));
  const firstMatch = atTW(D, kind === 'odd' ? w.oddFirst : w.regOpen);
  const auctionAt = atTW(D, w.regAuction);    // 13:25 收盤前集合競價開始
  const closeAt = atTW(D, w.regClose);        // 13:30 收盤
  const postAt = atTW(D, 1331);               // 收盤撮合結果出來的快照

  const bandOk = (t) => {
    if (limitP == null) return true;
    if ((up != null && limitP > up + 1e-9) || (down != null && limitP < down - 1e-9)) {
      finish('rejected', `委託價 ${limitP} 超出當天漲跌停（${down ?? '—'}～${up ?? '—'}），交易所退單`, t);
      return false;
    }
    return true;
  };

  // 1) 開始撮合
  if (prog.st === 'wait') {
    if (o.at < firstMatch) {
      // 開盤（零股第一次撮合）前送出：參加開盤集合競價，價格比開盤價好就用開盤價成交
      if (nowMs < firstMatch) return out;
      const O = kind === 'odd' && !usingRegForOdd ? mkt.oddOpen(o.code, D) : day.o;
      if (!isNum(O)) {
        const t1 = ticksAll.find((x) => x.t > firstMatch);
        if (!t1 && !(nowMs >= postAt && isNum(day.c))) return out;   // 等第一筆資料
        if (!bandOk(firstMatch)) return out;
        Object.assign(prog, { st: 'live', act: firstMatch, L: Infinity, H: -Infinity, zt0: firstMatch, cut: firstMatch });
      } else {
        if (!bandOk(firstMatch)) return out;
        const q = remain(firstMatch);
        if (q <= 0) { finish('cancelled', '已刪單', firstMatch); return out; }
        if (limitP != null && better(O)) fill(firstMatch, O, q, 'open');
        Object.assign(prog, { st: 'live', act: firstMatch, L: O, H: O, zt0: firstMatch, cut: firstMatch });
      }
    } else if (o.at >= auctionAt) {
      // 收盤前集合競價時段才送出：只參加 13:30 收盤撮合
      if (!bandOk(o.at)) return out;
      Object.assign(prog, { st: 'live', act: o.at, L: -Infinity, H: Infinity, zt0: Infinity, cut: Infinity });
    } else {
      // 盤中送出：在委託之後的第一筆快照到達，看那一刻的五檔能吃多少
      let t1 = ticksAll.find((x) => x.t > o.at);
      // 下一筆快照已經是 13:25 以後（收盤集合競價的委託簿）：不拿來逐筆撮合，只參加 13:30 收盤撮合
      if (t1 && t1.t >= auctionAt) t1 = null;
      if (!t1) {
        // 之後一直沒有新快照（後台斷線）：收盤後只能用收盤集合競價判斷
        if (!(nowMs >= postAt && isNum(day.c))) return out;
        if (!bandOk(o.at)) return out;
        Object.assign(prog, { st: 'live', act: o.at, L: -Infinity, H: Infinity, zt0: Infinity, cut: Infinity });
      } else {
        if (!bandOk(t1.t)) return out;
        // 委託送出就到了交易所；在下一筆快照之前送的刪單、減量，如果那筆快照顯示已經能成交，一律算「成交在先」
        // （看即時行情發現要虧了才刪單，在真實世界是來不及的）
        const q = remain(o.at + 1);
        const book = isB ? t1.a : t1.b;
        const noBook = !(t1.a && t1.a.length) && !(t1.b && t1.b.length);
        let got = { fills: [], filled: 0 };
        if (book && book.length) {
          got = walkBook(book, o.side, q, effP);
          if (!marketable) got.fills = got.fills.map((f) => ({ ...f, px: limitP }));
        }
        else if (noBook && isNum(t1.z) && isNum(t1.zt) && t1.zt > o.at && better(t1.z)) {
          // 這一筆完全沒有五檔資料（資料缺漏）：委託之後有人用比你更好的價格成交，才算成交
          got = { fills: [{ px: marketable || limitP == null ? t1.z : limitP, qty: q }], filled: q };
        }
        // 對方完全沒有掛單（例如漲停鎖死沒人賣）：吃不到，掛著等
        let n = roundLot(got.filled, o.sess);
        if (o.tif === 'FOK' && n < q) n = 0;
        let left = n;
        for (const f of got.fills) {
          const k = Math.min(left, f.qty);
          if (k > 0) fill(t1.t, f.px, k, 'arrive');
          left -= k;
        }
        if (o.tif === 'IOC' || o.tif === 'FOK') {
          if (prog.filled >= q) finish('filled', '', t1.t);
          else if (prog.filled > 0) finish('cancelled', `IOC：成交 ${prog.filled} 股，其餘取消`, t1.t);
          else finish('cancelled', o.tif === 'FOK' ? 'FOK：沒辦法一次全部成交，整筆取消' : 'IOC：當下沒有可成交的對手單，已取消', t1.t);
          return out;
        }
        Object.assign(prog, {
          st: 'live', act: t1.t, cut: t1.t, zt0: t1.t,
          L: isNum(t1.l) ? t1.l : Infinity, H: isNum(t1.h) ? t1.h : -Infinity,
        });
      }
    }
  }

  // 2) 掛著：每一筆新快照看價格有沒有「穿過」你的委託價（剛好碰到不算）
  if (prog.st === 'live') {
    for (const x of ticksAll) {
      if (!(x.t > prog.cut)) continue;
      if (x.t >= closeAt) break;                 // 收盤後的快照交給收盤撮合
      // 這一筆快照之前（上一筆之後）送的刪單、減量：如果這一筆顯示價格已經穿過，算成交在先
      const q = remain(prog.cut + 1);
      if (q <= 0) break;
      prog.cut = x.t;
      const book = x.t < auctionAt ? (isB ? x.a : x.b) : null;   // 13:25 以後是集合競價的委託簿，不拿來撮合
      if (limitP == null) {
        if (book && book.length) {
          const got = walkBook(book, o.side, q, effP);
          let left = roundLot(got.filled, o.sess);
          for (const f of got.fills) { const k = Math.min(left, f.qty); if (k > 0) fill(x.t, f.px, k, 'rest'); left -= k; }
          prog.filledAt = x.t;
        }
      } else {
        const through = (isNum(x.z) && isNum(x.zt) && x.zt > prog.zt0 && better(x.z))
          || (isB ? isNum(x.l) && x.l < prog.L - 1e-9 && better(x.l) : isNum(x.h) && x.h > prog.H + 1e-9 && better(x.h));
        if (through) fill(x.t, limitP, q, 'through');
        else if (book && book.length) {
          // 對方掛的價格比你的委託價還好：真實世界你的單早就成交了（用你的價格，量看對方掛多少）
          const got = walkBook(book, o.side, q, limitP);
          const n = roundLot(got.filled, o.sess);
          if (n > 0) fill(x.t, limitP, n, 'book');
        }
      }
      if (remainingAt(o, mods, x.t + 1, prog.filled) <= 0) break;
    }
    // 全部成交，或在收盤前就刪單／減量到零
    if (prog.full) { finish('filled', '', out.fills.length ? out.fills[out.fills.length - 1].t : prog.cut); return out; }
    const tEval = Math.min(nowMs, closeAt);
    if (remain(tEval) <= 0) {
      const { cancelled } = qtyAt(o, mods, tEval);
      const m = mods.filter((x) => x.oid === o.id && x.at < tEval).pop();
      // 刪單、減量要等下一筆行情確認：那一筆如果顯示早就成交了，成交算數
      if (m && prog.cut < m.at && nowMs < closeAt) return out;
      if (!cancelled && prog.filled > 0) finish('filled', '減量後全部成交', m ? m.at : prog.cut);
      else finish('cancelled', prog.filled > 0 ? `已刪單（之前已成交 ${prog.filled} 股）` : '已刪單', m ? m.at : prog.cut);
      return out;
    }

    // 3) 收盤集合競價（13:30）：13:30 真的有撮合成交，而且成交價比你的委託價好，才用那個價格成交；其餘收盤後失效
    if (nowMs < postAt) return out;
    const ca = mkt.closeAuction(o.code, D, usingRegForOdd ? 'reg' : kind);
    if (!ca.known && nowMs < nextOpen()) return out;
    const C = ca.known ? ca.px : null;
    const q = remain(closeAt);
    if (q > 0 && isNum(C) && better(C)) fill(closeAt, C, q, 'close');
    if (prog.filled > 0 && remain(closeAt) <= 0) finish('filled', '', closeAt);
    else {
      const why = prog.filled > 0 ? `收盤後失效（已成交 ${prog.filled} 股）`
        : isNum(C) ? `收盤撮合 ${C}，沒有比你的委託價好，收盤後失效` : '收盤時沒有撮合成交，委託收盤後失效';
      finish('expired', why, closeAt);
    }
  }
  return out;
}

export function fmtD(d) {
  return `${Math.floor(d / 100) % 100}/${d % 100}`;
}

// ------------------------------------------------------------------ 整局推進
/**
 * 把一局所有還沒結束的委託推進到現在。回傳新的成交、進度、結束狀態（呼叫端合併進紀錄後存檔）。
 * 成交的 id 是「委託 id:序號」，同一筆委託不管在哪個分頁算，都會得到同樣的 id，合併時不會重複。
 */
export function processRun(run, mkt, nowMs) {
  const newFills = [];
  const prog = { ...(run.prog || {}) };
  const finals = { ...(run.finals || {}) };
  const fillsBy = new Map();
  for (const f of run.fills || []) {
    if (!fillsBy.has(f.oid)) fillsBy.set(f.oid, []);
    fillsBy.get(f.oid).push(f);
  }
  for (const o of run.orders || []) {
    if (finals[o.id]) continue;
    const before = fillsBy.get(o.id) || [];
    const p0 = prog[o.id] || { filled: before.reduce((s, f) => s + f.qty, 0) };
    const r = advance(o, p0, run.mods || [], mkt, nowMs);
    prog[o.id] = r.prog;
    let seq = before.length;
    let cum = before.reduce((s, f) => s + f.amt, 0);
    let feeC = before.reduce((s, f) => s + f.fee, 0);
    let feeF = before.reduce((s, f) => s + (f.fin ?? f.fee), 0);
    let tax = before.reduce((s, f) => s + (f.tax || 0), 0);
    const odd = o.sess === 'odd' || o.sess === 'oddpm';
    const rate = o.side === 'S' ? taxRate(o.code, mkt.cat(o.code), o.day) : 0;
    const fees = run.fees;
    for (const f of r.fills) {
      const amt = amountOf(f.qty, f.px);
      const cum2 = cum + amt;
      // 同一筆委託當天的手續費、稅合併計算（最低收費只收一次）
      const fc = feeCharged(cum2, odd, fees) - feeC;
      const ff = feeFinal(cum2, odd, fees) - feeF;
      const tx = taxOf(cum2, rate) - tax;
      const rec = {
        id: `${o.id}:${++seq}`, oid: o.id, t: f.t, d: o.day, code: o.code, side: o.side, sess: o.sess,
        qty: f.qty, px: f.px, amt, fee: fc, fin: fees.rebate === 'instant' ? fc : ff, tax: tx, how: f.how,
      };
      newFills.push(rec);
      cum = cum2; feeC += fc; feeF += ff; tax += tx;
    }
    if (r.done) finals[o.id] = r.done;
  }
  return { newFills, prog, finals };
}

/** 把 processRun 的結果併進一局（成交依 id 去重） */
export function mergeProgress(run, res) {
  const byId = new Map();
  for (const f of [...(run.fills || []), ...(res.newFills || [])]) if (!byId.has(f.id)) byId.set(f.id, f);
  const fills = [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  return { ...run, fills, prog: res.prog, finals: { ...res.finals, ...(run.finals || {}) } };
}

/** 委託目前的狀態（給畫面） */
export function orderStatus(run, o) {
  const fin = (run.finals || {})[o.id];
  const filled = (run.fills || []).filter((f) => f.oid === o.id).reduce((s, f) => s + f.qty, 0);
  const p = (run.prog || {})[o.id];
  if (fin) return { st: fin.st === 'part' ? 'expired' : fin.st, why: fin.why, filled, t: fin.t };
  if ((run.mods || []).some((m) => m.oid === o.id && m.kind === 'cancel')) return { st: 'cancelling', filled };
  if (filled > 0) return { st: 'part', filled };
  return { st: p && p.st === 'live' ? 'live' : o.phase === 'reserve' ? 'queued' : 'wait', filled };
}

// ------------------------------------------------------------------ 帳務
/**
 * 依成交、配息、分割重播帳戶。today＝伺服器的台灣日期。
 * 現金：交割帳戶餘額（T+2 交割才扣款／入帳；手續費日退在下一個交易日退回；配息在發放日入帳）。
 */
export function ledger(run, mkt, nowMs) {
  const { d: today } = tw(nowMs);
  const cal = mkt.cal;
  const flows = [];   // {d: 入帳日, amt: 正＝入帳, kind, ref}
  const pos = new Map();
  const get = (c) => {
    if (!pos.has(c)) pos.set(c, { code: c, sh: 0, cost: 0, realized: 0, divs: 0, fees: 0, taxes: 0, buys: 0, sells: 0, todayBuy: 0, lastBuy: null });
    return pos.get(c);
  };
  flows.push({ d: run.start.d, amt: run.capital, kind: 'capital' });
  for (const x of run.cash || []) flows.push({ d: x.d, amt: x.amt, kind: x.kind, ref: x.note });

  // 事件依時間排：成交、分割、除息
  const fills = [...(run.fills || [])].sort((a, b) => a.t - b.t);
  const codes = new Set(fills.map((f) => f.code));
  const events = fills.map((f) => ({ t: f.t, d: f.d, kind: 'fill', f }));
  for (const c of codes) {
    for (const [sd, k] of mkt.splits(c) || []) {
      if (sd > run.start.d && sd <= today) events.push({ t: atTW(sd, 0), d: sd, kind: 'split', c, k });
    }
    for (const [ex, cash] of mkt.divs(c) || []) {
      if (ex > run.start.d && ex <= today && cash > 0) events.push({ t: atTW(ex, 0) + 1, d: ex, kind: 'div', c, cash });
    }
  }
  events.sort((a, b) => a.t - b.t || (a.kind === 'fill' ? 1 : -1));
  const divItems = [];
  const sells = [];
  let buyAmt = 0;
  let feesPaid = 0;
  let taxesPaid = 0;
  for (const e of events) {
    if (e.kind === 'split') {
      const p = get(e.c);
      if (p.sh > 0) p.sh = Math.round(p.sh * e.k);
      continue;
    }
    if (e.kind === 'div') {
      const p = pos.get(e.c);
      if (!p || !(p.sh > 0)) continue;
      const amt = Math.floor(p.sh * e.cash + 1e-9);
      if (amt <= 0) continue;
      const nhi = amt >= NHI_MIN ? Math.round(amt * NHI_RATE) : 0;
      const pay = addTradingDays(cal, e.d, DIV_PAY_LAG);
      divItems.push({ code: e.c, ex: e.d, cash: e.cash, sh: p.sh, amt, nhi, net: amt - nhi, pay });
      flows.push({ d: pay, amt: amt - nhi, kind: 'div', ref: e.c });
      p.divs += amt - nhi;
      continue;
    }
    const f = e.f;
    const p = get(f.code);
    const settle = settleDay(cal, f.d, 2);
    const rebate = (f.fee || 0) - (f.fin ?? f.fee ?? 0);
    feesPaid += f.fin ?? f.fee;
    taxesPaid += f.tax || 0;
    p.fees += f.fin ?? f.fee;
    p.taxes += f.tax || 0;
    if (f.side === 'B') {
      buyAmt += f.amt;
      flows.push({ d: settle, amt: -(f.amt + f.fee), kind: 'buy', ref: f.id });
      p.cost += f.amt + (f.fin ?? f.fee);
      p.sh += f.qty;
      p.buys += f.qty;
      if (f.d === today) p.todayBuy += f.qty;
      p.lastBuy = f.d;
    } else {
      const net = f.amt - f.fee - (f.tax || 0);
      flows.push({ d: settle, amt: net, kind: 'sell', ref: f.id });
      const avg = p.sh > 0 ? p.cost / p.sh : 0;
      const n = Math.min(f.qty, p.sh);
      const pnl = f.amt - (f.fin ?? f.fee) - (f.tax || 0) - avg * n;
      sells.push({ id: f.id, oid: f.oid, code: f.code, d: f.d, t: f.t, qty: f.qty, px: f.px, avg, pnl, ret: avg > 0 ? pnl / (avg * n) : 0 });
      p.realized += pnl;
      p.cost -= avg * n;
      p.sh -= n;
      p.sells += f.qty;
      if (p.sh <= 0) { p.sh = 0; p.cost = 0; }
    }
    if (rebate > 0) flows.push({ d: nextTradingDay(cal, f.d), amt: rebate, kind: 'rebate', ref: f.id });
  }
  let cash = 0;
  let pending = 0;
  const upcoming = [];
  for (const x of flows) {
    if (x.d <= today) cash += x.amt;
    else { pending += x.amt; upcoming.push(x); }
  }
  upcoming.sort((a, b) => a.d - b.d);
  const pendingTrade = upcoming.filter((x) => x.kind === 'buy' || x.kind === 'sell').reduce((s, x) => s + x.amt, 0);
  const pendingDiv = upcoming.filter((x) => x.kind === 'div').reduce((s, x) => s + x.amt, 0);
  const pendingRebate = upcoming.filter((x) => x.kind === 'rebate').reduce((s, x) => s + x.amt, 0);

  // 掛著的買單要圈存額度；掛著的賣單要圈住股數
  let reserved = 0;
  const lockedSh = new Map();
  for (const o of run.orders || []) {
    const st = orderStatus(run, o);
    if (['filled', 'cancelled', 'expired', 'rejected'].includes(st.st)) continue;
    // 刪單還沒確認之前，圈存照樣圈著（可能成交在先）
    const { q } = qtyAt(o, [], Infinity);
    const qq = Math.min(q, qtyAt(o, (run.mods || []).filter((m) => m.kind === 'reduce'), Infinity).q);
    const left = Math.max(0, (st.st === 'cancelling' ? o.qty : qq) - st.filled);
    if (left <= 0) continue;
    if (o.side === 'B') reserved += reserveOf(o, left, run.fees);
    else lockedSh.set(o.code, (lockedSh.get(o.code) || 0) + left);
  }
  // 可用額度：交割帳戶餘額＋還沒交割的買賣淨額（台灣是淨額交割）－掛單圈存
  const avail = Math.floor(cash + pendingTrade - reserved);

  const holdings = [];
  for (const p of pos.values()) {
    if (p.sh <= 0 && !p.realized && !p.divs) continue;
    const px = mkt.last(p.code);
    const mv = isNum(px) ? p.sh * px : null;
    const locked = lockedSh.get(p.code) || 0;
    holdings.push({ ...p, px, mv, avg: p.sh > 0 ? p.cost / p.sh : null, locked });
  }
  holdings.sort((a, b) => (b.mv || 0) - (a.mv || 0));
  const mvTotal = holdings.reduce((s, h) => s + (h.mv || 0), 0);
  const equity = cash + pending + mvTotal;
  return {
    today, cash: Math.round(cash), pending: Math.round(pending), pendingTrade: Math.round(pendingTrade),
    pendingDiv, pendingRebate, reserved: Math.round(reserved), avail, holdings, mv: mvTotal, equity,
    upcoming, divItems, feesPaid, taxesPaid, lockedSh, sells, buyAmt,
  };
}

/** 買單要圈存的錢：限價×股數（市價用漲停價；沒有漲跌停的用參考價的 1.2 倍）＋原價手續費 */
export function reserveOf(o, qty, fees, refPx) {
  const px = o.type === 'L' || o.type === 'C' ? o.px : (o.resPx || refPx || 0);
  const amt = amountOf(qty, px || 0);
  return amt + feeCharged(amt, o.sess === 'odd' || o.sess === 'oddpm', fees);
}

/** 能賣多少股：庫存－今天買進的（沒有當沖資格）－掛著的賣單 */
export function sellable(L, code, daytradeOk) {
  const h = L.holdings.find((x) => x.code === code);
  if (!h) return 0;
  return Math.max(0, h.sh - (daytradeOk ? 0 : h.todayBuy) - h.locked);
}
