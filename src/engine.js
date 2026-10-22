/* 沙盤 SANDTABLE — 撮合引擎與帳務（純函式：不碰畫面、不連網、不讀時鐘，同樣的輸入永遠得到同樣的結果）。

   核心原則：跟真的下單一樣，不能作弊。
   1. 委託時間＝伺服器時間（App 送單時向網站要的 HTTP Date），不是手機時鐘。
   2. 委託只會用「委託時間之後」才出現的行情成交：盤中單在下一筆快照成交（看那一刻的五檔），
      掛著的限價單要價格「穿過」才算（剛好碰到不算：真實世界要排隊），收盤集合競價、盤後也一樣保守。
      快照的時間一律用證交所那筆資料「本身的時間」（不是後台去問的時間；證交所的資料常常落後一兩分鐘）。
   3. 「還沒有資料」和「確定沒有」分清楚：一天的行情有沒有結束、收盤撮合結果出來了沒，一律看資料本身
      （mkt.final、mkt.closeAuction），不看時鐘。資料還沒到就等，不會因為時間過了就自己下結論。
   4. 成交一旦算出來就存進紀錄，之後資料怎麼補都不會改；不能修改、不能刪除，只能刪單、減量。

   行情介面 mkt（由 data.js 提供）：
     mkt.cal                         交易日曆（rules.makeCal）
     mkt.ticks(code, d, 'reg'|'odd') 那一天的逐輪快照 [{t: 資料時間, z, zt, h, l, v, a:[[價,股]], b:[[價,股]]}]（依 t 遞增），沒有就 null
     mkt.final(code, d)              那一天的盤中行情是不是已經結束、不會再有新的快照（true／false）
     mkt.day(code, d)                那一天的 {o,h,l,c,v,u,w,y}（收盤價 c：數字／null 確定沒有／undefined 還不知道），沒有就 null
     mkt.official(code, d)           那一天的官方日 K {o,h,l,c}；null＝確定沒有；undefined＝還不知道（要等）
     mkt.oddOpen(code, d)            盤中零股第一次撮合價
     mkt.closeAuction(code, d, kind) 13:30 收盤撮合：{known: 結果確定了沒, px: 13:30 撮合成交價（沒成交是 null）}
     mkt.after(code, d)              證交所盤後結果 [盤後零股價, 股數, 盤後定價股數, 定價剩下的買量, 定價剩下的賣量]；
                                     undefined＝還沒公布，null＝公布了但這檔沒有（或確定不會有）
     mkt.market(code)                'tse'｜'otc'
     mkt.cat(code)                   類別（broad／div／bond…）
     mkt.divs(code)                  [[除息日, 每單位現金]]，mkt.splits(code) [[生效日, 倍數]]
     mkt.close(code, d)              某天收盤價（估值用），mkt.last(code) 目前最新價 */

import {
  tw, atTW, windows, isTradingDay, closedSure, nextTradingDay, addTradingDays, settleDay, LOT,
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

/**
 * 從五檔依價格吃單：side B 吃賣方（a 由低到高），S 吃買方（b 由高到低）。limit=null 表示市價。
 * skip：同一筆快照、同一邊，你自己比較早的委託已經吃掉的股數（從最好的價位開始扣），不能再吃一次。
 */
export function walkBook(levels, side, qty, limit, skip = 0) {
  const fills = [];
  let left = qty;
  let sk = skip;
  for (const [px, vol0] of levels || []) {
    if (left <= 0) break;
    if (!(px > 0) || !(vol0 > 0)) continue;
    if (limit != null && (side === 'B' ? px > limit + 1e-9 : px < limit - 1e-9)) break;
    let vol = vol0;
    if (sk > 0) { const k = Math.min(sk, vol); vol -= k; sk -= k; }
    if (!(vol > 0)) continue;
    const n = Math.min(left, vol);
    fills.push({ px, qty: n });
    left -= n;
  }
  return { fills, filled: qty - left };
}

/**
 * 你自己的委託不能重複吃同一批量：同一筆快照、同一邊的五檔，盤中市價單用的成交量，盤後定價對手方剩下的量，
 * 先到先得（照委託時間），後面的委託只拿得到剩下的。從已經存下來的成交算起，所以分幾次算、在哪個分頁算都一樣。
 */
export function makeLiquidity(fills) {
  const used = new Map();
  const key = (code, kind, t, side, what) => `${code}|${kind}|${t}|${side}|${what}`;
  const add = (k, n) => { if (n > 0) used.set(k, (used.get(k) || 0) + n); };
  for (const f of fills || []) {
    const kind = f.sess === 'odd' ? 'odd' : 'reg';
    if (f.how === 'arrive' || f.how === 'book') add(key(f.code, kind, f.t, f.side, 'book'), f.qty);
    else if (f.how === 'rest') { add(key(f.code, kind, f.t, f.side, 'book'), f.qty); add(key(f.code, kind, f.t, f.side, 'dv'), f.qty); }
    else if (f.how === 'fix') add(key(f.code, 'fix', f.d, f.side, 'left'), f.qty);
  }
  return {
    get: (code, kind, t, side, what) => used.get(key(code, kind, t, side, what)) || 0,
    take: (n, code, kind, t, side, what) => add(key(code, kind, t, side, what), n),
  };
}

// 零股撮合以「股」為單位；整股要整張。可成交量取整張。
function roundLot(n, sess) {
  return sess === 'reg' || sess === 'fix' ? Math.floor(n / LOT) * LOT : Math.floor(n);
}

// 進度存進 localStorage 要經過 JSON，Infinity 會變成 null：一律用很大的有限數代替
export const BIG = 1e15;
/** 讀回來的進度整理一下（舊版存的 null 就是當初的 ±Infinity） */
export function normProg(p) {
  if (!p || p.st !== 'live') return p;
  const q = { ...p };
  if (q.cut == null) { Object.assign(q, { cut: BIG, co: true, L: -BIG, H: BIG, zt0: BIG }); return q; }
  if (q.L == null) q.L = BIG;
  if (q.H == null) q.H = -BIG;
  if (q.zt0 == null) q.zt0 = BIG;
  return q;
}

/** 這筆委託「開始撮合」的時間：在這之前刪單，一定還沒成交 */
export function startOf(o) {
  const w = windows(o.day);
  if (o.sess === 'fix' || o.sess === 'oddpm') return atTW(o.day, 1430);
  return atTW(o.day, o.sess === 'odd' ? w.oddFirst : w.regOpen);
}

// ------------------------------------------------------------------ 單筆委託的推進
/**
 * 把一筆委託往前推進到目前資料能決定的地方。
 * prog（存起來的進度）：{ st, act, L, H, zt0, cut, filled, full, v, zp }
 *   st：'wait' 還沒開始撮合／'live' 掛著／'done' 結束
 *   act：開始撮合的時間；L／H：開始撮合時的當日最低／最高（之後創新低／新高才算穿價）
 *   cut：已經處理到哪一筆快照（資料時間）；filled：已成交股數（一律從存下來的成交算，呼叫端傳進來）
 *   v：上一筆快照的累計成交量；zp：上一筆的成交價（市價單剩下的部分用）
 * liq：同一局其他委託已經吃掉的量（makeLiquidity）；只算單一筆委託時可以不給。
 * 回傳 { prog, fills: [{t, px, qty, how}], done: {st, why, t} | null }
 */
export function advance(o, prog0, mods, mkt, nowMs, liq = null) {
  const prog = { st: 'wait', act: null, L: null, H: null, zt0: null, cut: 0, filled: 0, ...normProg(prog0) };
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
    // 全部成交了（之後的刪單無效）。只看「這筆成交那一刻」已經送出的減量：之後才送的減量，要等它自己的確認
    if (prog.filled >= qtyAt(o, mods, t + 1).q) prog.full = true;
  };
  const finish = (st, why, t) => {
    prog.st = 'done';
    out.done = { st, why: why || '', t };
  };
  const final = () => !!(mkt.final && mkt.final(o.code, D));
  const sessFrom = { reg: w.regFrom, odd: w.oddFrom, oddpm: w.oddpmFrom, fix: w.fixFrom }[o.sess] || w.regFrom;

  // 還沒開始撮合（預約單、開盤前、盤中零股第一次撮合前、盤後單 14:30 前）就刪單：不可能已經成交，馬上確定
  const startAt = startOf(o);
  if (prog.st === 'wait' && o.at < startAt) {
    const c = mods.find((m) => m.oid === o.id && m.kind === 'cancel' && m.at < startAt && m.at <= nowMs);
    if (c) { finish('cancelled', '已刪單', c.at); return out; }
  }
  if (nowMs < atTW(D, sessFrom)) return out;           // 預約單：還沒到那一天
  if (!isTradingDay(mkt.cal, D)) {
    // 那天後來休市（颱風假）：證交所或後台確定沒開市，預約單才作廢；App 自己猜的不算
    if (closedSure(mkt.cal, D)) finish('expired', `${fmtD(D)} 休市，委託失效`, atTW(D, 1430));
    return out;
  }
  const day = mkt.day(o.code, D) || {};
  // 只用「現在以前」的快照（資料不可能來自未來；測試或時鐘異常時也不會偷看答案）
  const ticksAll = (mkt.ticks(o.code, D, kind) || []).filter((x) => x.t <= nowMs);

  // ---------------- 盤後定價：14:30 用收盤價，照證交所隨機排序撮合；保守：只吃得到對手方「沒成交剩下的」量
  if (o.sess === 'fix') {
    const t = atTW(D, 1430);
    if (nowMs < t) return out;
    const q = remain(t);
    if (q <= 0) { finish('cancelled', '已刪單', t); return out; }
    const af = mkt.after(o.code, D);
    if (af === undefined) return out;                  // 等證交所公布盤後結果
    const C = day.c;
    if (!isNum(C)) {
      // 收盤價確定沒有（整天沒成交）才失效；還不知道（資料還沒到）就等
      if (af === null || (C === null && final())) finish('expired', '這天沒有收盤價（整天沒有成交），盤後定價不成交', t);
      return out;
    }
    const used = liq ? liq.get(o.code, 'fix', D, o.side, 'left') : 0;
    const left = af ? Math.max(0, ((isB ? af[4] : af[3]) || 0) - used) : 0;
    const n = roundLot(Math.min(q, left), 'fix');
    if (n > 0) { fill(t, C, n, 'fix'); if (liq) liq.take(n, o.code, 'fix', D, o.side, 'left'); }
    if (n >= q) finish('filled', '', t);
    else {
      finish('expired', n > 0 ? `盤後定價對手方剩下的委託只有 ${n} 股，其餘未成交`
        : af ? '盤後定價對手方的委託都已經成交（證交所用隨機排序，你排不到），保守判定未成交' : '這檔今天盤後定價沒有交易，未成交', t);
    }
    return out;
  }

  // ---------------- 盤後零股：14:30 集合競價一次撮合，用證交所公布的盤後零股成交價
  if (o.sess === 'oddpm') {
    const t = atTW(D, 1430);
    if (nowMs < t) return out;
    const q = remain(t);
    if (q <= 0) { finish('cancelled', '已刪單', t); return out; }
    const af = mkt.after(o.code, D);
    if (af === undefined) return out;
    const X = af ? af[0] : null;
    if (!isNum(X)) { finish('expired', af === null && mkt.market(o.code) === 'otc' ? '上櫃 ETF 沒有盤後零股資料，沒辦法判斷，委託失效' : '這檔今天盤後零股沒有成交，未成交', t); return out; }
    if (isB ? o.px > X + 1e-9 : o.px < X - 1e-9) fill(t, X, q, 'oddpm');
    finish(prog.filled ? 'filled' : 'expired', prog.filled ? '' : `盤後零股撮合價 ${X}，你的價格${isB ? '沒有高於' : '沒有低於'}它，保守判定未成交`, t);
    return out;
  }

  // ---------------- 整股、盤中零股
  const limitP = o.type === 'L' ? o.px : null;
  const up = isNum(day.u) ? day.u : null;
  const down = isNum(day.w) ? day.w : null;
  // 市價單沒成交的部分：最多付到漲停價（買）／最少賣到跌停價（賣）
  const effP = limitP != null ? limitP : (isB ? up : down);
  const better = (px) => (effP == null ? true : isB ? px < effP - 1e-9 : px > effP + 1e-9);   // 嚴格穿價
  // 送單當下（照你看得到的最新五檔）是不是「馬上能成交」的單。不是的話，之後成交一律用你的委託價（掛著的單被吃掉），
  // 不會因為下一筆快照剛好跌更深而用更好的價格成交（那樣等於偷看了之後的行情）。
  const refA = kind === 'odd' ? o.ref && o.ref.oa1 : o.ref && o.ref.a1;
  const refB = kind === 'odd' ? o.ref && o.ref.ob1 : o.ref && o.ref.b1;
  const marketable = o.type === 'M' || (limitP != null && (isB ? isNum(refA) && refA <= limitP + 1e-9 : isNum(refB) && refB >= limitP - 1e-9));
  const firstMatch = atTW(D, kind === 'odd' ? w.oddFirst : w.regOpen);
  const closeAt = atTW(D, w.regClose);        // 13:30 收盤
  // 整股 13:25 起是收盤前集合競價；盤中零股沒有這一段，一直每 5 秒撮合到 13:30
  const auctionAt = kind === 'odd' ? closeAt : atTW(D, w.regAuction);

  const bandOk = (t) => {
    if (limitP == null) return true;
    if ((up != null && limitP > up + 1e-9) || (down != null && limitP < down - 1e-9)) {
      finish('rejected', `委託價 ${limitP} 超出當天漲跌停（${down ?? '—'}～${up ?? '—'}），交易所退單`, t);
      return false;
    }
    return true;
  };
  const closeOnly = (t) => Object.assign(prog, { st: 'live', act: t, L: -BIG, H: BIG, zt0: BIG, cut: BIG, co: true });
  // 市價單剩下的部分（證交所：每次撮合前把市價單換成「參考價」——買進取對方價格、最近成交價、最高買價裡最高的）
  const mktPx = (cands) => {
    const xs = cands.filter(isNum);
    if (!xs.length) return null;
    return isB ? Math.max(...xs) : Math.min(...xs);
  };

  // 盤中委託（整股、盤中零股）最晚 13:30 收盤前送到；收盤後才送出的不會進到交易所（App 也不讓你送）
  if (prog.st === 'wait' && o.at >= closeAt) { finish('rejected', '13:30 收盤以後才送出的盤中委託，交易所不收', o.at); return out; }

  // 1) 開始撮合
  if (prog.st === 'wait') {
    if (o.at < firstMatch) {
      // 開盤（零股第一次撮合）前送出：參加開盤集合競價，價格比開盤價好就用開盤價成交
      if (nowMs < firstMatch) return out;
      if (kind === 'odd' && !ticksAll.length && final()) {
        finish('expired', '這一天沒有盤中零股的行情資料，沒辦法判斷，委託失效', firstMatch);
        return out;
      }
      const O = kind === 'odd' ? mkt.oddOpen(o.code, D) : day.o;
      if (!isNum(O)) {
        // 還不知道開盤價：等第一筆資料；有資料了還是沒有開盤價＝開盤沒有成交，委託留在委託簿
        const t1 = ticksAll.find((x) => x.t > firstMatch);
        if (!t1 && !final()) return out;
        if (!bandOk(firstMatch)) return out;
        Object.assign(prog, { st: 'live', act: firstMatch, L: BIG, H: -BIG, zt0: firstMatch, cut: firstMatch, v: null, zp: null });
      } else {
        if (!bandOk(firstMatch)) return out;
        const q = remain(firstMatch);
        if (q <= 0) { finish('cancelled', '已刪單', firstMatch); return out; }
        if (limitP != null && better(O)) fill(firstMatch, O, q, 'open');
        Object.assign(prog, { st: 'live', act: firstMatch, L: O, H: O, zt0: firstMatch, cut: firstMatch, v: null, zp: O });
      }
    } else if (o.at >= auctionAt) {
      // 收盤前集合競價時段才送出：只參加 13:30 收盤撮合（這個時段只收限價 ROD，App 送單時就會擋下其他的）
      if (o.type !== 'L' || o.tif === 'IOC' || o.tif === 'FOK') {
        finish('rejected', `收盤前集合競價時段不接受${o.type !== 'L' ? '市價單' : ` ${o.tif}`}，交易所退單`, o.at);
        return out;
      }
      if (!bandOk(o.at)) return out;
      closeOnly(o.at);
    } else {
      // 盤中送出：在委託之後的第一筆快照到達，看那一刻的五檔能吃多少
      const t1 = ticksAll.find((x) => x.t > o.at);
      // 下一筆快照已經是 13:25 以後（收盤集合競價的委託簿），或者那天的行情已經結束都沒有下一筆：只參加 13:30 收盤撮合
      const late = t1 ? t1.t >= auctionAt : final();
      if (!t1 && !late) return out;                     // 等下一筆行情
      if (late) {
        if (o.tif === 'IOC' || o.tif === 'FOK') {
          finish('cancelled', `${o.tif}：送到交易所時已經是收盤前集合競價（不接受 ${o.tif}），沒有成交，委託取消`, t1 ? t1.t : o.at);
          return out;
        }
        if (kind === 'odd' && !ticksAll.length) { finish('expired', '這一天沒有盤中零股的行情資料，沒辦法判斷，委託失效', o.at); return out; }
        if (!bandOk(o.at)) return out;
        closeOnly(o.at);
        // 送出之後、收盤前集合競價之前，其實有人用比你的委託價更好的價格成交了（下一筆快照的最後成交）：
        // 真實世界你的單在盤中就成交了；那之前送的刪單、減量來不及（成交在先）
        if (t1 && limitP != null && isNum(t1.z) && isNum(t1.zt) && t1.zt > o.at && t1.zt < auctionAt && better(t1.z)) {
          const q = remain(o.at + 1);
          if (q > 0) fill(t1.t, limitP, q, 'through');
        }
      } else {
        if (!bandOk(t1.t)) return out;
        // 委託送出就到了交易所；在下一筆快照之前送的刪單、減量，如果那筆快照顯示已經能成交，一律算「成交在先」
        // （看即時行情發現要虧了才刪單，在真實世界是來不及的）
        const q = remain(o.at + 1);
        const book = isB ? t1.a : t1.b;
        const noBook = !(t1.a && t1.a.length) && !(t1.b && t1.b.length);
        let got = { fills: [], filled: 0 };
        if (book && book.length) {
          got = walkBook(book, o.side, q, effP, liq ? liq.get(o.code, kind, t1.t, o.side, 'book') : 0);
          if (!marketable) got.fills = got.fills.map((f) => ({ ...f, px: limitP }));
        } else if (noBook && limitP != null && isNum(t1.z) && isNum(t1.zt) && t1.zt > o.at && better(t1.z)) {
          // 這一筆完全沒有五檔資料（資料缺漏）：委託之後有人用比你更好的價格成交，才算成交
          got = { fills: [{ px: marketable ? t1.z : limitP, qty: q }], filled: q };
        }
        // 對方完全沒有掛單（例如漲停鎖死沒人賣）：吃不到，掛著等
        let n = roundLot(got.filled, o.sess);
        if (o.tif === 'FOK' && n < q) n = 0;
        let left = n;
        let lastPx = null;
        for (const f of got.fills) {
          const k = Math.min(left, f.qty);
          if (k > 0) { fill(t1.t, f.px, k, 'arrive'); lastPx = f.px; if (liq) liq.take(k, o.code, kind, t1.t, o.side, 'book'); }
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
          L: isNum(t1.l) ? t1.l : BIG, H: isNum(t1.h) ? t1.h : -BIG,
          v: isNum(t1.v) ? t1.v : null, zp: mktPx([lastPx, t1.z]),
        });
      }
    }
  }

  // 2) 掛著：每一筆新快照看價格有沒有「穿過」你的委託價（剛好碰到不算）
  if (prog.st === 'live') {
    // 已經全部成交（例如送出就整筆吃到）：不用再等之後的行情
    if (prog.full) { finish('filled', '', out.fills.length ? out.fills[out.fills.length - 1].t : prog.cut); return out; }
    let ticks = ticksAll;
    // 那天的行情已經結束、但最後一段沒有快照（後台斷線）：用官方日 K 的最高最低補一筆，只拿來判斷有沒有穿價
    const off = kind === 'reg' && final() && mkt.official ? mkt.official(o.code, D) : null;
    const lastT = ticks.length ? ticks[ticks.length - 1].t : -Infinity;
    const gap = lastT < auctionAt - 1 && !prog.co;      // 快照少了最後一段
    if (off && isNum(off.h) && isNum(off.l) && gap) ticks = [...ticks, { t: auctionAt - 1, z: null, zt: null, h: off.h, l: off.l, v: null, a: [], b: [], syn: true }];
    for (const x of ticks) {
      if (!(x.t > prog.cut)) continue;
      if (x.t >= closeAt) break;                 // 收盤後的快照交給收盤撮合
      // 這一筆快照之前（上一筆之後）送的刪單、減量：如果這一筆顯示價格已經穿過，算成交在先
      const q = remain(prog.cut + 1);
      if (q <= 0) break;
      prog.cut = x.t;
      const book = x.t < auctionAt ? (isB ? x.a : x.b) : null;   // 13:25 以後是集合競價的委託簿，不拿來撮合
      let px0 = null;
      if (limitP == null) {
        // 市價單剩下的部分：排在所有限價單前面，之後有人賣（買）就先跟它成交；價格用證交所的「轉換參考價」
        if (x.t < auctionAt && !x.syn) {
          const got = book && book.length ? walkBook(book, o.side, q, effP, liq ? liq.get(o.code, kind, x.t, o.side, 'book') : 0) : { fills: [], filled: 0 };
          const dv = isNum(x.v) && isNum(prog.v) ? Math.max(0, x.v - prog.v - (liq ? liq.get(o.code, kind, x.t, o.side, 'dv') : 0)) : 0;
          const n = roundLot(Math.min(q, got.filled + dv), o.sess);
          const px = mktPx([prog.zp, x.z, got.fills.length ? got.fills[got.fills.length - 1].px : null]);
          if (n > 0 && isNum(px) && (effP == null || (isB ? px <= effP + 1e-9 : px >= effP - 1e-9))) {
            fill(x.t, px, n, 'rest');
            px0 = px;
            if (liq) { const b = Math.min(n, got.filled); liq.take(b, o.code, kind, x.t, o.side, 'book'); liq.take(n - b, o.code, kind, x.t, o.side, 'dv'); }
          }
        }
      } else {
        const through = (isNum(x.z) && isNum(x.zt) && x.zt > prog.zt0 && better(x.z))
          || (isB ? isNum(x.l) && x.l < prog.L - 1e-9 && better(x.l) : isNum(x.h) && x.h > prog.H + 1e-9 && better(x.h));
        if (through) fill(x.t, limitP, q, 'through');
        else if (book && book.length) {
          // 對方掛的價格比你的委託價還好：真實世界你的單早就成交了（用你的價格，量看對方掛多少，扣掉你自己別的單已經吃掉的）
          const got = walkBook(book, o.side, q, limitP, liq ? liq.get(o.code, kind, x.t, o.side, 'book') : 0);
          const n = roundLot(got.filled, o.sess);
          if (n > 0) { fill(x.t, limitP, n, 'book'); if (liq) liq.take(n, o.code, kind, x.t, o.side, 'book'); }
        }
      }
      if (isNum(x.v)) prog.v = x.v;
      if (isNum(px0)) prog.zp = px0;
      else if (isNum(x.z)) prog.zp = x.z;
      if (remainingAt(o, mods, x.t + 1, prog.filled) <= 0) break;
    }
    // 全部成交
    if (prog.full) { finish('filled', '', out.fills.length ? out.fills[out.fills.length - 1].t : prog.cut); return out; }

    // 在收盤前就刪單、減量到零：要等「刪單之後」的下一筆行情確認，那一筆顯示早就能成交的話，成交算數
    if (remain(closeAt) <= 0) {
      const mine = mods.filter((m) => m.oid === o.id && m.at < closeAt);
      const m = mine[mine.length - 1];
      if (m && prog.cut < m.at && !prog.co) {
        const nx = ticks.find((x) => x.t > m.at);       // 刪單之後的下一筆（一定是收盤後的那一筆，不然上面就處理掉了）
        const offd = !nx && final() ? (kind === 'reg' && mkt.official ? mkt.official(o.code, D) : null) : null;
        if (!nx && !final()) return out;                // 等下一筆行情
        if (!nx && offd === undefined) return out;      // 官方日 K 還沒拿到：等（不能沒看證據就讓刪單成立）
        const ev = nx || (offd ? { h: offd.h, l: offd.l, v: null } : null);
        const q = remain(prog.cut + 1);
        if (ev && q > 0) {
          if (limitP != null) {
            const thr = isB ? isNum(ev.l) && ev.l < prog.L - 1e-9 && better(ev.l) : isNum(ev.h) && ev.h > prog.H + 1e-9 && better(ev.h);
            if (thr) fill(m.at, limitP, q, 'through');
          } else {
            const dv = isNum(ev.v) && isNum(prog.v) ? Math.max(0, ev.v - prog.v) : 0;
            const n = roundLot(Math.min(q, dv), o.sess);
            const px = mktPx([prog.zp, isB ? ev.h : ev.l]);
            if (n > 0 && isNum(px)) fill(m.at, px, n, 'rest');
          }
        }
        prog.cut = Math.max(prog.cut, m.at);
        if (prog.full) { finish('filled', '', m.at); return out; }
      }
      const { cancelled } = qtyAt(o, mods, closeAt);
      const tm = m ? m.at : prog.cut;
      if (!cancelled && prog.filled > 0) finish('filled', '減量後全部成交', tm);
      else finish('cancelled', prog.filled > 0 ? `已刪單（之前已成交 ${prog.filled} 股）` : '已刪單', tm);
      return out;
    }

    // 3) 收盤撮合（13:30）：13:30 真的有撮合成交，而且成交價比你的委託價好，才用那個價格成交；其餘收盤後失效
    if (nowMs < closeAt) return out;
    // 快照少了最後一段、官方日 K 又還沒拿到：等（那一段可能已經穿價，不能少看那一段就用收盤結果下結論）
    if (off === undefined && gap) return out;
    const ca = mkt.closeAuction(o.code, D, kind);
    if (!ca || !ca.known) return out;              // 收盤結果還沒出來：等資料，不看時鐘
    const C = ca.px;
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
/** 每檔的持股（給賣出成交的保險：不管哪裡出錯，都不會賣超過手上的股數） */
function sharesNow(run, mkt, nowMs) {
  const m = new Map();
  for (const h of ledger(run, mkt, nowMs).holdings) m.set(h.code, h.sh);
  return m;
}

/**
 * 把一局所有還沒結束的委託推進到現在。回傳新的成交、進度、結束狀態（呼叫端合併進紀錄後存檔）。
 * 成交的 id 由「委託、快照時間、第幾筆」決定，同一筆快照不管在哪個分頁、算幾次，都得到同樣的 id，合併時不會重複。
 * 已成交股數一律從存下來的成交算（不信任存下來的進度），兩個分頁輪流寫也不會重複成交。
 */
export function processRun(run, mkt, nowMs) {
  const newFills = [];
  const prog = { ...(run.prog || {}) };
  const finals = { ...(run.finals || {}) };
  const fillsBy = new Map();
  const ids = new Set();
  for (const f of run.fills || []) {
    ids.add(f.id);
    if (!fillsBy.has(f.oid)) fillsBy.set(f.oid, []);
    fillsBy.get(f.oid).push(f);
  }
  // 照委託時間排：同一筆快照的量先到先得
  const open = (run.orders || []).filter((o) => !finals[o.id]).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const shares = open.some((o) => o.side === 'S') ? sharesNow(run, mkt, nowMs) : null;
  const liq = makeLiquidity(run.fills || []);
  for (const o of open) {
    const before = fillsBy.get(o.id) || [];
    const filled0 = before.reduce((s, f) => s + f.qty, 0);
    const p0 = heal({ ...(prog[o.id] || {}), filled: filled0 }, before, o, mkt);
    if (p0.full && filled0 < qtyAt(o, run.mods || [], Infinity).q) delete p0.full;
    const r = advance(o, p0, run.mods || [], mkt, nowMs, liq);
    let cum = before.reduce((s, f) => s + f.amt, 0);
    let feeC = before.reduce((s, f) => s + f.fee, 0);
    let feeF = before.reduce((s, f) => s + (f.fin ?? f.fee), 0);
    let tax = before.reduce((s, f) => s + (f.tax || 0), 0);
    const odd = o.sess === 'odd' || o.sess === 'oddpm';
    const rate = o.side === 'S' ? taxRate(o.code, mkt.cat(o.code), o.day) : 0;
    const fees = run.fees;
    const perT = new Map();
    let capped = false;
    for (const f of r.fills) {
      const k = perT.get(f.t) || 0;
      perT.set(f.t, k + 1);
      const id = `${o.id}@${f.t.toString(36)}.${k}`;
      if (ids.has(id)) continue;          // 已經記過的同一筆（不會發生；保險）
      let qty = f.qty;
      if (o.side === 'S' && shares) {
        const have = shares.get(o.code) || 0;
        if (qty > have) { qty = roundLot(have, o.sess); capped = true; }
        if (!(qty > 0)) continue;
        shares.set(o.code, have - qty);
      } else if (shares) shares.set(o.code, (shares.get(o.code) || 0) + qty);
      const amt = amountOf(qty, f.px);
      const cum2 = cum + amt;
      // 同一筆委託當天的手續費、稅合併計算（最低收費只收一次）
      const fc = feeCharged(cum2, odd, fees) - feeC;
      const ff = feeFinal(cum2, odd, fees) - feeF;
      const tx = taxOf(cum2, rate) - tax;
      const rec = {
        id, oid: o.id, t: f.t, d: o.day, code: o.code, side: o.side, sess: o.sess,
        qty, px: f.px, amt, fee: fc, fin: fees.rebate === 'instant' ? fc : ff, tax: tx, how: f.how,
      };
      ids.add(id);
      newFills.push(rec);
      cum = cum2; feeC += fc; feeF += ff; tax += tx;
    }
    // 賣出超過手上的股數被保險擋下來（理論上不會發生）：進度不往前，下次重算；已經結束的照實寫
    if (capped && !r.done) continue;
    prog[o.id] = { ...r.prog };
    delete prog[o.id].filled;
    if (r.done) {
      if (capped) {
        const got = filled0 + newFills.filter((f) => f.oid === o.id).reduce((s2, f) => s2 + f.qty, 0);
        finals[o.id] = got > 0 ? { st: 'expired', why: `庫存只夠賣 ${got} 股，其餘未成交`, t: r.done.t } : { st: 'rejected', why: '庫存不足，賣單沒有成交', t: r.done.t };
      } else finals[o.id] = r.done;
    }
  }
  return { newFills, prog, finals };
}

/**
 * 存下來的進度比存下來的成交還舊（例如舊版 App、兩個分頁輪流寫）：從最後一筆成交那一刻接著算，
 * 不會把同一筆快照再成交一次。
 */
function heal(p0, before, o, mkt) {
  if (!before.length || p0.st === 'done') return p0;
  const lastT = Math.max(...before.map((f) => f.t));
  if (p0.st === 'live') {
    const p = normProg(p0);
    return p.cut >= lastT ? p : { ...p, cut: lastT };
  }
  const x = (mkt.ticks(o.code, o.day, o.sess === 'odd' ? 'odd' : 'reg') || []).find((k) => k.t === lastT);
  return {
    ...p0, st: 'live', act: lastT, cut: lastT, zt0: lastT,
    L: x && isNum(x.l) ? x.l : -BIG, H: x && isNum(x.h) ? x.h : BIG, v: x && isNum(x.v) ? x.v : null, zp: x && isNum(x.z) ? x.z : null,
  };
}

/** 兩份進度取「走得比較前面」的那一份（另一個分頁可能拿比較舊的行情算過） */
export function laterProg(a0, b0) {
  const a = normProg(a0);
  const b = normProg(b0);
  if (!a) return b;
  if (!b) return a;
  if (a.st === 'done') return a;
  if (b.st === 'done') return b;
  if (a.st === 'wait' && b.st !== 'wait') return b;
  if (b.st === 'wait' && a.st !== 'wait') return a;
  return (b.cut || 0) > (a.cut || 0) ? b : a;
}

/** 把 processRun 的結果併進一局（成交依 id 去重、結束狀態只增不減、進度取走得比較前面的） */
export function mergeProgress(run, res) {
  const byId = new Map();
  for (const f of [...(run.fills || []), ...(res.newFills || [])]) if (!byId.has(f.id)) byId.set(f.id, f);
  const fills = [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const finals = { ...(res.finals || {}), ...(run.finals || {}) };
  const prog = {};
  for (const k of new Set([...Object.keys(run.prog || {}), ...Object.keys(res.prog || {})])) {
    if (finals[k]) continue;
    prog[k] = laterProg((run.prog || {})[k], (res.prog || {})[k]);
  }
  return { ...run, fills, prog, finals };
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

/** 已經「確定生效」的刪單、減量：送出之後有一筆行情確認過（或那筆委託還沒開始撮合） */
export function confirmedMods(run, o, asOf = Infinity) {
  const p = normProg((run.prog || {})[o.id]);
  // 只參加收盤撮合的單（prog.co）：13:30 以前送的刪單、減量馬上生效；13:30 以後才送的來不及（收盤已經撮合），
  // 圈存照樣圈著，等收盤結果
  if (p && p.st === 'live' && p.co) {
    const closeAt = atTW(o.day, windows(o.day).regClose);
    return (run.mods || []).filter((m) => m.oid === o.id && m.at <= asOf && m.at < closeAt);
  }
  const cut = p && p.st === 'live' ? p.cut : -Infinity;
  const start = startOf(o);
  return (run.mods || []).filter((m) => m.oid === o.id && m.at <= asOf && (m.at <= cut || (o.at < start && m.at < start && (!p || p.st === 'wait'))));
}

// ------------------------------------------------------------------ 帳務
/**
 * 依成交、配息、分割重播帳戶，算到 nowMs 那一刻為止（之後的成交、委託、刪單都不算；戰報畫每天的淨值、
 * 定期定額判斷「那時候」的可用額度都靠這個）。today＝nowMs 的台灣日期。
 * 現金：交割帳戶餘額（T+2 交割才扣款／入帳；手續費日退在下一個交易日退回；配息在發放日入帳）。
 */
export function ledger(run, mkt, nowMs) {
  const { d: today } = tw(nowMs);
  const cal = mkt.cal;
  const flows = [];   // {d: 入帳日, amt: 正＝入帳, kind, ref}
  const pos = new Map();
  const get = (c) => {
    if (!pos.has(c)) pos.set(c, { code: c, sh: 0, cost: 0, realized: 0, divs: 0, fees: 0, taxes: 0, buys: 0, sells: 0, todayBuy: 0, todayReg: 0, lastBuy: null });
    return pos.get(c);
  };
  flows.push({ d: run.start.d, amt: run.capital, kind: 'capital' });
  for (const x of run.cash || []) flows.push({ d: x.d, amt: x.amt, kind: x.kind, ref: x.note });

  // 事件依時間排：成交、分割、除息
  const fills = (run.fills || []).filter((f) => f.t <= nowMs).sort((a, b) => a.t - b.t);
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
      if (f.d === today) { p.todayBuy += f.qty; if (f.sess === 'reg') p.todayReg += f.qty; }
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

  // 掛著的買單要圈存額度；掛著的賣單要圈住股數。
  // 刪單、減量還沒被下一筆行情確認之前，照原來的數量圈著（可能成交在先）。
  let reserved = 0;
  const lockedSh = new Map();
  const filledBy = new Map();
  for (const f of fills) filledBy.set(f.oid, (filledBy.get(f.oid) || 0) + f.qty);
  for (const o of run.orders || []) {
    if (o.at > nowMs) continue;
    const fin = (run.finals || {})[o.id];
    if (fin && !(isNum(fin.t) && fin.t > nowMs)) continue;
    const { q, cancelled } = qtyAt(o, confirmedMods(run, o, nowMs), Infinity);
    if (cancelled) continue;
    const left = Math.max(0, q - (filledBy.get(o.id) || 0));
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

/**
 * 能賣多少股：庫存－掛著的賣單－今天買進還不能賣的。
 * 現股當沖只限「整股」：有當沖資格時，今天用整股買進的可以今天用整股賣；
 * 零股（盤中、盤後）、盤後定價買進的，今天一律不能賣；今天的任何買進也不能用零股、盤後定價賣掉。
 */
export function sellable(L, code, daytradeOk, sess = 'reg') {
  const h = L.holdings.find((x) => x.code === code);
  if (!h) return 0;
  const notYet = daytradeOk && sess === 'reg' ? h.todayBuy - (h.todayReg || 0) : h.todayBuy;
  return Math.max(0, h.sh - notYet - h.locked);
}
