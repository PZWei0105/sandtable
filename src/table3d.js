/* 沙盤 — 3D 戰情沙盤：每一檔 ETF 是一塊六角地形，依類別分成一座座島；
   今天漲越多地形越高、顏色越紅，跌的下陷、偏綠（台股紅漲綠跌）；你持有的插藍旗，掛著的委託有藍色光圈。
   沒有 WebGL 時退回平面六角地圖。 */
import * as THREE from '../vendor/three.module.min.js';

const SQ3 = Math.sqrt(3);
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const CAT_ORDER = ['broad', 'div', 'theme', 'active', 'overseas', 'bond', 'lev', 'inv', 'fut'];
export const CAT_NAME = {
  broad: '市值型', div: '高股息', theme: '產業主題', overseas: '海外股票', bond: '債券',
  lev: '槓桿型', inv: '反向型', fut: '期貨商品', active: '主動式',
};
const C = {
  room: 0x0f120e, felt: 0x1a2117, rim: 0x3a2a1a, sand: 0xcdb88f, up: 0xff4a55, down: 0x1fbf86,
  blue: 0x4f86ff, brass: 0xd9a441,
};

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
function hexDist(a, b) {
  return (Math.abs(a[0] - b[0]) + Math.abs(a[0] + a[1] - b[0] - b[1]) + Math.abs(a[1] - b[1])) / 2;
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
  return { cells, regions, w: maxX - minX + 2, h: maxZ - minZ + 2 };
}

export function heightOf(pct) {
  if (pct == null || !Number.isFinite(pct)) return 0.5;
  const p = Math.max(-4, Math.min(10, pct));
  return p >= 0 ? 0.55 + p * 0.2 : Math.max(0.07, 0.55 + p * 0.12);
}
function colorOf(pct, out) {
  const base = new THREE.Color(C.sand);
  if (pct == null || !Number.isFinite(pct) || Math.abs(pct) < 0.05) return out.copy(base);
  const k = 0.2 + 0.8 * Math.min(1, Math.abs(pct) / 2.5);
  return out.copy(base).lerp(new THREE.Color(pct > 0 ? C.up : C.down), k);
}

// ------------------------------------------------------------------ 材質
function sandTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 205 + Math.floor(Math.random() * 50);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function feltTexture(size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(256, 256, 20, 256, 256, 256);
  grd.addColorStop(0, '#3a4630');
  grd.addColorStop(0.45, '#232c1f');
  grd.addColorStop(1, '#0f130d');
  g.fillStyle = grd;
  g.fillRect(0, 0, 512, 512);
  // 細細的方格（作戰地圖的座標格）
  g.strokeStyle = 'rgba(205,184,143,0.06)';
  g.lineWidth = 1;
  const step = 512 / size;
  for (let i = 0; i <= size; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i * step); g.lineTo(512, i * step); g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function textSprite(text, sub, { color = '#e9dcc0', size = 64 } = {}) {
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d');
  const font = `700 ${size}px "LXGW WenKai TC", "Noto Sans TC", serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 24;
  cv.width = Math.max(w, 64);
  cv.height = Math.ceil(size * (sub ? 1.75 : 1.25));
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.shadowColor = 'rgba(0,0,0,0.85)';
  g.shadowBlur = 10;
  g.fillStyle = color;
  g.fillText(text, cv.width / 2, 4);
  if (sub) {
    g.font = `600 ${Math.round(size * 0.42)}px "Barlow Condensed", "Noto Sans TC", sans-serif`;
    g.fillStyle = 'rgba(233,220,192,0.7)';
    g.fillText(sub, cv.width / 2, size * 1.18);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: true });
  const s = new THREE.Sprite(m);
  const h = 2.0;
  s.scale.set((cv.width / cv.height) * h * (sub ? 1.75 / 1.25 : 1), h * (sub ? 1.4 : 1), 1);
  s.userData.dispose = () => { t.dispose(); m.dispose(); };
  return s;
}
function flagTexture(code) {
  const cv = document.createElement('canvas');
  cv.width = 192;
  cv.height = 120;
  const g = cv.getContext('2d');
  g.fillStyle = '#3d74f0';
  g.fillRect(0, 0, 192, 120);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(0, 0, 192, 10);
  g.fillStyle = '#f4efe2';
  g.font = '700 54px "Barlow Condensed", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(code, 96, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
  const hi = quality === 'high' || (quality === 'auto' && window.matchMedia('(min-width: 1100px)').matches);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hi ? 2 : 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = hi;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(C.room, 1);
  wrap.insertBefore(renderer.domElement, labels);
  renderer.domElement.className = 'st-canvas';

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C.room, 30, 70);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 200);
  const target = new THREE.Vector3(0, 0, 0);
  const cam = { az: -0.55, pol: 0.92, dist: 40, fit: 40 };

  const hemi = new THREE.HemisphereLight(0xfff0d2, 0x1a2117, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffd9a6, 0);
  key.position.set(-10, 22, 12);
  key.castShadow = hi;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -24; key.shadow.camera.right = 24; key.shadow.camera.top = 24; key.shadow.camera.bottom = -24;
  key.shadow.bias = -0.0008;
  scene.add(key);
  const rimL = new THREE.DirectionalLight(0x6f8fff, 0.25);
  rimL.position.set(14, 6, -16);
  scene.add(rimL);

  // 桌面與木框
  let table = null;
  let rim = null;
  function buildTable(w, h) {
    if (table) { scene.remove(table); table.geometry.dispose(); table.material.map.dispose(); table.material.dispose(); }
    if (rim) { scene.remove(rim); rim.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
    const W = Math.max(w, h) + 10;
    table = new THREE.Mesh(new THREE.PlaneGeometry(W, W), new THREE.MeshStandardMaterial({ map: feltTexture(14), roughness: 1, metalness: 0 }));
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    scene.add(table);
    rim = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: C.rim, roughness: 0.7, metalness: 0.05 });
    const brass = new THREE.MeshStandardMaterial({ color: C.brass, roughness: 0.35, metalness: 0.8 });
    const t = 0.7;
    for (const [x, z, sx, sz] of [[0, -W / 2, W + t * 2, t], [0, W / 2, W + t * 2, t], [-W / 2, 0, t, W], [W / 2, 0, t, W]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.9, sz), wood);
      b.position.set(x, 0.3, z);
      b.castShadow = hi;
      rim.add(b);
    }
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const k = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.0, 16), brass);
      k.position.set((x * W) / 2, 0.38, (z * W) / 2);
      rim.add(k);
    }
    scene.add(rim);
  }

  // 六角地形（一次畫完全部，InstancedMesh）
  const hexGeo = new THREE.CylinderGeometry(0.9, 0.93, 1, 6, 1, false);
  hexGeo.translate(0, 0.5, 0);
  const sandMap = sandTexture();
  const hexMat = new THREE.MeshStandardMaterial({ map: sandMap, roughness: 0.93, metalness: 0 });
  let hexes = null;
  let codes = [];
  let cells = new Map();
  let regions = [];
  let regionSprites = [];
  const info = new Map();          // code → {pct, name, h0, h1, delay}
  const tmpM = new THREE.Matrix4();
  const tmpC = new THREE.Color();
  const tmpV = new THREE.Vector3();

  // 選取標記：黃銅圈＋光柱
  const selRing = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.07, 8, 6), new THREE.MeshStandardMaterial({ color: C.brass, emissive: C.brass, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.7 }));
  selRing.rotation.x = Math.PI / 2;
  selRing.rotation.z = Math.PI / 6;
  selRing.visible = false;
  scene.add(selRing);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.9, 7, 6, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd58a, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  beam.visible = false;
  scene.add(beam);

  // 藍旗（持有）與藍圈（掛單）
  const flags = new Map();
  const rings = new Map();
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.07, 3.0, 6);
  poleGeo.translate(0, 1.5, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.6, metalness: 0.4 });
  const knobMat = new THREE.MeshStandardMaterial({ color: C.brass, roughness: 0.3, metalness: 0.85 });
  const ringGeo = new THREE.TorusGeometry(1.1, 0.1, 6, 6);
  const pillarGeo = new THREE.CylinderGeometry(0.16, 0.16, 2.2, 6, 1, true);
  pillarGeo.translate(0, 1.1, 0);

  let selected = null;
  let anim = null;         // {t0, dur, kind}
  let lampT = reduced ? 1 : 0;
  let lastAct = performance.now();
  let alive = true;
  let visible = true;

  function heightNow(code, now) {
    const s = info.get(code);
    if (!s) return 0.5;
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
      hexes.castShadow = hi;
      hexes.receiveShadow = hi;
      scene.add(hexes);
      buildTable(lay.w, lay.h);
      for (const s of regionSprites) { scene.remove(s); s.userData.dispose(); }
      regionSprites = regions.map((g) => {
        const s = textSprite(CAT_NAME[g.cat] || g.cat, `${g.n} 檔`, { size: 60 });
        s.position.set(g.x, 3.4 + g.R * 0.2, g.z - (g.R + 0.9) * 1.5);
        scene.add(s);
        return s;
      });
      const span = Math.max(lay.w, lay.h);
      cam.fit = span * 1.25 + 6;
      cam.dist = cam.fit;
      scene.fog.near = cam.fit * 0.75;
      scene.fog.far = cam.fit * 1.9;
      for (const c of codes) info.set(c, { pct: null, name: '', h0: 0.02, h1: 0.02, delay: 0 });
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
      s.delay = (Math.hypot(p.x, p.z) / 28) * (o.intro ? 1100 : 500);
      info.set(c, s);
      hexes.setColorAt(i, colorOf(it.pct, tmpC));
    }
    hexes.instanceColor.needsUpdate = true;
    anim = reduced ? null : { t0: now, dur: o.intro ? 900 : 600 };
    if (o.intro && !reduced) lampT = 0;
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
  }

  function setHeld(list) {
    const want = new Set(list);
    for (const [c, g] of flags) {
      if (!want.has(c)) { scene.remove(g); g.userData.dispose(); flags.delete(c); }
    }
    for (const c of want) {
      if (flags.has(c) || !cells.has(c)) continue;
      const g = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.castShadow = hi;
      g.add(pole);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), knobMat);
      knob.position.y = 3.05;
      g.add(knob);
      // 旗子底下一圈藍色的「插旗點」
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.04, 6), new THREE.MeshBasicMaterial({ color: C.blue, transparent: true, opacity: 0.55, depthWrite: false }));
      base.position.set(-0.25, 0.03, -0.15);
      g.add(base);
      const tex = flagTexture(c);
      const clothGeo = new THREE.PlaneGeometry(1.9, 1.15, 12, 4);
      clothGeo.translate(0.95, 0, 0);
      const cloth = new THREE.Mesh(clothGeo, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.7, emissive: 0x1b3a8a, emissiveIntensity: 0.35 }));
      cloth.position.y = 2.4;
      cloth.castShadow = hi;
      cloth.userData.base = clothGeo.attributes.position.array.slice();
      g.add(cloth);
      g.userData = { cloth, drop: performance.now(), dispose: () => { tex.dispose(); clothGeo.dispose(); cloth.material.dispose(); base.geometry.dispose(); base.material.dispose(); } };
      flags.set(c, g);
      scene.add(g);
    }
    kick();
  }
  function setPending(list) {
    const want = new Set(list);
    for (const [c, m] of rings) if (!want.has(c)) { scene.remove(m); m.traverse((o) => { if (o.material) o.material.dispose(); }); rings.delete(c); }
    for (const c of want) {
      if (rings.has(c) || !cells.has(c)) continue;
      // 掛單：藍色光圈＋一道細細的藍光柱（遠遠就看得到）
      const m = new THREE.Group();
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: C.blue, transparent: true, opacity: 0.85, depthWrite: false }));
      ring.rotation.x = Math.PI / 2;
      ring.rotation.z = Math.PI / 6;
      m.add(ring);
      const pillar = new THREE.Mesh(pillarGeo, new THREE.MeshBasicMaterial({ color: C.blue, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      m.add(pillar);
      m.userData = { ring, pillar };
      rings.set(c, m);
      scene.add(m);
    }
    kick();
  }
  function select(c) {
    selected = c && cells.has(c) ? c : null;
    selRing.visible = beam.visible = !!selected;
    kick();
  }

  function updateMarkers(now) {
    const t = now / 1000;
    for (const [c, g] of flags) {
      const p = cells.get(c);
      if (!p) continue;
      const h = heightNow(c, now);
      const age = (now - g.userData.drop) / 1000;
      const drop = reduced ? 0 : Math.max(0, 1 - age / 0.55);
      g.position.set(p.x + 0.25, h + drop * drop * 6, p.z + 0.15);
      // 旗子飄動
      const cloth = g.userData.cloth;
      const pos = cloth.geometry.attributes.position;
      const base = cloth.userData.base;
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3];
        const wave = reduced ? 0 : Math.sin(x * 2.6 - t * 3.2 + p.x) * 0.12 * x;
        pos.array[i * 3 + 2] = base[i * 3 + 2] + wave;
        pos.array[i * 3 + 1] = base[i * 3 + 1] - x * 0.05;
      }
      pos.needsUpdate = true;
    }
    for (const [c, m] of rings) {
      const p = cells.get(c);
      if (!p) continue;
      const h = heightNow(c, now);
      const k = reduced ? 1 : 1 + 0.08 * Math.sin(t * 3.2);
      m.position.set(p.x, h + 0.04, p.z);
      m.userData.ring.scale.set(k, k, k);
      m.userData.ring.material.opacity = reduced ? 0.85 : 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3.2));
      m.userData.pillar.material.opacity = reduced ? 0.25 : 0.14 + 0.16 * (0.5 + 0.5 * Math.sin(t * 3.2 + 1));
    }
    if (selected) {
      const p = cells.get(selected);
      const h = heightNow(selected, now);
      selRing.position.set(p.x, h + 0.06, p.z);
      beam.position.set(p.x, h + 3.5, p.z);
    }
  }

  // ---- 標籤（DOM）：選取的那一格＋今天漲跌最多的幾格
  let labelEls = new Map();
  function labelList() {
    const arr = [...info.entries()].filter(([, s]) => s.pct != null).sort((a, b) => b[1].pct - a[1].pct);
    const pick = new Set([...arr.slice(0, 3), ...arr.slice(-2)].map(([c]) => c));
    if (selected) pick.add(selected);
    return pick;
  }
  function updateLabels(now) {
    const want = labelList();
    for (const [c, el] of labelEls) if (!want.has(c)) { el.remove(); labelEls.delete(c); }
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const boxes = [];
    const order = [...want].sort((a, b) => (a === selected ? -1 : b === selected ? 1 : 0));
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
      const txt = `<b>${c}</b><i>${pct == null ? '—' : (pct > 0 ? '+' : '') + pct.toFixed(2) + '%'}</i>`;
      if (el._t !== txt) { el.innerHTML = txt; el._t = txt; }
      // 有插旗的格子，標籤放到旗子上面，不要把旗子擋住
      tmpV.set(p.x, heightNow(c, now) + (flags.has(c) ? 3.55 : 0.5), p.z).project(camera);
      const x = (tmpV.x * 0.5 + 0.5) * w;
      const y = (-tmpV.y * 0.5 + 0.5) * h;
      let hidden = tmpV.z > 1 || x < -40 || x > w + 40 || y < -20 || y > h + 20;
      // 標籤互相重疊時，後面的先藏起來（選取的那一格優先）
      const bw = 92;
      const bh = 22;
      const box = [x - bw / 2, y - bh, x + bw / 2, y];
      if (!hidden && boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) hidden = true;
      if (!hidden) boxes.push(box);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      el.style.opacity = hidden ? '0' : '1';
    }
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
      cam.pol = Math.max(0.35, Math.min(1.22, cam.pol - dy * 0.0045));
    } else if (ptrs.size === 2 && pinch0) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      cam.dist = Math.max(cam.fit * 0.35, Math.min(cam.fit * 1.4, pinch0.dist * (pinch0.d / Math.max(20, d))));
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
    cam.dist = Math.max(cam.fit * 0.35, Math.min(cam.fit * 1.4, cam.dist * Math.exp(e.deltaY * 0.0012)));
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
  function kick() { if (!raf && alive) raf = requestAnimationFrame(loop); }
  function loop(now) {
    raf = 0;
    if (!alive) return;
    if (!visible || document.hidden) return;
    frame++;
    const idle = now - lastAct > 4000;
    const animating = anim && now - anim.t0 < anim.dur + 1300;
    if (!animating && anim) anim = null;
    if (lampT < 1) lampT = Math.min(1, lampT + 0.018);
    if (!reduced && idle && !ptrs.size) cam.az += 0.00045;
    const skip = idle && !animating && lampT >= 1 && frame % 2 === 1;
    if (!skip) {
      key.intensity = 2.7 * (lampT * lampT);
      hemi.intensity = 0.25 + 0.75 * lampT;
      if (animating) applyHeights(now);
      updateMarkers(now);
      placeCamera();
      renderer.render(scene, camera);
      updateLabels(now);
    }
    const needs = !reduced || animating || lampT < 1 || ptrs.size;
    if (needs) raf = requestAnimationFrame(loop);
  }
  function resize() {
    const w = wrap.clientWidth || 1;
    const h = wrap.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 520 ? 44 : 36;
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
    setData, setHeld, setPending, select,
    ignite() { lampT = reduced ? 1 : 0; kick(); },
    focus(c) {
      const p = cells.get(c);
      if (!p) return;
      target.set(p.x * 0.5, 0, p.z * 0.5);
      cam.dist = Math.max(cam.fit * 0.55, cam.dist * 0.9);
      lastAct = performance.now();
      kick();
    },
    reset() { target.set(0, 0, 0); cam.dist = cam.fit; kick(); },
    dispose() {
      alive = false;
      ro.disconnect(); io.disconnect();
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
  let sel = null;
  function draw() {
    if (!lay) return;
    const w = wrap.clientWidth || 300;
    const h = wrap.clientHeight || 200;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0f120e';
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
        g.lineTo(x + Math.cos(a) * s * 0.9, y + Math.sin(a) * s * 0.9);
      }
      g.closePath();
      colorOf(byC.get(c)?.pct, col);
      g.fillStyle = `#${col.getHexString()}`;
      g.fill();
      if (held.has(c)) { g.strokeStyle = '#4f86ff'; g.lineWidth = 2.5; g.stroke(); }
      if (pend.has(c)) { g.setLineDash([3, 3]); g.strokeStyle = '#4f86ff'; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
      if (c === sel) { g.strokeStyle = '#d9a441'; g.lineWidth = 3; g.stroke(); }
    }
    g.font = '600 13px "LXGW WenKai TC", sans-serif';
    g.fillStyle = 'rgba(233,220,192,0.8)';
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
    select(c) { sel = c; draw(); },
    ignite() {}, focus() {}, reset() {},
    dispose() { wrap.remove(); },
  };
}
