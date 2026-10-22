// 定期定額測試：node tests/dca_test.mjs
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';
import { schedule, runDca, cutover, nextRun } from '../src/dca.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}
const cal = R.makeCal({ holidays: [20261026, 20270101, 20270216, 20270217] });
// asof＝官方收盤資料最新的日期（沒給就用 closes 裡最後一天）；那天以後的收盤價一律「還沒到」
const mk = (closes = {}, { asof: a, ...extra } = {}) => {
  const ds = Object.keys(closes).map(Number);
  const asof = a !== undefined ? a : (ds.length ? Math.max(...ds) : null);
  return {
    cal, asof: () => asof, close: (c, d) => (asof == null || d > asof ? undefined : closes[d]),
    splits: () => [], divs: () => [], last: () => 100, cat: () => 'broad', ...extra,
  };
};
const baseRun = (o = {}) => ({ id: 'r', start: { at: R.atTW(20261001, 900), d: 20261001 }, capital: 100000, fees: { ...R.DEFAULT_FEES }, orders: [], mods: [], fills: [], plans: [], dcaLog: {}, ...o });

test('申請後第 2 個交易日才生效', () => {
  assert.equal(cutover(cal, 20261022), 20261027, '四送 → 五、（六日）、（一休市）→ 二');
  assert.equal(cutover(cal, 20261005), 20261007);
});
test('休市順延、沒有的日期不買', () => {
  const p = { id: 'p', c: '0050', days: [26, 30], amt: 3000, start: 20261001, end: null };
  const s = schedule(p, cal, 20261001, 20270331);
  assert.deepEqual(s.filter((x) => x.s === 20261026), [{ s: 20261026, d: 20261027 }], '10/26 休市 → 10/27');
  assert.ok(!s.some((x) => Math.floor(x.s / 100) === 202702 && x.s % 100 === 30), '2/30 那一期不買');
  assert.ok(s.some((x) => x.s === 20270130));
});
test('月底扣款日順延到下個月初也算', () => {
  const p = { id: 'p', c: '0050', days: [31], amt: 3000, start: 20261201, end: null };
  const s = schedule(p, cal, 20270101, 20270110);
  assert.deepEqual(s, [{ s: 20261231, d: 20261231 }].filter((x) => x.d >= 20270101));
  const p2 = { id: 'p2', c: '0050', days: [1], amt: 3000, start: 20261201, end: null };
  assert.deepEqual(schedule(p2, cal, 20270101, 20270105), [{ s: 20270101, d: 20270104 }], '1/1 休市 → 1/4（一）');
});
test('用收盤價買零股，股數無條件捨去、手續費 1 元', () => {
  const p = { id: 'p', c: '0050', days: [6], amt: 3000, start: 20261001, end: null };
  const r = runDca(baseRun({ plans: [p] }), mk({ 20261006: 108.3 }), R.atTW(20261006, 1500));
  assert.equal(r.newFills.length, 1);
  assert.equal(r.newFills[0].qty, Math.floor(2999 / 108.3));
  assert.equal(r.newFills[0].fee, 1);
  assert.equal(r.newFills[0].id, 'dca:p:20261006');
});
test('官方收盤資料還沒出來就不買、就等', () => {
  const p = { id: 'p', c: '0050', days: [6], amt: 3000, start: 20261001, end: null };
  assert.equal(runDca(baseRun({ plans: [p] }), mk({ 20261006: 108.3 }, { asof: 20261005 }), R.atTW(20261006, 1500)).newFills.length, 0, '收盤資料停在前一天');
  assert.equal(runDca(baseRun({ plans: [p] }), mk({}), R.atTW(20261006, 1500)).newFills.length, 0);
});
test('資料一直沒到也不會因為時間過了就跳過那一期（不看時鐘）', () => {
  const p = { id: 'p', c: '0050', days: [6, 13], amt: 3000, start: 20261001, end: null };
  const r = runDca(baseRun({ plans: [p] }), mk({ 20261013: 100 }, { asof: 20261020 }), R.atTW(20261120, 1500));
  assert.equal(r.log['p:20261006'], undefined, '10/6 的收盤價還沒載入：等，不記成跳過');
  assert.equal(r.log['p:20261013'], undefined, '照順序一期一期來，前面那期還沒好，後面也等');
  assert.equal(r.newFills.length, 0);
});
test('停止交易那天不扣也不補', () => {
  const p = { id: 'p', c: '0050', days: [6], amt: 3000, start: 20261001, end: null };
  const r = runDca(baseRun({ plans: [p] }), mk({ 20261006: null }), R.atTW(20261007, 1500));
  assert.equal(r.newFills.length, 0);
  assert.equal(r.log['p:20261006'].st, 'halt');
});
test('錢不夠就扣款失敗、不補扣；連續 3 次全部終止', () => {
  const p = { id: 'p', c: '0050', days: [6, 7, 8, 9], amt: 3000, start: 20261001, end: null };
  const r = runDca(baseRun({ plans: [p], capital: 2000 }), mk({ 20261006: 100, 20261007: 100, 20261008: 100, 20261009: 100 }), R.atTW(20261012, 1500));
  assert.equal(r.newFills.length, 0);
  assert.equal(r.log['p:20261006'].st, 'fail');
  assert.equal(r.stopAt, 20261008);
  assert.equal(r.log['p:20261009'], undefined, '終止之後不再扣');
});
test('同一期重算不會重複買', () => {
  const p = { id: 'p', c: '0050', days: [6], amt: 3000, start: 20261001, end: null };
  const run = baseRun({ plans: [p] });
  const r1 = runDca(run, mk({ 20261006: 100 }), R.atTW(20261006, 1500));
  const r2 = runDca({ ...run, fills: r1.newFills, dcaLog: r1.log }, mk({ 20261006: 100 }), R.atTW(20261008, 1500));
  assert.equal(r2.newFills.length, 0);
});
test('下一次扣款日', () => {
  const p = { id: 'p', c: '0050', days: [26], amt: 3000, start: 20261001, end: null };
  assert.deepEqual(nextRun(p, cal, 20261022), { s: 20261026, d: 20261027 });
});
console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
