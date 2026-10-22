/* 沙盤 — 聲音與震動：全部用 WebAudio 當場合成（沒有音檔）。
   音色走「黑金戰術台」：FM 合成的金屬共鳴（像敲在金色金屬上）、很低的重音、聲納回音，調性是 D。
   冷眼用的是 A 小調的方波／鋸齒波晶片音，兩邊刻意聽起來不一樣。
   手機要先點一下畫面才能出聲；iPhone 側邊靜音時不出聲（audioSession ambient）。 */
let ctx = null;
let master = null;
let space = null;     // 回音（聲納、成交的尾音）
let on = true;
let buzz = true;

export function setSound(v) { on = !!v; }
export function setHaptics(v) { buzz = !!v; }

export function unlock() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
  } catch { /* 不支援就算了 */ }
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(comp);
    // 回音：一條有回授的延遲線，回授路徑上加低通，越後面越悶
    const d = ctx.createDelay(1);
    d.delayTime.value = 0.19;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    space = ctx.createGain();
    space.gain.value = 1;
    space.connect(d);
    d.connect(lp).connect(fb).connect(d);
    const out = ctx.createGain();
    out.gain.value = 0.42;
    lp.connect(out).connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

let nb = null;
function noiseBuf() {
  if (nb) return nb;
  const n = Math.floor(ctx.sampleRate * 2);
  nb = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = nb.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return nb;
}
function env(g, t0, a, peak, dec) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
}
function out(node, wet) {
  node.connect(master);
  if (wet) { const w = ctx.createGain(); w.gain.value = wet; node.connect(w); w.connect(space); }
}
/** 濾波雜訊（風聲、掃過去的聲音）；f1 有給就從 f0 掃到 f1 */
function noise(t0, dur, type, f0, f1, q, peak, a = 0.004, wet = 0) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf();
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(f0, t0);
  if (f1) f.frequency.exponentialRampToValueAtTime(f1, t0 + a + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t0, a, peak, dur);
  s.connect(f).connect(g);
  out(g, wet);
  s.start(t0, Math.random() * 1.5);
  s.stop(t0 + a + dur + 0.05);
}
/** 一般的音（低音重擊用） */
function tone(t0, type, f0, f1, dur, peak, a = 0.004, wet = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + a + dur);
  const g = ctx.createGain();
  env(g, t0, a, peak, dur);
  o.connect(g);
  out(g, wet);
  o.start(t0);
  o.stop(t0 + a + dur + 0.05);
}
/** FM 金屬音：載波 f、調變比 ratio（不是整數就有金屬感）、調變深度從 idx 往下掉（越敲越乾淨） */
function fm(t0, f, ratio, idx, dur, peak, a = 0.003, wet = 0, glide = 0) {
  const c = ctx.createOscillator();
  const m = ctx.createOscillator();
  c.frequency.setValueAtTime(f, t0);
  m.frequency.setValueAtTime(f * ratio, t0);
  if (glide) {
    c.frequency.exponentialRampToValueAtTime(f * glide, t0 + a + dur);
    m.frequency.exponentialRampToValueAtTime(f * ratio * glide, t0 + a + dur);
  }
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * ratio * idx, t0);
  mg.gain.exponentialRampToValueAtTime(Math.max(1, f * ratio * idx * 0.04), t0 + a + dur * 0.6);
  m.connect(mg).connect(c.frequency);
  const g = ctx.createGain();
  env(g, t0, a, peak, dur);
  c.connect(g);
  out(g, wet);
  c.start(t0); m.start(t0);
  c.stop(t0 + a + dur + 0.05); m.stop(t0 + a + dur + 0.05);
}

// D 調的幾個音
const D3 = 146.83; const D4 = 293.66; const A4 = 440; const D5 = 587.33; const Fs5 = 739.99; const A5 = 880; const D6 = 1174.66; const A6 = 1760;

const SOUNDS = {
  // 輕點：很短的金屬點擊
  tap(t) { fm(t, 2349, 1.41, 0.7, 0.05, 0.3); },
  // 新行情：聲納 ping（帶回音）
  sand(t) { fm(t, D6, 2.0, 0.35, 0.32, 0.16, 0.004, 0.9, 0.985); },
  // 送單：往上掃的氣流＋兩聲上行的發射音
  send(t) {
    noise(t, 0.24, 'bandpass', 900, 5200, 1.4, 0.16, 0.02);
    fm(t + 0.05, D5, 1.5, 1.2, 0.09, 0.2);
    fm(t + 0.13, A5, 1.5, 1.0, 0.16, 0.22, 0.003, 0.35);
  },
  // 成交：低音重擊＋金色和弦（D、升F、A）的金屬共鳴
  fill(t) {
    tone(t, 'sine', 72, 38, 0.5, 0.7, 0.003);
    noise(t, 0.07, 'lowpass', 1600, 300, 0.7, 0.2);
    fm(t + 0.03, D5, 3.51, 1.6, 1.3, 0.18, 0.003, 0.5);
    fm(t + 0.05, Fs5, 3.51, 1.3, 1.1, 0.14, 0.003, 0.5);
    fm(t + 0.07, A5, 3.51, 1.1, 0.9, 0.12, 0.003, 0.5);
    fm(t + 0.1, A6, 1.0, 0.2, 0.7, 0.05, 0.01, 0.6);
  },
  // 鎖定：加自選、記錄
  stamp(t) {
    tone(t, 'sine', 120, 60, 0.16, 0.45);
    fm(t + 0.02, D6, 2.76, 0.9, 0.22, 0.16, 0.003, 0.4);
  },
  // 刪單：往下沉的氣流＋下行音
  cancel(t) {
    noise(t, 0.3, 'bandpass', 4200, 500, 1.2, 0.14, 0.02);
    fm(t + 0.04, A5, 1.5, 0.8, 0.18, 0.16, 0.003, 0, 0.6);
  },
  // 退單、錯誤：兩聲不和諧的低音
  reject(t) {
    fm(t, 155, 1.07, 2.2, 0.12, 0.22);
    fm(t + 0.15, 146, 1.07, 2.2, 0.16, 0.22);
  },
  // 開盤、收盤：金屬鑼（不整數比的 FM，很長的尾音）＋低音
  bell(t) {
    tone(t, 'sine', 73.4, 73.4, 2.8, 0.3, 0.004);
    fm(t, D3, 1.4, 3.2, 3.4, 0.22, 0.004, 0.45);
    fm(t, D4, 2.01, 1.4, 2.6, 0.1, 0.004, 0.45);
    noise(t, 0.05, 'lowpass', 1800, 0, 0.6, 0.12);
  },
  // 開機：往上衝的低頻＋氣流，最後一聲重低音和金色和弦
  ignite(t) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(40, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.75);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(120, t);
    f.frequency.exponentialRampToValueAtTime(1800, t + 0.75);
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.82);
    o.connect(f).connect(g).connect(master);
    o.start(t); o.stop(t + 0.9);
    noise(t, 0.7, 'bandpass', 300, 6000, 2, 0.06, 0.1);
    const h = t + 0.78;
    tone(h, 'sine', 64, 34, 1.4, 0.8, 0.003);
    noise(h, 0.1, 'lowpass', 2000, 200, 0.7, 0.25);
    for (const [fr, k] of [[D4, 0], [A4, 1], [D5, 2], [Fs5, 3]]) fm(h + k * 0.035, fr, 2.0, 0.9, 1.8, 0.05, 0.02, 0.5);
  },
};

export function play(name) {
  if (!on || !ctx || ctx.state !== 'running') return;
  const s = SOUNDS[name];
  if (!s) return;
  try { s(ctx.currentTime + 0.01); } catch { /* 單一音效失敗不影響 App */ }
}

const PATTERNS = { tap: 8, send: [12, 40, 18], fill: [30, 50, 60], reject: [60, 60, 60], stamp: 25, bell: [20, 80, 20], ignite: [15, 60, 120] };
export function haptic(name) {
  if (!buzz || !navigator.vibrate) return;
  try { navigator.vibrate(PATTERNS[name] || 10); } catch { /* 不支援 */ }
}

export function fx(name) { play(name); haptic(name); }
