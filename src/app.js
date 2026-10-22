/* 沙盤 SANDTABLE — 畫面與流程。規則在 rules.js、撮合與帳務在 engine.js（純函式），這裡只負責畫面、下單流程與存檔。 */
import * as R from './rules.js';
import * as E from './engine.js';
import * as D from './data.js';
import * as ST from './store.js';
import { navSeries, report, dayReport, BENCH } from './stats.js';
import { createTable, CAT_NAME } from './table3d.js';
import { drawIntraday, drawK, drawNav } from './charts.js';
import { fx, unlock, setSound, setHaptics, play } from './fx.js';
import { rulesHTML, TERMS } from './guide.js';
import * as DCA from './dca.js';
import { UPDATES } from './updates.js';

// ------------------------------------------------------------------ 小工具
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const N = (x, d = 0) => (isNum(x) ? x.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const P = (x) => (isNum(x) ? x.toFixed(2) : '—');
const PCT = (x, d = 2) => (isNum(x) ? `${x > 0 ? '+' : ''}${x.toFixed(d)}%` : '—');
const RET = (x, d = 2) => (isNum(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const cls = (x) => (!isNum(x) || Math.abs(x) < 1e-9 ? 'flat' : x > 0 ? 'up' : 'down');
const SH = (n) => {
  if (!isNum(n)) return '—';
  if (n >= 1000 && n % 1000 === 0) return `${N(n / 1000)} 張`;
  if (n >= 1000) return `${N(Math.floor(n / 1000))} 張 ${n % 1000} 股`;
  return `${N(n)} 股`;
};
const HMS = (ms) => {
  const t = new Date(ms + 8 * 3600e3);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}:${String(t.getUTCSeconds()).padStart(2, '0')}`;
};
const MD = (d) => `${Math.floor(d / 100) % 100}/${d % 100}`;
const WD = (d) => '日一二三四五六'[R.dow(d)];
const now = () => D.serverNow();

// 打開之前手機上就有沙盤的存檔＝老玩家（更新紀錄要提示他）；全新的人不跳
const HAD_SAVE = (() => { try { return localStorage.getItem('sandtable.v1') != null; } catch { return false; } })();
let db = ST.load();
const UI = {
  tab: 'table', sel: '0050', chart: 'intra', book: 'reg', q: '', seen: new Set(), seenFinal: new Set(),
  table: null, ready: false, lastPhase: null, reportCache: null, orderView: 'today', qmode: 'list', qcat: 'all', qsort: 'val', lastPx: null,
};
try { const s = JSON.parse(localStorage.getItem('sandtable.ui') || '{}'); if (s.sel) UI.sel = s.sel; if (s.tab) UI.tab = s.tab; } catch { /* 沒有就用預設 */ }
function saveUI() { try { localStorage.setItem('sandtable.ui', JSON.stringify({ sel: UI.sel, tab: UI.tab })); } catch { /* 無所謂 */ } }

function run() { db = ST.load(); return ST.curRun(db); }
/** 未實現損益：現在全部賣掉、扣掉手續費與證交稅後，比成本多或少多少 */
function unrealOf(h, fees, today) {
  const px = h.px || 0;
  const lots = Math.floor(h.sh / 1000) * 1000;
  const amtLots = R.amountOf(lots, px);
  const amtOdd = R.amountOf(h.sh - lots, px);
  const rate = R.taxRate(h.code, (D.row(h.code) || {}).k, today);
  const cost = R.feeFinal(amtLots, false, fees) + R.feeFinal(amtOdd, true, fees) + R.taxOf(amtLots, rate) + R.taxOf(amtOdd, rate);
  return (h.mv || 0) - cost - h.cost;
}
function mkt() { return D.mkt(); }
function L(r = run()) { return r ? E.ledger(r, mkt(), now()) : null; }
function daytradeOk(r, Lg) {
  if (!r) return false;
  const yearAgo = R.addDays(R.tw(now()).d, -365);
  const fills = new Set((r.fills || []).filter((f) => f.d >= yearAgo).map((f) => f.oid)).size;
  return R.daytradeStatus(r.start.d, R.tw(now()).d, fills).ok;
}

const OTC_AFTER = '上櫃 ETF 的盤後定價、盤後零股，沙盤還沒有官方的成交資料可以判斷，暫時不開放（盤中零股可以下）';
/** 今天買的為什麼還不能賣 */
function sellWhy(h, dtOk, sess) {
  if (!dtOk) return '今天買進的股數要明天才能賣（還沒有當沖資格）';
  if (sess !== 'reg') return '今天買進的股數不能用零股、盤後定價賣掉（現股當沖只限整股）';
  return '今天用零股、盤後買進的股數要明天才能賣（零股不能當沖）';
}

// ------------------------------------------------------------------ 更新紀錄：有沒看過的新功能就提示一次
function updatesHTML(list) {
  return list.map((u) => `<div class="upd"><div class="h"><b>${esc(u.title)}</b><span class="num dim">${Math.floor(u.d / 10000)}/${MD(u.d)}</span></div><ul>${u.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('');
}
function showUpdates() {
  modal(`<h2>更新紀錄</h2><div class="prose">${updatesHTML(UPDATES.slice(0, 12))}</div><div class="row" style="justify-content:flex-end"><button class="btn brass" data-close>知道了</button></div>`, { wide: true });
}
function announceUpdates() {
  if (!UPDATES.length || $('#modalHost').children.length) return;
  let seen = null;
  try { seen = localStorage.getItem('sandtable.seenUpd'); } catch { /* 沒關係 */ }
  const latest = UPDATES[0].id;
  try { localStorage.setItem('sandtable.seenUpd', latest); } catch { /* 沒關係 */ }
  if (seen === latest || (!seen && !HAD_SAVE)) return;      // 全新的人不跳；老玩家第一次看到更新紀錄、或之後有新的才跳
  const fresh = UPDATES.slice(0, Math.max(1, seen ? UPDATES.findIndex((u) => u.id === seen) : 2));
  modal(`<h2>沙盤更新了</h2><div class="prose">${updatesHTML(fresh.slice(0, 3))}</div><div class="row" style="justify-content:flex-end"><button class="btn brass" data-close>開始用</button></div>`, { wide: true });
  play('stamp');
}

// ------------------------------------------------------------------ 提示
function toast(html, ms = 4200) {
  const box = document.createElement('div');
  box.className = 'toast';
  box.innerHTML = html;
  $('#toasts').appendChild(box);
  const kill = () => { box.style.transition = 'opacity .3s, transform .3s'; box.style.opacity = '0'; box.style.transform = 'translateY(-10px)'; setTimeout(() => box.remove(), 320); };
  box.addEventListener('click', kill);
  setTimeout(kill, ms);
}
function note(text, kind = '') {
  toast(`<div class="slip"><div class="h"><span class="side ${kind}">${kind === 'B' ? '買' : kind === 'S' ? '賣' : '沙盤'}</span></div><div class="m" style="font-size:14px;color:var(--ivory)">${text}</div></div>`, 3600);
}
function modal(html, { onMount, wide } = {}) {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true" style="${wide ? 'max-width:720px' : ''}">${html}</div></div>`;
  const bg = host.firstElementChild;
  const close = () => { host.innerHTML = ''; };
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
  if (onMount) onMount(bg.firstElementChild, close);
  return close;
}
function confirmBox(title, body, okText = '確定', danger = false) {
  return new Promise((res) => {
    modal(`<h2>${title}</h2><div class="prose">${body}</div><div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" data-close>取消</button><button class="btn ${danger ? 'danger' : 'brass'}" id="okBtn">${okText}</button></div>`, {
      onMount: (m, close) => {
        $('#okBtn', m).addEventListener('click', () => { close(); res(true); });
        m.parentElement.addEventListener('click', (e) => { if (e.target === m.parentElement) res(false); });
        $$('[data-close]', m).forEach((b) => b.addEventListener('click', () => res(false)));
      },
    });
  });
}
function termHTML(k, label) { return `<button class="term" type="button" data-term="${esc(k)}">${esc(label || k)}</button>`; }
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-term]');
  if (!t) return;
  const k = t.dataset.term;
  modal(`<h2>${esc(k)}</h2><p class="prose">${esc(TERMS[k] || '')}</p><div class="row" style="justify-content:flex-end"><button class="btn brass" data-close>知道了</button></div>`);
});

// ------------------------------------------------------------------ 分頁
function setTab(t) {
  if (UI.replay && t !== 'table' && !window.matchMedia('(min-width:1100px)').matches) stopReplay();
  UI.tab = t;
  saveUI();
  $$('#dock button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.dataset.p === t));
  const stage = $('#stage');
  if (t === 'table') stage.removeAttribute('data-off'); else stage.setAttribute('data-off', '');
  render(t);
  if (t !== 'table') window.scrollTo({ top: 0 });
  play('tap');
}
$('#dock').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  // 已經在看盤的單檔頁，再按一次「看盤」回到全部清單
  if (b.dataset.tab === 'quote' && UI.tab === 'quote' && UI.qmode === 'detail') UI.qmode = 'list';
  setTab(b.dataset.tab);
});
$('#deskNav').addEventListener('click', (e) => {
  if (!e.target.closest('[data-desk="report"]')) return;
  document.body.classList.toggle('wide-report');
  if (document.body.classList.contains('wide-report')) renderReport();
});

// ------------------------------------------------------------------ 開機
async function main() {
  applySettings();
  const ig = $('#ignite');
  // 啟動畫面：每天第一次打開才有（之後直接進入，點一下畫面就有聲音）
  let lit = null;
  try { lit = localStorage.getItem('sandtable.lit'); } catch { /* 沒關係 */ }
  const todayStr = String(R.tw(Date.now()).d);
  const wantIgnite = db.settings.ignite !== false && lit !== todayStr;
  const bootP = D.boot().catch((e) => { D.S.err = String(e); });
  if (wantIgnite) {
    ig.hidden = false;
    await new Promise((res) => $('#cord').addEventListener('click', res, { once: true }));
    try { localStorage.setItem('sandtable.lit', todayStr); } catch { /* 沒關係 */ }
    unlock();
    fx('ignite');
    ig.classList.add('lit');
    setTimeout(() => { ig.hidden = true; }, 950);
  } else {
    document.addEventListener('pointerdown', unlock, { once: true });
  }
  await bootP;
  initTable();
  const r = run();
  if (r) for (const f of r.fills) UI.seen.add(f.id);
  if (r) for (const k of Object.keys(r.finals || {})) UI.seenFinal.add(k);
  await settle(false);   // 不在的時候成交、失效的委託，一打開就告訴你
  setTab(UI.tab);
  renderAll();
  UI.ready = true;
  setTimeout(announceUpdates, 1600);
  if (!run()) openSetup();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden) poll(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('storage', (e) => { if (e.key === 'sandtable.v1') { db = ST.load(); renderAll(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function applySettings() {
  db = ST.load();
  setSound(db.settings.sound);
  setHaptics(db.settings.haptics);
  document.body.classList.toggle('nofx', db.settings.fx === false);
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const r = run();
    const codes = new Set([UI.sel]);
    if (r) for (const o of r.orders) if (!(r.finals || {})[o.id]) codes.add(o.code);
    const changed = await D.refresh(false, [...codes]);
    if (changed) {
      await settle();
      renderAll();
      updateTable(false);
      if (db.settings.sound) play('sand');
    }
  } finally { polling = false; }
}

/**
 * 撮合：把所有還沒結束的委託推進到現在，有新成交就通知。
 * 一定要拿到過新鮮的伺服器時間、而且不是離線（用快取的舊資料）才做：離線時什麼都不判斷、不存，
 * 連上網路之後再用真的資料判斷（改手機時鐘、關網路都沒辦法讓委託提早失效或刪單提早生效）。
 */
async function settle(quiet = false) {
  if (!D.serverOk()) return false;
  const r = run();
  if (!r) return false;
  const open = r.orders.filter((o) => !(r.finals || {})[o.id]);
  const t0 = now();
  const today = R.tw(t0).d;
  const late = R.tw(t0).hm >= 1330;
  // 每一筆還沒結束的委託「那一天」的逐輪快照（今天、前一個交易日在 tape/，更早的從封存抓）、官方日 K、盤後結果
  await Promise.all(open.map((o) => D.ensureTapeDay(o.code, o.day)));
  // 官方日 K：給最晚那一天，日 K 還沒更新到那一天（官方收盤資料已經出來）就重新抓
  const kDay = new Map();
  for (const o of open) if (o.day < today || late) kDay.set(o.code, Math.max(kDay.get(o.code) || 0, o.day));
  await Promise.all([...kDay].map(([c, d]) => D.ensureK(c, d)));
  await Promise.all([...new Set(open.filter((o) => o.sess === 'fix' || o.sess === 'oddpm').map((o) => o.day))].map((d) => D.ensureAfterDay(d)));
  const asof = D.S.summary ? D.S.summary.asof : null;
  if ((r.plans || []).length) await Promise.all([...new Set(r.plans.map((p) => p.c))].map((c) => Promise.all([D.ensureHist(c, asof), D.ensureK(c, asof)])));
  let changed = false;
  let before = null;
  await ST.withLock(() => {
    db = ST.update((x) => {
      // 在鎖裡面、用存檔裡最新的那一份算（另一個分頁可能剛寫過）
      const rr = ST.curRun(x);
      if (!rr || rr.id !== r.id || !D.serverOk()) return false;
      const res = E.processRun(rr, mkt(), now());
      let ch = ST.mergeEngine(x, rr.id, res);
      // 定期定額：每一期在成交日收盤資料出來以後，用官方收盤價買
      if ((rr.plans || []).length) {
        before = { ...(rr.dcaLog || {}) };
        const dres = DCA.runDca(rr, mkt(), now());
        if (ST.mergeDca(x, rr.id, dres)) ch = true;
      }
      changed = ch;
      return ch ? undefined : false;
    });
  });
  if (changed) {
    if (before) announceDca(quiet, before);
    announce(quiet);
    markTable();
  }
  return changed;
}

function announceDca(quiet, before) {
  const r = run();
  if (!r || quiet) return;
  for (const [k, v] of Object.entries(r.dcaLog || {})) {
    if (before[k]) continue;
    const pid = k.split(':')[0];
    const p = (r.plans || []).find((x) => x.id === pid);
    if (!p) continue;
    if (v.st === 'ok') toast(`<div class="slip"><span class="stamp filled new">扣款成功</span><div class="h"><span class="side B">定期定額</span><span class="code">${p.c}</span></div><div class="d">${SH(v.qty)} × ${P(v.px)}</div><div class="m">${MD(v.d)} 收盤價成交</div></div>`, 5200);
    else if (v.st === 'fail') toast(`<div class="slip"><span class="stamp rejected new">扣款失敗</span><div class="h"><span class="side B">定期定額</span><span class="code">${p.c}</span></div><div class="why">${esc(v.why)}</div></div>`, 6000);
  }
  UI.seenDca = true;
}

function announce(quiet) {
  const r = run();
  if (!r) return;
  const fresh = r.fills.filter((f) => !UI.seen.has(f.id));
  for (const f of fresh) if (f.sess === 'dca') UI.seen.add(f.id);
  const byO = new Map();
  for (const f of fresh) {
    if (f.sess === 'dca') continue;
    UI.seen.add(f.id);
    if (!byO.has(f.oid)) byO.set(f.oid, []);
    byO.get(f.oid).push(f);
  }
  if (!quiet) {
    for (const [oid, fs] of byO) {
      const o = r.orders.find((x) => x.id === oid);
      const q = fs.reduce((s, f) => s + f.qty, 0);
      const amt = fs.reduce((s, f) => s + f.amt, 0);
      const name = (D.row(o.code) || {}).n || '';
      toast(`<div class="slip"><span class="stamp filled new">成交</span><div class="h"><span class="side ${o.side}">${E.SIDE_NAME[o.side]}</span><span class="code">${o.code}</span><span class="nm">${esc(name)}</span></div><div class="d">${SH(q)} × 均價 ${P(amt / q)}</div><div class="m">${HMS(fs[fs.length - 1].t)} 成交回報</div></div>`, 5200);
    }
    if (byO.size) fx('fill');
    if (UI.table && UI.table.ping) for (const oid of byO.keys()) { const o = r.orders.find((x) => x.id === oid); if (o) UI.table.ping(o.code, 'fill'); }
  }
  for (const [oid, fin] of Object.entries(r.finals || {})) {
    if (UI.seenFinal.has(oid)) continue;
    UI.seenFinal.add(oid);
    if (quiet) continue;
    const o = r.orders.find((x) => x.id === oid);
    if (!o || fin.st === 'filled') continue;
    if (fin.st === 'rejected' || (fin.st === 'expired' && !byO.has(oid)) || (fin.st === 'cancelled' && fin.why && !/已刪單/.test(fin.why))) {
      toast(`<div class="slip"><span class="stamp ${fin.st}">${E.ST_NAME[fin.st]}</span><div class="h"><span class="side ${o.side}">${E.SIDE_NAME[o.side]}</span><span class="code">${o.code}</span></div><div class="why">${esc(fin.why)}</div></div>`, 5200);
      if (fin.st === 'rejected') fx('reject');
    }
  }
}

// ------------------------------------------------------------------ 戰情列
function tick() {
  const t = now();
  $('#clk').textContent = HMS(t);
  const hc = $('#hudClose');
  if (hc) hc.innerHTML = hudCountdown(t);
  const ph = R.marketPhase(D.S.cal, t);
  const el = $('#phase');
  el.dataset.p = ph.phase;
  el.textContent = R.PHASE_NAME[ph.phase] || '';
  if (UI.lastPhase && UI.lastPhase !== ph.phase && UI.ready && (ph.phase === 'continuous' || (UI.lastPhase === 'closing' && ph.phase === 'post'))) fx('bell');
  UI.lastPhase = ph.phase;
  // 行情新不新
  const qa = D.quotesAt();
  const age = qa ? (t - qa) / 60000 : null;
  const feed = $('#feed');
  const trading = ['preopen', 'continuous', 'closing'].includes(ph.phase);
  feed.dataset.s = D.S.offline ? 'off' : !qa ? 'off' : trading && age > 12 ? 'stale' : 'ok';
  $('#feedT').textContent = D.S.offline ? '離線' : !qa ? '' : trading ? (age < 1 ? '剛更新' : `${Math.floor(age)} 分前`) : `行情 ${HMS(qa).slice(0, 5)}`;
}

function renderAcct() {
  const r = run();
  const box = $('#acct');
  if (!r) { box.innerHTML = '<div class="eq num">—</div><div class="rt dim">還沒開戶</div>'; return; }
  const Lg = L(r);
  const ret = Lg.equity / r.capital - 1;
  box.innerHTML = `<div class="eq num">${N(Lg.equity)}</div><div class="rt num ${cls(ret)}">${RET(ret)}</div>`;
}

// ------------------------------------------------------------------ 3D 沙盤
function tableItems() {
  const rows = D.S.summary ? D.S.summary.etfs : [];
  return rows.map((r) => {
    const c = D.changeOf(r.c);
    return { c: r.c, n: r.n, k: r.k, val: r.val || 0, pct: c.pct, px: c.px };
  });
}
function initTable() {
  if (UI.table) return;
  const host = $('#stage');
  $('#stageLoading').hidden = true;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || db.settings.fx === false;
  UI.table = createTable(host, {
    reduced, quality: db.settings.quality,
    onPick: (c) => {
      if (!c) return;
      selectCode(c, false);
      play('tap');
      if (UI.tab === 'table') renderTablePane();
    },
    onHover: (c, e) => {
      const tip = $('#stageTip');
      if (!c) { tip.hidden = true; return; }
      const r = D.row(c);
      const ch = D.changeOf(c);
      const rect = host.getBoundingClientRect();
      tip.style.left = `${e.clientX - rect.left}px`;
      tip.style.top = `${e.clientY - rect.top}px`;
      tip.innerHTML = `<b class="num">${c}</b> ${esc(r ? r.n : '')} <span class="num ${cls(ch.pct)}">${P(ch.px)} ${PCT(ch.pct)}</span>`;
      tip.hidden = false;
    },
  });
  host.querySelectorAll('.hud-top, .hud-bot, .stage-tip').forEach((x) => host.appendChild(x));
  $('#stageReset').addEventListener('click', () => { UI.table.reset(); play('tap'); });
  $('#stageReplay').addEventListener('click', () => startReplay());
  replayButton(false);
  updateTable(true);
}
function updateTable(intro) {
  if (!UI.table || UI.replay) return;
  UI.table.setData(tableItems(), { intro });
  markTable();
}
/** 只更新寶藍信標（持有）、寶藍光圈（掛單）、金星（自選）與選取，不動地形 */
function markTable() {
  if (!UI.table) return;
  const r = run();
  if (r) {
    const Lg = L(r);
    UI.table.setHeld(Lg.holdings.filter((h) => h.sh > 0).map((h) => h.code));
    UI.table.setPending([...new Set(r.orders.filter((o) => { const s = E.orderStatus(r, o).st; return ['wait', 'queued', 'live', 'part', 'cancelling'].includes(s); }).map((o) => o.code))]);
  } else { UI.table.setHeld([]); UI.table.setPending([]); }
  if (UI.table.setWatch) UI.table.setWatch(db.settings.watch || []);
  UI.table.select(UI.sel);
}
function selectCode(c, go = true) {
  UI.sel = c;
  saveUI();
  if (UI.table) { UI.table.select(c); UI.table.focus(c); }
  if (go) UI.qmode = 'detail';
  if (go && UI.tab !== 'quote' && !window.matchMedia('(min-width:1100px)').matches) setTab('quote');
  else if (UI.tab === 'quote' || window.matchMedia('(min-width:1100px)').matches) renderQuote();
}

// ------------------------------------------------------------------ 全部重畫
function renderAll() {
  renderAcct();
  tick();
  const wide = window.matchMedia('(min-width:1100px)').matches;
  if (wide) { renderTablePane(); renderQuote(); renderOrders(); renderPos(); if (document.body.classList.contains('wide-report')) renderReport(); } else render(UI.tab);
  const r = run();
  const open = r ? r.orders.filter((o) => ['wait', 'queued', 'live', 'part', 'cancelling'].includes(E.orderStatus(r, o).st)).length : 0;
  const b = $('#badgeOrders');
  b.hidden = !open;
  b.textContent = open;
}
function render(t) {
  if (t === 'table') renderTablePane();
  else if (t === 'quote') renderQuote();
  else if (t === 'orders') renderOrders();
  else if (t === 'pos') renderPos();
  else if (t === 'report') renderReport();
}

// ------------------------------------------------------------------ 小圖：走勢線、星號
/** 走勢線（SVG）：今天的盤中走勢（沒有就用最近 40 天），虛線是昨收，最後一點發光。
 *  大張的照時間畫（看得出今天走到哪裡）；清單裡的小張 fit＝撐滿（看得清楚形狀） */
function sparkSVG(code, w = 120, h = 34, fit = false) {
  const sp = D.sparkOf(code);
  if (sp.pts.length < 2) return `<svg class="spk" viewBox="0 0 ${w} ${h}"></svg>`;
  const ys = sp.pts.map((x) => x[1]);
  if (isNum(sp.ref)) ys.push(sp.ref);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
  const x0 = sp.intra && !fit ? 0 : sp.pts[0][0];
  const x1 = sp.intra && !fit ? Math.max(270, sp.pts[sp.pts.length - 1][0]) : sp.pts[sp.pts.length - 1][0];
  const X = (x) => ((x - x0) / Math.max(1e-9, x1 - x0)) * (w - 4) + 2;
  const Y = (y) => h - 3 - ((y - lo) / (hi - lo)) * (h - 6);
  const last = sp.pts[sp.pts.length - 1];
  const dir = isNum(sp.ref) ? Math.sign(last[1] - sp.ref) : Math.sign(last[1] - sp.pts[0][1]);
  const col = dir > 0 ? 'var(--up)' : dir < 0 ? 'var(--down)' : 'var(--gold)';
  const d = sp.pts.map((x, i) => `${i ? 'L' : 'M'}${X(x[0]).toFixed(1)} ${Y(x[1]).toFixed(1)}`).join(' ');
  const area = `${d} L${X(last[0]).toFixed(1)} ${h} L${X(sp.pts[0][0]).toFixed(1)} ${h} Z`;
  const ref = isNum(sp.ref) ? `<line class="ref" x1="0" x2="${w}" y1="${Y(sp.ref).toFixed(1)}" y2="${Y(sp.ref).toFixed(1)}"/>` : '';
  // 清單裡一次幾百張：小張的不加發光濾鏡（手機捲動才順）
  const glow = (r) => (w >= 120 ? ` style="filter:drop-shadow(0 0 ${r}px ${col})"` : '');
  return `<svg class="spk" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${ref}<path class="ar" d="${area}" fill="${col}"/><path class="ln" d="${d}" stroke="${col}"${glow(3)}/><circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="2.6" fill="${col}"${glow(4)}/></svg>`;
}
const STAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>';
const STAR_O = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>';
function starBtn(code) {
  const on = (db.settings.watch || []).includes(code);
  return `<button class="star" type="button" data-star="${code}" aria-pressed="${on}" aria-label="${on ? '移出自選' : '加入自選'}">${on ? STAR : STAR_O}</button>`;
}
function toggleWatch(code) {
  let on = false;
  db = ST.update((x) => {
    const w = x.settings.watch || [];
    on = !w.includes(code);
    x.settings.watch = on ? [...w, code].slice(-30) : w.filter((k) => k !== code);
  });
  note(on ? `${code} 加入自選` : `${code} 移出自選`);
  fx(on ? 'stamp' : 'tap');
  if (UI.table && UI.table.setWatch) UI.table.setWatch(db.settings.watch || []);
}
/** 成交值：億／萬 */
function VAL(x) {
  if (!isNum(x) || x <= 0) return '—';
  if (x >= 1e8) return `${(x / 1e8).toFixed(x >= 1e10 ? 0 : 1)} 億`;
  return `${Math.round(x / 1e4).toLocaleString('zh-TW')} 萬`;
}
const PILL = (pct) => `<span class="pill ${cls(pct)}">${PCT(pct)}</span>`;

// ------------------------------------------------------------------ 戰術台上的 HUD：大盤、收盤倒數、漲跌家數
function hudCountdown(t) {
  const ph = R.marketPhase(D.S.cal, t);
  const { d } = R.tw(t);
  const span = (k, v) => `<span class="k">${k}</span><span class="v num">${v}</span>`;
  const left = (to) => {
    const s = Math.max(0, Math.floor((to - t) / 1000));
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  if (ph.phase === 'continuous' || ph.phase === 'closing') return span('收盤倒數', left(R.atTW(d, 1330)));
  if (ph.phase === 'preopen' || ph.phase === 'reserve') return span('開盤倒數', left(R.atTW(d, 900)));
  if (ph.phase === 'oddpm' || ph.phase === 'afterhours' || ph.phase === 'post') return span('盤後撮合倒數', left(R.atTW(d, 1430)));
  const nx = R.nextTradingDay(D.S.cal, d);
  return span('下次開盤', `${MD(nx)}（${WD(nx)}）09:00`);
}
function renderHud() {
  const tx = D.S.live && D.S.live.taiex;
  const txPct = tx && tx.z && tx.y ? (tx.z / tx.y - 1) * 100 : null;
  const a = $('#hudTx');
  if (a && !UI.replay) { a.classList.remove('rp'); a.innerHTML = `<span class="k">加權指數 ${tx && tx.t ? esc(tx.t) : ''}</span><span class="v num ${cls(txPct)}">${tx && tx.z ? N(tx.z, 2) : '—'}<small>${PCT(txPct)}</small></span>`; }
  if (!UI.replay) renderBreadth(tableItems().map((x) => x.pct));
  const c = $('#hudClose');
  if (c) c.innerHTML = hudCountdown(now());
}
/** 漲跌家數（HUD 下方那條） */
function renderBreadth(pcts) {
  const v = pcts.filter(isNum);
  const up = v.filter((x) => x > 0.001).length;
  const dn = v.filter((x) => x < -0.001).length;
  const fl = v.length - up - dn;
  const tot = Math.max(1, v.length);
  const b = $('#hudBreadth');
  if (b) b.innerHTML = `<div class="lb"><b class="up">漲 ${up}</b><span>平 ${fl}</span><b class="down">跌 ${dn}</b></div><div class="track"><i class="u" style="width:${(up / tot) * 100}%"></i><i class="f" style="width:${(fl / tot) * 100}%"></i><i class="d" style="width:${(dn / tot) * 100}%"></i></div>`;
}

// ------------------------------------------------------------------ 今日縮時：把今天 09:00 到現在的盤勢在戰術台上快轉播一遍（只用 spark.json 的真實走勢，純顯示）
function replaySeries() {
  const rows = D.S.summary ? D.S.summary.etfs : [];
  const ser = [];
  let tMax = 0;
  for (const r of rows) {
    const sp = D.sparkOf(r.c);
    if (!sp.intra || !(sp.ref > 0) || !sp.pts.length) continue;
    ser.push({ c: r.c, pts: sp.pts, ref: sp.ref, i: -1 });
    tMax = Math.max(tMax, sp.pts[sp.pts.length - 1][0]);
  }
  return { ser, tMax: Math.min(tMax, 285), day: D.S.spark && D.S.spark.d };
}
function replayButton(on) {
  const b = $('#stageReplay');
  if (!b) return;
  b.classList.toggle('on', on);
  b.innerHTML = on ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>停止' : '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>今日縮時';
}
function stopReplay(restore = true) {
  const rp = UI.replay;
  if (!rp) return;
  if (rp.raf) cancelAnimationFrame(rp.raf);
  clearTimeout(rp.end);
  UI.replay = null;
  replayButton(false);
  if (restore) { updateTable(false); renderHud(); }
}
function startReplay() {
  if (UI.replay) { stopReplay(); return; }
  if (!UI.table || !UI.table.setLive) return;
  const { ser, tMax, day } = replaySeries();
  if (!ser.length || tMax < 5) { note('今天還沒有盤中走勢可以回放（開盤後幾分鐘就有）'); return; }
  const dur = Math.max(9000, Math.min(20000, (tMax / 270) * 20000));
  const t0 = performance.now();
  UI.replay = { t0, raf: 0, end: 0 };
  replayButton(true);
  const chip = $('#hudTx');
  chip.classList.add('rp');
  const label = `今日縮時 ${day ? `${MD(day)}（${WD(day)}）` : ''}`;
  UI.table.reset();
  fx('send');
  let lastMark = -1;
  const frame = (nowP) => {
    if (!UI.replay || UI.replay.t0 !== t0) return;
    const k = Math.min(1, (nowP - t0) / dur);
    const t = tMax * k;
    const pcts = new Map();
    for (const x of ser) {
      while (x.i + 1 < x.pts.length && x.pts[x.i + 1][0] <= t) x.i++;
      const px = x.i >= 0 ? x.pts[x.i][1] : x.ref;   // 第一筆成交之前：還在昨收
      pcts.set(x.c, (px / x.ref - 1) * 100);
    }
    UI.table.setLive(pcts);
    renderBreadth([...pcts.values()]);
    const mm = Math.min(270, Math.round(t));
    chip.innerHTML = `<span class="k">${label}</span><span class="v num">${String(9 + Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}</span><span class="rb"><i style="width:${(k * 100).toFixed(1)}%"></i></span>`;
    const mark = Math.floor(t / 30);    // 每 30 分鐘一聲聲納
    if (mark !== lastMark) { lastMark = mark; if (k < 1 && mark > 0) play('sand'); }
    if (k < 1) { UI.replay.raf = requestAnimationFrame(frame); return; }
    UI.replay.raf = 0;
    play('stamp');
    UI.replay.end = setTimeout(() => { if (UI.replay && UI.replay.t0 === t0) stopReplay(); }, 1800);
  };
  UI.replay.raf = requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ 沙盤頁：選定目標、自選、今天最熱、漲跌排行、你的部位、消息
function renderTablePane() {
  const el = $('#pTable');
  const r = run();
  renderHud();
  const sel = D.row(UI.sel);
  const ch = D.changeOf(UI.sel);
  // 新行情進來、價格變了：大字閃一下（紅漲綠跌）
  const tflash = UI.lastTgt && UI.lastTgt.code === UI.sel && isNum(UI.lastTgt.px) && isNum(ch.px) && ch.px !== UI.lastTgt.px ? (ch.px > UI.lastTgt.px ? 'flash-up' : 'flash-down') : '';
  UI.lastTgt = { code: UI.sel, px: ch.px };
  const items = tableItems().filter((x) => isNum(x.pct));
  const movers = [...items].sort((a, b) => b.pct - a.pct);
  const top = movers.slice(0, 5);
  const bot = movers.slice(-5).reverse();
  const Lg = r ? L(r) : null;
  const held = Lg ? Lg.holdings.filter((h) => h.sh > 0) : [];
  const heldSet = new Set(held.map((h) => h.code));
  const watch = (db.settings.watch || []).filter((c) => D.row(c));
  const hot = (D.S.summary ? D.S.summary.etfs : []).map((x) => ({ c: x.c, n: x.n, val: D.valueOf(x.c) })).sort((a, b) => b.val - a.val).slice(0, 8);
  const hotMax = hot.length ? hot[0].val : 1;
  const news = ((D.S.news && D.S.news.items) || []).filter((x) => x.kind !== 'opinion').slice(0, 8);
  const SRC = { cna: '中央社', twse_news: '證交所', fsc: '金管會', cbc: '央行' };
  const maxMv = Math.max(0.01, ...movers.map((x) => Math.abs(x.pct)));
  const card = (c) => {
    const rw = D.row(c);
    const x = D.changeOf(c);
    return `<div class="card ${cls(x.pct)} ${c === UI.sel ? 'sel' : ''}" data-code="${c}">${heldSet.has(c) ? '<i class="held" title="你持有"></i>' : ''}
      <div class="cd">${c}</div><div class="nm">${esc(rw ? rw.n : '')}</div>
      <div class="px ${cls(x.pct)}">${P(x.px)}</div><div class="ch ${cls(x.pct)}">${isNum(x.ch) ? `${x.ch > 0 ? '▲' : x.ch < 0 ? '▼' : ''}${Math.abs(x.ch).toFixed(2)}` : ''} ${PCT(x.pct)}</div>
      ${sparkSVG(c, 134, 34)}</div>`;
  };
  const mv = (x, dir) => `<div class="mv ${dir}" data-code="${x.c}"><i style="width:${Math.min(100, (Math.abs(x.pct) / maxMv) * 100)}%"></i><div><b>${x.c}</b><small>${esc(x.n)}</small></div><span class="${cls(x.pct)}">${PCT(x.pct)}</span></div>`;
  el.innerHTML = `
    ${sel ? `<div class="dossier only-m"><div class="tab">選定目標 <small>${esc(CAT_NAME[sel.k] || '')}</small></div><div class="act">${starBtn(sel.c)}</div>
      <div class="target"><div><div class="cd">${sel.c}</div><div class="nm">${esc(sel.n)}</div></div>
        <div><div class="px ${cls(ch.pct)} ${tflash}" id="tgtPx">${P(ch.px)}</div><div class="ch ${cls(ch.pct)}">${isNum(ch.ch) ? `${ch.ch > 0 ? '▲' : ch.ch < 0 ? '▼' : ''}${Math.abs(ch.ch).toFixed(2)}` : ''} ${PCT(ch.pct)}</div></div>
        ${sparkSVG(sel.c, 320, 46)}</div>
      <div class="row" style="margin-top:12px"><button class="btn grow" data-go="quote">看盤</button><button class="btn buy grow" data-trade="B">買進</button><button class="btn sell grow" data-trade="S">賣出</button></div></div>` : ''}
    ${r ? `<div id="dayRep">${UI.dayRepHTML || ''}</div>` : ''}
    <div class="dossier"><div class="tab">自選 <small>${watch.length} 檔・點星號加減</small></div>
      <div class="rail">${watch.map(card).join('')}<button class="card add" type="button" data-go="list"><span><b>＋</b>加自選</span></button></div></div>
    <div class="dossier"><div class="tab">今天最熱 <small>成交值最大的 8 檔</small></div>
      <div class="list">${hot.map((x, i) => { const c2 = D.changeOf(x.c); return `<div class="rank" data-code="${x.c}"><div class="no">${i + 1}</div><div class="t"><span class="code">${x.c}</span>${esc(x.n)}</div>${sparkSVG(x.c, 70, 30, true)}<div class="r"><span class="p ${cls(c2.pct)}">${P(c2.px)}</span>${PILL(c2.pct)}</div><div class="bar2"><i style="width:${Math.max(4, (x.val / hotMax) * 100)}%"></i></div><div class="val">成交值${D.valueEst(x.c) ? '約' : ''} ${VAL(x.val)}</div></div>`; }).join('') || '<div class="empty">還沒有行情</div>'}</div></div>
    <div class="dossier"><div class="tab">漲跌排行</div>
      ${top.length ? `<div class="duo"><div><h4 class="up">漲最多</h4>${top.map((x) => mv(x, 'up')).join('')}</div><div><h4 class="down">跌最多</h4>${bot.map((x) => mv(x, 'down')).join('')}</div></div>` : '<div class="empty">還沒有行情</div>'}</div>
    ${held.length ? `<div class="dossier you only-m"><div class="tab">你的部位 <small>${held.length} 檔</small></div><div class="list">${held.map((h) => `<div class="li tap" data-code="${h.code}"><div class="t"><span class="code" style="color:var(--you-hi)">${h.code}</span>${esc((D.row(h.code) || {}).n || '')}</div><div class="v">${N(h.mv)}</div><div class="s">${SH(h.sh)}・均價 ${P(h.avg)}</div><div class="w num ${cls(h.mv - h.cost)}">${N(h.mv - h.cost)}</div></div>`).join('')}</div></div>` : ''}
    <div class="dossier news"><div class="tab">官方消息</div>
      ${news.length ? `<div class="ticker"><div>${news.map((n) => `<span><b>${esc(SRC[n.src] || n.src)}</b>${esc(n.t)}</span>`).join('')}</div></div>` : ''}
      <div class="list">${news.map((n) => `<a class="li" href="${esc(n.url)}" target="_blank" rel="noopener"><div class="t" style="font-weight:400;font-size:14px;white-space:normal"><span class="src">${esc(SRC[n.src] || n.src)}</span>${esc(n.t)}</div><div class="s">${n.ts ? esc(n.ts.slice(5, 16).replace('T', ' ')) : MD(n.d)}</div></a>`).join('') || '<div class="empty">目前沒有消息</div>'}</div></div>`;
  el.onclick = (e) => {
    const st = e.target.closest('[data-star]');
    if (st) { toggleWatch(st.dataset.star); renderTablePane(); return; }
    const go = e.target.closest('[data-go]');
    if (go) {
      if (go.dataset.go === 'list') { UI.qmode = 'list'; UI.qcat = 'all'; setTab('quote'); return; }
      UI.qmode = 'detail'; setTab('quote'); return;
    }
    const li = e.target.closest('[data-code]');
    if (li) { selectCode(li.dataset.code, false); play('tap'); renderTablePane(); if (!window.matchMedia('(min-width:1100px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const tr = e.target.closest('[data-trade]');
    if (tr) openTicket(UI.sel, tr.dataset.trade);
  };
  fillDayReport();
}

// ------------------------------------------------------------------ 今日戰報：今天賺賠多少、和 0050 比、每一檔的貢獻
let dayRepBusy = false;
async function fillDayReport() {
  const box = $('#dayRep');
  const r = run();
  if (!box || !r || dayRepBusy) return;
  dayRepBusy = true;
  try {
    const codes = [...new Set([...(r.fills || []).map((f) => f.code), BENCH])];
    await Promise.all(codes.map((c) => D.ensureHist(c)));
    const h = D.S.hist.get(BENCH);
    const t = now();
    const { d: today, hm } = R.tw(t);
    if (!h || !h.d || !h.d.length) return;
    const day = R.isTradingDay(D.S.cal, today) && hm >= 900 ? today : h.d.filter((d) => d < today).pop();
    const prevDay = day ? h.d.filter((d) => d < day).pop() : null;
    const el = $('#dayRep');
    if (!el || !day || !prevDay || r.start.d > day) { UI.dayRepHTML = ''; if (el) el.innerHTML = ''; return; }
    const rep = dayReport(r, mkt(), (c) => D.S.hist.get(c), t, prevDay, day);
    const live = rep.live && hm < 1330;
    const stamp = live ? '<span class="stamp live">盤中即時</span>' : rep.live && hm < 1430 ? '<span class="stamp wait">收盤・等盤後</span>' : '<span class="stamp filled">結算</span>';
    const diff = isNum(rep.ret) && isNum(rep.bench) ? rep.ret - rep.bench : null;
    const allCash = !rep.rows.length;
    const maxAbs = Math.max(1, ...rep.rows.map((x) => Math.abs(x.pnl)));
    UI.dayRepHTML = `<div class="dossier you dayrep"><div class="tab">${live ? '今日戰報' : `${rep.live ? '今日' : MD(day)}戰報`} <small>${MD(day)}（${WD(day)}）${rep.started ? '・開局第一天' : ''}</small></div><div class="act">${stamp}</div>
      <div class="dr-hero">
        <div><span class="k">${rep.live ? '今天' : '那天'}損益</span><b class="num ${cls(rep.pnl)}">${rep.pnl > 0 ? '+' : ''}${N(Math.round(rep.pnl))}</b><span class="num ${cls(rep.ret)}">${RET(rep.ret)}</span></div>
        <div><span class="k">0050 同一天（含息）</span><b class="num ${cls(rep.bench)}">${RET(rep.bench)}</b><span class="note2">${allCash ? '你全部是現金，沒有漲跌' : diff == null ? '' : Math.abs(diff) < 0.00005 ? '和 0050 一樣' : diff > 0 ? `<b class="up">贏 0050 ${(diff * 100).toFixed(2)} 個百分點</b>` : `<b class="down">輸 0050 ${(-diff * 100).toFixed(2)} 個百分點</b>`}</span></div>
      </div>
      <div class="dr-line">成交 ${rep.fills} 筆${rep.buyAmt ? ` ・ 買進 ${N(rep.buyAmt)}` : ''}${rep.sellAmt ? ` ・ 賣出 ${N(rep.sellAmt)}` : ''} ・ 手續費 ${N(rep.fees)}${rep.taxes ? ` ・ 證交稅 ${N(rep.taxes)}` : ''}</div>
      ${rep.rows.length ? `<div class="dr-list">${rep.rows.slice(0, 6).map((x) => `<div class="mv ${x.pnl >= 0 ? 'up' : 'down'}" data-code="${x.code}"><i style="width:${Math.max(3, (Math.abs(x.pnl) / maxAbs) * 100)}%"></i><div><b>${x.code}</b><small>${esc((D.row(x.code) || {}).n || '')}${x.div ? `・配息 ${N(x.div)}` : ''}</small></div><span class="${cls(x.pnl)}">${x.pnl > 0 ? '+' : ''}${N(Math.round(x.pnl))}</span></div>`).join('')}</div>` : ''}
      ${Math.abs(rep.other) >= 1 ? `<p class="note">其他 ${N(Math.round(rep.other))} 元（不是哪一檔的漲跌，例如入金出金）。</p>` : ''}
      <p class="note">${live ? '盤中用最新成交價算，收盤後才定案；' : ''}每一檔的貢獻＝今天的市值－昨天收盤的市值－買進花的錢＋賣出拿回的錢＋配息，手續費、證交稅都扣掉了。</p></div>`;
    el.innerHTML = UI.dayRepHTML;
  } finally { dayRepBusy = false; }
}

// ------------------------------------------------------------------ 看盤：全部 ETF 清單（類別、搜尋、排序）＋單檔
const QCATS = [['all', '全部'], ['watch', '自選'], ['held', '持有'], ['broad', '市值型'], ['div', '高股息'], ['theme', '產業主題'], ['active', '主動式'], ['overseas', '海外股票'], ['bond', '債券'], ['lev', '槓桿型'], ['inv', '反向型'], ['fut', '期貨商品']];
function renderQuoteList(el) {
  // 行情更新時整個清單重畫：正在打字的搜尋框要保留焦點和游標
  const prevInp = $('#qSearch', el);
  const typing = prevInp && document.activeElement === prevInp ? [prevInp.selectionStart, prevInp.selectionEnd] : null;
  const rows = D.S.summary ? D.S.summary.etfs : [];
  const r = run();
  const Lg = r ? L(r) : null;
  const heldSet = new Set(Lg ? Lg.holdings.filter((h) => h.sh > 0).map((h) => h.code) : []);
  const watch = db.settings.watch || [];
  const cat = UI.qcat || 'all';
  const qq = (UI.q || '').trim().toUpperCase();
  const count = (k) => (k === 'all' ? rows.length : k === 'watch' ? watch.length : k === 'held' ? heldSet.size : rows.filter((x) => x.k === k).length);
  let list = rows.filter((x) => (cat === 'all' ? true : cat === 'watch' ? watch.includes(x.c) : cat === 'held' ? heldSet.has(x.c) : x.k === cat));
  // 搜尋也認類別：打「高股息」「債」「市值」會把那一類全部列出來（名字裡沒有這幾個字的也算）
  const catHit = qq ? Object.entries(CAT_NAME).filter(([, n]) => n.includes(qq) || (qq.length >= 2 && qq.includes(n))).map(([k]) => k) : [];
  if (qq) list = list.filter((x) => x.c.toUpperCase().includes(qq) || x.n.toUpperCase().includes(qq) || catHit.includes(x.k));
  const sort = UI.qsort || 'val';
  const enriched = list.map((x) => ({ x, ch: D.changeOf(x.c), val: D.valueOf(x.c) }));
  if (sort === 'pct') enriched.sort((a, b) => (b.ch.pct ?? -1e9) - (a.ch.pct ?? -1e9));
  else if (sort === 'pctd') enriched.sort((a, b) => (a.ch.pct ?? 1e9) - (b.ch.pct ?? 1e9));
  else if (sort === 'code') enriched.sort((a, b) => (a.x.c < b.x.c ? -1 : 1));
  else enriched.sort((a, b) => b.val - a.val);
  if (cat === 'watch' && sort === 'val' && !qq) enriched.sort((a, b) => watch.indexOf(a.x.c) - watch.indexOf(b.x.c));
  el.innerHTML = `
    <div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input id="qSearch" type="search" placeholder="代號或名稱，例如 0050、高股息、債" value="${esc(UI.q)}" autocomplete="off"></div>
    <div class="chips" style="margin-top:10px">${QCATS.filter(([k]) => k === 'all' || k === 'watch' || count(k) > 0).map(([k, n]) => `<button class="chip" data-cat="${k}" aria-pressed="${cat === k}">${n} <span class="n">${count(k)}</span></button>`).join('')}</div>
    <div class="qbar"><div class="seg">${[['val', '成交值'], ['pct', '漲幅'], ['pctd', '跌幅'], ['code', '代號']].map(([k, n]) => `<button data-sort="${k}" aria-pressed="${sort === k}">${n}</button>`).join('')}</div><span class="cnt">${enriched.length} 檔</span></div>
    <div class="dossier" style="padding:4px 12px"><div class="list">${enriched.map(({ x, ch }) => `<div class="qrow ${x.c === UI.sel ? 'sel' : ''}" data-code="${x.c}"><div class="t"><b>${x.c}${heldSet.has(x.c) ? '<i class="tag you">持有</i>' : ''}</b><span>${esc(x.n)}</span></div>${sparkSVG(x.c, 64, 26, true)}<div class="r"><span class="p ${cls(ch.pct)}">${P(ch.px)}</span>${PILL(ch.pct)}</div>${starBtn(x.c)}</div>`).join('') || `<div class="empty"><span class="brush">${cat === 'watch' ? '還沒有自選' : '找不到'}</span>${cat === 'watch' ? '在清單裡點星號，就會出現在這裡和首頁' : '換個關鍵字試試'}</div>`}</div></div>`;
  const inp = $('#qSearch', el);
  if (typing) { inp.focus(); try { inp.setSelectionRange(typing[0], typing[1]); } catch { /* 有些輸入框不支援 */ } }
  inp.oninput = () => { UI.q = inp.value; renderQuote(); };
  el.onclick = (e) => {
    const st = e.target.closest('[data-star]');
    if (st) { toggleWatch(st.dataset.star); renderQuote(); return; }
    const c = e.target.closest('[data-cat]');
    if (c) { UI.qcat = c.dataset.cat; play('tap'); renderQuote(); return; }
    const so = e.target.closest('[data-sort]');
    if (so) { UI.qsort = so.dataset.sort; play('tap'); renderQuote(); return; }
    const li = e.target.closest('[data-code]');
    if (li) { selectCode(li.dataset.code, false); UI.qmode = 'detail'; play('tap'); renderQuote(); window.scrollTo({ top: 0 }); }
  };
}

/** 走勢圖上要畫的：這一檔還掛著的限價委託（剩下的股數）、所有成交 */
function chartMarks(r, code) {
  if (!r) return { orders: [], fills: [] };
  const t = now();
  const orders = [];
  for (const o of r.orders) {
    if (o.code !== code || !(o.px > 0)) continue;
    const st = E.orderStatus(r, o);
    if (!['wait', 'queued', 'live', 'part'].includes(st.st)) continue;
    const left = E.qtyAt(o, r.mods || [], t).q - st.filled;
    if (left <= 0) continue;
    orders.push({ px: o.px, side: o.side, lbl: SH(left) });
  }
  const fills = (r.fills || []).filter((f) => f.code === code).map((f) => ({ t: f.t, d: f.d, px: f.px, side: f.side, qty: f.qty, sess: f.sess }));
  return { orders, fills };
}

async function renderQuote() {
  const el = $('#pQuote');
  if ((UI.qmode || 'list') === 'list') { renderQuoteList(el); return; }
  const code = UI.sel;
  const r0 = D.row(code);
  const q = D.quoteOf(code);
  const qo = D.quoteOf(code, 'odd');
  const ch = D.changeOf(code);
  const lv = D.liveOf(code);
  const r = run();
  const Lg = r ? L(r) : null;
  const h = Lg ? Lg.holdings.find((x) => x.code === code && x.sh > 0) : null;
  const lim = R.limitsOf(q);
  const bk = UI.book === 'odd' ? qo : q;
  const asks = (bk && bk.a) || [];
  const bids = (bk && bk.b) || [];
  const maxV = Math.max(1, ...asks.map((x) => x[1]), ...bids.map((x) => x[1]));
  const unit = UI.book === 'odd' ? 1 : 1000;
  const lvl = (x) => `<div class="lv"><i style="width:${Math.round((x[1] / maxV) * 100)}%"></i><span class="${x[0] > ch.ref ? 'up' : x[0] < ch.ref ? 'down' : ''}">${P(x[0])}</span><span>${N(Math.round(x[1] / unit))}</span></div>`;
  const dv = r0 && r0.dv;
  const ex = dv && dv.d >= R.tw(now()).d ? `${MD(dv.d)} 除息${dv.cash ? ` ${dv.cash} 元` : '（金額待公告）'}` : null;
  const prevPx = UI.lastPx && UI.lastPx.code === code ? UI.lastPx.px : null;
  const flash = isNum(prevPx) && isNum(ch.px) && ch.px !== prevPx ? (ch.px > prevPx ? 'flash-up' : 'flash-down') : '';
  UI.lastPx = { code, px: ch.px };
  el.innerHTML = `
    <div class="row sp"><button class="back" type="button" data-back="1"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>全部 ETF</button>${r0 ? starBtn(code) : ''}</div>
    ${!r0 ? '<div class="empty">找不到這一檔</div>' : `
    <div class="dossier"><div class="tab">${esc(CAT_NAME[r0.k] || '')} <small>${q && q.t ? `行情 ${String(q.t).padStart(6, '0').replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3')}` : '收盤資料'}</small></div>
      <div class="qhead"><div><span class="cd">${code}</span><span class="nm">${esc(r0.n)}</span>${h ? ` <span class="tag you">持有 ${SH(h.sh)}</span>` : ''}</div></div>
      <div class="bigrow" style="margin-top:8px"><span class="big ${cls(ch.ch)} ${flash}">${P(ch.px)}</span><span class="chg ${cls(ch.ch)}">${isNum(ch.ch) ? `${ch.ch > 0 ? '▲' : ch.ch < 0 ? '▼' : ''}${Math.abs(ch.ch).toFixed(2)}` : ''} ${PCT(ch.pct)}</span></div>
      <div class="kv" style="margin-top:12px">
        <div><span>昨收</span><b>${P(ch.ref)}</b></div>
        <div><span>開盤</span><b class="${cls((q && q.o) - ch.ref)}">${P(q && q.o)}</b></div>
        <div><span>成交量</span><b>${q ? N(Math.round(q.v / 1000)) : '—'} 張</b></div>
        <div><span>最高</span><b class="${cls((q && q.h) - ch.ref)}">${P(q && q.h)}</b></div>
        <div><span>最低</span><b class="${cls((q && q.l) - ch.ref)}">${P(q && q.l)}</b></div>
        <div><span>${termHTML('漲跌停')}</span><b>${lim.none ? '無限制' : `<span class="up">${P(lim.up)}</span>／<span class="down">${P(lim.down)}</span>`}</b></div>
        <div><span>預估淨值</span><b>${lv && lv.nav ? P(lv.nav) : '—'}</b></div>
        <div><span>折溢價</span><b class="${lv && lv.prem > 0.5 ? 'warn' : ''}">${lv && isNum(lv.prem) ? PCT(lv.prem) : '—'}</b></div>
        <div><span>成交值${D.valueEst(code) ? '（估）' : ''}</span><b>${VAL(D.valueOf(code))}</b></div>
      </div>
      ${ex ? `<p class="note">配息：${esc(ex)}</p>` : ''}
    </div>
    <div class="dossier"><div class="tab">走勢</div><div class="act"><div class="seg"><button data-chart="intra" aria-pressed="${UI.chart === 'intra'}">分時</button><button data-chart="k" aria-pressed="${UI.chart === 'k'}">日 K</button></div></div>
      <div class="chart-wrap"><canvas id="qChart"></canvas><div class="tip" id="qTip" hidden></div></div>
    </div>
    <div class="dossier"><div class="tab">${termHTML('五檔')}</div><div class="act"><div class="seg"><button data-book="reg" aria-pressed="${UI.book === 'reg'}">整股（張）</button><button data-book="odd" aria-pressed="${UI.book === 'odd'}">零股（股）</button></div></div>
      ${asks.length || bids.length ? `<div class="book"><div class="bid"><h4>委買</h4>${bids.map(lvl).join('')}</div><div class="ask"><h4>委賣</h4>${asks.map(lvl).join('')}</div></div>
      <p class="note">${bk && bk.t ? `${String(bk.t).padStart(6, '0').replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3')} 的快照，約 5 分鐘更新一次` : ''}</p>` : `<div class="empty">${UI.book === 'odd' ? '現在沒有零股掛單資料' : '現在沒有掛單資料'}</div>`}
    </div>
    ${h ? `<div class="dossier you"><div class="tab">你的部位</div><div class="kv">
      <div><span>庫存</span><b>${SH(h.sh)}</b></div><div><span>均價</span><b>${P(h.avg)}</b></div><div><span>市值</span><b>${N(h.mv)}</b></div>
      <div><span>${termHTML('未實現損益', '未實現')}</span><b class="${cls(unrealOf(h, r.fees, Lg.today))}">${N(unrealOf(h, r.fees, Lg.today))}</b></div><div><span>報酬</span><b class="${cls(unrealOf(h, r.fees, Lg.today))}">${RET(h.cost ? unrealOf(h, r.fees, Lg.today) / h.cost : null)}</b></div><div><span>可賣</span><b>${SH(E.sellable(Lg, code, daytradeOk(r, Lg)))}</b></div>
    </div>${h.todayBuy && !daytradeOk(r, Lg) ? `<p class="note">今天買的 ${SH(h.todayBuy)} 要明天才能賣（還沒有${termHTML('當沖')}資格）。</p>`
      : h.todayBuy > (h.todayReg || 0) ? `<p class="note">今天用零股、盤後買的 ${SH(h.todayBuy - (h.todayReg || 0))} 要明天才能賣（零股不能${termHTML('當沖')}）。</p>` : ''}</div>` : ''}
    <div class="tradebar"><button class="btn buy" data-trade="B">買 進</button><button class="btn sell" data-trade="S">賣 出</button></div>`}`;
  el.onclick = (e) => {
    if (e.target.closest('[data-back]')) { UI.qmode = 'list'; play('tap'); renderQuote(); return; }
    const st = e.target.closest('[data-star]');
    if (st) { toggleWatch(st.dataset.star); renderQuote(); return; }
    const c = e.target.closest('[data-chart]');
    if (c) { UI.chart = c.dataset.chart; renderQuote(); return; }
    const b = e.target.closest('[data-book]');
    if (b) { UI.book = b.dataset.book; renderQuote(); return; }
    const tr = e.target.closest('[data-trade]');
    if (tr) openTicket(code, tr.dataset.trade);
  };
  if (!r0) return;
  // 圖：你掛著的委託（虛線）、你的成交（圓點／三角形）一起畫上去
  const marks = chartMarks(r, code);
  const cv = $('#qChart', el);
  if (UI.chart === 'intra') {
    const tp = await D.ensureTape(code);
    if (UI.sel !== code || !cv.isConnected) return;
    const qd = D.quotesDay();
    const rec = tp && tp.cur && (tp.cur.d === qd ? tp.cur : null) || (tp && tp.cur) || null;
    const d = rec ? rec.d : qd || R.tw(now()).d;
    const m = mkt();
    const ticks = rec ? (m.ticks(code, d, 'reg') || []) : [];
    drawIntraday(cv, { ticks, ref: rec && rec.y ? rec.y : ch.ref, up: rec ? rec.u : lim.up, down: rec ? rec.w : lim.down, d, nowMs: now(), marks: { orders: marks.orders, fills: marks.fills.filter((f) => f.d === d && f.sess !== 'dca') } }, $('#qTip', el));
  } else {
    const k = await D.ensureK(code);
    if (UI.sel !== code || !cv.isConnected) return;
    const splits = (D.S.divs[code] && D.S.divs[code].s) || [];
    const bars = k && k.d ? k.d.map((d, i) => {
      let f = 1;
      for (const [sd, kk] of splits) if (d < sd) f *= kk;
      return { d, o: k.o[i] / f, h: k.h[i] / f, l: k.l[i] / f, c: k.c_[i] / f, v: k.v[i] * f };
    }).filter((b) => b.c > 0) : [];
    // 今天盤中：補上今天這一根
    if (q && q.z && q.o && bars.length && q.d > bars[bars.length - 1].d) bars.push({ d: q.d, o: q.o, h: q.h, l: q.l, c: q.z, v: q.v });
    drawK(cv, bars, $('#qTip', el), marks);
  }
}

// ------------------------------------------------------------------ 委託
function orderLine(o) {
  const t = o.type === 'M' ? '市價' : o.type === 'C' ? '收盤價' : P(o.px);
  return `${R.SESS_NAME[o.sess]} ${E.TYPE_NAME[o.type]} ${o.tif} ・ ${t} × ${SH(o.qty)}`;
}
function renderOrders() {
  const el = $('#pOrders');
  const r = run();
  if (!r) { el.innerHTML = `<div class="dossier"><div class="tab">委託</div><div class="empty"><span class="brush">還沒開戶</span>先開一個模擬帳戶，就可以下單了</div><button class="btn brass blk" id="goSetup">開設模擬帳戶</button></div>`; $('#goSetup', el).onclick = openSetup; return; }
  const today = R.tw(now()).d;
  const all = [...r.orders].sort((a, b) => b.at - a.at);
  const st = (o) => E.orderStatus(r, o);
  const openOnes = all.filter((o) => ['wait', 'queued', 'live', 'part', 'cancelling'].includes(st(o).st));
  const todays = all.filter((o) => o.day === today || R.tw(o.at).d === today || openOnes.includes(o));
  const list = UI.orderView === 'today' ? todays : UI.orderView === 'fills' ? null : all.slice(0, 120);
  const fills = [...r.fills].sort((a, b) => b.t - a.t).slice(0, 120);
  const slip = (o) => {
    const s = st(o);
    const fs = r.fills.filter((f) => f.oid === o.id);
    const q = fs.reduce((a, f) => a + f.qty, 0);
    const avg = q ? fs.reduce((a, f) => a + f.amt, 0) / q : null;
    const nm = (D.row(o.code) || {}).n || '';
    const live = ['wait', 'queued', 'live', 'part', 'cancelling'].includes(s.st);
    // 那個時段撮合完以後（整股、零股 13:30；盤後 14:30）不能再刪改單，按鈕收起來
    const modOk = now() < R.atTW(o.day, o.sess === 'fix' || o.sess === 'oddpm' ? 1430 : 1330);
    const canPx = live && modOk && o.sess === 'reg' && o.type === 'L' && o.tif === 'ROD';
    const why = (r.finals[o.id] || {}).why;
    const nt = (r.notes || {})[o.id];
    return `<div class="slip" data-oid="${o.id}"><span class="stamp ${s.st}">${E.ST_NAME[s.st]}</span>
      <div class="h"><span class="side ${o.side}">${E.SIDE_NAME[o.side]}</span><span class="code">${o.code}</span><span class="nm">${esc(nm)}</span></div>
      <div class="d">${orderLine(o)}</div>
      <div class="m">委託 ${MD(R.tw(o.at).d)} ${HMS(o.at)}${o.day !== R.tw(o.at).d ? `（${MD(o.day)} 的預約單）` : ''}${q ? ` ・ 已成交 ${SH(q)} 均價 ${P(avg)}` : ''}</div>
      ${why ? `<div class="why">${esc(why)}</div>` : ''}
      ${nt && nt.t ? `<div class="m">理由：${esc(nt.t)}</div>` : ''}
      ${s.st === 'cancelling' ? '<div class="m">刪單已送出，等下一筆行情確認（如果那之前已經成交，成交算數）</div>' : ''}
      ${live && !modOk && s.st !== 'cancelling' ? '<div class="m">已經撮合，等交易所的結果（不能再刪改單）</div>' : ''}
      ${live && modOk && s.st !== 'cancelling' ? `<div class="acts"><button class="btn sm" data-act="cancel">刪單</button>${o.qty - q > (o.sess === 'reg' ? 1000 : 1) ? '<button class="btn sm" data-act="reduce">減量</button>' : ''}${canPx ? '<button class="btn sm" data-act="reprice">改價</button>' : ''}</div>` : ''}
    </div>`;
  };
  el.innerHTML = `
    <div class="dossier"><div class="tab">委託與成交回報</div><div class="act"><div class="seg">
      <button data-view="today" aria-pressed="${UI.orderView === 'today'}">今天</button><button data-view="fills" aria-pressed="${UI.orderView === 'fills'}">成交</button><button data-view="all" aria-pressed="${UI.orderView === 'all'}">全部</button></div></div>
      ${!D.serverOk() ? '<div class="dossier hazard" style="margin:24px 0 8px"><div class="tab warn">離線</div><p class="note">連不上網路：撮合暫停，什麼都不判斷、不存。連上網路之後，才會用真的行情判斷這段時間的成交。</p></div>' : ''}
      ${openOnes.length ? `<p class="note">掛著 ${openOnes.length} 筆，後台每一輪新行情進來就會自動撮合。</p>` : ''}
      ${list ? (list.map(slip).join('') || `<div class="empty"><span class="brush">${UI.orderView === 'fills' ? '還沒有成交' : '還沒有委託'}</span>${UI.orderView === 'today' ? '今天還沒下單。到「看盤」選一檔，按買進或賣出' : '這一局還沒有紀錄'}</div>`)
        : (fills.map((f) => `<div class="slip"><span class="stamp filled">${f.sess === 'dca' ? '定期定額' : '成交'}</span><div class="h"><span class="side ${f.side}">${E.SIDE_NAME[f.side]}</span><span class="code">${f.code}</span><span class="nm">${esc((D.row(f.code) || {}).n || '')}</span></div>
          <div class="d">${SH(f.qty)} × ${P(f.px)} ＝ ${N(f.amt)}</div>
          <div class="m">${MD(f.d)} ${HMS(f.t)} ・ 手續費 ${N(f.fee)}${f.fee !== f.fin ? `（隔天退 ${N(f.fee - f.fin)}）` : ''}${f.tax ? ` ・ 證交稅 ${N(f.tax)}` : ''} ・ ${MD(R.settleDay(D.S.cal, f.d, 2))} 交割</div></div>`).join('') || '<div class="empty"><span class="brush">還沒有成交</span></div>')}
    </div>`;
  el.onclick = async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { UI.orderView = v.dataset.view; renderOrders(); return; }
    const a = e.target.closest('[data-act]');
    if (!a) {
      const s = e.target.closest('[data-oid]');
      if (s) { const o = r.orders.find((x) => x.id === s.dataset.oid); if (o) selectCode(o.code, true); }
      return;
    }
    const oid = a.closest('[data-oid]').dataset.oid;
    const o = run().orders.find((x) => x.id === oid);
    if (a.dataset.act === 'cancel') modOrder(o, 'cancel');
    else if (a.dataset.act === 'reduce') reduceDialog(o);
    else if (a.dataset.act === 'reprice') repriceDialog(o);
  };
}

/** 刪單、減量：一樣要連網拿伺服器時間，生效時間＝伺服器時間 */
async function modOrder(o, kind, qty) {
  let at;
  try { ({ at } = await D.freshForOrder(o.code)); } catch { note('連不上網路，刪改單沒有送出'); fx('reject'); return false; }
  await settle(true);
  const r = run();
  const s = E.orderStatus(r, r.orders.find((x) => x.id === o.id));
  if (s.st === 'cancelling') { note('這筆已經送出刪單，正在等下一筆行情確認'); return false; }
  if (!['wait', 'queued', 'live', 'part'].includes(s.st)) { note(`來不及了：這筆已經「${E.ST_NAME[s.st]}」`); renderAll(); return false; }
  // 那個時段已經撮合完（整股、盤中零股 13:30；盤後 14:30）：交易所不收刪改單，等撮合結果
  const endHM = o.sess === 'fix' || o.sess === 'oddpm' ? 1430 : 1330;
  if (at >= R.atTW(o.day, endHM)) { note(`來不及了：${MD(o.day)} ${String(endHM).replace(/(\d\d)$/, ':$1')} 已經撮合，交易所不收刪改單，等撮合結果`); fx('reject'); renderAll(); return false; }
  const m = { id: ST.newId('m', at), oid: o.id, at, kind, qty: qty || 0 };
  db = ST.update((x) => { x.runs[r.id].mods.push(m); });
  fx(kind === 'cancel' ? 'cancel' : 'stamp');
  note(kind === 'cancel' ? `刪單已送出（${HMS(at)}），等下一筆行情確認；如果那之前價格已經穿過你的委託價，算成交在先。` : `減量 ${SH(qty)} 已送出（${HMS(at)}），下一筆行情之後生效`);
  await settle();
  renderAll();
  updateTable(false);
  return true;
}
function reduceDialog(o) {
  const r = run();
  const s = E.orderStatus(r, o);
  const { q } = E.qtyAt(o, r.mods, Infinity);
  const left = q - s.filled;
  const unit = o.sess === 'reg' ? 1000 : 1;
  modal(`<h2>減量</h2><p class="prose">${o.code} 還沒成交 ${SH(left)}，要減掉多少？</p>
    <div class="field"><label>減掉（${unit === 1000 ? '張' : '股'}）</label><input id="rq" type="number" inputmode="numeric" min="1" max="${Math.floor((left - unit) / unit)}" value="1"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>取消</button><button class="btn brass" id="rOk">送出減量</button></div>`, {
    onMount: (m, close) => {
      $('#rOk', m).onclick = () => {
        const n = Math.floor(Number($('#rq', m).value)) * unit;
        if (!(n > 0) || n >= left) { $('#rq', m).style.borderColor = 'var(--up)'; return; }
        close();
        modOrder(o, 'reduce', n);
      };
    },
  });
}
function repriceDialog(o) {
  modal(`<h2>改價</h2><p class="prose">改價等於「刪掉原來那筆、用新價格重新排隊」（交易所規定：改價後委託時間改成改價的時間）。已經成交的部分不受影響。</p>
    <div class="field"><label>新價格</label><input id="np" type="number" inputmode="decimal" step="${R.tick(o.px)}" value="${o.px}"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>取消</button><button class="btn brass" id="pOk">送出改價</button></div>`, {
    onMount: (m, close) => {
      $('#pOk', m).onclick = async () => {
        const px = R.r2(Number($('#np', m).value));
        if (!R.onTick(px)) { $('#np', m).style.borderColor = 'var(--up)'; return; }
        close();
        const r = run();
        const s = E.orderStatus(r, o);
        const { q } = E.qtyAt(o, r.mods, Infinity);
        const left = q - s.filled;
        if (!(await modOrder(o, 'cancel'))) return;
        await placeOrder({ code: o.code, side: o.side, kind: 'lot', type: 'L', tif: 'ROD', px, qty: left, note: '', tags: [], prev: o.id }, { silentOk: false });
      };
    },
  });
}

// ------------------------------------------------------------------ 庫存與帳戶
function renderPos() {
  const el = $('#pPos');
  const r = run();
  if (!r) { el.innerHTML = `<div class="dossier you"><div class="tab">我的帳戶</div><div class="empty"><span class="brush">還沒開戶</span></div><button class="btn brass blk" id="goSetup2">開設模擬帳戶</button></div>`; $('#goSetup2', el).onclick = openSetup; return; }
  const Lg = L(r);
  const held = Lg.holdings.filter((h) => h.sh > 0);
  const closed = Lg.holdings.filter((h) => h.sh <= 0);
  const est = (h) => unrealOf(h, r.fees, Lg.today);
  const unreal = held.reduce((s, h) => s + est(h), 0);
  const realized = Lg.holdings.reduce((s, h) => s + h.realized, 0);
  const divs = Lg.divItems.reduce((s, x) => s + x.net, 0);
  const tl = Lg.upcoming.slice(0, 10).map((x) => `<li><span class="d">${MD(x.d)}（${WD(x.d)}）</span><span>${{ buy: '買進交割扣款', sell: '賣出交割入帳', rebate: '手續費退款', div: `配息入帳 ${x.ref || ''}`, capital: '入金' }[x.kind] || x.kind}</span><span class="a ${x.amt >= 0 ? 'up' : 'down'}">${x.amt >= 0 ? '+' : ''}${N(x.amt)}</span></li>`).join('');
  el.innerHTML = `
    <div class="dossier you"><div class="tab">${esc(r.name)} <small>${MD(r.start.d)} 開戶</small></div>
      <div class="dim" style="font-size:12px">${termHTML('總資產')}</div>
      <div class="bigrow"><span class="big">${N(Lg.equity)}</span><span class="chg ${cls(Lg.equity - r.capital)}">${RET(Lg.equity / r.capital - 1)}</span></div>
      <div class="ledger" style="margin-top:10px">
        <div><span>交割帳戶餘額</span><b>${N(Lg.cash)}</b></div>
        <div><span>${termHTML('可用額度')}</span><b class="you">${N(Lg.avail)}</b></div>
        <div><span>持股市值</span><b>${N(Lg.mv)}</b></div>
        <div><span>待交割淨額</span><b class="${cls(Lg.pendingTrade)}">${N(Lg.pendingTrade)}</b></div>
      </div>
      ${Lg.reserved ? `<p class="note">掛著的買單圈存 <b class="num">${N(Lg.reserved)}</b> 元</p>` : ''}
      ${tl ? `<ul class="timeline">${tl}</ul>` : ''}
    </div>
    <div class="dossier you"><div class="tab">庫存 <small>${held.length} 檔</small></div>
      ${held.length ? held.map((h) => {
        const nm = (D.row(h.code) || {}).n || '';
        const pnl = est(h);
        const ch = D.changeOf(h.code);
        return `<div class="pos" data-code="${h.code}"><div class="t"><span class="flag"></span><span class="code">${h.code}</span>${esc(nm)}</div><div class="v">${N(h.mv)}</div>
          <div class="s">${SH(h.sh)} ・ 均價 ${P(h.avg)} ・ 現價 <span class="${cls(ch.ch)}">${P(h.px)}</span>${h.todayBuy ? ' ・ 今日買進' : ''}${h.locked ? ` ・ 掛賣 ${SH(h.locked)}` : ''}</div>
          <div class="w ${cls(pnl)}">${N(pnl)}（${RET(h.cost ? pnl / h.cost : null)}）</div></div>`;
      }).join('') : '<div class="empty"><span class="brush">還沒插旗</span>到「看盤」選一檔，按買進</div>'}
      <div class="stats" style="margin-top:10px">
        <div><span>${termHTML('未實現損益')}</span><b class="${cls(unreal)}">${N(unreal)}</b></div>
        <div><span>已實現損益</span><b class="${cls(realized)}">${N(realized)}</b></div>
        <div><span>已領配息</span><b class="up">${N(divs - Lg.pendingDiv)}</b></div>
        <div><span>應收配息</span><b>${N(Lg.pendingDiv)}</b></div>
      </div>
      <p class="note">未實現損益已經扣掉「現在全部賣掉」要付的手續費與證交稅。</p>
    </div>
    ${dcaHTML(r)}
    ${closed.length ? `<div class="dossier"><div class="tab">已經出清</div><div class="list">${closed.map((h) => `<div class="li tap" data-code="${h.code}"><div class="t"><span class="code">${h.code}</span>${esc((D.row(h.code) || {}).n || '')}</div><div class="v ${cls(h.realized)}">${N(h.realized)}</div></div>`).join('')}</div></div>` : ''}`;
  el.onclick = (e) => {
    if (e.target.closest('#dcaAdd')) { openDcaForm(); return; }
    const st = e.target.closest('[data-dcastop]');
    if (st) { stopPlan(st.dataset.dcastop); return; }
    const p = e.target.closest('[data-code]');
    if (p) selectCode(p.dataset.code, true);
  };
}

// ------------------------------------------------------------------ 定期定額
function dcaHTML(r) {
  const today = R.tw(now()).d;
  const plans = r.plans || [];
  const rows = plans.map((p) => {
    const nm = (D.row(p.c) || {}).n || '';
    const ended = p.end && p.end < today;
    const nx = ended ? null : DCA.nextRun(p, D.S.cal, today);
    const logs = Object.entries(r.dcaLog || {}).filter(([k]) => k.startsWith(`${p.id}:`)).map(([, v]) => v);
    const ok = logs.filter((x) => x.st === 'ok');
    const sh = ok.reduce((s, x) => s + x.qty, 0);
    const fail = logs.filter((x) => x.st === 'fail').length;
    return `<div class="li"><div class="t"><span class="code">${p.c}</span>${esc(nm)}</div><div class="v">${N(p.amt)}</div>
      <div class="s">每月 ${p.days.join('、')} 號 ・ ${p.start > today ? `${MD(p.start)} 起生效` : ended ? `已停扣（${MD(p.end)}）` : nx ? `下次 ${MD(nx.d)}（${WD(nx.d)}）` : ''}${ok.length ? ` ・ 已買 ${ok.length} 期 ${SH(sh)}` : ''}${fail ? ` ・ <span class="warn">失敗 ${fail} 期</span>` : ''}${p.why ? `<br><span class="warn">${esc(p.why)}</span>` : ''}</div>
      <div class="w">${!ended && !(p.end && p.end >= today && p.stopAt) ? `<button class="btn sm" data-dcastop="${p.id}">停扣</button>` : ''}</div></div>`;
  }).join('');
  return `<div class="dossier you"><div class="tab">定期定額 <small>照國泰證券的規則</small></div><div class="act"><button class="btn sm" id="dcaAdd">新增計畫</button></div>
    ${rows ? `<div class="list">${rows}</div>` : '<div class="empty"><span class="brush">還沒有定期定額</span>可以把你在國泰扣的那一套也搬來練，看長期下來誰比較好</div>'}
    <p class="note">每月選幾號扣款、遇假日順延、2/30 這種日期那期不買；申請、停扣都要「送出後第 2 個交易日」才生效。用扣款日的收盤價買零股，金額含手續費（2026 年底前每筆 1 元）。可用額度不夠就扣款失敗、不補扣，連續 3 次失敗全部終止。</p></div>`;
}
function openDcaForm() {
  const r = run();
  if (!r) return;
  let code = UI.sel;
  const days = new Set([6]);
  modal(`<h2>新增定期定額</h2>
    <div class="field"><label>ETF 代號</label><input id="dCode" value="${esc(code)}" autocomplete="off"></div>
    <div class="note" id="dName"></div>
    <div class="field"><label>每月幾號扣款（可以選好幾天）</label><div class="quick" id="dDays">${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<button data-day="${d}" style="min-width:34px">${d}</button>`).join('')}</div></div>
    <div class="field"><label>每期金額（含手續費，百元為單位、最低 100 元）</label><input id="dAmt" type="number" inputmode="numeric" min="100" step="100" value="3000"></div>
    <p class="note" id="dWhen"></p>
    <div class="err" id="dErr" hidden></div>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>取消</button><button class="btn brass" id="dOk">送出申請</button></div>`, {
    onMount: (m, close) => {
      const paint = () => {
        const row0 = D.row($('#dCode', m).value.trim().toUpperCase());
        $('#dName', m).textContent = row0 ? `${row0.n}（${CAT_NAME[row0.k] || ''}）` : '找不到這一檔';
        $$('#dDays [data-day]', m).forEach((b) => { const on = days.has(Number(b.dataset.day)); b.style.borderColor = on ? 'var(--gold)' : ''; b.style.color = on ? 'var(--gold-hi)' : ''; });
        const c = DCA.cutover(D.S.cal, R.tw(now()).d);
        $('#dWhen', m).textContent = `今天送出，${MD(c)}（${WD(c)}）起才會照這個設定扣款。`;
      };
      $('#dDays', m).onclick = (e) => { const b = e.target.closest('[data-day]'); if (!b) return; const d = Number(b.dataset.day); if (days.has(d)) days.delete(d); else days.add(d); paint(); };
      $('#dCode', m).oninput = paint;
      paint();
      $('#dOk', m).onclick = async () => {
        const err = $('#dErr', m);
        code = $('#dCode', m).value.trim().toUpperCase();
        const amt = Math.floor(Number($('#dAmt', m).value) || 0);
        if (!D.row(code)) { err.hidden = false; err.textContent = '找不到這一檔 ETF'; return; }
        if (!days.size) { err.hidden = false; err.textContent = '至少選一天'; return; }
        if (amt < DCA.DCA_MIN || amt % 100) { err.hidden = false; err.textContent = '金額要以百元為單位、最低 100 元'; return; }
        let at;
        try { ({ at } = await D.freshForOrder(code)); } catch { err.hidden = false; err.textContent = '連不上網路，申請沒有送出'; fx('reject'); return; }
        const start = DCA.cutover(D.S.cal, R.tw(at).d);
        const plan = { id: ST.newId('p', at), c: code, days: [...days].sort((a, b) => a - b), amt, fee: 1, start, end: null, at };
        db = ST.update((x) => { const rr = x.runs[r.id]; rr.plans = [...(rr.plans || []), plan]; });
        close();
        fx('stamp');
        note(`定期定額申請已送出：${code} 每月 ${plan.days.join('、')} 號 ${N(amt)} 元，${MD(start)} 起生效`);
        renderAll();
      };
    },
  });
}
async function stopPlan(pid) {
  const r = run();
  const p = (r.plans || []).find((x) => x.id === pid);
  if (!p) return;
  const ok = await confirmBox('停扣？', `<p>${p.c} 每月 ${p.days.join('、')} 號 ${N(p.amt)} 元。停扣也是送出後第 2 個交易日才生效，在那之前的扣款照常。</p>`, '送出停扣', true);
  if (!ok) return;
  let at;
  try { ({ at } = await D.freshForOrder(p.c)); } catch { note('連不上網路，停扣沒有送出'); fx('reject'); return; }
  const c = DCA.cutover(D.S.cal, R.tw(at).d);
  db = ST.update((x) => { const pp = (x.runs[r.id].plans || []).find((y) => y.id === pid); if (pp && (!pp.end || pp.end >= c)) { pp.end = R.addDays(c, -1); pp.stopAt = at; } });
  fx('cancel');
  note(`停扣已送出，${MD(c)} 起不再扣款`);
  renderAll();
}

// ------------------------------------------------------------------ 戰報
async function renderReport() {
  const el = $('#pReport');
  const r = run();
  const runs = (db.order || []).map((id) => db.runs[id]).filter(Boolean);
  const archived = runs.filter((x) => x.end).reverse();
  const settingsHTML = settingsBlock();
  if (!r) {
    el.innerHTML = `<div class="dossier"><div class="tab">戰報</div><div class="empty"><span class="brush">還沒開戰</span>開一個模擬帳戶，從現在的真實行情開始</div><button class="btn brass blk" id="goSetup3">開設模擬帳戶</button></div>${archiveHTML(archived)}${settingsHTML}`;
    $('#goSetup3', el).onclick = openSetup;
    bindSettings(el);
    return;
  }
  const Lg = L(r);
  el.innerHTML = `<div class="dossier you"><div class="tab">${esc(r.name)}</div><div class="empty">戰報計算中…</div></div>${archiveHTML(archived)}${settingsHTML}`;
  bindSettings(el);
  // 需要的歷史檔：持有過的每一檔＋0050
  const codes = [...new Set([...(r.fills || []).map((f) => f.code), BENCH])];
  await Promise.all(codes.map((c) => D.ensureHist(c)));
  const h0050 = D.S.hist.get(BENCH);
  const today = R.tw(now()).d;
  let days = h0050 && h0050.d ? h0050.d.filter((d) => d >= r.start.d) : [];
  if (R.isTradingDay(D.S.cal, today) && !days.includes(today) && R.tw(now()).hm >= 900) days = [...days, today];
  if (!days.length) days = [Math.max(r.start.d, today)];
  const series = navSeries(r, mkt(), (c) => D.S.hist.get(c), now(), days);
  const rep = report(r, Lg, series);
  rep.unreal = Lg.holdings.filter((h) => h.sh > 0).reduce((s, h) => s + unrealOf(h, r.fees, Lg.today), 0);   // 和庫存頁一樣，扣掉賣出的手續費與稅
  const elapsed = R.daysBetween(r.start.d, today);
  const restores = (r.restores || []).length;
  const journal = journalHTML(r);
  const html = `
    <div class="dossier you"><div class="tab">${esc(r.name)} <small>開戰第 ${elapsed + 1} 天</small></div>
      <div class="hero"><div class="who">${MD(r.start.d)} ${HMS(r.start.at).slice(0, 5)} 開局 ・ 起始資金 ${N(r.capital)}</div>
        <div class="vs"><div><span>你</span><b class="${cls(rep.ret)}">${RET(rep.ret)}</b></div><div><span>同期間一直抱著 0050（含息）</span><b class="${cls(rep.bench)}">${RET(rep.bench)}</b></div></div>
        <p class="note">${rep.excess == null ? '' : rep.excess >= 0 ? `目前贏 0050 <b class="up">${RET(rep.excess)}</b>。` : `目前輸 0050 <b class="down">${RET(rep.excess)}</b>：什麼都不做、只抱 0050，會比現在好。`}</p>
      </div>
      <div class="chart-wrap" style="height:210px"><canvas id="navCv"></canvas><div class="tip" id="navTip" hidden></div></div>
      ${days.length < 2 ? '<p class="note">開局第一天：之後每個交易日收盤會多一個點，曲線就出來了。</p>' : ''}
      <div class="legend"><span><i></i>你的總資產報酬</span><span><i class="b"></i>0050 含息</span></div>
      ${restores ? `<div class="dossier hazard" style="margin-top:26px"><div class="tab warn">誠信紀錄</div><p class="note">這一局還原過備份 ${restores} 次（最近一次 ${MD(R.tw(r.restores[restores - 1].at).d)}）。還原等於回到過去，成績僅供參考。</p></div>` : ''}
    </div>
    <div class="dossier"><div class="tab">數字</div><div class="stats">
      <div><span>最大回撤</span><b class="${rep.mdd < -1e-6 ? 'down' : ''}">${RET(rep.mdd)}</b></div>
      <div><span>持股比重</span><b>${Math.round(rep.exposure * 100)}%</b></div>
      <div><span>成交筆數</span><b>${rep.fills}</b></div>
      <div><span>賣出勝率</span><b>${rep.winRate == null ? '—' : `${Math.round(rep.winRate * 100)}%（${rep.wins}勝${rep.losses}負）`}</b></div>
      <div><span>已實現</span><b class="${cls(rep.realized)}">${N(rep.realized)}</b></div>
      <div><span>未實現</span><b class="${cls(rep.unreal)}">${N(rep.unreal)}</b></div>
      <div><span>手續費</span><b>${N(rep.fees)}</b></div>
      <div><span>證交稅</span><b>${N(rep.taxes)}</b></div>
      <div><span>配息（淨）</span><b class="up">${N(rep.divs)}</b></div>
      <div><span>周轉率</span><b>${rep.turnover.toFixed(2)} 倍</b></div>
    </div>
    ${rep.best ? `<p class="note">賣得最好：${rep.best.code} ${RET(rep.best.ret)}（${N(rep.best.pnl)}）${rep.worst && rep.worst.pnl < 0 ? `；最痛：${rep.worst.code} ${RET(rep.worst.ret)}（${N(rep.worst.pnl)}）` : ''}</p>` : ''}
    </div>
    ${journal}
    ${archiveHTML(archived)}
    ${settingsHTML}`;
  if (!el.isConnected) return;
  el.innerHTML = html;
  bindSettings(el);
  drawNav($('#navCv', el), series, $('#navTip', el));
  UI.reportCache = { rep, series };
}

function journalHTML(r) {
  const filled = r.orders.filter((o) => r.fills.some((f) => f.oid === o.id)).sort((a, b) => b.at - a.at).slice(0, 30);
  if (!filled.length) return '';
  const rows = filled.map((o) => {
    const fs = r.fills.filter((f) => f.oid === o.id);
    const q = fs.reduce((s, f) => s + f.qty, 0);
    const avg = fs.reduce((s, f) => s + f.amt, 0) / q;
    const h = D.S.hist.get(o.code);
    const after = (n) => {
      if (!h || !h.d) return null;
      const i = h.d.findIndex((d) => d > o.day);
      const j = i < 0 ? -1 : i + n - 1;
      if (i < 0 || j >= h.d.length) return null;
      let px = h.p[j];
      for (const [sd, k] of h.splits || []) if (sd > o.day && sd <= h.d[j]) px *= k;
      return px / avg - 1;
    };
    const a5 = after(5);
    const a20 = after(20);
    const nt = (r.notes || {})[o.id];
    const good = (x) => (x == null ? '' : (o.side === 'B' ? x > 0 : x < 0) ? 'up' : 'down');
    return `<div class="li"><div class="t"><span class="code">${o.code}</span>${E.SIDE_NAME[o.side]} ${SH(q)} @ ${P(avg)}</div>
      <div class="w">${MD(o.day)}</div>
      <div class="s">${nt && nt.t ? `理由：${esc(nt.t)}` : '沒寫理由'}${nt && nt.tags && nt.tags.length ? ` ・ ${nt.tags.map(esc).join('、')}` : ''}</div>
      <div class="w num"><span class="${good(a5)}">5日 ${RET(a5, 1)}</span> ・ <span class="${good(a20)}">20日 ${RET(a20, 1)}</span></div></div>`;
  }).join('');
  return `<div class="dossier"><div class="tab">覆盤 <small>成交後 5／20 個交易日的價格變化</small></div><div class="list">${rows}</div>
    <p class="note">買進後漲、賣出後跌是紅字（做對了）。「沒寫理由」的單最難覆盤，下單時花 5 秒寫一句。</p></div>`;
}

function archiveHTML(list) {
  const logs = db.restores || [];
  const restoreNote = logs.length ? `<p class="note">這支手機還原過備份 ${logs.length} 次（最近一次 ${MD(R.tw(logs[logs.length - 1].at).d)}）。</p>` : '';
  if (!list.length) return restoreNote ? `<div class="dossier"><div class="tab">戰役紀錄</div>${restoreNote}</div>` : '';
  return `<div class="dossier"><div class="tab">戰役紀錄 <small>封存的每一局都留著</small></div><div class="list">${list.map((x) => `<div class="li"><div class="t">${esc(x.name)}${x.end.parked ? ' <small class="warn">還原時捨棄</small>' : ''}</div><div class="v ${cls(x.end.ret)}">${x.end.parked ? '—' : RET(x.end.ret)}</div>
    <div class="s">${MD(x.start.d)}～${x.end.d ? MD(x.end.d) : ''} ・ 起始 ${N(x.capital)} ・ ${x.end.parked ? `${(x.fills || []).length} 筆成交` : `${x.end.fills} 筆成交`}${(x.restores || []).length ? ' ・ 還原過' : ''}</div><div class="w">${x.end.parked ? '' : `0050 ${RET(x.end.bench)}`}</div></div>`).join('')}</div>${restoreNote}</div>`;
}

function settingsBlock() {
  const s = db.settings;
  const f = s.fees;
  return `<div class="dossier"><div class="tab">設定</div>
    <div class="setting"><div class="l"><b>音效</b><small>新行情的聲納、送單、成交、開收盤的鑼</small></div><input class="switch" type="checkbox" data-set="sound" ${s.sound ? 'checked' : ''}></div>
    <div class="setting"><div class="l"><b>震動</b><small>只有 Android 手機有效</small></div><input class="switch" type="checkbox" data-set="haptics" ${s.haptics ? 'checked' : ''}></div>
    <div class="setting"><div class="l"><b>動態效果</b><small>戰術台起伏、雷達掃描、信標、鎖定動畫</small></div><input class="switch" type="checkbox" data-set="fx" ${s.fx !== false ? 'checked' : ''}></div>
    <div class="setting"><div class="l"><b>啟動畫面</b><small>每天第一次打開時先按「啟動戰術台」進場（手機要先點一下才能出聲）；關掉就一律直接進入</small></div><input class="switch" type="checkbox" data-set="ignite" ${s.ignite !== false ? 'checked' : ''}></div>
    <div class="setting"><div class="l"><b>3D 畫質</b><small>手機很燙就調低</small></div><select data-set="quality" class="field" style="margin:0"><option value="auto" ${s.quality === 'auto' ? 'selected' : ''}>自動</option><option value="high" ${s.quality === 'high' ? 'selected' : ''}>高</option><option value="low" ${s.quality === 'low' ? 'selected' : ''}>低</option></select></div>
    <div class="setting"><div class="l"><b>手續費條件</b><small>${Math.round(f.disc * 1000) / 100} 折・整股最低 ${f.min} 元・零股最低 ${f.minOdd} 元・${f.rebate === 'instant' ? '直接折扣' : '日退'}（新開的一局照這個算）</small></div><button class="btn sm" id="feeBtn">修改</button></div>
    <div class="setting"><div class="l"><b>規則說明</b><small>沙盤怎麼判斷成交、哪些地方做不到</small></div><button class="btn sm" id="rulesBtn">打開</button></div>
    <div class="setting"><div class="l"><b>更新紀錄</b><small>最近一次：${UPDATES.length ? `${MD(UPDATES[0].d)} ${esc(UPDATES[0].title)}` : '—'}</small></div><button class="btn sm" id="updBtn">打開</button></div>
    <div class="setting"><div class="l"><b>備份</b><small>只存在這支手機；清除瀏覽器資料會不見，記得定期匯出</small></div><div class="row"><button class="btn sm" id="expBtn">匯出</button><button class="btn sm" id="impBtn">還原</button></div></div>
    <div class="setting"><div class="l"><b>封存這一局、開新的一局</b><small>舊的一局會永遠留在戰役紀錄，不能刪</small></div><button class="btn sm danger" id="endBtn">封存</button></div>
  </div>`;
}
function bindSettings(el) {
  $$('[data-set]', el).forEach((inp) => {
    inp.onchange = () => {
      const k = inp.dataset.set;
      const v = inp.type === 'checkbox' ? inp.checked : inp.value;
      db = ST.update((x) => { x.settings[k] = v; });
      applySettings();
      if (k === 'quality' || k === 'fx') { if (UI.table) { UI.table.dispose(); UI.table = null; } initTable(); }
    };
  });
  const on = (id, fn) => { const b = $(`#${id}`, el); if (b) b.onclick = fn; };
  on('updBtn', () => showUpdates());
  on('rulesBtn', () => modal(`<h2>沙盤的規則</h2><div class="prose">${rulesHTML((run() || db.settings).fees || db.settings.fees)}</div><div class="row" style="justify-content:flex-end"><button class="btn brass" data-close>知道了</button></div>`, { wide: true }));
  on('feeBtn', feeDialog);
  on('expBtn', exportDialog);
  on('impBtn', importDialog);
  on('endBtn', endDialog);
}
function feeDialog() {
  const f = db.settings.fees;
  modal(`<h2>手續費條件</h2><p class="prose">照你在國泰（或其他券商）帳戶的實際條件填。改了只影響之後新開的一局，進行中的這一局維持開局時的條件（真實世界換條件也要重新簽約）。</p>
    <div class="field"><label>折扣（例如 2.8 折填 0.28）</label><input id="fDisc" type="number" step="0.01" min="0.05" max="1" value="${f.disc}"></div>
    <div class="field"><label>整股最低收費（元）</label><input id="fMin" type="number" min="0" value="${f.min}"></div>
    <div class="field"><label>零股最低收費（元）</label><input id="fMinOdd" type="number" min="0" value="${f.minOdd}"></div>
    <div class="field"><label>折扣怎麼退</label><select id="fReb"><option value="daily" ${f.rebate === 'daily' ? 'selected' : ''}>日退（成交先收原價，隔天退差額）</option><option value="instant" ${f.rebate === 'instant' ? 'selected' : ''}>成交時直接折扣</option></select></div>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>取消</button><button class="btn brass" id="fOk">儲存</button></div>`, {
    onMount: (m, close) => {
      $('#fOk', m).onclick = () => {
        const disc = Math.max(0.05, Math.min(1, Number($('#fDisc', m).value) || 1));
        const min = Math.max(0, Math.floor(Number($('#fMin', m).value) || 0));
        const minOdd = Math.max(0, Math.floor(Number($('#fMinOdd', m).value) || 0));
        db = ST.update((x) => { x.settings.fees = { disc, min, minOdd, rebate: $('#fReb', m).value }; });
        close();
        renderReport();
      };
    },
  });
}
async function exportDialog() {
  const code = await ST.exportBackup(now());
  modal(`<h2>匯出備份</h2><p class="prose">把下面這串複製起來存好（例如傳給自己）。換手機或清掉瀏覽器資料後，用「還原」貼回來。</p>
    <textarea class="field" style="width:100%;height:120px;font-size:11px" readonly>${esc(code)}</textarea>
    <div class="row" style="justify-content:flex-end"><button class="btn" id="dl">存成檔案</button><button class="btn brass" id="cp">複製</button></div>`, {
    onMount: (m) => {
      $('#cp', m).onclick = async () => { try { await navigator.clipboard.writeText(code); note('已複製備份碼'); } catch { $('textarea', m).select(); } };
      $('#dl', m).onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
        a.download = `沙盤備份-${R.tw(now()).d}.txt`;
        a.click();
      };
    },
  });
}
function importDialog() {
  modal(`<h2>還原備份</h2><div class="dossier hazard" style="margin-top:26px"><div class="tab warn">注意</div><p class="note">還原是把備份「合併」進這支手機：手機上已經有的委託、成交一筆都不會少（同一局取兩邊的聯集），手機上沒有的局整局加進來。進行中的局只能有一個：手機上本來進行中的那一局優先，備份帶進來的其他進行中的局會封存起來。每次還原都會留下紀錄，戰報上一直看得到。</p></div>
    <textarea id="impT" class="field" style="width:100%;height:110px;font-size:11px" placeholder="貼上備份碼"></textarea>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>取消</button><button class="btn danger" id="impOk">還原</button></div>`, {
    onMount: (m, close) => {
      $('#impOk', m).onclick = async () => {
        if (!D.hasServerTime()) { note('連不上網路：還原要記下伺服器時間，請連上網路再試'); return; }
        try {
          const { log } = await ST.importBackup($('#impT', m).value, now());
          close();
          note(`已還原：加進 ${log.added.length} 局、合併 ${log.merged.length} 局${log.parked.length ? `、封存 ${log.parked.length} 局` : ''}`);
          setTimeout(() => location.reload(), 900);
        } catch (e) { $('#impT', m).style.borderColor = 'var(--up)'; note(esc(e.message || '還原失敗')); }
      };
    },
  });
}
async function endDialog() {
  if (!run()) return;
  // 封存不能拿來躲成交：還沒結束的委託要先刪單、等交易所確認（如果那之前已經成交，成交算數），或等撮合結果
  if (!D.serverOk()) { note('連上網路才能封存：要先用最新的行情把還沒結束的委託算完'); fx('reject'); return; }
  await settle(true);
  const r = run();
  const open = r.orders.filter((o) => ['wait', 'queued', 'live', 'part', 'cancelling'].includes(E.orderStatus(r, o).st));
  if (open.length) {
    // 那個時段已經撮合完的（整股、盤中零股 13:30；盤後 14:30）不能再刪，只能等結果
    const can = open.filter((o) => ['wait', 'queued', 'live', 'part'].includes(E.orderStatus(r, o).st) && now() < R.atTW(o.day, o.sess === 'fix' || o.sess === 'oddpm' ? 1430 : 1330));
    const go = await confirmBox('還有委託沒有結束', `<p>還有 ${open.length} 筆委託沒有結束，封存之前要先讓它們結束：刪單要等下一筆行情確認（如果那之前價格已經穿過你的委託價，成交算數），已經撮合的要等結果出來。</p>${can.length ? `<p>要現在把 ${can.length} 筆全部送出刪單嗎？確認之後再回來封存。</p>` : '<p>剩下的都在等確認或撮合結果，稍後再回來封存。</p>'}`, can.length ? '全部刪單' : '知道了', !!can.length);
    if (go && can.length) for (const o of can) await modOrder(o, 'cancel');
    return;
  }
  const ok = await confirmBox('封存這一局？', `<p>${esc(r.name)} 會結算目前的總資產、和 0050 的比較，永遠留在戰役紀錄裡（不能刪、不能再交易）。</p><p>之後可以馬上開新的一局，從那一刻的真實行情開始。</p>`, '封存', true);
  if (!ok) return;
  await renderReport();
  const rep = UI.reportCache ? UI.reportCache.rep : null;
  const Lg = L(r);
  let ended = false;
  db = ST.update((x) => {
    ended = ST.endRun(x, r.id, { at: now(), d: R.tw(now()).d, equity: Lg.equity, ret: Lg.equity / r.capital - 1, bench: rep ? rep.bench : null, fills: r.fills.length, mdd: rep ? rep.mdd : null });
  });
  // 剛好另一個分頁又送了一筆委託：先不封存
  if (!ended) { note('還有委託沒有結束，這一局先不封存'); fx('reject'); renderAll(); return; }
  fx('stamp');
  renderAll();
  updateTable(false);
  openSetup();
}

// ------------------------------------------------------------------ 開局
function openSetup() {
  const caps = [100000, 300000, 500000, 1000000, 3000000, 10000000];
  let cap = 1000000;
  const no = Object.keys(db.runs).length + 1;
  const f = db.settings.fees;
  modal(`<div class="setup"><h2>開設模擬帳戶（第 ${no} 局）</h2>
    <p class="prose">從<b>按下開戶的這一刻</b>開始，跟著真實行情往前走，不能回到過去、也不能重來；想重來只能封存這一局、開新的一局。</p>
    <div class="field"><label>起始資金（假的錢，交割帳戶裡的現金）</label></div>
    <div class="caps">${caps.map((c) => `<button data-cap="${c}" aria-pressed="${c === cap}">${c >= 10000 ? `${c / 10000} 萬` : N(c)}</button>`).join('')}</div>
    <div class="field"><label>或自己填（元）</label><input id="capIn" type="number" inputmode="numeric" min="10000" step="10000" placeholder="例如 250000"></div>
    <p class="note">手續費照國泰證券電子下單：${Math.round(f.disc * 1000) / 100} 折、${f.rebate === 'instant' ? '直接折扣' : '日退'}、整股最低 ${f.min} 元、零股最低 ${f.minOdd} 元（設定裡可以改成你自己的條件）。</p>
    <div class="err" id="setupErr" hidden></div>
    <button class="btn brass blk" id="openBtn" style="margin-top:12px;min-height:52px;font-size:17px">開戶，開始</button>
    ${run() ? '' : '<button class="btn ghost blk" data-close style="margin-top:6px">先看看就好</button>'}</div>`, {
    onMount: (m, close) => {
      m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cap]');
        if (!b) return;
        cap = Number(b.dataset.cap);
        $('#capIn', m).value = '';
        $$('[data-cap]', m).forEach((x) => x.setAttribute('aria-pressed', x === b));
        play('tap');
      });
      $('#openBtn', m).onclick = async () => {
        const custom = Number($('#capIn', m).value);
        const capital = custom >= 10000 ? Math.floor(custom) : cap;
        const err = $('#setupErr', m);
        const btn = $('#openBtn', m);
        btn.disabled = true;
        btn.textContent = '連線中…';
        try {
          const { at } = await D.freshForOrder(BENCH);
          await D.refresh(true);
          const bench = D.lastPx(BENCH);
          db = ST.update((x) => { if (!ST.curRun(x)) ST.newRun(x, { capital, at, d: R.tw(at).d, bench, fees: x.settings.fees }); });
          close();
          fx('stamp');
          note(`開戶完成：${N(capital)} 元，${HMS(at)} 開局`);
          renderAll();
          updateTable(false);
        } catch (e) {
          err.hidden = false;
          err.textContent = '連不上網路，沒辦法拿到伺服器時間。開局需要連網（跟真的開戶一樣），請確認網路後再試一次。';
          btn.disabled = false;
          btn.textContent = '開戶，開始';
          fx('reject');
        }
      };
    },
  });
}

// ------------------------------------------------------------------ 下單匣
const TAGS = ['紀律加碼', '逢低布局', '突破追價', '停利', '停損', '調整比重', '要用錢', '試單'];

function openTicket(code, side) {
  const r = run();
  if (!r) { openSetup(); return; }
  const row0 = D.row(code);
  if (!row0) return;
  const lastPx = D.lastPx(code) || row0.p;
  const st = { code, side, kind: 'lot', type: 'L', tif: 'ROD', px: lastPx, qty: 1000, tags: [], note: '' };
  // 賣出時預設數量＝可賣
  if (side === 'S') {
    const Lg = L(r);
    const can = E.sellable(Lg, code, daytradeOk(r, Lg), 'reg');
    const canOdd = E.sellable(Lg, code, daytradeOk(r, Lg), 'odd');
    if (can < 1000 && canOdd > 0) { st.kind = 'odd'; st.qty = Math.min(999, canOdd); } else if (can >= 1000) st.qty = 1000;
  }
  const host = $('#sheetHost');
  host.innerHTML = '<div class="sheet-bg"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="下單"></div>';
  const bg = host.firstElementChild;
  const sh = host.lastElementChild;
  const close = () => { host.innerHTML = ''; clearInterval(timer); };
  bg.onclick = close;
  const timer = setInterval(() => { if (!sh.isConnected) return; paint(false); }, 5000);

  function ctx() {
    const t = now();
    const win = R.orderWindow(D.S.cal, t, st.kind);
    const q = D.quoteOf(code);
    const qo = D.quoteOf(code, 'odd');
    const lim = R.limitsOf(q);
    const today = R.tw(t).d;
    const sameDay = win && !win.blocked && win.day === today && q && q.d === today;
    return { t, win, q, qo, lim, today, sameDay };
  }
  function check() {
    const r1 = run();
    const Lg = L(r1);
    const c = ctx();
    const errs = [];
    const w = c.win;
    if (!w || w.blocked) return { errs: [w ? w.why : '現在不能下單'], c, Lg };
    if (!w.types.includes(st.type === 'C' ? 'C' : st.type)) {
      if (w.sess === 'fix') st.type = 'C'; else st.type = 'L';
    }
    if (st.type === 'M' && !D.hasLimits(code)) st.type = 'L';
    if (!w.tifs.includes(st.tif)) st.tif = 'ROD';
    if ((w.sess === 'fix' || w.sess === 'oddpm') && row0.m === 'otc') errs.push(OTC_AFTER);
    if (w.sess === 'fix') {
      st.type = 'C';
      const close = c.q && c.q.d === c.today ? c.q.z : null;
      st.px = close;
      if (!isNum(close)) errs.push('今天的收盤價還沒確定（或今天沒有成交），不能下盤後定價');
    }
    const qtyOk = R.qtyOk(w.sess, st.qty);
    if (!qtyOk) errs.push(w.sess === 'reg' || w.sess === 'fix' ? '整股要以「張」為單位（1 張＝1000 股）' : '零股一次 1～999 股');
    if ((w.sess === 'reg' || w.sess === 'fix') && st.qty > 499000) errs.push('整股一筆最多 499 張');
    if (st.type === 'L') {
      if (!isNum(st.px) || st.px <= 0) errs.push('請輸入價格');
      else if (!R.onTick(st.px)) errs.push(`價格要符合升降單位：${st.px >= 50 ? '50 元以上每檔 0.05' : '未滿 50 元每檔 0.01'}`);
      else if (c.sameDay && ((c.lim.up && st.px > c.lim.up + 1e-9) || (c.lim.down && st.px < c.lim.down - 1e-9))) errs.push(`超出今天的漲跌停（${P(c.lim.down)}～${P(c.lim.up)}）`);
    }
    // 金額
    const odd = w.sess === 'odd' || w.sess === 'oddpm';
    const refPx = st.type === 'M' ? (st.side === 'B' ? (c.lim.up || (c.q && c.q.z ? R.snapTick(c.q.z * 1.1, 1) : lastPx * 1.1)) : (c.q && c.q.z) || lastPx) : st.px;
    const amt = R.amountOf(st.qty, refPx || 0);
    const fee = R.feeCharged(amt, odd, r1.fees);
    const fin = R.feeFinal(amt, odd, r1.fees);
    const tax = st.side === 'S' ? R.taxOf(amt, R.taxRate(code, row0.k, w.day)) : 0;
    const total = st.side === 'B' ? amt + fee : amt - fee - tax;
    const dtOk = daytradeOk(r1, Lg);
    if (st.side === 'B') {
      if (amt + fee > Lg.avail) errs.push(`可用額度不足：需要 ${N(amt + fee)}，可用 ${N(Lg.avail)}`);
    } else {
      const can = E.sellable(Lg, code, dtOk, w.sess);
      const h = Lg.holdings.find((x) => x.code === code);
      if (st.qty > can) {
        if (h && h.todayBuy && st.qty <= h.sh - h.locked) errs.push(sellWhy(h, dtOk, w.sess));
        else errs.push(`可賣 ${SH(can)}`);
      }
    }
    return { errs, c, Lg, amt, fee, fin, tax, total, refPx, odd, dtOk };
  }
  function paint(full = true) {
    const k = check();
    const w = k.c.win;
    const q = k.c.q;
    const name = row0.n;
    const ch = D.changeOf(code);
    const unit = st.kind === 'lot' ? 1000 : 1;
    const qtyShown = st.kind === 'lot' ? st.qty / 1000 : st.qty;
    const settleD = w && !w.blocked ? R.settleDay(D.S.cal, w.day, 2) : null;
    const b1 = q && q.b && q.b[0] ? q.b[0][0] : null;
    const a1 = q && q.a && q.a[0] ? q.a[0][0] : null;
    if (!full && sh.querySelector('#tCost')) {
      // 只更新會變的部分（行情、額度、錯誤）
      $('#tSess', sh).innerHTML = sessHTML(w);
      $('#tCost', sh).innerHTML = costHTML(k, settleD);
      $('#tErr', sh).innerHTML = errHTML(k);
      $('#hold', sh).disabled = !!k.errs.length;
      return;
    }
    sh.innerHTML = `<div class="grab"></div>
      <div class="row sp"><h2>${code} <span style="font-size:15px;font-weight:500;color:var(--text-2)">${esc(name)}</span></h2><button class="btn sm ghost" id="tClose">關閉</button></div>
      <div class="num ${cls(ch.ch)}" style="font-size:15px">${P(ch.px)} ${PCT(ch.pct)}${b1 || a1 ? ` <span class="dim">買一 ${P(b1)}／賣一 ${P(a1)}</span>` : ''}</div>
      <div class="ticket-side"><button class="B" data-side="B" aria-pressed="${st.side === 'B'}">買 進</button><button class="S" data-side="S" aria-pressed="${st.side === 'S'}">賣 出</button></div>
      <div class="row sp"><div class="seg"><button data-kind="lot" aria-pressed="${st.kind === 'lot'}">整股</button><button data-kind="odd" aria-pressed="${st.kind === 'odd'}">零股</button></div>
        <div class="seg">${['L', 'M'].map((t) => `<button data-type="${t}" aria-pressed="${st.type === t}" ${w && !w.blocked && w.types.includes(t) && (t !== 'M' || D.hasLimits(code)) ? '' : 'disabled'}>${E.TYPE_NAME[t]}</button>`).join('')}</div>
        <div class="seg">${['ROD', 'IOC', 'FOK'].map((t) => `<button data-tif="${t}" aria-pressed="${st.tif === t}" ${w && !w.blocked && w.tifs.includes(t) ? '' : 'disabled'}>${t}</button>`).join('')}</div></div>
      <div id="tSess">${sessHTML(w)}</div>
      <div class="field"><label>價格 ${st.type === 'M' ? '（市價：有人賣就買）' : st.type === 'C' ? '（盤後定價：今天收盤價）' : ''}</label>
        <div class="stepper"><button data-px="-1" ${st.type !== 'L' ? 'disabled' : ''}>−</button><input id="tPx" inputmode="decimal" value="${st.type === 'L' ? P(st.px) : st.type === 'C' ? P(st.px) : '市價'}" ${st.type !== 'L' ? 'disabled' : ''}><button data-px="1" ${st.type !== 'L' ? 'disabled' : ''}>＋</button></div>
        ${st.type === 'L' ? `<div class="quick">${[['跌停', k.c.lim.down], ['買一', b1], ['平盤', ch.ref], ['成交', ch.px], ['賣一', a1], ['漲停', k.c.lim.up]].filter((x) => isNum(x[1])).map(([l, v]) => `<button data-setpx="${v}">${l} ${P(v)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="field"><label>數量（${st.kind === 'lot' ? '張' : '股'}）</label>
        <div class="stepper"><button data-q="-1">−</button><input id="tQty" inputmode="numeric" value="${qtyShown}"><button data-q="1">＋</button></div>
        <div class="quick">${st.kind === 'lot' ? [1, 2, 5, 10].map((n) => `<button data-setq="${n}">${n} 張</button>`).join('') : [10, 50, 100, 500].map((n) => `<button data-setq="${n}">${n} 股</button>`).join('')}<button data-max="1">${st.side === 'B' ? '最多可買' : '全部可賣'}</button></div>
      </div>
      <div id="tCost">${costHTML(k, settleD)}</div>
      <div class="field"><label>為什麼這樣下？（覆盤用，可以不寫）</label>
        <div class="quick">${TAGS.map((t) => `<button data-tag="${t}" style="${st.tags.includes(t) ? 'border-color:var(--gold);color:var(--gold-hi)' : ''}">${t}</button>`).join('')}</div>
        <input id="tNote" maxlength="80" placeholder="一句話就好" value="${esc(st.note)}" style="margin-top:6px">
      </div>
      <div id="tErr">${errHTML(k)}</div>
      <button class="hold ${st.side}" id="hold" ${k.errs.length ? 'disabled' : ''}><span class="fillbar"></span><span class="lab">${st.side === 'B' ? '長按送出買單' : '長按送出賣單'}</span></button>
      <p class="note" style="text-align:center">送出時會先連網取得伺服器時間；盤中委託在下一筆行情（約 5 分鐘內）到達交易所撮合。${D.hasLimits(code) ? '' : '<br>這檔沒有漲跌幅限制（國外成分），證交所不接受市價單。'}<br>看不懂？${termHTML('ROD')}、${termHTML('IOC')}、${termHTML('FOK')}、${termHTML('五檔')}</p>`;
    bind();
  }
  function sessHTML(w) {
    if (!w) return '';
    if (w.blocked) return `<div class="dossier hazard" style="margin:24px 0 8px"><div class="tab warn">現在不能下這種單</div><p class="note">${esc(w.why)}</p></div>`;
    const dayTxt = w.day !== R.tw(now()).d ? `${MD(w.day)}（${WD(w.day)}）` : '今天';
    return `<p class="note"><b>${R.SESS_NAME[w.sess]}</b> ・ ${dayTxt} ・ ${esc(w.note)}</p>`;
  }
  function costHTML(k, settleD) {
    if (!isNum(k.amt)) return '';
    const fee = k.fee || 0;
    return `<div class="cost">
      <div><span>${st.type === 'M' ? (st.side === 'B' ? '圈存價金（用漲停價估）' : '預估價金') : '價金'}</span><b>${N(k.amt)}</b></div>
      <div><span>手續費${fee !== k.fin ? `（隔天退 ${N(fee - k.fin)}）` : ''}</span><b>${N(fee)}</b></div>
      ${st.side === 'S' ? `<div><span>證交稅</span><b>${N(k.tax)}</b></div>` : ''}
      <div class="tot"><span>${st.side === 'B' ? '交割要付' : '交割可收'}${settleD ? `（${MD(settleD)} ${WD(settleD)}）` : ''}</span><b>${N(k.total)}</b></div>
      <div><span>${st.side === 'B' ? '可用額度' : '可賣'}</span><b class="you">${st.side === 'B' ? N(k.Lg.avail) : SH(E.sellable(k.Lg, code, k.dtOk, k.c.win && !k.c.win.blocked ? k.c.win.sess : 'reg'))}</b></div>
    </div>`;
  }
  function errHTML(k) {
    if (k.c.win && k.c.win.blocked) return '';   // 上面的琥珀框已經說明了
    return k.errs.length ? `<div class="err">${k.errs.map(esc).join('<br>')}</div>` : '';
  }
  function bind() {
    $('#tClose', sh).onclick = close;
    sh.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.id === 'hold') return;
      if (b.dataset.side) { st.side = b.dataset.side; play('tap'); paint(); }
      else if (b.dataset.kind) { st.kind = b.dataset.kind; st.qty = st.kind === 'lot' ? 1000 : Math.min(999, Math.max(1, st.qty % 1000 || 100)); paint(); }
      else if (b.dataset.type) { st.type = b.dataset.type; if (st.type === 'M') st.tif = st.tif === 'ROD' ? 'ROD' : st.tif; paint(); }
      else if (b.dataset.tif) { st.tif = b.dataset.tif; paint(); }
      else if (b.dataset.px) { st.px = Number(b.dataset.px) > 0 ? R.tickUp(st.px) : R.tickDown(st.px); play('tap'); paint(); }
      else if (b.dataset.setpx) { st.px = Number(b.dataset.setpx); play('tap'); paint(); }
      else if (b.dataset.q) { const u = st.kind === 'lot' ? 1000 : 1; st.qty = Math.max(u, st.qty + Number(b.dataset.q) * u); if (st.kind === 'odd') st.qty = Math.min(999, st.qty); play('tap'); paint(); }
      else if (b.dataset.setq) { st.qty = Number(b.dataset.setq) * (st.kind === 'lot' ? 1000 : 1); paint(); }
      else if (b.dataset.max) {
        const k = check();
        const u = st.kind === 'lot' ? 1000 : 1;
        if (st.side === 'S') {
          const can = E.sellable(k.Lg, code, k.dtOk, k.c.win && !k.c.win.blocked ? k.c.win.sess : 'reg');
          st.qty = st.kind === 'lot' ? Math.max(1000, Math.floor(can / 1000) * 1000) : Math.max(1, Math.min(999, can % 1000 || can));
        } else {
          const px = k.refPx || lastPx;
          let n = Math.floor(k.Lg.avail / (px * (1 + R.FEE_RATE)) / u) * u;
          if (st.kind === 'odd') n = Math.min(999, n);
          st.qty = Math.max(u, n);
        }
        paint();
      } else if (b.dataset.tag) {
        const t = b.dataset.tag;
        st.tags = st.tags.includes(t) ? st.tags.filter((x) => x !== t) : [...st.tags, t];
        paint();
      }
    };
    const px = $('#tPx', sh);
    if (px && !px.disabled) px.onchange = () => { st.px = R.r2(Number(px.value)); paint(); };
    const qi = $('#tQty', sh);
    qi.onchange = () => { const v = Math.floor(Number(qi.value) || 0); st.qty = st.kind === 'lot' ? v * 1000 : v; paint(); };
    $('#tNote', sh).oninput = (e) => { st.note = e.target.value; };
    // 長按送出：按住 0.7 秒
    const hold = $('#hold', sh);
    const bar = $('.fillbar', hold);
    let t0 = 0;
    let raf = 0;
    const stop = () => { cancelAnimationFrame(raf); raf = 0; bar.style.width = '0'; };
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 700);
      bar.style.width = `${p * 100}%`;
      if (p >= 1) { stop(); submit(); return; }
      raf = requestAnimationFrame(step);
    };
    hold.onpointerdown = (e) => { if (hold.disabled) return; e.preventDefault(); unlock(); t0 = performance.now(); raf = requestAnimationFrame(step); fx('tap'); };
    hold.onpointerup = stop;
    hold.onpointerleave = stop;
    hold.onpointercancel = stop;
    hold.onkeydown = (e) => { if (e.key === 'Enter' && !hold.disabled) submit(); };
  }
  async function submit() {
    const hold = $('#hold', sh);
    hold.disabled = true;
    $('.lab', hold).textContent = '連線交易所…';
    const ok = await placeOrder({ ...st }, {});
    if (ok) close();
    else { paint(); }
  }
  paint();
  sh.querySelector('#tQty').blur();
}

/** 送單當下看得到的價格（之後判斷「是不是一送出就能成交的單」） */
function refOf(code, q) {
  const qo = D.quoteOf(code, 'odd');
  const p1 = (x, side) => (x && x[side] && x[side][0] ? x[side][0][0] : null);
  return { z: q ? q.z : null, a1: p1(q, 'a'), b1: p1(q, 'b'), oa1: p1(qo, 'a'), ob1: p1(qo, 'b'), qAt: D.S.quotes ? D.S.quotes.at : null };
}

/** 真正送單：拿伺服器時間、用最新的行情和帳戶再檢查一次、存起來 */
async function placeOrder(st, opt) {
  let at;
  let q;
  try { ({ at, q } = await D.freshForOrder(st.code)); } catch {
    note('連不上網路，委託沒有送出（跟真的一樣，沒網路不能下單）');
    fx('reject');
    return false;
  }
  await settle(true);
  const r = run();
  if (!r) return false;
  const reject = (msg) => { note(esc(msg)); fx('reject'); return false; };
  const w = R.orderWindow(D.S.cal, at, st.kind);
  if (!w || w.blocked) return reject(w ? w.why : '現在不能下單');
  const today = R.tw(at).d;
  const lim = R.limitsOf(q);
  const row0 = D.row(st.code) || {};
  let type = st.type;
  const tif = st.tif;
  if (w.sess === 'fix') type = 'C';
  else if (!w.types.includes(type)) return reject(`現在（${R.PHASE_NAME[w.phase]}）只能下限價 ROD`);
  // 送出那一刻的時段不接受這種委託條件：照實退回，不會偷偷改成 ROD
  if (!w.tifs.includes(tif)) return reject(`現在（${R.PHASE_NAME[w.phase]}）只接受 ${w.tifs.join('／')}，你的 ${tif} 沒有送出`);
  if (type === 'M' && !D.hasLimits(st.code)) return reject('這檔沒有漲跌幅限制（國外成分 ETF），證交所不接受市價單');
  if ((w.sess === 'fix' || w.sess === 'oddpm') && row0.m === 'otc') return reject(OTC_AFTER);
  let px = type === 'M' ? null : st.px;
  if (type === 'C') {
    px = q && q.d === today ? q.z : null;
    if (!isNum(px)) return reject('今天的收盤價還沒確定，不能下盤後定價');
  }
  if (!R.qtyOk(w.sess, st.qty)) return reject('數量不對');
  if ((w.sess === 'reg' || w.sess === 'fix') && st.qty > 499000) return reject('整股一筆最多 499 張');
  if (type === 'L') {
    if (!R.onTick(px)) return reject('價格不符合升降單位');
    if (w.day === today && q && q.d === today && ((lim.up && px > lim.up + 1e-9) || (lim.down && px < lim.down - 1e-9))) return reject('超出今天的漲跌停');
  }
  const resPx = type === 'M' ? (st.side === 'B' ? (lim.up || R.snapTick((q && q.z ? q.z : D.lastPx(st.code)) * 1.2, 1)) : null) : null;
  const order = {
    id: ST.newId('o', at), at, code: st.code, side: st.side, sess: w.sess, type, tif, px, qty: st.qty, day: w.day, phase: w.phase,
    resPx, ref: refOf(st.code, q),
    prev: st.prev || null,
  };
  // 槓桿／反向 ETF：第一次買要先看風險預告書（真實世界要簽）
  const cat = row0.k;
  if (st.side === 'B' && (cat === 'lev' || cat === 'inv') && !(r.signed || {}).lev) {
    const ok = await confirmBox('槓桿／反向 ETF 風險預告書', `<ul><li>槓桿、反向 ETF 追蹤的是「每天」的倍數報酬，持有超過一天，報酬不會剛好是指數的幾倍，盤整時會一直耗損。</li><li>適合短線操作，不適合長期存股。</li><li>真實世界第一次買要符合適格性條件並簽署風險預告書。</li></ul>`, '我了解，簽署');
    if (!ok) return false;
    db = ST.update((x) => { if (x.runs[r.id]) x.runs[r.id].signed = { ...(x.runs[r.id].signed || {}), lev: at }; });
  }
  // 最後一關：在鎖裡面用存檔裡最新的帳戶再檢查一次額度、可賣股數（另一個分頁可能剛下過單）
  let err = null;
  await ST.withLock(() => {
    db = ST.update((x) => {
      const rr = ST.curRun(x);
      if (!rr || rr.id !== r.id) { err = '這一局已經結束'; return false; }
      const Lg = E.ledger(rr, mkt(), now());
      if (st.side === 'B') {
        const need = E.reserveOf(order, st.qty, rr.fees);
        if (need > Lg.avail) { err = `可用額度不足：需要 ${N(need)}，可用 ${N(Lg.avail)}`; return false; }
      } else {
        const can = E.sellable(Lg, st.code, daytradeOk(rr, Lg), w.sess);
        if (st.qty > can) {
          const h = Lg.holdings.find((y) => y.code === st.code);
          err = h && h.todayBuy && st.qty <= h.sh - h.locked ? sellWhy(h, daytradeOk(rr, Lg), w.sess) : `可賣只有 ${SH(can)}`;
          return false;
        }
      }
      rr.orders.push(order);
      if (st.note || (st.tags && st.tags.length)) rr.notes[order.id] = { t: st.note || '', tags: st.tags || [] };
      return undefined;
    });
  });
  if (err) return reject(err);
  fx('send');
  if (UI.table && UI.table.ping) UI.table.ping(order.code, 'you');
  toast(`<div class="slip"><span class="stamp ${w.phase === 'reserve' ? 'queued' : 'wait'} new">${w.phase === 'reserve' ? '預約' : '已送出'}</span><div class="h"><span class="side ${order.side}">${E.SIDE_NAME[order.side]}</span><span class="code">${order.code}</span></div><div class="d">${orderLine(order)}</div><div class="m">伺服器時間 ${HMS(at)} ${w.phase === 'continuous' ? '・ 下一筆行情到達交易所' : `・ ${esc(w.note)}`}</div></div>`, 4600);
  await settle();
  renderAll();
  updateTable(false);
  return true;
}

main();
