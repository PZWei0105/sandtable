// 存檔、還原、戰報測試：node tests/store_test.mjs
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const R = await import('../src/rules.js');
const ST = await import('../src/store.js');
const { navSeries, dayReport } = await import('../src/stats.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { mem.clear(); await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}
const T = (hm, s = 0, d = 20261022) => R.atTW(d, hm, s);
const fill = (id, oid, extra = {}) => ({ id, oid, t: T(1000), d: 20261022, code: '0050', side: 'B', sess: 'reg', qty: 1000, px: 100, amt: 100000, fee: 142, fin: 39, tax: 0, how: 'arrive', ...extra });

await test('C6 還原「之前」的備份不會把之後開的局刪掉（合併，不是蓋掉）', async () => {
  const blank = await ST.exportBackup(Date.parse('2026-10-01T01:00:00Z'));
  ST.update((db) => { ST.newRun(db, { capital: 1e6, at: Date.parse('2026-10-02T01:00:00Z'), d: 20261002, bench: 100, fees: db.settings.fees }); });
  ST.update((db) => { ST.curRun(db).fills.push(fill('o1@x.0', 'o1', { code: '00631L', qty: 10000, px: 300, amt: 3e6 })); });
  await assert.rejects(() => ST.importBackup(blank, Date.now()), /沒有任何一局/, '備份裡一局都沒有：什麼都不做');
  const db = ST.load();
  assert.equal(Object.keys(db.runs).length, 1);
  assert.equal(ST.curRun(db).fills.length, 1, '虧損的那一局還在');
});
await test('C6 同一局：舊備份合併回來，委託、成交只增不減；新的備份把別台手機的紀錄補進來', async () => {
  let id;
  ST.update((db) => { id = ST.newRun(db, { capital: 1e6, at: T(900), d: 20261022, bench: 100, fees: db.settings.fees }).id; });
  ST.update((db) => { db.runs[id].orders.push({ id: 'o1', at: T(1000), code: '0050', side: 'B', sess: 'reg', type: 'L', tif: 'ROD', px: 100, qty: 1000, day: 20261022, phase: 'continuous', ref: {} }); });
  const old = await ST.exportBackup(T(1001));
  ST.update((db) => { db.runs[id].fills.push(fill('o1@a.0', 'o1')); db.runs[id].finals.o1 = { st: 'filled', why: '', t: T(1003) }; });
  const { log } = await ST.importBackup(old, T(1100));
  const r = ST.load().runs[id];
  assert.equal(r.fills.length, 1, '還原舊備份：之後的成交不會消失');
  assert.equal(r.finals.o1.st, 'filled');
  assert.deepEqual(log.merged, [id]);
  assert.equal(r.restores.length, 1, '這一局留下還原紀錄');
  assert.equal(ST.load().restores.length, 1, '整個存檔也留下還原紀錄');
});
await test('C6 進行中的局只能有一個：手機上的優先，備份帶進來的另一局封存成「還原時捨棄」', async () => {
  ST.update((db) => { ST.newRun(db, { capital: 1e6, at: T(900, 0, 20261001), d: 20261001, bench: 100, fees: db.settings.fees }); });
  const other = await ST.exportBackup(T(1000, 0, 20261001));
  mem.clear();
  let mine;
  ST.update((db) => { mine = ST.newRun(db, { capital: 5e5, at: T(900), d: 20261022, bench: 100, fees: db.settings.fees }).id; });
  const { log } = await ST.importBackup(other, T(1200));
  const db = ST.load();
  assert.equal(db.cur, mine);
  assert.equal(log.parked.length, 1);
  const parked = db.runs[log.parked[0]];
  assert.equal(parked.end.parked, true);
});
await test('C6 換新手機：手機上什麼都沒有，整份加進來', async () => {
  ST.update((db) => { ST.newRun(db, { capital: 1e6, at: T(900), d: 20261022, bench: 100, fees: db.settings.fees }); });
  const code = await ST.exportBackup(T(1000));
  const id = ST.load().cur;
  mem.clear();
  const { log } = await ST.importBackup(code, T(1100));
  assert.deepEqual(log.added, [id]);
  assert.equal(ST.load().cur, id);
});
await test('備份碼被改過（例如自己加一筆好價格的成交）：不能還原', async () => {
  ST.update((db) => { ST.newRun(db, { capital: 1e6, at: T(900), d: 20261022, bench: 100, fees: db.settings.fees }); });
  const code = await ST.exportBackup(T(1000));
  const json = await new Response(new Blob([Uint8Array.from(atob(code.slice(5)), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const obj = JSON.parse(json);
  const rid = Object.keys(obj.db.runs)[0];
  obj.db.runs[rid].fills.push(fill('fake@1.0', 'fake', { px: 1 }));
  const forged = `ST1J:${btoa(unescape(encodeURIComponent(JSON.stringify(obj))))}`;
  await assert.rejects(() => ST.importBackup(forged, T(1100)), /被改過/);
});
await test('備份裡奇怪的欄位一律丟掉（代號、id 只能是安全字元）', async () => {
  const db = { v: 1, cur: 'rabc', runs: { rabc: { id: 'rabc', start: { at: T(900), d: 20261022 }, capital: 1e6, orders: [
    { id: 'o1', at: T(1000), code: '<img src=x>', side: 'B', sess: 'reg', type: 'L', tif: 'ROD', px: 1, qty: 1000, day: 20261022 },
    { id: 'o2', at: T(1000), code: '0050', side: 'B', sess: 'reg', type: 'L', tif: 'ROD', px: 100, qty: 1000, day: 20261022, evil: 'x' },
  ], fills: [], mods: [], notes: { o2: { t: 'ok', tags: ['a'] }, 'bad"id': { t: 'x' } } } } };
  const code = `ST1J:${btoa(unescape(encodeURIComponent(JSON.stringify({ app: 'sandtable', v: 1, at: T(1000), db }))))}`;
  await ST.importBackup(code, T(1100));
  const r = ST.load().runs.rabc;
  assert.deepEqual(r.orders.map((o) => o.id), ['o2']);
  assert.equal(r.orders[0].evil, undefined);
  assert.deepEqual(Object.keys(r.notes), ['o2']);
});
await test('兩個分頁輪流寫：進度取走得比較前面的那一份', () => {
  let id;
  ST.update((db) => { id = ST.newRun(db, { capital: 1e6, at: T(900), d: 20261022, bench: 100, fees: db.settings.fees }).id; });
  ST.update((db) => ST.mergeEngine(db, id, { newFills: [], prog: { o1: { st: 'live', cut: T(1009), L: 99, H: 101, zt0: T(1004), act: T(1004) } }, finals: {} }));
  ST.update((db) => ST.mergeEngine(db, id, { newFills: [], prog: { o1: { st: 'live', cut: T(1004), L: 99, H: 101, zt0: T(1004), act: T(1004) } }, finals: {} }));
  assert.equal(ST.load().runs[id].prog.o1.cut, T(1009));
});
await test('戰報：以前每一天的淨值只算到那一天為止的成交', () => {
  const days = [20261019, 20261020, 20261021, 20261022];
  const hist = { d: days, p: [90, 92, 95, 100], splits: [], divs: [] };
  const run = {
    id: 'r', start: { at: T(900, 0, 20261019), d: 20261019, bench: 90 }, capital: 1000000, fees: { ...R.DEFAULT_FEES },
    orders: [], mods: [], prog: {}, finals: {},
    fills: [{ id: 'a:1', oid: 'a', t: T(1000), d: 20261022, code: '0056', side: 'B', sess: 'reg', qty: 10000, px: 100, amt: 1000000 - 2000, fee: 1422, fin: 398, tax: 0 }],
  };
  const cal = R.makeCal({});
  const m = { cal, splits: () => [], divs: () => [], last: (c) => (c === '0056' ? 50 : 100), cat: () => 'broad' };
  const s = navSeries(run, m, () => hist, T(1400), days);
  assert.deepEqual(s.nav.slice(0, 3).map(Math.round), [1000000, 1000000, 1000000], '10/22 才第一次買：之前三天都是 100 萬');
});

await test('今日戰報：每一檔的貢獻加起來＝總資產的變化；和 0050 同一天含息比', () => {
  const D0 = 20261021;
  const D1 = 20261022;
  const run = {
    id: 'r', start: { at: T(900, 0, 20261019), d: 20261019, bench: 99 }, capital: 1000000, fees: { ...R.DEFAULT_FEES },
    orders: [], mods: [], prog: {}, finals: {},
    fills: [
      { id: 'a@1.0', oid: 'a', t: T(1000, 0, 20261020), d: 20261020, code: '0050', side: 'B', sess: 'reg', qty: 2000, px: 100, amt: 200000, fee: 285, fin: 79, tax: 0 },
      { id: 'b@1.0', oid: 'b', t: T(1000, 0, D1), d: D1, code: '0050', side: 'S', sess: 'reg', qty: 1000, px: 104, amt: 104000, fee: 148, fin: 41, tax: 104 },
      { id: 'c@1.0', oid: 'c', t: T(1010, 0, D1), d: D1, code: '00878', side: 'B', sess: 'reg', qty: 3000, px: 22, amt: 66000, fee: 94, fin: 26, tax: 0 },
    ],
  };
  const hist = {
    '0050': { d: [20261019, 20261020, D0, D1], p: [99, 100, 102, 104], splits: [], divs: [[D1, 1]] },
    '00878': { d: [20261019, 20261020, D0], p: [21.5, 21.7, 21.9], splits: [], divs: [] },
  };
  const cal = R.makeCal({});
  const live = { '0050': 105, '00878': 22.2 };
  const m = { cal, splits: () => [], divs: (c) => (hist[c] ? hist[c].divs : []), last: (c) => live[c], cat: () => 'broad' };
  const rep = dayReport(run, m, (c) => hist[c], T(1100, 0, D1), D0, D1);
  const sum = rep.rows.reduce((a, x) => a + x.pnl, 0);
  assert.ok(Math.abs(rep.pnl - sum) < 1e-6, `加起來要等於總資產的變化（差 ${rep.pnl - sum}）`);
  assert.ok(Math.abs(rep.other) < 1e-6);
  const r0050 = rep.rows.find((x) => x.code === '0050');
  // 昨天 2000 股 × 102；今天賣 1000 股拿回 104000－41－104，剩 1000 股 × 105；除息 1 元 × 2000 股
  assert.equal(Math.round(r0050.pnl), Math.round(1000 * 105 - 2000 * 102 + (104000 - 41 - 104) + 2000));
  const r878 = rep.rows.find((x) => x.code === '00878');
  assert.equal(Math.round(r878.pnl), Math.round(3000 * 22.2 - 66000 - 26), '今天買的：從買價算（含手續費）');
  assert.equal(rep.fills, 2);
  assert.equal(rep.fees, 41 + 26);
  assert.equal(rep.taxes, 104);
  assert.ok(Math.abs(rep.bench - ((105 + 1) / 102 - 1)) < 1e-9, '0050 同一天含息（除息加回）');
  // 開局當天：從開局那一刻（起始資金、開局時的 0050 價格）算
  const rep2 = dayReport({ ...run, start: { at: T(930, 0, D1), d: D1, bench: 103 }, fills: [run.fills[2]] }, m, (c) => hist[c], T(1100, 0, D1), D0, D1);
  assert.equal(rep2.started, true);
  assert.equal(rep2.eq0, 1000000);
  assert.ok(Math.abs(rep2.bench - (105 / 103 - 1)) < 1e-9);
});

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
