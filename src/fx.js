/* 沙盤 — 聲音與震動：全部用 WebAudio 當場合成（沒有音檔）。音色走「實體」路線：沙、紙、木頭、鼓、黃銅，
   跟冷眼的電子音完全不同。手機要先點一下畫面才能出聲；iPhone 側邊靜音時不出聲。 */
let ctx = null;
let master = null;
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
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function noiseBuf(sec) {
  const n = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function env(g, t0, a, peak, dec) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
}
function noise(t0, dur, type, freq, q, peak, dec = dur) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf(dur + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t0, 0.004, peak, dec);
  s.connect(f).connect(g).connect(master);
  s.start(t0);
  s.stop(t0 + dur + 0.05);
  return f;
}
function tone(t0, type, f0, f1, dur, peak, a = 0.004) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  const g = ctx.createGain();
  env(g, t0, a, peak, dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + a + dur + 0.05);
}

const SOUNDS = {
  // 沙沙聲：新行情到了
  sand(t) { noise(t, 0.22, 'bandpass', 3200, 0.8, 0.05, 0.2); noise(t + 0.06, 0.18, 'bandpass', 5200, 1.2, 0.03, 0.16); },
  // 木頭輕敲：按鈕
  tap(t) { tone(t, 'sine', 1250, 900, 0.05, 0.12); noise(t, 0.02, 'highpass', 2500, 0.7, 0.05, 0.02); },
  // 紙條抽出＋木塊：委託送出
  send(t) {
    const f = noise(t, 0.28, 'bandpass', 1800, 0.9, 0.16, 0.26);
    f.frequency.exponentialRampToValueAtTime(5200, t + 0.26);
    tone(t + 0.27, 'triangle', 620, 420, 0.07, 0.2);
    noise(t + 0.27, 0.03, 'highpass', 1800, 0.7, 0.12, 0.03);
  },
  // 鼓聲＋黃銅：成交
  fill(t) {
    tone(t, 'sine', 110, 46, 0.42, 0.55);
    noise(t, 0.06, 'lowpass', 900, 0.7, 0.22, 0.06);
    tone(t + 0.05, 'triangle', 880, 880, 0.9, 0.08, 0.01);
    tone(t + 0.05, 'sine', 1320, 1320, 0.7, 0.05, 0.01);
    tone(t + 0.05, 'sine', 1760 * 1.003, 1760, 0.5, 0.03, 0.01);
  },
  // 印章：記錄、蓋章
  stamp(t) { tone(t, 'sine', 160, 70, 0.18, 0.4); noise(t, 0.05, 'lowpass', 700, 0.6, 0.25, 0.05); },
  // 反向的風聲：刪單
  cancel(t) {
    const f = noise(t, 0.32, 'lowpass', 400, 1.2, 0.14, 0.3);
    f.frequency.exponentialRampToValueAtTime(4200, t + 0.3);
  },
  // 低沉兩聲：退單、錯誤
  reject(t) { tone(t, 'square', 150, 140, 0.09, 0.07); tone(t + 0.13, 'square', 120, 110, 0.12, 0.07); },
  // 鑼：開盤、收盤
  bell(t) {
    for (const [r, a, d] of [[1, 0.22, 2.6], [1.506, 0.12, 2.1], [2.2, 0.08, 1.6], [3.01, 0.05, 1.1], [4.1, 0.03, 0.8]]) {
      tone(t, 'sine', 196 * r, 196 * r * 0.996, d, a, 0.006);
    }
    noise(t, 0.04, 'lowpass', 1200, 0.6, 0.15, 0.04);
  },
  // 開燈：開機
  ignite(t) {
    noise(t, 0.03, 'highpass', 3000, 0.7, 0.18, 0.03);
    tone(t + 0.02, 'sine', 55, 55, 1.6, 0.18, 0.5);
    tone(t + 0.02, 'sine', 110, 110, 1.4, 0.06, 0.6);
  },
};

export function play(name) {
  if (!on || !ctx || ctx.state !== 'running') return;
  const s = SOUNDS[name];
  if (!s) return;
  try { s(ctx.currentTime + 0.01); } catch { /* 單一音效失敗不影響 App */ }
}

const PATTERNS = { tap: 8, send: [12, 40, 18], fill: [30, 50, 60], reject: [60, 60, 60], stamp: 25, bell: [20, 80, 20] };
export function haptic(name) {
  if (!buzz || !navigator.vibrate) return;
  try { navigator.vibrate(PATTERNS[name] || 10); } catch { /* 不支援 */ }
}

export function fx(name) { play(name); haptic(name); }
