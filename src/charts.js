/* 沙盤 — 圖表（canvas）：分時走勢、日 K、戰報淨值曲線。全部可以用手指或滑鼠移動看數字。 */
import { atTW } from './rules.js';

const COL = {
  ink: '#ece2cc', dim: 'rgba(236,226,204,0.55)', faint: 'rgba(236,226,204,0.12)', grid: 'rgba(205,184,143,0.09)',
  up: '#ff4a55', down: '#1fbf86', brass: '#d9a441', blue: '#4f86ff', sand: '#cdb88f', bg: '#151a13',
};
const NUM = '600 11px "Barlow Condensed", "Noto Sans TC", sans-serif';

function setup(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.round(r.width));
  const h = Math.max(10, Math.round(r.height));
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/** 讓圖可以用手指／滑鼠查看：回傳要畫十字線的 x（或 null） */
function crosshair(cv, onMove) {
  const handler = (e) => {
    const r = cv.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    onMove(Math.max(0, Math.min(r.width, x)));
  };
  cv.onpointermove = (e) => { if (e.pointerType === 'mouse' || e.buttons) handler(e); };
  cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); handler(e); };
  cv.onpointerleave = () => onMove(null);
  cv.onpointerup = (e) => { if (e.pointerType !== 'mouse') setTimeout(() => onMove(null), 1600); };
}

// ------------------------------------------------------------------ 分時
/**
 * ticks：[{t(ms), z, v(累計股)}]；ref 昨收；up/down 漲跌停；d 日期；live 目前價（最後補一點）
 */
export function drawIntraday(cv, { ticks = [], ref, up, down, d, nowMs }, tipEl) {
  const pts = ticks.filter((x) => x.z > 0);
  const t0 = atTW(d, 900);
  const t1 = atTW(d, 1330);
  let hover = null;
  function render() {
    const { g, w, h } = setup(cv);
    const padL = 6; const padR = 46; const padT = 10; const volH = Math.round(h * 0.2); const padB = 18;
    const ph = h - padT - padB - volH - 6;
    const pw = w - padL - padR;
    const prices = pts.map((x) => x.z);
    if (ref) prices.push(ref);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    if (!Number.isFinite(lo)) { lo = (ref || 1) * 0.99; hi = (ref || 1) * 1.01; }
    const padP = Math.max((hi - lo) * 0.12, (ref || hi) * 0.002);
    lo -= padP; hi += padP;
    // 以昨收為中心對稱（看得出漲跌幅）
    if (ref) { const m = Math.max(hi - ref, ref - lo); lo = ref - m; hi = ref + m; }
    const X = (t) => padL + ((t - t0) / (t1 - t0)) * pw;
    const Y = (p) => padT + (1 - (p - lo) / (hi - lo)) * ph;
    // 格線與價位
    g.font = NUM;
    g.textBaseline = 'middle';
    for (const v of niceTicks(lo, hi, 4)) {
      g.strokeStyle = COL.grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(padL + pw, Y(v)); g.stroke();
      g.fillStyle = ref && v > ref + 1e-9 ? COL.up : ref && v < ref - 1e-9 ? COL.down : COL.dim;
      g.textAlign = 'left';
      g.fillText(fmt(v, v >= 50 ? 2 : 2), padL + pw + 6, Y(v));
    }
    for (const hm of [1000, 1100, 1200, 1300]) {
      const x = X(atTW(d, hm));
      g.strokeStyle = COL.grid;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + ph + 6 + volH); g.stroke();
      g.fillStyle = COL.dim; g.textAlign = 'center';
      g.fillText(`${hm / 100}:00`, x, h - 8);
    }
    if (ref) {
      g.setLineDash([4, 4]); g.strokeStyle = 'rgba(236,226,204,0.4)';
      g.beginPath(); g.moveTo(padL, Y(ref)); g.lineTo(padL + pw, Y(ref)); g.stroke(); g.setLineDash([]);
    }
    for (const [v, c] of [[up, COL.up], [down, COL.down]]) {
      if (v && v <= hi && v >= lo) { g.strokeStyle = c; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(padL + pw, Y(v)); g.stroke(); g.globalAlpha = 1; }
    }
    if (!pts.length) {
      g.fillStyle = COL.dim; g.textAlign = 'center'; g.font = '500 13px "Noto Sans TC", sans-serif';
      g.fillText('今天還沒有成交', padL + pw / 2, padT + ph / 2);
      return;
    }
    // 量
    let maxV = 1;
    const vols = pts.map((x, i) => Math.max(0, (x.v || 0) - (i ? pts[i - 1].v || 0 : 0)));
    for (const v of vols) maxV = Math.max(maxV, v);
    const bw = Math.max(1.5, pw / 66 - 1);
    pts.forEach((x, i) => {
      const vh = (vols[i] / maxV) * volH;
      g.fillStyle = i && x.z < pts[i - 1].z ? 'rgba(31,191,134,0.55)' : 'rgba(255,74,85,0.55)';
      g.fillRect(X(x.t) - bw / 2, padT + ph + 6 + volH - vh, bw, vh);
    });
    // 價格線＋填色
    const last = pts[pts.length - 1];
    const lineC = ref && last.z >= ref ? COL.up : COL.down;
    g.beginPath();
    pts.forEach((x, i) => (i ? g.lineTo(X(x.t), Y(x.z)) : g.moveTo(X(x.t), Y(x.z))));
    g.strokeStyle = lineC; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    const grd = g.createLinearGradient(0, padT, 0, padT + ph);
    grd.addColorStop(0, lineC === COL.up ? 'rgba(255,74,85,0.22)' : 'rgba(31,191,134,0.22)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.lineTo(X(last.t), padT + ph); g.lineTo(X(pts[0].t), padT + ph); g.closePath();
    g.fillStyle = grd; g.fill();
    g.beginPath(); g.arc(X(last.t), Y(last.z), 3.5, 0, Math.PI * 2); g.fillStyle = lineC; g.fill();
    // 十字線
    if (hover != null) {
      let best = pts[0];
      for (const x of pts) if (Math.abs(X(x.t) - hover) < Math.abs(X(best.t) - hover)) best = x;
      const bx = X(best.t);
      g.strokeStyle = 'rgba(236,226,204,0.5)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(bx, padT); g.lineTo(bx, padT + ph + 6 + volH); g.stroke();
      g.beginPath(); g.arc(bx, Y(best.z), 4, 0, Math.PI * 2); g.fillStyle = COL.ink; g.fill();
      if (tipEl) {
        const tt = new Date(best.t + 8 * 3600e3);
        const hh = `${String(tt.getUTCHours()).padStart(2, '0')}:${String(tt.getUTCMinutes()).padStart(2, '0')}`;
        const i = pts.indexOf(best);
        tipEl.innerHTML = `<b>${hh}</b> ${fmt(best.z)}${ref ? ` <em class="${best.z >= ref ? 'up' : 'down'}">${((best.z / ref - 1) * 100).toFixed(2)}%</em>` : ''} <span>量 ${Math.round(vols[i] / 1000).toLocaleString()} 張</span>`;
        tipEl.hidden = false;
      }
    } else if (tipEl) tipEl.hidden = true;
  }
  crosshair(cv, (x) => { hover = x; render(); });
  render();
  return render;
}

// ------------------------------------------------------------------ 日 K
/** bars：[{d,o,h,l,c,v}]（已經做好分割調整） */
export function drawK(cv, bars, tipEl) {
  let n = Math.min(bars.length, 70);
  let end = bars.length;
  let hover = null;
  const ma = (k) => bars.map((_, i) => (i + 1 >= k ? bars.slice(i + 1 - k, i + 1).reduce((s, b) => s + b.c, 0) / k : null));
  const m5 = ma(5); const m20 = ma(20); const m60 = ma(60);
  function render() {
    const { g, w, h } = setup(cv);
    const padL = 6; const padR = 46; const padT = 16; const volH = Math.round(h * 0.2); const padB = 18;
    const ph = h - padT - padB - volH - 6;
    const pw = w - padL - padR;
    const vis = bars.slice(Math.max(0, end - n), end);
    const off = Math.max(0, end - n);
    if (!vis.length) {
      g.fillStyle = COL.dim; g.font = '500 13px "Noto Sans TC", sans-serif'; g.textAlign = 'center';
      g.fillText('沒有 K 線資料', w / 2, h / 2);
      return;
    }
    let lo = Math.min(...vis.map((b) => b.l));
    let hi = Math.max(...vis.map((b) => b.h));
    const pad = (hi - lo) * 0.08 || hi * 0.01;
    lo -= pad; hi += pad;
    const cw = pw / vis.length;
    const X = (i) => padL + cw * (i + 0.5);
    const Y = (p) => padT + (1 - (p - lo) / (hi - lo)) * ph;
    g.font = NUM; g.textBaseline = 'middle';
    for (const v of niceTicks(lo, hi, 4)) {
      g.strokeStyle = COL.grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(padL + pw, Y(v)); g.stroke();
      g.fillStyle = COL.dim; g.textAlign = 'left'; g.fillText(fmt(v), padL + pw + 6, Y(v));
    }
    // 月份
    let lastM = null;
    vis.forEach((b, i) => {
      const m = Math.floor(b.d / 100) % 100;
      if (m !== lastM && i > 2) {
        g.fillStyle = COL.dim; g.textAlign = 'center'; g.fillText(`${m}月`, X(i), h - 8);
        g.strokeStyle = COL.grid; g.beginPath(); g.moveTo(X(i), padT); g.lineTo(X(i), padT + ph + 6 + volH); g.stroke();
      }
      lastM = m;
    });
    const maxV = Math.max(1, ...vis.map((b) => b.v || 0));
    const bw = Math.max(1, cw * 0.66);
    vis.forEach((b, i) => {
      const upB = b.c >= b.o;
      const c = upB ? COL.up : COL.down;
      g.strokeStyle = c; g.fillStyle = c; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(i), Y(b.h)); g.lineTo(X(i), Y(b.l)); g.stroke();
      const y1 = Y(Math.max(b.o, b.c));
      const y2 = Y(Math.min(b.o, b.c));
      g.fillRect(X(i) - bw / 2, y1, bw, Math.max(1, y2 - y1));
      const vh = ((b.v || 0) / maxV) * volH;
      g.globalAlpha = 0.5;
      g.fillRect(X(i) - bw / 2, padT + ph + 6 + volH - vh, bw, vh);
      g.globalAlpha = 1;
    });
    for (const [arr, c] of [[m5, COL.ink], [m20, COL.brass], [m60, COL.blue]]) {
      g.beginPath();
      let started = false;
      vis.forEach((_, i) => {
        const v = arr[off + i];
        if (v == null) return;
        if (started) g.lineTo(X(i), Y(v)); else { g.moveTo(X(i), Y(v)); started = true; }
      });
      g.strokeStyle = c; g.lineWidth = 1.4; g.globalAlpha = 0.85; g.stroke(); g.globalAlpha = 1;
    }
    // 圖例
    g.font = NUM; g.textAlign = 'left';
    let lx = padL + 2;
    for (const [lab, c, arr] of [['MA5', COL.ink, m5], ['MA20', COL.brass, m20], ['MA60', COL.blue, m60]]) {
      const v = arr[end - 1];
      const t = `${lab} ${fmt(v)}`;
      g.fillStyle = c; g.fillText(t, lx, 7);
      lx += g.measureText(t).width + 12;
    }
    if (hover != null) {
      const i = Math.max(0, Math.min(vis.length - 1, Math.floor((hover - padL) / cw)));
      const b = vis[i];
      g.strokeStyle = 'rgba(236,226,204,0.5)';
      g.beginPath(); g.moveTo(X(i), padT); g.lineTo(X(i), padT + ph + 6 + volH); g.stroke();
      if (tipEl) {
        const prev = bars[off + i - 1];
        const pct = prev ? (b.c / prev.c - 1) * 100 : null;
        tipEl.innerHTML = `<b>${Math.floor(b.d / 100) % 100}/${b.d % 100}</b> 開 ${fmt(b.o)} 高 ${fmt(b.h)} 低 ${fmt(b.l)} 收 ${fmt(b.c)}${pct != null ? ` <em class="${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</em>` : ''} <span>${Math.round((b.v || 0) / 1000).toLocaleString()} 張</span>`;
        tipEl.hidden = false;
      }
    } else if (tipEl) tipEl.hidden = true;
  }
  // 拖曳看更早的 K 線、雙指縮放
  let drag = null;
  cv.onwheel = (e) => { e.preventDefault(); n = Math.max(20, Math.min(bars.length, Math.round(n * Math.exp(e.deltaY * 0.0015)))); end = Math.max(n, end); render(); };
  cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, end, moved: 0 }; const r = cv.getBoundingClientRect(); hover = e.clientX - r.left; render(); };
  cv.onpointermove = (e) => {
    const r = cv.getBoundingClientRect();
    if (drag && e.buttons) {
      const cw = (r.width - 52) / n;
      const di = Math.round((e.clientX - drag.x) / cw);
      drag.moved += Math.abs(e.movementX || 0);
      if (drag.moved > 12) { end = Math.max(n, Math.min(bars.length, drag.end - di)); hover = null; }
      else hover = e.clientX - r.left;
      render();
    } else if (e.pointerType === 'mouse') { hover = e.clientX - r.left; render(); }
  };
  cv.onpointerup = () => { drag = null; setTimeout(() => { hover = null; render(); }, 1800); };
  cv.onpointerleave = () => { hover = null; render(); };
  cv.style.touchAction = 'pan-y';
  render();
  return render;
}

// ------------------------------------------------------------------ 戰報：你 vs 0050
export function drawNav(cv, { days, ret, bench }, tipEl) {
  let hover = null;
  function render() {
    const { g, w, h } = setup(cv);
    const padL = 6; const padR = 50; const padT = 12; const padB = 20;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const vals = [...ret, ...bench.filter((x) => x != null), 0];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = (hi - lo) * 0.15 || 0.01;
    lo -= pad; hi += pad;
    const N = Math.max(2, days.length);
    const X = (i) => padL + (N === 1 ? pw / 2 : (i / (N - 1)) * pw);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ph;
    g.font = NUM; g.textBaseline = 'middle';
    for (const v of niceTicks(lo, hi, 4)) {
      g.strokeStyle = Math.abs(v) < 1e-9 ? 'rgba(236,226,204,0.35)' : COL.grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(padL + pw, Y(v)); g.stroke();
      g.fillStyle = v > 0 ? COL.up : v < 0 ? COL.down : COL.dim; g.textAlign = 'left';
      g.fillText(`${(v * 100).toFixed(Math.abs(hi - lo) < 0.02 ? 2 : 1)}%`, padL + pw + 6, Y(v));
    }
    const line = (arr, c, wdt, dash) => {
      g.beginPath();
      let st = false;
      arr.forEach((v, i) => { if (v == null) return; if (st) g.lineTo(X(i), Y(v)); else { g.moveTo(X(i), Y(v)); st = true; } });
      g.setLineDash(dash || []); g.strokeStyle = c; g.lineWidth = wdt; g.lineJoin = 'round'; g.stroke(); g.setLineDash([]);
    };
    line(bench, COL.sand, 1.6, [5, 4]);
    line(ret, COL.blue, 2.4);
    const li = ret.length - 1;
    if (li >= 0) { g.beginPath(); g.arc(X(li), Y(ret[li]), 4, 0, Math.PI * 2); g.fillStyle = COL.blue; g.fill(); }
    // 日期
    g.fillStyle = COL.dim; g.textAlign = 'left';
    if (days.length) {
      g.fillText(`${Math.floor(days[0] / 100) % 100}/${days[0] % 100}`, padL, h - 8);
      g.textAlign = 'right';
      g.fillText(`${Math.floor(days[days.length - 1] / 100) % 100}/${days[days.length - 1] % 100}`, padL + pw, h - 8);
    }
    if (hover != null && days.length) {
      const i = Math.max(0, Math.min(days.length - 1, Math.round(((hover - padL) / pw) * (N - 1))));
      g.strokeStyle = 'rgba(236,226,204,0.5)';
      g.beginPath(); g.moveTo(X(i), padT); g.lineTo(X(i), padT + ph); g.stroke();
      if (tipEl) {
        const d = days[i];
        const pc = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
        tipEl.innerHTML = `<b>${Math.floor(d / 100) % 100}/${d % 100}</b> 你 <em class="${ret[i] >= 0 ? 'up' : 'down'}">${pc(ret[i])}</em> 0050 <em class="${bench[i] >= 0 ? 'up' : 'down'}">${pc(bench[i])}</em>`;
        tipEl.hidden = false;
      }
    } else if (tipEl) tipEl.hidden = true;
  }
  crosshair(cv, (x) => { hover = x; render(); });
  render();
  return render;
}
