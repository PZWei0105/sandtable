// 撮合引擎與帳務測試：node tests/engine_test.mjs
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';
import { advance, processRun, mergeProgress, ledger, orderStatus, walkBook, sellable } from '../src/engine.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}

const D = 20261022;          // 星期四
const D2 = 20261023;         // 星期五
const T = (hm, s = 0, d = D) => R.atTW(d, hm, s);
const cal = R.makeCal({ holidays: [20261026], settle_only: [] });

/** 假行情：ticks[code][d][kind] = [...]；day[code][d] = {...} */
function mk({ ticks = {}, day = {}, after = {}, oddOpen = {}, oddClose = {}, market = {}, cat = {}, divs = {}, splits = {}, last = {} } = {}) {
  return {
    cal,
    ticks: (c, d, k) => (ticks[c] && ticks[c][d] && ticks[c][d][k]) || null,
    day: (c, d) => (day[c] && day[c][d]) || null,
    after: (c, d) => ((market[c] || 'tse') === 'otc' ? undefined : (after[d] === undefined ? undefined : (after[d][c] ?? null))),
    oddOpen: (c, d) => (oddOpen[c] || {})[d] ?? null,
    closeAuction: (c, d, k) => {
      if (k === 'odd') { const x = (oddClose[c] || {})[d]; return x === undefined ? { known: false, px: null } : { known: true, px: x }; }
      const tks = (ticks[c] && ticks[c][d] && ticks[c][d].reg) || [];
      const post = tks.find((x) => x.t >= R.atTW(d, 1331));
      if (post) return { known: true, px: post.zt >= R.atTW(d, 1330) ? post.z : null };
      const dd = day[c] && day[c][d];
      return dd && dd.c != null ? { known: true, px: dd.c } : { known: false, px: null };
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
test('盤中限價買：下一筆快照的賣方五檔能吃就成交（價格用對方的）', () => {
  const m = mk({ ticks: { '0050': { [D]: { reg: [tk(1003, 0, { a: [[99.9, 2000], [100, 5000]], l: 99.8, h: 100.2, z: 99.95, zt: T(1002) })] } } } });
  const r = run1(order({ qty: 3000 }), m, T(1004));
  assert.deepEqual(r.fills.map((f) => [f.px, f.qty]), [[99.9, 2000], [100, 1000]]);
  assert.equal(r.done.st, 'filled');
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
test('收盤價還沒出來：先不判定', () => {
  const ticks = [tk(1005, 0, { a: [[100.1, 3000]], l: 99.98, z: 100.1, zt: T(1004) })];
  const r = run1(order(), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1335));
  assert.equal(r.done, null);
});
test('刪單在成交快照之前：不成交', () => {
  const ticks = [tk(1003, 0, { a: [[99.9, 2000]] })];
  const r = run1(order(), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1004), [{ oid: 'o1', at: T(1001), kind: 'cancel' }]);
  assert.equal(r.fills.length, 0);
  assert.equal(r.done.st, 'cancelled');
});
test('刪單在成交之後：成交算數，刪單失敗', () => {
  const ticks = [tk(1003, 0, { a: [[99.9, 2000]] })];
  const r = run1(order(), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1006), [{ oid: 'o1', at: T(1005), kind: 'cancel' }]);
  assert.equal(r.fills.length, 1);
  assert.equal(r.done.st, 'filled');
});
test('減量：最多成交減量後的數量', () => {
  const ticks = [tk(1003, 0, { a: [[99.9, 9000]] })];
  const r = run1(order({ qty: 3000 }), mk({ ticks: { '0050': { [D]: { reg: ticks } } } }), T(1004), [{ oid: 'o1', at: T(1001), kind: 'reduce', qty: 1000 }]);
  assert.equal(r.fills[0].qty, 2000);
  assert.equal(r.done.st, 'filled');
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
  const r = run1(order({ sess: 'odd', qty: 300, px: 108.45 }), m, T(1004));
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
test('盤後定價：有對手單就用收盤價成交', () => {
  const after = { [D]: { '0050': [108.35, 66858, 43000, 807000, 0] } };
  const m = mk({ after, day: { '0050': { [D]: { c: 108.15, v: 1e6 } } } });
  const r = run1(order({ sess: 'fix', type: 'C', px: 108.15, at: T(1405) }), m, T(1600));
  assert.deepEqual(r.fills.map((f) => [f.px, f.how]), [[108.15, 'fix']]);
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
  assert.equal(r.fills[0].id, 'a1:1');
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

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
