// 撮合引擎與帳務測試：node tests/engine_test.mjs
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';
import { advance, processRun, mergeProgress, ledger, orderStatus, walkBook, sellable, BIG } from '../src/engine.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}

const D = 20261022;          // 星期四
const D2 = 20261023;         // 星期五
const T = (hm, s = 0, d = D) => R.atTW(d, hm, s);
const cal = R.makeCal({ holidays: [20261026], settle_only: [] });

/**
 * 假行情（和 data.js 的規則一樣）：ticks[code][d][kind] = [...]（t＝資料時間）；day[code][d] = {...}；
 * fin[code][d]＝那天的行情已經結束（沒給的話：官方收盤價 day.c 出來了就算結束）；official[code][d]＝官方日 K。
 */
function mk({ ticks = {}, day = {}, after = {}, oddOpen = {}, oddClose = {}, market = {}, cat = {}, divs = {}, splits = {}, last = {}, fin = {}, official = {} } = {}) {
  const final = (c, d) => (fin[c] && fin[c][d] !== undefined ? fin[c][d] : !!(day[c] && day[c][d] && day[c][d].c != null));
  return {
    cal,
    ticks: (c, d, k) => (ticks[c] && ticks[c][d] && ticks[c][d][k]) || null,
    final,
    day: (c, d) => (day[c] && day[c][d]) || null,
    official: (c, d) => (official[c] && official[c][d]) || null,
    after: (c, d) => ((market[c] || 'tse') === 'otc' ? (final(c, d) ? null : undefined) : (after[d] === undefined ? undefined : (after[d][c] ?? null))),
    oddOpen: (c, d) => (oddOpen[c] || {})[d] ?? null,
    closeAuction: (c, d, k) => {
      if (k === 'odd' && oddClose[c] && oddClose[c][d] !== undefined) return { known: true, px: oddClose[c][d] };
      const tks = (ticks[c] && ticks[c][d] && ticks[c][d][k]) || [];
      for (const x of tks) if (x.t >= R.atTW(d, 1330) && x.zt != null && x.zt >= R.atTW(d, 1330)) return { known: true, px: x.z };
      if (tks.some((x) => x.t >= R.atTW(d, 1331))) return { known: true, px: null };
      if (final(c, d)) { const dd = day[c] && day[c][d]; return { known: true, px: k === 'odd' ? null : dd && dd.c != null ? dd.c : null }; }
      return { known: false, px: null };
    },
    market: (c) => market[c] || 'tse',
    cat: (c) => cat[c] || 'broad',
    divs: (c) => divs[c] || [],
    splits: (c) => splits[c] || [],
    close: () => null,
    last: (c) => last[c] ?? null,
  };
}
const tk = (hm, s, f) => ({ t: T(hm, s), z: null, zt: null, h: null, l: null, v: 0, a: [], b: [], ...f });
const order = (f) => ({ id: 'o1', at: T(1000), code: '0050', side: 'B', sess: 'reg', type: 'L', tif: 'ROD', px: 100, qty: 1000, day: D, phase: 'continuous', ...f });
const run1 = (o, m, now, mods = []) => advance(o, undefined, mods, m, now);

// ------------------------------------------------------------------ 規則
test('升降單位：50 元以下 0.01、以上 0.05', () => {
  assert.equal(R.tick(49.99), 0.01);
  assert.equal(R.tick(50), 0.05);
  assert.equal(R.tickUp(49.99), 50);
  assert.equal(R.tickUp(50), 50.05);
  assert.equal(R.tickDown(50), 49.99);
  assert.equal(R.tickDown(50.05), 50);
  assert.ok(R.onTick(108.15) && !R.onTick(108.13) && R.onTick(35.41));
  assert.equal(R.snapTick(108.13, 1), 108.15);
  assert.equal(R.snapTick(108.13, -1), 108.1);
});
test('時段：盤中、收盤競價、盤後、預約單', () => {
  assert.equal(R.orderWindow(cal, T(1000), 'lot').phase, 'continuous');
  assert.deepEqual(R.orderWindow(cal, T(1000), 'lot').types, ['L', 'M']);
  assert.equal(R.orderWindow(cal, T(1326), 'lot').phase, 'closing');
  assert.deepEqual(R.orderWindow(cal, T(1326), 'lot').types, ['L']);
  assert.ok(R.orderWindow(cal, T(1345), 'lot').blocked);
  assert.equal(R.orderWindow(cal, T(1410), 'lot').sess, 'fix');
  assert.equal(R.orderWindow(cal, T(1500), 'lot').day, D2);
  assert.equal(R.orderWindow(cal, T(845), 'lot').phase, 'preopen');
  assert.equal(R.orderWindow(cal, T(800), 'lot').phase, 'reserve');
  assert.equal(R.orderWindow(cal, T(1500, 0, D2), 'lot').day, 20261027, '週五晚上的預約單到下週二（週一休市）');
  assert.equal(R.orderWindow(cal, T(1335), 'odd').sess, undefined, '13:30～13:40 零股不收單');
  assert.equal(R.orderWindow(cal, T(1345), 'odd').sess, 'oddpm');
  assert.equal(R.orderWindow(cal, T(905), 'odd').phase, 'preopen', '新制前零股 09:10 第一次撮合');
  assert.equal(R.orderWindow(cal, R.atTW(20261208, 905), 'odd').phase, 'continuous', '2026/12/7 起零股 09:00 開始撮合');
});
test('交割日 T+2 跳過週末與休市', () => {
  assert.equal(R.settleDay(cal, D, 2), 20261027);   // 四 → 五、(六日)、(一休市) → 二
  const c2 = R.makeCal({ holidays: [20260212, 20260213], settle_only: [20260212, 20260213] });
  assert.equal(R.settleDay(c2, 20260211, 2), 20260213, '只辦交割的日子也算營業日');
});
test('手續費：日退先收原價、最低 20／1 元', () => {
  const f = R.DEFAULT_FEES;
  assert.equal(R.feeCharged(108150, false, f), 154);
  assert.equal(R.feeFinal(108150, false, f), 43);
  assert.equal(R.feeCharged(1000, false, f), 20);
  assert.equal(R.feeCharged(1000, true, f), 1);
  assert.equal(R.taxRate('00679B', 'bond', D), 0, '被動式債券 ETF 停徵到 2026/12/31');
  assert.equal(R.taxRate('00679B', 'bond', 20270104), 0.001);
  assert.equal(R.taxRate('00980D', 'bond', D), 0.001, '主動式債券 ETF 照課');
});
test('當沖資格：開戶滿 3 個月＋一年內成交 10 筆', () => {
  assert.equal(R.daytradeStatus(20260722, D, 10).ok, true);
  assert.equal(R.daytradeStatus(20260723, D, 10).ok, false);
  assert.equal(R.daytradeStatus(20260101, D, 9).ok, false);
});

// ------------------------------------------------------------------ 撮合
test('五檔吃單：依價格由好到壞', () => {
  const r = walkBook([[100, 2000], [100.05, 5000], [100.1, 9000]], 'B', 3000, 100.05);
  assert.deepEqual(r.fills, [{ px: 100, qty: 2000 }, { px: 100.05, qty: 1000 }]);
});
test('盤中限價買（送單時就能成交）：下一筆快照的賣方五檔能吃就成交，價格用對方的', () => {
  const m = mk({ ticks: { '0050': { [D]: { reg: [tk(1003, 0, { a: [[99.9, 2000], [100, 5000]], l: 99.8, h: 100.2, z: 99.95, zt: T(1002) })] } } } });
  const r = run1(order({ qty: 3000, ref: { a1: 99.95 } }), m, T(1004));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty]), [[99.9, 2000], [100, 1000]]);
  assert.equal(r.done.st, 'filled');
});
test('送單時還不能成交的限價單：之後就算跌更深，也只用委託價成交（不能偷到更好的價格）', () => {
  const m = mk({ ticks: { '0050': { [D]: { reg: [tk(1003, 0, { a: [[99.6, 2000], [99.7, 5000]], l: 99.5, h: 100.2, z: 99.6, zt: T(1002) })] } } } });
  const r = run1(order({ qty: 3000, ref: { a1: 100.2 } }), m, T(1004));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty]), [[100, 2000], [100, 1000]]);
});
test('委託前的快照不能拿來成交（不能看答案）', () => {
  const m = mk({ ticks: { '0050': { [D]: { reg: [tk(959, 0, { a: [[99, 9000]] })] } } } });
  const r = run1(order(), m, T(1001));
  assert.equal(r.fills.length, 0);
  assert.equal(r.prog.st, 'wait');
});
test('掛著的限價單：剛好碰到不算，要穿過才成交', () => {
  const ticks = [
    tk(1005, 0, { a: [[100.05, 3000]], b: [[99.95, 1000]], l: 99.95, h: 100.3, z: 100, zt: T(1004) }),
    tk(1010, 0, { a: [[100.05, 3000]], l: 99.95, h: 100.3, z: 100, zt: T(1009) }),     // 剛好碰到 100（委託價）
    tk(1015, 0, { a: [[100.1, 3000]], l: 99.95, h: 100.3, z: 99.95, zt: T(1014) }),   // 有人用 99.95 成交 → 穿過
  ];
  const m = mk({ ticks: { '0050': { [D]: { reg: ticks } } } });
  const o = order();
  let r = run1(o, m, T(1011));
  assert.equal(r.fills.length, 0, '碰到不算');
  r = advance(o, r.prog, [], m, T(1016));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty, f.how]), [[100, 1000, 'through']]);
});
test('創當日新低（低於委託價）也算穿價', () => {
  const ticks = [
    tk(1005, 0, { a: [[100.1, 3000]], l: 99.9, h: 100.3, z: 100.1, zt: T(1004) }),
    tk(1010, 0, { a: [[100.2, 3000]], l: 99.85, h: 100.3, z: 100.2, zt: T(1009) }),
  ];
  const r = run1(order(), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1011));
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].px, 100);
});
test('開始撮合前的當日低點不算（低點發生在委託前）', () => {
  const ticks = [
    tk(1005, 0, { a: [[100.1, 3000]], l: 99.5, h: 100.3, z: 100.1, zt: T(1004) }),
    tk(1010, 0, { a: [[100.2, 3000]], l: 99.5, h: 100.3, z: 100.2, zt: T(1009) }),
  ];
  const r = run1(order(), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1011));
  assert.equal(r.fills.length, 0);
});
test('賣方掛得比你的買價還低：用你的價格成交、量看對方', () => {
  const ticks = [
    tk(1005, 0, { a: [[100.1, 3000]], l: 99.9, z: 100.1, zt: T(1004) }),
    tk(1010, 0, { a: [[99.95, 1000], [100, 500]], l: 99.9, z: 100.1, zt: T(1004) }),
  ];
  const r = run1(order({ qty: 2000 }), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1011));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty]), [[100, 1000]], '只吃得到 1500 股 → 整股取 1 張');
});
test('漲停鎖死：市價買不到，收盤後失效', () => {
  const day = { '0050': { [D]: { u: 110, w: 90, c: 110, o: 105 } } };
  const ticks = [tk(1005, 0, { a: [], b: [[110, 9e6]], l: 104, h: 110, z: 110, zt: T(1004) }), tk(1331, 0, { z: 110, zt: T(1330) })];
  const r = run1(order({ type: 'M', px: null }), mk({ day, ticks: { '0050': { [D]: { reg: ticks } } } }), T(1340));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'expired');
});
test('開盤前委託：比開盤價好就用開盤價成交', () => {
  const day = { '0050': { [D]: { o: 100.1, u: 110, w: 90 } } };
  const r = run1(order({ at: T(850), phase: 'preopen', px: 100.2 }), mk({ day }), T(900, 30));
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[100.1, 'open']]);
});
test('開盤前委託：等於開盤價不算，之後跌破才成交', () => {
  const day = { '0050': { [D]: { o: 100.1, u: 110, w: 90 } } };
  const ticks = [tk(901, 0, { a: [[100.15, 1000]], l: 100.1, h: 100.3, z: 100.15, zt: T(900, 50) }), tk(906, 0, { l: 100.05, z: 100.2, zt: T(905) })];
  const o = order({ at: T(850), phase: 'preopen', px: 100.1 });
  const r = run1(o, mk({ day, ticks: { '0050': { [D]: { reg: ticks } } } }), T(907));
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[100.1, 'through']]);
});
test('預約單在開盤前刪單：馬上確定，不用等行情', () => {
  const o = order({ at: T(1500), day: D2, phase: 'reserve', px: 100 });
  const r = run1(o, mk(), T(2000), [{ oid: 'o1', at: T(1900), kind: 'cancel' }]);
  assert.equal(r.done.st, 'cancelled');
});
test('預約單超出隔天漲跌停：交易所退單', () => {
  const day = { '0050': { [D2]: { o: 100, u: 105, w: 95 } } };
  const o = order({ at: T(1500), day: D2, phase: 'reserve', px: 106 });
  const r = run1(o, mk({ day }), R.atTW(D2, 901));
  assert.equal(r.done.st, 'rejected');
});
test('收盤集合競價：比收盤價好就用收盤價成交；剛好等於不算', () => {
  const day = { '0050': { [D]: { c: 99.95, u: 110, w: 90 } } };
  const ticks = [tk(1005, 0, { a: [[100.1, 3000]], l: 99.98, z: 100.1, zt: T(1004) }), tk(1331, 0, { z: 99.95, zt: T(1330) })];
  const m = mk({ day, ticks: { '0050': { [D]: { reg: ticks } } } });
  let r = run1(order(), m, T(1335));
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[99.95, 'close']]);
  r = run1(order({ px: 99.95 }), m, T(1335));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'expired');
});
test('13:30 收盤沒有撮合成交（最後成交在早上）：掛單不能用那個價格成交', () => {
  const day = { '0050': { [D]: { c: 20, u: 22, w: 18 } } };
  const ticks = [tk(1105, 0, { a: [[20.1, 3000]], l: 20, z: 20, zt: T(1000) }), tk(1331, 0, { z: 20, zt: T(1000) })];
  const r = run1(order({ at: T(1100), px: 20.05 }), mk({ day, ticks: { '0050': { [D]: { reg: ticks } } } }), T(1335));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'expired');
});
test('13:25 前送出、下一筆快照已經是收盤競價時段：不用競價委託簿成交，只參加收盤撮合', () => {
  const day = { '0050': { [D]: { c: 100.2, u: 110, w: 90 } } };
  const ticks = [tk(1326, 0, { a: [[99.5, 9000]], l: 99.9, z: 100, zt: T(1324) }), tk(1331, 0, { z: 100.2, zt: T(1330) })];
  const m = mk({ day, ticks: { '0050': { [D]: { reg: ticks } } } });
  let r = run1(order({ at: T(1324, 50), px: 100, ref: { a1: 100.05 } }), m, T(1327));
  assert.equal(r.fills.length, 0);
  r = run1(order({ at: T(1324, 50), px: 100.3, ref: { a1: 100.05 } }), m, T(1335));
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[100.2, 'close']]);
});
test('收盤價還沒出來：先不判定', () => {
  const ticks = [tk(1005, 0, { a: [[100.1, 3000]], l: 99.98, z: 100.1, zt: T(1004) })];
  const r = run1(order(), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1335));
  assert.equal(r.done, null);
});
test('刪單送出後、下一筆快照顯示早就能成交：成交在先（看到要虧才刪單是來不及的）', () => {
  const ticks = [tk(1003, 0, { a: [[99.9, 2000]] })];
  const r = run1(order({ ref: { a1: 99.95 } }), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1004), [{ oid: 'o1', at: T(1001), kind: 'cancel' }]);
  assert.equal(r.fills.length, 1);
  assert.equal(r.done.st, 'filled');
});
test('刪單：下一筆快照沒有成交的跡象，刪單才確定', () => {
  const ticks = [tk(1003, 0, { a: [[100.1, 2000]], l: 99.95, h: 100.3, z: 100.1, zt: T(1002) }), tk(1008, 0, { a: [[100.1, 2000]], l: 99.95, z: 100.1, zt: T(1007) })];
  const m = mk({ ticks: { '0050': { [D]: { reg: ticks } } } });
  const mods = [{ oid: 'o1', at: T(1005), kind: 'cancel' }];
  let r = run1(order(), m, T(1006), mods);
  assert.equal(r.done, null, '刪單送出了，但下一筆行情還沒來：刪單中');
  r = advance(order(), r.prog, mods, m, T(1009));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'cancelled');
});
test('刪單之後、下一筆快照顯示價格已經穿過：成交在先', () => {
  const ticks = [tk(1003, 0, { a: [[100.1, 2000]], l: 99.95, h: 100.3, z: 100.1, zt: T(1002) }), tk(1008, 0, { a: [[100.1, 2000]], l: 99.8, z: 100.1, zt: T(1007) })];
  const r = run1(order(), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1009), [{ oid: 'o1', at: T(1005), kind: 'cancel' }]);
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[100, 'through']]);
  assert.equal(r.done.st, 'filled');
});
test('刪單在成交之後：成交算數，刪單失敗', () => {
  const ticks = [tk(1003, 0, { a: [[99.9, 2000]] })];
  const r = run1(order(), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1006), [{ oid: 'o1', at: T(1005), kind: 'cancel' }]);
  assert.equal(r.fills.length, 1);
  assert.equal(r.done.st, 'filled');
});
test('減量：下一筆快照之後才生效；之後成交最多到減量後的數量', () => {
  const ticks = [tk(1003, 0, { a: [[100.1, 9000]], l: 99.95, z: 100.1, zt: T(1002) }), tk(1008, 0, { a: [[99.9, 9000]], l: 99.95, z: 100.1, zt: T(1002) })];
  const r = run1(order({ qty: 3000 }), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1009), [{ oid: 'o1', at: T(1004), kind: 'reduce', qty: 1000 }]);
  assert.equal(r.fills.reduce((s, f) => s + f.qty, 0), 3000, '減量在 10:04，10:08 那筆快照的區間內 → 成交在先');
  const r2 = run1(order({ qty: 3000 }), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1009), [{ oid: 'o1', at: T(1001), kind: 'reduce', qty: 1000 }]);
  assert.equal(r2.fills.reduce((s, f) => s + f.qty, 0), 2000, '減量在第一筆快照之前就確定了');
  assert.equal(r2.done.st, 'filled');
});
test('IOC：吃得到的成交、其餘取消；FOK：不夠就整筆取消', () => {
  const ticks = [tk(1003, 0, { a: [[99.9, 1000]] })];
  const m = mk({ ticks: { '0050': { [D]: { reg: ticks } } } });
  let r = run1(order({ qty: 3000, tif: 'IOC' }), m, T(1004));
  assert.equal(r.fills[0].qty, 1000);
  assert.equal(r.done.st, 'cancelled');
  r = run1(order({ qty: 3000, tif: 'FOK' }), m, T(1004));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'cancelled');
});
test('盤中零股：用零股的五檔，量以股計', () => {
  const ticks = [tk(1003, 0, { a: [[108.4, 150], [108.45, 500]] })];
  const m = mk({ ticks: { '0050': { [D]: { odd: ticks, reg: [] } } } });
  const r = run1(order({ sess: 'odd', qty: 300, px: 108.45, ref: { oa1: 108.4 } }), m, T(1004));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty]), [[108.4, 150], [108.45, 150]]);
});
test('盤後零股：用證交所公布的成交價，嚴格比較', () => {
  const after = { [D]: { '0050': [108.35, 66858, 43000, 807000, 0] } };
  const m = mk({ after, day: { '0050': { [D]: { c: 108.15 } } } });
  let r = run1(order({ sess: 'oddpm', qty: 50, px: 108.4, at: T(1400) }), m, T(1700));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty]), [[108.35, 50]]);
  r = run1(order({ sess: 'oddpm', qty: 50, px: 108.35, at: T(1400) }), m, T(1700));
  assert.equal(r.done.st, 'expired');
});
test('盤後零股：結果還沒公布就等', () => {
  const r = run1(order({ sess: 'oddpm', qty: 50, px: 108.4, at: T(1400) }), mk({ day: { '0050': { [D]: { c: 108.15 } } } }), T(1440));
  assert.equal(r.done, null);
});
test('盤後定價：對手方有剩下沒成交的委託，才用收盤價成交，量最多到剩下的量', () => {
  const after = { [D]: { '0050': [108.35, 66858, 43000, 807000, 0] } };   // 10/21 實際：成交 43 張、買方剩 807 張、賣方剩 0
  const m = mk({ after, day: { '0050': { [D]: { c: 108.15 } } } });
  let r = run1(order({ sess: 'fix', type: 'C', px: 108.15, qty: 100000, at: T(1405) }), m, T(1600));
  assert.equal(r.fills.length, 0, '買方已經多出 807 張沒成交：新的買單排不到');
  assert.equal(r.done.st, 'expired');
  r = run1(order({ sess: 'fix', type: 'C', px: 108.15, side: 'S', qty: 1000000, at: T(1405) }), m, T(1600));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty, f.how]), [[108.15, 807000, 'fix']], '賣單最多吃到買方剩下的 807 張');
  assert.equal(r.done.st, 'expired');
});
test('預約的那天變成颱風假：預約單失效', () => {
  const c3 = R.makeCal({ closed: [D2] });
  const m = { ...mk(), cal: c3 };
  const r = run1(order({ at: T(1500), day: D2, phase: 'reserve' }), m, R.atTW(D2, 1500));
  assert.equal(r.done.st, 'expired');
});

// ------------------------------------------------------------------ 整局與帳務
const baseRun = () => ({
  id: 'r1', no: 1, start: { at: T(900, 0, 20261020), d: 20261020 }, capital: 1000000,
  fees: { ...R.DEFAULT_FEES }, orders: [], mods: [], fills: [], prog: {}, finals: {},
});
test('同一局重算不會重複成交（成交 id 固定）', () => {
  const run = baseRun();
  run.orders.push(order({ id: 'a1' }));
  const m = mk({ ticks: { '0050': { [D]: { reg: [tk(1003, 0, { a: [[99.9, 2000]] })] } } }, last: { '0050': 100 } });
  let r = mergeProgress(run, processRun(run, m, T(1004)));
  r = mergeProgress(r, processRun(r, m, T(1005)));
  const other = processRun(run, m, T(1006));
  const both = mergeProgress(r, other);
  assert.equal(r.fills.length, 1);
  assert.equal(both.fills.length, 1, '兩個分頁各算一次，合併後還是一筆');
  assert.equal(r.fills[0].id, `a1@${T(1003).toString(36)}.0`, 'id 由委託、快照時間、第幾筆決定');
  assert.equal(orderStatus(r, r.orders[0]).st, 'filled');
});
test('帳務：T+2 才扣款、手續費隔天退、可用額度先扣掉', () => {
  const run = baseRun();
  run.orders.push(order({ id: 'a1', px: 100, qty: 1000 }));
  const m = mk({ ticks: { '0050': { [D]: { reg: [tk(1003, 0, { a: [[100, 2000]] })] } } }, last: { '0050': 101 } });
  const r = mergeProgress(run, processRun(run, m, T(1004)));
  const f = r.fills[0];
  assert.equal(f.amt, 100000);
  assert.equal(f.fee, 142);
  assert.equal(f.fin, 39);
  let L = ledger(r, m, T(1004));
  assert.equal(L.cash, 1000000, '還沒交割');
  assert.equal(L.avail, 1000000 - 100142);
  assert.equal(L.holdings[0].sh, 1000);
  assert.equal(L.holdings[0].todayBuy, 1000);
  assert.equal(Math.round(L.equity), 1000000 - 142 + 103 + 1000, '權益＝現金－待交割＋手續費待退＋市值');
  L = ledger(r, m, R.atTW(D2, 1000));
  assert.equal(L.cash, 1000000 + 103, '隔天退手續費');
  L = ledger(r, m, R.atTW(20261027, 1000));
  assert.equal(L.cash, 1000000 + 103 - 100142, 'T+2（跳過週末、週一休市）扣款');
  assert.equal(sellable(ledger(r, m, T(1005)), '0050', false), 0, '沒當沖資格：今天買的今天不能賣');
  assert.equal(sellable(ledger(r, m, T(1005)), '0050', true, 'reg'), 1000, '有當沖資格：今天整股買的可以今天整股賣');
  assert.equal(sellable(ledger(r, m, T(1005)), '0050', true, 'odd'), 0, '今天買的不能用零股賣（零股不能當沖）');
  assert.equal(sellable(ledger(r, m, R.atTW(D2, 1000)), '0050', false), 1000);
});
test('帳務：賣出扣證交稅、已實現損益', () => {
  const run = baseRun();
  run.fills = [
    { id: 'b:1', oid: 'b', t: T(1000, 0, 20261020), d: 20261020, code: '0050', side: 'B', sess: 'reg', qty: 1000, px: 100, amt: 100000, fee: 142, fin: 39, tax: 0 },
    { id: 's:1', oid: 's', t: T(1000), d: D, code: '0050', side: 'S', sess: 'reg', qty: 1000, px: 110, amt: 110000, fee: 156, fin: 43, tax: 110 },
  ];
  const L = ledger(run, mk({ last: { '0050': 110 } }), R.atTW(20261028, 1000));
  const h = L.holdings.find((x) => x.code === '0050');
  assert.equal(h.sh, 0);
  assert.equal(Math.round(h.realized), 110000 - 43 - 110 - 100039);
  assert.equal(L.cash, 1000000 - 100142 + 103 + (110000 - 156 - 110) + 113);
});
test('帳務：除息日前一天持有就領得到配息（扣二代健保），發放日入帳', () => {
  const run = baseRun();
  run.fills = [{ id: 'b:1', oid: 'b', t: T(1000, 0, 20261020), d: 20261020, code: '0056', side: 'B', sess: 'reg', qty: 30000, px: 35, amt: 1050000, fee: 1496, fin: 419, tax: 0 }];
  run.capital = 2000000;
  const m = mk({ divs: { '0056': [[D, 1.0]] }, last: { '0056': 34 } });
  const L = ledger(run, m, T(1000));
  assert.equal(L.divItems.length, 1);
  assert.equal(L.divItems[0].amt, 30000);
  assert.equal(L.divItems[0].nhi, Math.round(30000 * 0.0211));
  assert.ok(L.divItems[0].pay > D);
  assert.equal(L.pendingDiv, 30000 - 633);
});
test('帳務：分割後股數乘倍數、成本不變', () => {
  const run = baseRun();
  run.fills = [{ id: 'b:1', oid: 'b', t: T(1000, 0, 20261020), d: 20261020, code: '0050', side: 'B', sess: 'reg', qty: 1000, px: 200, amt: 200000, fee: 285, fin: 79, tax: 0 }];
  const L = ledger(run, mk({ splits: { '0050': [[D, 4]] }, last: { '0050': 50 } }), T(1000));
  assert.equal(L.holdings[0].sh, 4000);
  assert.equal(Math.round(L.holdings[0].cost), 200079);
});
test('掛單圈存：買單圈額度、賣單圈股數', () => {
  const run = baseRun();
  run.fills = [{ id: 'b:1', oid: 'b', t: T(1000, 0, 20261020), d: 20261020, code: '0050', side: 'B', sess: 'reg', qty: 2000, px: 100, amt: 200000, fee: 285, fin: 79, tax: 0 }];
  run.orders = [order({ id: 'x', px: 99, qty: 1000, at: T(1100) }), order({ id: 'y', side: 'S', px: 105, qty: 1000, at: T(1100) })];
  const L = ledger(run, mk({ last: { '0050': 100 } }), T(1101));
  assert.equal(L.reserved, 99000 + 141);
  assert.equal(sellable(L, '0050', false), 1000);
});

// ------------------------------------------------------------------ 獨立檢查找到的漏洞（每一個都要有測試）
test('C1 快照的時間用資料本身的時間：委託之前就發生的低點不算穿價', () => {
  // 證交所資料 09:42:34 的五檔、09:48:20 的五檔（當日低點 107.9 其實發生在 09:42:50，委託之前）
  const t1 = tk(942, 34, { a: [[108.25, 100000]], b: [[108.2, 239000]], h: 109.15, l: 108.25, z: 108.3, zt: T(942, 24) });
  const x = tk(948, 20, { a: [[108.45, 50000]], b: [[108.4, 80000]], h: 109.15, l: 107.9, z: 108.4, zt: T(948, 20) });
  const o = order({ at: T(943), px: 108, qty: 5000, ref: { a1: 108.45, b1: 108.4 } });
  const r = run1(o, mk({ ticks: { '0050': { [D]: { reg: [t1, x] } } } }), T(949));
  assert.equal(r.fills.length, 0, '委託 09:43:00 到達的是 09:48:20 那一筆，那時的低點已經算進起點');
  assert.equal(r.prog.L, 107.9);
});
test('C1 委託時看到的五檔（資料時間在委託前）不能拿來成交', () => {
  const t1 = tk(942, 34, { a: [[108.25, 100000]], z: 108.3, zt: T(942, 24) });
  const o = order({ at: T(943), px: 108.25, qty: 100000, tif: 'IOC', ref: { a1: 108.45 } });
  const r = run1(o, mk({ ticks: { '0050': { [D]: { reg: [t1] } } } }), T(945));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done, null, '等下一筆資料');
});
test('C2 收盤結果還沒出來：時間過了再久也不判定（不看時鐘）', () => {
  const ticks = [tk(925, 0, { a: [[108.65, 1000]], b: [[108.6, 1000]], l: 108.5, h: 108.7, z: 108.6, zt: T(924) })];
  const o = order({ at: T(921), px: 108.2, qty: 5000, ref: { a1: 108.65, b1: 108.6 } });
  const r = run1(o, mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1601));
  assert.equal(r.done, null, '16:01 了但那天的行情還沒確定結束：等');
  const r2 = run1(o, mk({ ticks: { '0050': { [D]: { reg: ticks } } }, fin: { '0050': { [D]: true } } }), T(1601));
  assert.equal(r2.done.st, 'expired', '後台確定那天結束了才判定');
});
test('C2 刪單要等「刪單之後」的資料確認：時間到了 13:30 也不能自己確定', () => {
  const base = [tk(1322, 0, { a: [[100.5, 5000]], l: 100.2, h: 100.8, z: 100.5, zt: T(1321) })];
  const o = order({ id: 'o2', at: T(1320) });
  const p = run1(o, mk({ ticks: { '0050': { [D]: { reg: base } } } }), T(1323)).prog;
  const mods = [{ oid: 'o2', at: T(1324, 50), kind: 'cancel' }];
  let r = advance(o, p, mods, mk({ ticks: { '0050': { [D]: { reg: base } } } }), T(1330, 30));
  assert.equal(r.done, null, '13:24:50 刪單之後還沒有新資料：刪單中');
  // 收盤後那一筆（13:30:20）顯示當日低點 99.7（穿過 100）：可能在刪單前就成交了 → 成交在先
  const post = tk(1330, 20, { l: 99.7, h: 100.8, z: 99.8, zt: T(1330) });
  r = advance(o, p, mods, mk({ ticks: { '0050': { [D]: { reg: [...base, post] } } } }), T(1335));
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[100, 'through']]);
  assert.equal(r.done.st, 'filled');
  // 沒有之後的快照、但那天確定結束了：用官方日 K 的最低價判斷
  r = advance(o, p, mods, mk({ ticks: { '0050': { [D]: { reg: base } } }, fin: { '0050': { [D]: true } }, official: { '0050': { [D]: { o: 100.4, h: 100.8, l: 100.2, c: 100.5 } } } }), T(1601));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'cancelled', '官方最低 100.2 沒穿過 100：刪單成功');
});
test('C3 後台斷線、那天只有官方日 K：開盤前的單照開盤價、之後照最低價判斷', () => {
  const m = mk({ day: { '0050': { [D]: { o: 100.4, h: 101.5, l: 99.8, c: 101 } } }, official: { '0050': { [D]: { o: 100.4, h: 101.5, l: 99.8, c: 101 } } } });
  let r = run1(order({ at: T(850), phase: 'preopen', px: 100.5 }), m, T(1500));
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[100.4, 'open']]);
  r = run1(order({ at: T(850), phase: 'preopen', px: 100 }), m, T(1500));
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[100, 'through']], '開盤後的最低 99.8 穿過 100：用委託價成交');
  r = run1(order({ at: T(1000), px: 100 }), m, T(1500));
  assert.equal(r.fills.length, 0, '盤中送出、之後沒有快照：只參加收盤撮合（收盤 101 沒有比 100 好）');
  assert.equal(r.done.st, 'expired');
});
test('C4 減量還沒確認之前，股數照原來的圈著（不能先拿去賣）', () => {
  const run = baseRun();
  run.fills = [{ id: 'b:1', oid: 'b', t: T(1000, 0, 20261020), d: 20261020, code: '0050', side: 'B', sess: 'reg', qty: 2000, px: 100, amt: 200000, fee: 285, fin: 79, tax: 0 }];
  run.orders = [order({ id: 'S1', side: 'S', px: 105, qty: 2000, at: T(1000), ref: { a1: 104.6, b1: 104.5 } })];
  const ticks = [tk(1004, 0, { a: [[104.6, 5000]], b: [[104.5, 5000]], h: 104.8, l: 104, z: 104.5, zt: T(1003, 50) })];
  const m = mk({ ticks: { '0050': { [D]: { reg: ticks } } }, last: { '0050': 104.5 } });
  let r = mergeProgress(run, processRun(run, m, T(1005)));
  r = { ...r, mods: [{ id: 'm1', oid: 'S1', at: T(1012), kind: 'reduce', qty: 1000 }] };
  let L = ledger(r, m, T(1012, 10));
  assert.equal(L.lockedSh.get('0050'), 2000, '減量送出了但還沒有新資料確認：照樣圈 2 張');
  assert.equal(sellable(L, '0050', false), 0);
  const later = tk(1014, 0, { a: [[104.7, 5000]], b: [[104.6, 5000]], h: 104.8, l: 104, z: 104.6, zt: T(1013) });
  const m2 = mk({ ticks: { '0050': { [D]: { reg: [...ticks, later] } } }, last: { '0050': 104.6 } });
  r = mergeProgress(r, processRun(r, m2, T(1015)));
  L = ledger(r, m2, T(1015));
  assert.equal(L.lockedSh.get('0050'), 1000, '下一筆資料確認之後才放出 1 張');
});
test('C4 保險：不管哪裡出錯，賣出成交不會超過手上的股數', () => {
  const run = baseRun();
  run.fills = [{ id: 'b:1', oid: 'b', t: T(1000, 0, 20261020), d: 20261020, code: '0050', side: 'B', sess: 'reg', qty: 2000, px: 100, amt: 200000, fee: 285, fin: 79, tax: 0 }];
  run.orders = [order({ id: 'S1', side: 'S', px: 104, qty: 2000, at: T(1000), ref: { b1: 104.5 } }), order({ id: 'S2', side: 'S', px: 104, qty: 1000, at: T(1001), ref: { b1: 104.5 } })];
  const ticks = [tk(1004, 0, { a: [[104.6, 5000]], b: [[104.5, 9000]], h: 104.8, l: 104, z: 104.5, zt: T(1003) })];
  const m = mk({ ticks: { '0050': { [D]: { reg: ticks } } }, last: { '0050': 104.5 } });
  const r = mergeProgress(run, processRun(run, m, T(1005)));
  const sold = r.fills.filter((f) => f.side === 'S').reduce((s, f) => s + f.qty, 0);
  assert.equal(sold, 2000);
});
test('C5 上櫃 ETF 沒有盤後資料：盤後定價、盤後零股不成交（不會用已知的收盤價偷成交）', () => {
  const D0 = 20261021;
  const m = mk({ market: { '00679B': 'otc' }, day: { '00679B': { [D0]: { c: 25.77 } } } });
  let r = run1({ id: 'f2', code: '00679B', side: 'B', sess: 'fix', type: 'C', tif: 'ROD', px: 25.77, qty: 100000, day: D0, phase: 'afterhours', at: R.atTW(D0, 1405) }, m, R.atTW(D0, 1431));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'expired');
  r = run1({ id: 'f3', code: '00679B', side: 'B', sess: 'oddpm', type: 'L', tif: 'ROD', px: 25.78, qty: 999, day: D0, phase: 'oddpm', at: R.atTW(D0, 1345) }, m, R.atTW(D0, 1431));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'expired');
});
test('C7 盤中零股沒有零股資料：不拿整股的開盤價代替', () => {
  const day = { '0050': { [D]: { o: 100, h: 102.5, l: 99.9, u: 108.9, w: 89.1 } } };
  const o = order({ sess: 'odd', at: T(905), px: 102.4, qty: 999, phase: 'preopen', ref: {} });
  let r = run1(o, mk({ day, ticks: { '0050': { [D]: { reg: [tk(908, 0, { z: 102.4, zt: T(907) })] } } } }), T(910, 5));
  assert.equal(r.fills.length, 0, '整股 09:00 開盤 100，但零股還沒有資料：等');
  assert.equal(r.done, null);
  r = run1(o, mk({ day: { '0050': { [D]: { ...day['0050'][D], c: 102 } } } }), T(1500));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'expired', '那天確定結束了也沒有零股資料：委託失效');
});
test('市價單剩下的部分：照證交所的轉換參考價成交（漲停打開時用漲停價，不撿便宜）', () => {
  const day = { '0050': { [D]: { u: 110, w: 90, o: 105 } } };
  const ticks = [
    tk(1004, 0, { a: [], b: [[110, 9e6]], h: 110, l: 104, z: 110, zt: T(1003), v: 5e6 }),
    tk(1009, 0, { a: [[108.5, 3000], [108.6, 5000]], b: [[108.4, 2000]], h: 110, l: 104, z: 108.5, zt: T(1008), v: 6e6 }),
  ];
  const r = run1(order({ type: 'M', px: null, qty: 3000 }), mk({ day, ticks: { '0050': { [D]: { reg: ticks } } } }), T(1010));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty, f.how]), [[110, 3000, 'rest']]);
});
test('IOC／FOK 送到時已經是收盤前集合競價：取消，不會變成 ROD', () => {
  const ticks = [tk(1326, 0, { a: [[99.5, 9000]], l: 99.9, z: 100, zt: T(1324) })];
  const r = run1(order({ at: T(1324, 50), px: 100.3, tif: 'IOC', ref: { a1: 100.05 } }), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1327));
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'cancelled');
});
test('盤中零股 13:25 以後還是每 5 秒撮合（沒有收盤前集合競價）', () => {
  const odd = [tk(1327, 30, { a: [[100, 500]], b: [[99.9, 300]], z: 99.95, zt: T(1327, 25) })];
  const r = run1(order({ sess: 'odd', at: T(1326), px: 100, qty: 200, ref: { oa1: 100.05 } }), mk({ ticks: { '0050': { [D]: { odd, reg: [] } } } }), T(1328));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty]), [[100, 200]]);
});
test('零股不能當沖：今天用零股買的，今天不能賣', () => {
  const run = { ...baseRun(), start: { at: T(900, 0, 20260601), d: 20260601 } };
  run.fills = [{ id: 'q:1', oid: 'q', t: T(1000), d: D, code: '0050', side: 'B', sess: 'odd', qty: 500, px: 100, amt: 50000, fee: 71, fin: 19, tax: 0 }];
  const L = ledger(run, mk({ last: { '0050': 101 } }), T(1100));
  assert.equal(sellable(L, '0050', true, 'reg'), 0);
  assert.equal(sellable(L, '0050', true, 'odd'), 0);
});
test('兩個分頁輪流寫：舊行情的分頁不會讓同一筆快照成交兩次', () => {
  const t1 = tk(1004, 0, { a: [[100.5, 5000]], b: [[100.4, 5000]], l: 100.2, h: 100.8, z: 100.5, zt: T(1003) });
  const t2 = tk(1009, 0, { a: [[99.95, 1000], [100.5, 5000]], b: [[99.9, 5000]], l: 100.2, h: 100.8, z: 100.5, zt: T(1003) });
  const stale = mk({ ticks: { '0050': { [D]: { reg: [t1] } } }, last: { '0050': 100 } });
  const fresh = mk({ ticks: { '0050': { [D]: { reg: [t1, t2] } } }, last: { '0050': 100 } });
  let run = { ...baseRun(), orders: [order({ id: 'o1', qty: 3000, ref: { a1: 100.5, b1: 100.4 } })] };
  run = mergeProgress(run, processRun(run, stale, T(1005)));
  const A = processRun(run, fresh, T(1010));
  const B = processRun(run, stale, T(1010));
  run = mergeProgress(mergeProgress(run, A), B);
  assert.equal(run.prog.o1.cut, T(1009), '進度取走得比較前面的那一份');
  run = mergeProgress(run, processRun(run, fresh, T(1011)));
  assert.equal(run.fills.reduce((s, f) => s + f.qty, 0), 1000, '只有 1 張掛在 99.95');
});
test('存進手機再讀回來（JSON）：只參加收盤撮合的單不會壞掉', () => {
  const ticks = [tk(1326, 0, { a: [[99.5, 9000]], b: [[100.5, 9000]], l: 99.9, h: 100.9, z: 100, zt: T(1324) })];
  const o = order({ side: 'S', at: T(1324, 50), px: 100.3, ref: { b1: 100.1 } });
  const m = mk({ ticks: { '0050': { [D]: { reg: ticks } } } });
  const p = JSON.parse(JSON.stringify(run1(o, m, T(1327)).prog));
  assert.equal(p.cut, BIG);
  const r = advance(o, p, [], m, T(1328));
  assert.equal(r.fills.length, 0, '舊版存成 null 會被當成「從頭撮合」');
  const old = advance(o, { st: 'live', act: T(1324, 50), L: null, H: null, zt0: null, cut: null }, [], m, T(1328));
  assert.equal(old.fills.length, 0, '舊版存下來的 null 也讀得懂');
});
test('那天後來休市：App 自己猜的不算，證交所／後台確定了才作廢', () => {
  const c4 = R.makeCal({ guess: [D2] });
  const r = run1(order({ at: T(1500), day: D2, phase: 'reserve' }), { ...mk(), cal: c4 }, R.atTW(D2, 1500));
  assert.equal(r.done, null);
});

test('資料一筆一筆進來慢慢算，和一次算完結果一樣（之後才送的減量不會讓委託提早結束）', () => {
  const o = order({ id: 'o9', side: 'S', px: 149.4, qty: 6000, at: T(935, 2), ref: { a1: 150.2, b1: 149.9 } });
  const mods = [{ oid: 'o9', at: T(947, 19), kind: 'reduce', qty: 1000 }];
  const all = [
    tk(941, 34, { b: [[149.7, 1000], [149.35, 21000]], z: 149.7, zt: T(941, 30), l: 149.7, h: 150.2 }),
    tk(942, 56, { b: [[149.7, 1000], [149.4, 3000]], z: 149.7, zt: T(941, 30), l: 149.7, h: 150.2 }),
    tk(947, 31, { b: [[149.75, 1000], [149.5, 1000]], z: 149.7, zt: T(941, 30), l: 149.7, h: 150.2 }),
  ];
  const one = run1(o, mk({ ticks: { '0050': { [D]: { reg: all } } } }), T(1500), mods);
  let prog;
  const inc = [];
  let done = null;
  for (let n = 1; n <= all.length && !done; n++) {
    const r = advance(o, prog, mods, mk({ ticks: { '0050': { [D]: { reg: all.slice(0, n) } } } }), all[n - 1].t + 120e3);
    inc.push(...r.fills);
    prog = JSON.parse(JSON.stringify(r.prog));
    done = r.done;
  }
  assert.deepEqual(inc.map((f) => [f.t, f.qty]), one.fills.map((f) => [f.t, f.qty]));
  assert.equal(one.fills.reduce((a, f) => a + f.qty, 0), 6000, '減量之後的那一筆顯示早就成交：成交在先');
  assert.equal(done && done.st, one.done.st);
});

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
