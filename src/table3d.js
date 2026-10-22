/* 沙盤 — 3D 全像戰術台：黑色玻璃桌面上投影出每一檔 ETF 的六角地形，依類別分成一座座島。
   今天漲越多升得越高、透出紅光，跌的下沉、透出綠光（台股紅漲綠跌）；雷達光束一直掃過整張桌。
   今天漲跌最多的幾格射出紅／綠光柱；你持有的上面浮著寶藍色信標、掛著的委託有寶藍光圈、自選的格子上面有一顆金星、
   選中的那一格有金色鎖定環和光柱。類別名稱與代號標籤是 HTML（一直清楚，不會被光暈糊掉）。
   有支援的裝置加上光暈（bloom）；沒有 WebGL 時退回平面六角地圖。 */
import * as THREE from '../vendor/three.module.min.js';

const SQ3 = Math.sqrt(3);
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const CAT_ORDER = ['broad', 'div', 'theme', 'active', 'overseas', 'bond', 'lev', 'inv', 'fut'];
export const CAT_NAME = {
  broad: '市值型', div: '高股息', theme: '產業主題', overseas: '海外股票', bond: '債券',
  lev: '槓桿型', inv: '反向型', fut: '期貨商品', active: '主動式',
};
const C = { void: 0x040405, gold: 0xf2b84b, goldHi: 0xffd98e, up: 0xff3b4e, down: 0x14d999, flat: 0x9a7432, you: 0x5b8cff };

// ------------------------------------------------------------------ 六角格排版
function key(q, r) { return `${q},${r}`; }
function* spiral(cq, cr, maxR) {
  yield [cq, cr];
  for (let k = 1; k <= maxR; k++) {
    let q = cq + DIRS[4][0] * k;
    let r = cr + DIRS[4][1] * k;
    for (let side = 0; side < 6; side++) {
      for (let s = 0; s < k; s++) {
        yield [q, r];
        q += DIRS[side][0];
        r += DIRS[side][1];
      }
    }
  }
}
/** 依類別排成一座座六角島（島和島之間至少隔一格），回傳 {cells: Map(code → {q,r,x,z}), regions: [{cat,x,z,n}]} */
export function layout(items) {
  const groups = new Map();
  for (const it of items) {
    const k = CAT_ORDER.includes(it.k) ? it.k : 'theme';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const occ = new Set();
  const cells = new Map();
  const regions = [];
  const cats = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
  for (const cat of cats) {
    const list = groups.get(cat).sort((a, b) => (b.val || 0) - (a.val || 0));
    const n = list.length;
    let R = 0;
    while (1 + 3 * R * (R + 1) < n) R++;
    let center = null;
    for (const c of spiral(0, 0, 60)) {
      let ok = true;
      for (const x of spiral(c[0], c[1], R + 1)) { if (occ.has(key(x[0], x[1]))) { ok = false; break; } }
      if (ok) { center = c; break; }
    }
    if (!center) center = [regions.length * 30, 0];
    let i = 0;
    for (const x of spiral(center[0], center[1], R)) {
      occ.add(key(x[0], x[1]));
      if (i < n) {
        const it = list[i++];
        cells.set(it.c, { q: x[0], r: x[1], x: SQ3 * (x[0] + x[1] / 2), z: 1.5 * x[1], cat });
      }
    }
    regions.push({ cat, n, x: SQ3 * (center[0] + center[1] / 2), z: 1.5 * center[1], R });
  }
  // 置中
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const p of cells.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (const p of cells.values()) { p.x -= cx; p.z -= cz; }
  for (const g of regions) { g.x -= cx; g.z -= cz; }
  let rad = 0;
  for (const p of cells.values()) rad = Math.max(rad, Math.hypot(p.x, p.z));
  return { cells, regions, w: maxX - minX + 2, h: maxZ - minZ + 2, rad: rad + 1.2 };
}

export function heightOf(pct) {
  if (pct == null || !Number.isFinite(pct)) return 0.35;
  const p = Math.max(-4, Math.min(10, pct));
  return p >= 0 ? 0.4 + p * 0.42 : Math.max(0.06, 0.4 + p * 0.085);
}
/** 顏色：紅漲綠跌，越多越亮；平盤是暗金 */
function colorOf(pct, out) {
  if (pct == null || !Number.isFinite(pct)) return out.setHex(0x3a3024);
  if (Math.abs(pct) < 0.05) return out.setHex(C.flat);
  const k = 0.35 + 0.65 * Math.min(1, Math.abs(pct) / 3);
  out.setHex(pct > 0 ? C.up : C.down);
  return out.multiplyScalar(k);
}

// ------------------------------------------------------------------ 著色器：六角地形、桌面
const HEX_VS = /* glsl */`
  uniform float uTime;
  varying vec3 vColor;
  varying vec3 vLocal;
  varying vec3 vN;
  varying vec3 vWorld;
  varying vec2 vCenter;
  void main() {
    vColor = instanceColor;
    vLocal = position;
    mat4 m = modelMatrix * instanceMatrix;
    vec4 wp = m * vec4(position, 1.0);
    vWorld = wp.xyz;
    vN = normalize(mat3(m) * normal);
    vCenter = vec2(m[3][0], m[3][2]);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const HEX_FS = /* glsl */`
  uniform float uTime;
  uniform float uSweep;
  varying vec3 vColor;
  varying vec3 vLocal;
  varying vec3 vN;
  varying vec3 vWorld;
  varying vec2 vCenter;
  void main() {
    vec3 base = vColor;
    float ang = atan(vCenter.x, vCenter.y);
    float da = mod(uSweep - ang + 6.2831853, 6.2831853);
    float ping = exp(-da * 3.2);
    vec3 col;
    if (vN.y > 0.5) {
      // 頂面：外框發亮、中間暗一點，像投影出來的六角板
      float d = max(abs(vLocal.x), abs(vLocal.x) * 0.5 + abs(vLocal.z) * 0.8660254) / 0.7621;
      float border = smoothstep(0.78, 0.97, d);
      float core = 0.22 + 0.10 * (1.0 - d);
      col = base * (core + 1.9 * border) + base * ping * 1.1;
    } else {
      // 側面：底部暗、往上漸亮，加一點掃描線和邊緣光
      vec3 vd = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - abs(dot(vN, vd)), 2.2);
      float y = clamp(vLocal.y, 0.0, 1.0);
      float grad = pow(y, 1.7);
      float scan = 0.5 + 0.5 * sin(vWorld.y * 26.0 - uTime * 3.5);
      col = mix(vec3(0.010, 0.009, 0.012), base * 0.62, grad) + base * fres * 0.75 * (0.4 + grad);
      col += base * scan * 0.05 * grad + base * ping * 0.45 * grad;
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const GROUND_VS = /* glsl */`
  varying vec2 vXZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const GROUND_FS = /* glsl */`
  uniform float uTime;
  uniform float uSweep;
  uniform float uR;
  uniform float uIntro;
  varying vec2 vXZ;
  void main() {
    vec3 gold = vec3(0.95, 0.60, 0.16);
    float r = length(vXZ);
    float inside = smoothstep(uR * 1.02, uR * 0.62, r);
    // 六角排列的光點
    vec2 p = vXZ / 1.1;
    float row = floor(p.y / 0.866);
    vec2 q = vec2(p.x + mod(row, 2.0) * 0.5, p.y);
    vec2 f = vec2(fract(q.x) - 0.5, fract(q.y / 0.866) - 0.5);
    float dots = smoothstep(0.075, 0.0, length(f * vec2(1.0, 0.866)));
    // 距離環
    float ringD = abs(fract(r / 7.0 + 0.5) - 0.5) * 7.0;
    float rings = smoothstep(0.06, 0.0, ringD);
    // 十字座標線
    float axis = smoothstep(0.05, 0.0, min(abs(vXZ.x), abs(vXZ.y)));
    // 雷達掃描
    float ang = atan(vXZ.x, vXZ.y);
    float da = mod(uSweep - ang + 6.2831853, 6.2831853);
    float trail = exp(-da * 2.4);
    float edge = smoothstep(0.035, 0.0, da);
    vec3 col = vec3(0.010, 0.009, 0.011);
    col += gold * dots * 0.16 * inside;
    col += gold * rings * 0.22 * inside;
    col += gold * axis * 0.10 * inside;
    col += gold * trail * 0.085 * inside;
    col += vec3(1.0, 0.78, 0.38) * edge * 0.55 * inside;
    col += gold * 0.06 * smoothstep(uR, 0.0, r);
    // 桌緣的光
    float rim = smoothstep(0.35, 0.0, abs(r - uR * 1.04));
    col += gold * rim * 0.9;
    gl_FragColor = vec4(col * uIntro, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// ------------------------------------------------------------------ 貼圖
/** 自選的金星 */
function starTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 96;
  const g = cv.getContext('2d');
  g.translate(48, 50);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 15 : 34;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.shadowColor = 'rgba(255,200,90,1)';
  g.shadowBlur = 14;
  const grd = g.createLinearGradient(0, -34, 0, 30);
  grd.addColorStop(0, '#fff3d0');
  grd.addColorStop(0.55, '#ffc85a');
  grd.addColorStop(1, '#b07818');
  g.fillStyle = grd;
  g.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function glowTexture(color = '255,217,142') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, `rgba(${color},1)`);
  grd.addColorStop(0.35, `rgba(${color},0.35)`);
  grd.addColorStop(1, `rgba(${color},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

// ------------------------------------------------------------------ 主體
export function createTable(host, opts = {}) {
  const reduced = !!opts.reduced;
  const quality = opts.quality || 'auto';
  const wrap = document.createElement('div');
  wrap.className = 'st-wrap';
  host.appendChild(wrap);
  const labels = document.createElement('div');
  labels.className = 'st-labels';
  wrap.appendChild(labels);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: quality !== 'low', alpha: false, powerPreference: 'high-performance' });
  } catch {
    return createFlat(host, wrap, opts);
  }
  const wide = window.matchMedia('(min-width: 1100px)').matches;
  const hi = quality === 'high' || (quality === 'auto' && wide);
  const useBloom = quality !== 'low';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hi ? 2 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(C.void, 1);
  wrap.insertBefore(renderer.domElement, labels);
  renderer.domElement.className = 'st-canvas';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 300);
  const target = new THREE.Vector3(0, 0, 0);
  const cam = { az: -0.5, pol: 0.86, dist: 40, fit: 40 };

  // 光暈（bloom）：載入失敗就直接畫
  let composer = null;
  let bloomPass = null;
  if (useBloom) {
    Promise.all([
      import('../vendor/fx/EffectComposer.js'), import('../vendor/fx/RenderPass.js'),
      import('../vendor/fx/UnrealBloomPass.js'), import('../vendor/fx/OutputPass.js'),
    ]).then(([EC, RP, UB, OP]) => {
      if (!alive) return;
      const c = new EC.EffectComposer(renderer);
      c.addPass(new RP.RenderPass(scene, camera));
      bloomPass = new UB.UnrealBloomPass(new THREE.Vector2(256, 256), 0.95, 0.55, 0.16);
      c.addPass(bloomPass);
      c.addPass(new OP.OutputPass());
      composer = c;
      resize();
    }).catch(() => { composer = null; });
  }

  const uni = { uTime: { value: 0 }, uSweep: { value: 0 }, uR: { value: 20 }, uIntro: { value: reduced ? 1 : 0 } };

  // 桌面（黑玻璃＋光點、距離環、雷達掃描）
  let ground = null;
  const groundMat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: GROUND_VS, fragmentShader: GROUND_FS, fog: false });
  // 外圈刻度環（慢慢轉）
  const hud = new THREE.Group();
  scene.add(hud);
  function buildGround(rad) {
    if (ground) { scene.remove(ground); ground.geometry.dispose(); }
    hud.clear();
    uni.uR.value = rad;
    ground = new THREE.Mesh(new THREE.CircleGeometry(rad * 1.6, 96), groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const tickGeo = new THREE.PlaneGeometry(0.07, 0.6);
    tickGeo.rotateX(-Math.PI / 2);
    const tickMat = new THREE.MeshBasicMaterial({ color: C.gold, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
    const n = 144;
    const ticks = new THREE.InstancedMesh(tickGeo, tickMat, n);
    const m = new THREE.Matrix4();
    const qn = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const long = i % 12 === 0;
      qn.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
      m.compose(new THREE.Vector3(Math.sin(a) * (rad * 1.1), 0.02, Math.cos(a) * (rad * 1.1)), qn, new THREE.Vector3(long ? 1.8 : 1, 1, long ? 1.6 : 1));
      ticks.setMatrixAt(i, m);
    }
    hud.add(ticks);
    const arcMat = new THREE.MeshBasicMaterial({ color: C.goldHi, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    for (let k = 0; k < 3; k++) {
      const arc = new THREE.Mesh(new THREE.RingGeometry(rad * 1.16, rad * 1.16 + 0.12, 64, 1, (k * Math.PI * 2) / 3, Math.PI * 0.42), arcMat);
      arc.rotation.x = -Math.PI / 2;
      arc.position.y = 0.03;
      hud.add(arc);
    }
  }

  // 六角地形（一次畫完全部，InstancedMesh＋自己的著色器）
  const hexGeo = new THREE.CylinderGeometry(0.88, 0.88, 1, 6, 1, false);
  hexGeo.translate(0, 0.5, 0);
  const hexMat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: HEX_VS, fragmentShader: HEX_FS, fog: false });
  let hexes = null;
  let codes = [];
  let cells = new Map();
  let regions = [];
  let regionEls = [];
  const info = new Map();          // code → {pct, name, h0, h1, delay}
  const tmpM = new THREE.Matrix4();
  const tmpC = new THREE.Color();
  const tmpV = new THREE.Vector3();

  // 選取：金色鎖定環（三段弧，會轉）＋光柱＋地面脈衝
  const selGroup = new THREE.Group();
  const lockMat = new THREE.MeshBasicMaterial({ color: C.goldHi, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  for (let k = 0; k < 3; k++) {
    const a = new THREE.Mesh(new THREE.RingGeometry(1.12, 1.26, 32, 1, (k * Math.PI * 2) / 3 + 0.25, Math.PI * 0.42), lockMat);
    a.rotation.x = -Math.PI / 2;
    selGroup.add(a);
  }
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(C.goldHi) } },
    vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uColor; varying float vY; void main(){ gl_FragColor = vec4(uColor, pow(1.0 - vY, 2.4) * 0.3); }',
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.7, 9, 6, 1, true), beamMat);
  beam.position.y = 4.5;
  selGroup.add(beam);
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.05, 6), new THREE.MeshBasicMaterial({ color: C.gold, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  pulse.rotation.x = -Math.PI / 2;
  pulse.rotation.z = Math.PI / 6;
  selGroup.add(pulse);
  selGroup.visible = false;
  scene.add(selGroup);

  // 持有：寶藍信標；掛單：寶藍光圈；自選：金色外框
  const flags = new Map();
  const rings = new Map();
  const watchRings = new Map();
  const beaconGeo = new THREE.OctahedronGeometry(0.34, 0);
  const youMat = new THREE.MeshBasicMaterial({ color: 0x3f6fff, transparent: true, opacity: 0.9, depthWrite: false });
  const youGlow = new THREE.SpriteMaterial({ map: glowTexture('70,110,255'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.38 });
  const poleGeo = new THREE.CylinderGeometry(0.025, 0.025, 1, 6, 1, true);
  poleGeo.translate(0, 0.5, 0);
  const poleMat = new THREE.MeshBasicMaterial({ color: 0x3f6fff, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
  const hexRingGeo = new THREE.RingGeometry(0.98, 1.1, 6);
  const starMat = new THREE.SpriteMaterial({ map: starTexture(), transparent: true, depthWrite: false, opacity: 0.95 });

  // 今天漲跌最多的幾格：紅／綠光柱（高度跟著漲跌幅）
  const BEAMS = 10;
  const moverGeo = new THREE.CylinderGeometry(0.42, 0.62, 1, 6, 1, true);
  moverGeo.translate(0, 0.5, 0);
  const beams = [];
  for (let i = 0; i < BEAMS; i++) {
    const m = new THREE.Mesh(moverGeo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color() }, uTime: uni.uTime, uK: { value: 1 } },
      vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uTime; uniform float uK; varying float vY; void main(){ float a = pow(1.0 - vY, 1.35) * 0.8 * uK; a *= 0.82 + 0.18 * sin(vY * 30.0 - uTime * 4.0); gl_FragColor = vec4(uColor * 1.4, a); }',
    }));
    m.visible = false;
    m.userData.code = null;
    scene.add(m);
    beams.push(m);
  }
  let beamCodes = [];

  // 浮在空中的光點（減少動態效果時不放）
  let sparks = null;
  if (!reduced) {
    const n = hi ? 360 : 180;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(Math.random()) * 28;
      const a = Math.random() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = Math.random() * 14;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sparks = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.12, map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffcf7a }));
    scene.add(sparks);
  }

  let selected = null;
  let anim = null;         // {t0, dur}
  let introT = reduced ? 1 : 0;
  let lastAct = performance.now();
  let alive = true;
  let visible = true;
  let selAt = 0;

  function heightNow(code, now) {
    const s = info.get(code);
    if (!s) return 0.35;
    if (!anim) return s.h1;
    const t = Math.max(0, Math.min(1, (now - anim.t0 - s.delay) / anim.dur));
    const e = 1 - Math.pow(1 - t, 3);
    return s.h0 + (s.h1 - s.h0) * e;
  }

  function setData(items, o = {}) {
    const lay = layout(items);
    const sameLayout = hexes && codes.length === items.length && items.every((it) => cells.has(it.c) && lay.cells.get(it.c).q === cells.get(it.c).q && lay.cells.get(it.c).r === cells.get(it.c).r);
    const now = performance.now();
    if (!sameLayout) {
      if (hexes) { scene.remove(hexes); hexes.dispose(); }
      cells = lay.cells;
      regions = lay.regions;
      codes = items.map((it) => it.c).filter((c) => cells.has(c));
      hexes = new THREE.InstancedMesh(hexGeo, hexMat, codes.length);
      hexes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(codes.length * 3), 3);
      scene.add(hexes);
      buildGround(lay.rad);
      for (const e of regionEls) e.remove();
      regionEls = regions.map((g) => {
        const e = document.createElement('div');
        e.className = 'st-region';
        e.innerHTML = `<b>${CAT_NAME[g.cat] || g.cat}</b><small>${g.n} 檔</small>`;
        labels.appendChild(e);
        return e;
      });
      cam.fit = lay.rad * 2.2 + 8;
      cam.dist = cam.fit;
      for (const c of codes) info.set(c, { pct: null, name: '', h0: 0.02, h1: 0.02, delay: 0 });
      for (const m of [...flags.values(), ...rings.values(), ...watchRings.values()]) scene.remove(m);
      flags.clear(); rings.clear(); watchRings.clear();
      for (const b of beams) b.visible = false;
    }
    const byCode = new Map(items.map((it) => [it.c, it]));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      const it = byCode.get(c);
      const p = cells.get(c);
      const s = info.get(c) || {};
      const hNow = heightNow(c, now);
      s.h0 = o.intro ? 0.02 : hNow;
      s.h1 = heightOf(it.pct);
      s.pct = it.pct;
      s.name = it.n;
      s.px = it.px;
      s.delay = (Math.hypot(p.x, p.z) / 28) * (o.intro ? 1300 : 500);
      info.set(c, s);
      hexes.setColorAt(i, colorOf(it.pct, tmpC));
    }
    hexes.instanceColor.needsUpdate = true;
    pickBeams();
    anim = reduced ? null : { t0: now, dur: o.intro ? 1000 : 650 };
    if (o.intro && !reduced) introT = 0;
    applyHeights(now);
    updateMarkers(now);
    kick();
  }

  function applyHeights(now) {
    if (!hexes) return;
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      const p = cells.get(c);
      const h = heightNow(c, now);
      tmpM.makeScale(1, Math.max(0.02, h), 1);
      tmpM.setPosition(p.x, 0, p.z);
      hexes.setMatrixAt(i, tmpM);
    }
    hexes.instanceMatrix.needsUpdate = true;
    hexes.computeBoundingSphere();
  }

  function setHeld(list) {
    const want = new Set(list);
    for (const [c, g] of flags) if (!want.has(c)) { scene.remove(g); flags.delete(c); }
    for (const c of want) {
      if (flags.has(c) || !cells.has(c)) continue;
      const g = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, poleMat);
      g.add(pole);
      const gem = new THREE.Mesh(beaconGeo, youMat);
      g.add(gem);
      const halo = new THREE.Sprite(youGlow);
      halo.scale.set(1.6, 1.6, 1);
      g.add(halo);
      const base = new THREE.Mesh(hexRingGeo, new THREE.MeshBasicMaterial({ color: C.you, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      base.rotation.x = -Math.PI / 2;
      base.rotation.z = Math.PI / 6;
      g.add(base);
      g.userData = { pole, gem, halo, base, drop: performance.now() };
      flags.set(c, g);
      scene.add(g);
    }
    kick();
  }
  function setPending(list) {
    const want = new Set(list);
    for (const [c, m] of rings) if (!want.has(c)) { scene.remove(m); m.material.dispose(); rings.delete(c); }
    for (const c of want) {
      if (rings.has(c) || !cells.has(c)) continue;
      const m = new THREE.Mesh(hexRingGeo, new THREE.MeshBasicMaterial({ color: C.you, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = Math.PI / 6;
      rings.set(c, m);
      scene.add(m);
    }
    kick();
  }
  function setWatch(list) {
    const want = new Set(list);
    for (const [c, m] of watchRings) if (!want.has(c)) { scene.remove(m); watchRings.delete(c); }
    for (const c of want) {
      if (watchRings.has(c) || !cells.has(c)) continue;
      const m = new THREE.Sprite(starMat);
      watchRings.set(c, m);
      scene.add(m);
    }
    kick();
  }
  /** 光柱給今天漲最多、跌最多的各 5 檔（漲跌 1% 以上才有） */
  function pickBeams() {
    const arr = [...info.entries()].filter(([c, s]) => cells.has(c) && s.pct != null && Math.abs(s.pct) >= 1);
    const ups = arr.filter(([, s]) => s.pct > 0).sort((a, b) => b[1].pct - a[1].pct).slice(0, BEAMS / 2);
    const dns = arr.filter(([, s]) => s.pct < 0).sort((a, b) => a[1].pct - b[1].pct).slice(0, BEAMS / 2);
    beamCodes = [...ups, ...dns].map(([c]) => c);
    beams.forEach((m, i) => {
      const c = beamCodes[i];
      m.visible = !!c;
      m.userData.code = c || null;
      if (c) {
        const pct = info.get(c).pct;
        m.material.uniforms.uColor.value.setHex(pct > 0 ? C.up : C.down);
        m.userData.len = 2.6 + Math.min(10, Math.abs(pct)) * 1.15;
      }
    });
  }
  function select(c) {
    const prev = selected;
    selected = c && cells.has(c) ? c : null;
    selGroup.visible = !!selected;
    if (selected && selected !== prev) selAt = performance.now();
    kick();
  }

  function updateMarkers(now) {
    const t = now / 1000;
    const zs = Math.max(1, Math.min(2.6, cam.dist / 30));
    for (const [c, g] of flags) {
      const p = cells.get(c);
      if (!p) continue;
      const h = heightNow(c, now);
      const age = (now - g.userData.drop) / 1000;
      const drop = reduced ? 0 : Math.max(0, 1 - age / 0.6);
      const lift = 1.5 * zs + (reduced ? 0 : Math.sin(t * 1.8 + p.x) * 0.12 * zs);
      g.position.set(p.x, h, p.z);
      g.userData.pole.scale.y = lift;
      g.userData.gem.position.y = lift + 0.34 * zs + drop * drop * 7;
      g.userData.gem.scale.setScalar(zs);
      g.userData.gem.rotation.y = reduced ? 0.6 : t * 1.4;
      g.userData.halo.position.y = g.userData.gem.position.y;
      g.userData.halo.scale.set(1.7 * zs, 1.7 * zs, 1);
      g.userData.base.position.y = 0.03;
    }
    for (const m of beams) {
      const c = m.userData.code;
      const p = c && cells.get(c);
      if (!p) continue;
      const h = heightNow(c, now);
      m.position.set(p.x, h, p.z);
      const grow = anim ? Math.max(0, Math.min(1, (now - anim.t0 - info.get(c).delay) / anim.dur)) : 1;
      m.scale.set(1, Math.max(0.01, m.userData.len * grow), 1);
      m.material.uniforms.uK.value = introT;
    }
    for (const [c, m] of rings) {
      const p = cells.get(c);
      if (!p) continue;
      const k = reduced ? 1 : 1 + 0.07 * Math.sin(t * 3.4);
      m.position.set(p.x, heightNow(c, now) + 0.05, p.z);
      m.scale.set(k, k, k);
      m.material.opacity = reduced ? 0.85 : 0.45 + 0.45 * (0.5 + 0.5 * Math.sin(t * 3.4));
    }
    for (const [c, m] of watchRings) {
      const p = cells.get(c);
      if (!p) continue;
      const bob = reduced ? 0 : Math.sin(t * 2 + p.z) * 0.08;
      // 有信標的格子，星星往旁邊讓一點
      m.position.set(p.x + (flags.has(c) ? 0.75 * zs : 0), heightNow(c, now) + 0.7 * zs + bob, p.z);
      m.scale.set(0.95 * zs, 0.95 * zs, 1);
    }
    if (selected) {
      const p = cells.get(selected);
      const h = heightNow(selected, now);
      selGroup.position.set(p.x, h + 0.06, p.z);
      selGroup.children[0].parent.rotation.y = reduced ? 0 : t * 0.9;
      const since = (now - selAt) / 1000;
      const k = 1 + (since % 1.6) * 1.2;
      pulse.scale.set(k, k, k);
      pulse.material.opacity = reduced ? 0 : 0.7 * (1 - (since % 1.6) / 1.6);
      const lockIn = reduced ? 1 : Math.min(1, since / 0.35);
      const s = (1.8 - 0.8 * lockIn) * Math.min(1.8, zs);
      for (let i = 0; i < 3; i++) selGroup.children[i].scale.set(s, s, s);
      lockMat.opacity = 0.35 + 0.6 * lockIn;
    }
  }

  // ---- 標籤（DOM）：選取的那一格＋今天漲跌最多的幾格
  const labelEls = new Map();
  function labelList() {
    const arr = [...info.entries()].filter(([, s]) => s.pct != null).sort((a, b) => b[1].pct - a[1].pct);
    const pick = new Set([...arr.slice(0, 3), ...arr.slice(-2)].map(([c]) => c));
    for (const c of flags.keys()) pick.add(c);
    if (selected) pick.add(selected);
    return pick;
  }
  function updateLabels(now) {
    const want = labelList();
    for (const [c, el] of labelEls) if (!want.has(c)) { el.remove(); labelEls.delete(c); }
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const boxes = [];
    const rank = (c) => (c === selected ? 0 : flags.has(c) ? 1 : 2);
    const order = [...want].sort((a, b) => rank(a) - rank(b));
    for (const c of order) {
      const p = cells.get(c);
      const s = info.get(c);
      if (!p || !s) continue;
      let el = labelEls.get(c);
      if (!el) {
        el = document.createElement('div');
        el.className = 'st-label';
        labels.appendChild(el);
        labelEls.set(c, el);
      }
      const pct = s.pct;
      el.dataset.dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
      el.classList.toggle('sel', c === selected);
      el.classList.toggle('you', flags.has(c) && c !== selected);
      const txt = `<b>${c}</b><i>${pct == null ? '—' : (pct > 0 ? '+' : '') + pct.toFixed(2) + '%'}</i>`;
      if (el._t !== txt) { el.innerHTML = txt; el._t = txt; }
      const zs = Math.max(1, Math.min(2.6, cam.dist / 30));
      const bi = beamCodes.indexOf(c);
      const top = flags.has(c) ? 2.3 * zs : bi >= 0 && beams[bi].visible ? beams[bi].scale.y * 0.55 : 0.3;
      tmpV.set(p.x, heightNow(c, now) + top, p.z).project(camera);
      const x = (tmpV.x * 0.5 + 0.5) * w;
      const y = (-tmpV.y * 0.5 + 0.5) * h;
      let hidden = tmpV.z > 1 || x < -40 || x > w + 40 || y < -20 || y > h + 20;
      const bw = 96;
      const bh = 44;
      const box = [x - bw / 2, y - bh, x + bw / 2, y];
      if (!hidden && boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) hidden = true;
      if (!hidden) boxes.push(box);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      el.style.opacity = hidden ? '0' : '1';
    }
    // 類別名稱：放在每座島在畫面上的上緣，被代號標籤擋到就先藏起來
    regions.forEach((g, i) => {
      const e = regionEls[i];
      if (!e) return;
      const rr = (g.R + 0.7) * SQ3;
      let topY = Infinity;
      let botY = -Infinity;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        tmpV.set(g.x + Math.cos(a) * rr, 0.4, g.z + Math.sin(a) * rr).project(camera);
        const yy = (-tmpV.y * 0.5 + 0.5) * h;
        topY = Math.min(topY, yy);
        botY = Math.max(botY, yy);
      }
      tmpV.set(g.x, 0.4, g.z).project(camera);
      const cx = (tmpV.x * 0.5 + 0.5) * w;
      const hit = (bx) => boxes.some((b) => bx[0] < b[2] && bx[2] > b[0] && bx[1] < b[3] && bx[3] > b[1]);
      let box = [cx - 34, topY - 30, cx + 34, topY];
      let y = topY - 30;
      if (hit(box)) { box = [cx - 34, botY + 2, cx + 34, botY + 32]; y = botY + 2; }
      const hide = tmpV.z > 1 || hit(box);
      if (!hide) boxes.push(box);
      e.style.transform = `translate(${cx.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, 0)`;
      e.style.opacity = hide ? '0' : '1';
    });
  }

  // ---- 鏡頭與操作
  function placeCamera() {
    const r = cam.dist;
    camera.position.set(target.x + r * Math.sin(cam.pol) * Math.sin(cam.az), target.y + r * Math.cos(cam.pol), target.z + r * Math.sin(cam.pol) * Math.cos(cam.az));
    camera.lookAt(target);
  }
  const ptrs = new Map();
  let down = null;
  let pinch0 = null;
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: cam.dist };
    }
    lastAct = performance.now();
    kick();
  });
  el.addEventListener('pointermove', (e) => {
    const prev = ptrs.get(e.pointerId);
    if (!prev) { hover(e); return; }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX; prev.y = e.clientY;
    if (ptrs.size === 1 && down) {
      down.moved += Math.abs(dx) + Math.abs(dy);
      cam.az -= dx * 0.0065;
      cam.pol = Math.max(0.3, Math.min(1.2, cam.pol - dy * 0.0045));
    } else if (ptrs.size === 2 && pinch0) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      cam.dist = Math.max(cam.fit * 0.3, Math.min(cam.fit * 1.4, pinch0.dist * (pinch0.d / Math.max(20, d))));
      if (down) down.moved = 99;
    }
    lastAct = performance.now();
    kick();
  });
  const up = (e) => {
    const was = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch0 = null;
    if (was && down && ptrs.size === 0) {
      if (down.moved < 8 && performance.now() - down.t < 450) pick(e, true);
      down = null;
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.max(cam.fit * 0.3, Math.min(cam.fit * 1.4, cam.dist * Math.exp(e.deltaY * 0.0012)));
    lastAct = performance.now();
    kick();
  }, { passive: false });

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function hit(e) {
    if (!hexes) return null;
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(hexes, false);
    return hits.length ? codes[hits[0].instanceId] : null;
  }
  function pick(e) {
    const c = hit(e);
    if (opts.onPick) opts.onPick(c);
  }
  let hoverC = null;
  function hover(e) {
    if (e.pointerType !== 'mouse') return;
    const c = hit(e);
    if (c === hoverC) return;
    hoverC = c;
    el.style.cursor = c ? 'pointer' : 'grab';
    if (opts.onHover) opts.onHover(c, e);
  }

  // ---- 迴圈：沒在動的時候降到每秒 30 張；看不到就停
  let raf = 0;
  let frame = 0;
  const t0 = performance.now();
  function kick() { if (!raf && alive) raf = requestAnimationFrame(loop); }
  function loop(now) {
    raf = 0;
    if (!alive) return;
    if (!visible || document.hidden) return;
    frame++;
    const idle = now - lastAct > 4000;
    const animating = anim && now - anim.t0 < anim.dur + 1500;
    if (!animating && anim) anim = null;
    if (introT < 1) introT = Math.min(1, introT + 0.016);
    if (!reduced && idle && !ptrs.size) cam.az += 0.0004;
    const skip = idle && !animating && introT >= 1 && frame % 2 === 1;
    if (!skip) {
      const ts = (now - t0) / 1000;
      uni.uTime.value = ts;
      uni.uSweep.value = reduced ? 0.6 : (ts * 0.75) % (Math.PI * 2);
      uni.uIntro.value = introT;
      hud.rotation.y = reduced ? 0 : ts * 0.04;
      if (sparks) {
        sparks.material.opacity = 0.7 * introT;
        const a = sparks.geometry.attributes.position;
        for (let i = 1; i < a.array.length; i += 3) { a.array[i] += 0.006; if (a.array[i] > 14) a.array[i] = 0; }
        a.needsUpdate = true;
      }
      if (animating) applyHeights(now);
      updateMarkers(now);
      placeCamera();
      if (composer) composer.render(); else renderer.render(scene, camera);
      updateLabels(now);
    }
    const needs = !reduced || animating || introT < 1 || ptrs.size;
    if (needs) raf = requestAnimationFrame(loop);
  }
  function resize() {
    const w = wrap.clientWidth || 1;
    const h = wrap.clientHeight || 1;
    renderer.setSize(w, h, false);
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
      if (bloomPass) bloomPass.resolution.set(w / 2, h / 2);
    }
    camera.aspect = w / h;
    camera.fov = w < 520 ? 46 : 36;
    camera.updateProjectionMatrix();
    kick();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  const io = new IntersectionObserver((ents) => { visible = ents.some((x) => x.isIntersecting); kick(); });
  io.observe(wrap);
  document.addEventListener('visibilitychange', kick);
  resize();

  return {
    ok: true,
    setData, setHeld, setPending, setWatch, select,
    ignite() { introT = reduced ? 1 : 0; kick(); },
    focus(c) {
      const p = cells.get(c);
      if (!p) return;
      target.set(p.x * 0.5, 0, p.z * 0.5);
      cam.dist = Math.max(cam.fit * 0.5, cam.dist * 0.9);
      lastAct = performance.now();
      kick();
    },
    reset() { target.set(0, 0, 0); cam.dist = cam.fit; kick(); },
    dispose() {
      alive = false;
      ro.disconnect(); io.disconnect();
      if (composer) composer.dispose && composer.dispose();
      renderer.dispose();
      wrap.remove();
    },
  };
}

// ------------------------------------------------------------------ 沒有 WebGL：平面六角地圖
function createFlat(host, wrap, opts) {
  const cv = document.createElement('canvas');
  cv.className = 'st-canvas';
  wrap.appendChild(cv);
  let lay = null;
  let data = [];
  let held = new Set();
  let pend = new Set();
  let watch = new Set();
  let sel = null;
  function draw() {
    if (!lay) return;
    const w = wrap.clientWidth || 300;
    const h = wrap.clientHeight || 200;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#040405';
    g.fillRect(0, 0, w, h);
    const s = Math.min(w / lay.w, h / lay.h) * 0.92;
    const byC = new Map(data.map((x) => [x.c, x]));
    const col = new THREE.Color();
    for (const [c, p] of lay.cells) {
      const x = w / 2 + p.x * s;
      const y = h / 2 + p.z * s;
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 3 * k + Math.PI / 6;
        g.lineTo(x + Math.cos(a) * s * 0.88, y + Math.sin(a) * s * 0.88);
      }
      g.closePath();
      colorOf(byC.get(c)?.pct, col);
      g.fillStyle = `#${col.getHexString()}`;
      g.globalAlpha = 0.85;
      g.fill();
      g.globalAlpha = 1;
      if (watch.has(c)) { g.strokeStyle = '#ffd98e'; g.lineWidth = 1.5; g.stroke(); }
      if (held.has(c)) { g.strokeStyle = '#5b8cff'; g.lineWidth = 2.5; g.stroke(); }
      if (pend.has(c)) { g.setLineDash([3, 3]); g.strokeStyle = '#5b8cff'; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
      if (c === sel) { g.strokeStyle = '#ffd98e'; g.lineWidth = 3; g.stroke(); }
    }
    g.font = '900 13px "Noto Sans TC", sans-serif';
    g.fillStyle = 'rgba(255,217,142,0.9)';
    g.textAlign = 'center';
    for (const r of lay.regions) g.fillText(CAT_NAME[r.cat] || r.cat, w / 2 + r.x * s, h / 2 + (r.z - (r.R + 1) * 1.5) * s);
  }
  cv.addEventListener('click', (e) => {
    if (!lay) return;
    const r = cv.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    const s = Math.min(w / lay.w, h / lay.h) * 0.92;
    let best = null;
    let bd = Infinity;
    for (const [c, p] of lay.cells) {
      const d = Math.hypot(w / 2 + p.x * s - (e.clientX - r.left), h / 2 + p.z * s - (e.clientY - r.top));
      if (d < bd) { bd = d; best = c; }
    }
    if (opts.onPick) opts.onPick(bd < s ? best : null);
  });
  new ResizeObserver(draw).observe(wrap);
  return {
    ok: false,
    setData(items) { data = items; lay = layout(items); draw(); },
    setHeld(l) { held = new Set(l); draw(); },
    setPending(l) { pend = new Set(l); draw(); },
    setWatch(l) { watch = new Set(l); draw(); },
    select(c) { sel = c; draw(); },
    ignite() {}, focus() {}, reset() {},
    dispose() { wrap.remove(); },
  };
}
