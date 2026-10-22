// 資料介面測試（data.js 給撮合引擎的 mkt）：node tests/data_test.mjs
import assert from 'node:assert/strict';

globalThis.location = new URL('http://localhost/sandtable/');
const R = await import('../src/rules.js');
const Dm = await import('../src/data.js');
const S = Dm.S;

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}
const D = 20261022;
const sec = (hm, s = 0, d = D) => Math.floor(R.atTW(d, hm, s) / 1000);
const hms = (hm, s = 0) => hm * 100 + s;
function series(rows) {
  const s = { t: [], q: [], z: [], zt: [], h: [], l: [], v: [], a: [], b: [], pz: [] };
  for (const r of rows) {
    s.t.push(r.t); s.q.push(r.q ?? null); s.z.push(r.z ?? null); s.zt.push(r.zt ?? null); s.h.push(r.h ?? null); s.l.push(r.l ?? null);
    s.v.push(r.v ?? 0); s.a.push(r.a || []); s.b.push(r.b || []); s.pz.push(null);
  }
  return s;
}
function reset() {
  S.tape.clear(); S.arc.clear(); S.k.clear(); S.hist.clear(); S.afterDays.clear();
  S.after = {};
  S.summary = { asof: 20261021, etfs: [] };
  S.rows = new Map([['0050', { c: '0050', m: 'tse', k: 'broad', d: 20261021, p: 108.15 }], ['00679B', { c: '00679B', m: 'otc', k: 'bond', d: 20261021, p: 25.77 }]]);
  S.cal = R.makeCal({ holidays: [20261026] });
  S.quotes = null;
}

await test('C1 快照的時間：有證交所資料時間（q）就用它，不用後台去問的時間', () => {
  reset();
  const reg = series([
    { t: sec(943, 46), q: sec(942, 34), z: 108.3, zt: hms(942, 24) },
    { t: sec(948, 25), q: sec(946, 59), z: 108.3, zt: hms(946, 59) },
  ]);
  S.tape.set('0050', { c: '0050', cur: { d: D, reg }, prev: null });
  const tk = Dm.mkt().ticks('0050', D, 'reg');
  assert.deepEqual(tk.map((x) => x.t), [R.atTW(D, 942, 34), R.atTW(D, 946, 59)]);
});
await test('C1 舊快照沒有資料時間：用一定不晚於它的時間（最後成交時間，最多往前 10 分鐘）', () => {
  reset();
  const reg = series([
    { t: sec(943, 46), z: 108.3, zt: hms(942, 24) },     // 用最後成交時間 09:42:24
    { t: sec(1100), z: 20, zt: hms(901) },               // 冷門：最後成交很久以前 → 用 10:50（往前 10 分鐘）
  ]);
  S.tape.set('0050', { c: '0050', cur: { d: D, reg }, prev: null });
  const tk = Dm.mkt().ticks('0050', D, 'reg');
  assert.deepEqual(tk.map((x) => x.t), [R.atTW(D, 942, 24), R.atTW(D, 1050)]);
});
await test('資料時間沒有往前的快照不重複用', () => {
  reset();
  const reg = series([{ t: 100, q: sec(1000) }, { t: 200, q: sec(1000) }, { t: 300, q: sec(1005) }]);
  S.tape.set('0050', { c: '0050', cur: { d: D, reg }, prev: null });
  assert.equal(Dm.mkt().ticks('0050', D, 'reg').length, 2);
});
await test('C2 收盤撮合：資料說了才算（13:30 以後有成交、或 13:31 以後的資料），不看時鐘', () => {
  reset();
  const base = [{ t: sec(1325), q: sec(1324), z: 100, zt: hms(1324, 50) }];
  S.tape.set('0050', { c: '0050', cur: { d: D, reg: series(base) }, prev: null });
  assert.deepEqual(Dm.mkt().closeAuction('0050', D, 'reg'), { known: false, px: null }, '收盤後還沒有資料：不知道');
  S.tape.set('0050', { c: '0050', cur: { d: D, reg: series([...base, { t: sec(1331, 30), q: sec(1330), z: 100.5, zt: hms(1330) }]) }, prev: null });
  assert.deepEqual(Dm.mkt().closeAuction('0050', D, 'reg'), { known: true, px: 100.5 });
  S.tape.set('0050', { c: '0050', cur: { d: D, reg: series([...base, { t: sec(1332), q: sec(1331, 5), z: 100, zt: hms(1324, 50) }]) }, prev: null });
  assert.deepEqual(Dm.mkt().closeAuction('0050', D, 'reg'), { known: true, px: null }, '13:31 以後的資料還是早上的成交：收盤沒有撮合');
});
await test('C2 那天結束了沒：後台標完成、換日、或官方收盤資料出來了', () => {
  reset();
  S.tape.set('0050', { c: '0050', cur: { d: D, reg: series([{ t: sec(1325), q: sec(1324) }]) }, prev: null });
  assert.equal(Dm.mkt().final('0050', D), false);
  S.tape.get('0050').cur.done = true;
  assert.equal(Dm.mkt().final('0050', D), true);
  S.tape.set('0050', { c: '0050', cur: { d: 20261023, reg: series([{ t: 1, q: 1 }]) }, prev: { d: D } });
  assert.equal(Dm.mkt().final('0050', D), true, '前一天（prev）一定結束了');
  S.tape.set('0050', { c: '0050', cur: { d: D }, prev: null });
  S.summary.asof = D;
  assert.equal(Dm.mkt().final('0050', D), true, '官方收盤資料出來了');
});
await test('C2 收盤撮合：那天結束了、卻沒有收盤後的快照（後台斷線）→ 整股用官方收盤價，零股沒有', () => {
  reset();
  S.summary = { asof: D, etfs: [] };
  S.rows.set('0050', { c: '0050', m: 'tse', k: 'broad', d: D, p: 100.4 });
  S.tape.set('0050', { c: '0050', cur: { d: D, reg: series([{ t: sec(1100), q: sec(1059) }]), odd: series([{ t: sec(1100), q: sec(1059) }]) }, prev: null });
  assert.deepEqual(Dm.mkt().closeAuction('0050', D, 'reg'), { known: true, px: 100.4 });
  assert.deepEqual(Dm.mkt().closeAuction('0050', D, 'odd'), { known: true, px: null });
});
await test('C3 更早的交易日從封存讀，讀到的一定是「已經結束」的一天', () => {
  reset();
  S.tape.set('0050', { c: '0050', cur: { d: 20261023 }, prev: { d: D } });
  S.arc.set('20261020/0050', { d: 20261020, reg: series([{ t: sec(1000, 0, 20261020), q: sec(959, 0, 20261020), z: 99 }]) });
  const m = Dm.mkt();
  assert.equal(m.ticks('0050', 20261020, 'reg').length, 1);
  assert.equal(m.final('0050', 20261020), true);
});
await test('C5 盤後結果：還沒公布是 undefined、確定沒有是 null；上櫃那天結束就是 null', () => {
  reset();
  const m = () => Dm.mkt();
  assert.equal(m().after('0050', D), undefined);
  S.after = { _days: [20261021, 20261023], 20261023: { '0050': [1, 1, 1, 1, 1] } };
  assert.equal(m().after('0050', D), null, '後面的日子有、這一天沒有：那天沒抓到，確定不會有了');
  assert.equal(m().after('0050', 20261021), undefined, '有這一天、還沒抓 after/{日期}.json');
  S.afterDays.set('20261021', { '0050': [108.35, 66858, 43000, 807000, 0] });
  assert.deepEqual(m().after('0050', 20261021), [108.35, 66858, 43000, 807000, 0]);
  assert.equal(m().after('00679B', D), undefined, '上櫃：那天還沒結束');
  S.summary.asof = D;
  assert.equal(m().after('00679B', D), null, '上櫃：那天結束了也沒有資料');
});
await test('C5 沒有假的成交量：只知道官方收盤價時，日資料就只有收盤價', () => {
  reset();
  S.summary = { asof: D, etfs: [] };
  S.rows.set('00679B', { c: '00679B', m: 'otc', k: 'bond', d: D, p: 25.77 });
  const d = Dm.mkt().day('00679B', D);
  assert.equal(d.c, 25.77);
  assert.equal(d.v, undefined);
});
await test('定期定額用的收盤價：資料還沒到是 undefined、確定沒成交是 null', () => {
  reset();
  const m = () => Dm.mkt();
  assert.equal(m().close('0050', D), undefined, '官方收盤資料還停在前一天');
  S.summary.asof = D;
  assert.equal(m().close('0050', D), null, '收盤資料出來了，這檔那天沒有成交');
  S.rows.set('0050', { c: '0050', m: 'tse', k: 'broad', d: D, p: 108.4 });
  assert.equal(m().close('0050', D), 108.4);
  S.rows.set('0050', { c: '0050', m: 'tse', k: 'broad', d: 20261023, p: 109 });
  S.summary.asof = 20261023;
  assert.equal(m().close('0050', D), undefined, '日 K、歷史檔還沒載入：等');
  S.k.set('0050', { d: [D], o: [108], h: [109], l: [108], c_: [108.4], v: [1] });
  assert.equal(m().close('0050', D), 108.4);
});
await test('伺服器時間：用網站給的時間往後推，改手機時鐘也不會跳；離線不能撮合', async () => {
  reset();
  const realFetch = globalThis.fetch;
  const srv = Date.parse('2026-10-22T02:00:00Z');
  globalThis.fetch = async () => new Response(JSON.stringify({ at: 1, reg: {}, odd: {} }), { status: 200, headers: { Date: new Date(srv).toUTCString() } });
  const realNow = Date.now;
  try {
    await Dm.freshForOrder('0050');
    assert.ok(Dm.serverOk());
    const a = Dm.serverNow();
    Date.now = () => realNow() + 6 * 3600e3;          // 手機時鐘往後調 6 小時
    const b = Dm.serverNow();
    assert.ok(Math.abs(b - a) < 2000, `伺服器時間不跟著手機時鐘跳（差 ${b - a} 毫秒）`);
    assert.ok(Math.abs(a - (srv + 500)) < 2000);
    globalThis.fetch = async () => new Response(JSON.stringify({ built: 'x' }), { status: 200, headers: { Date: new Date(srv + 9 * 3600e3).toUTCString(), 'X-Sandtable-Offline': '1' } });
    await Dm.refresh(true, []);
    assert.equal(Dm.serverOk(), false, '離線（快取的舊資料）：不能撮合');
    assert.ok(Math.abs(Dm.serverNow() - a) < 2000, '離線回應的時間不採用');
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
});

console.log(`\n${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
