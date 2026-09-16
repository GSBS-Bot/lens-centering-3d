// main.js — M1 接线：数据模型 -> LDM 表格 + 3D 双向同步
import * as THREE from '../vendor/three/three.module.js?v=0.8.4';
import { OrbitControls } from '../vendor/three/OrbitControls.js?v=0.8.4';
import { System, demoSingleElement, DEMO_LENSES, ELEMENTS } from './model.js?v=0.8.4';
import { buildSystemGroup, buildSurfaceMarker, renderLayoutSVG, layoutBadge, setTheme3D } from './geom.js?v=1.1.7';
import { LDM } from './ldm.js?v=0.8.4';
import { importFile, importFriendJson, exportZmx } from './import.js?v=1.4.0';
import { traceFields, firstOrder, autoVignette, traceSpot, traceIllumination, traceWavefront, traceRayFan, fieldAberrations } from './trace.js?v=1.4.7';
import { geometricOTFComplex, diffractionLimit, sampleOtfComplex, otfFromPupil, otfFromOpd, throughFocusFromPupil, throughFocusMultiColor, throughFocusMTF, defocusWaves } from './mtf.js?v=1.4.4';

const STATUS = document.querySelector('.status');
const renderFo = document.getElementById('fo');
const resetBtn = document.getElementById('resetView');
const demoSel = document.getElementById('demoSelect');
const fileInput = document.getElementById('fileInput');
const importBtn = document.getElementById('importFile');
const fmodeEl = document.getElementById('fmode');
const fvalsEl = document.getElementById('fvals');
const npupilEl = document.getElementById('npupil');
const wfnEl = document.getElementById('wfn');
const autoVigBtn = document.getElementById('autoVig');
const tabLayout = document.getElementById('tabLayout');
const tabSpot = document.getElementById('tabSpot');
const tabIllum = document.getElementById('tabIllum');
const spotView = document.getElementById('spotView');
const spotMain = document.getElementById('spotMain');
const spotGrid = document.getElementById('spotGrid');
const spotField = document.getElementById('spotField');
const spotWavelength = document.getElementById('spotWavelength');
const spotAiry = document.getElementById('spotAiry');
const illumView = document.getElementById('illumView');
const illumMain = document.getElementById('illumMain');
const illumGrid = document.getElementById('illumGrid');
const illumN = document.getElementById('illumN');
const illumWavelength = document.getElementById('illumWavelength');
const tabMtf = document.getElementById('tabMtf');
const mtfView = document.getElementById('mtfView');
const mtfMain = document.getElementById('mtfMain');
const mtfAlgo = document.getElementById('mtfAlgo');
const mtfField = document.getElementById('mtfField');
const mtfGrid = document.getElementById('mtfGrid');
const mtfNu = document.getElementById('mtfNu');
const mtfWavelength = document.getElementById('mtfWavelength');
const mtfMode = document.getElementById('mtfMode');
const mtfNuLabel = document.getElementById('mtfNuLabel');
const mtfFocusRange = document.getElementById('mtfFocusRange');
const mtfFocusUnit = document.getElementById('mtfFocusUnit');
const mtfFocusUnitLabel = document.getElementById('mtfFocusUnitLabel');
const tabAber = document.getElementById('tabAber');
const aberView = document.getElementById('aberView');
const aberMain = document.getElementById('aberMain');
const aberType = document.getElementById('aberType');
const aberGrid = document.getElementById('aberGrid');
const aberRange = document.getElementById('aberRange');
const aberField = document.getElementById('aberField');
const aberWavelength = document.getElementById('aberWavelength');
const vigEl = document.getElementById('fieldVig');

function setStatus(msg, ok) {
  if (STATUS) STATUS.textContent = msg;
  if (ok) STATUS.classList.add('ok'); else STATUS.classList.remove('ok');
}
function fail(err) {
  console.error(err);
  setStatus('报错：' + (err && err.message ? err.message : err));
}

// 按 BOM 正确解码 .zmx/.seq（UTF-16 文件无需 .text() 的 UTF-8 破坏）
function lensTextFromBuffer(buf) {
  const u = new Uint8Array(buf);
  if (u.length > 1 && u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(u);
  if (u.length > 1 && u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u);
  return new TextDecoder('utf-8').decode(u);
}
// 载入系统后，把视场/模式/波长/工作F数同步到左侧面板
let pendingAutoVig = false;   // 文件未给 F# → 置 1 并自动渐晕(得到按净口径的 F#)
function applyPanelFromSys() {
  if (fvalsEl) {
    // 视场取自文件读取(sys.fields)；无则仅轴上(0)。不编造 0.707/满场。
    const f = (sys.fields && sys.fields.length) ? sys.fields : [0];
    fvalsEl.value = f.join(' ');
  }
  if (fmodeEl) fmodeEl.value = (sys.fmode === 'height') ? 'height' : 'angle';
  // 工作F数：文件有 F# 用之；否则置 1 并标记自动渐晕
  const fno = sys.fno;
  if (isFinite(fno) && fno > 0) { if (wfnEl) wfnEl.value = +(+fno).toFixed(2); pendingAutoVig = false; }
  else { if (wfnEl) wfnEl.value = 1; pendingAutoVig = true; }
  renderWaveEditor();
}

// ---------- Three.js scene ----------
const scene = new THREE.Scene();
// 主题：3D 背景/网格随主题切换（面板配色由 css 变量控制）
const THEMES = {
  blue:     { bg:'#0e131a', grid1:'#26313d', grid2:'#1d2631', ray:0xffffff, accent:0x4cc2ff, accentSoft:0x66d9ff, accentEdge:0x8fe6ff },
  graphite: { bg:'#141414', grid1:'#333333', grid2:'#242424', ray:0xffffff, accent:0xcfd8e3, accentSoft:0xbfc9d4, accentEdge:0xaab6c2 },
  violet:   { bg:'#120e1b', grid1:'#3a2d52', grid2:'#271f37', ray:0xffffff, accent:0xb388ff, accentSoft:0x9d6ff0, accentEdge:0xc9aaff },
  forest:   { bg:'#0d1512', grid1:'#28483c', grid2:'#1d3128', ray:0xffffff, accent:0x5fd0a0, accentSoft:0x49b98a, accentEdge:0x8fe6c4 },
  light:    { bg:'#eef1f5', grid1:'#c7d0d9', grid2:'#dde3e9', ray:0x2b3a48, accent:0x0b7fc4, accentSoft:0x2a9fd6, accentEdge:0x3aa7dd },
};
let rayBaseColor = 0xffffff;
let currentTheme = 'blue';
scene.background = new THREE.Color(THEMES.blue.bg);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);            // 3D 透视
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('view'), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const layout2dEl = document.getElementById('layout2d');   // 2D 剖面 SVG（参考站形式）
const layoutBadgeEl = document.getElementById('layoutBadge');
const vertEl = document.getElementById('vertReadout');    // 3D 顶点坐标小窗

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight('#dcefff', '#10141c', 1.0));
const dir = new THREE.DirectionalLight('#ffffff', 1.6);
dir.position.set(20, 30, 20);
scene.add(dir);
let grid = new THREE.GridHelper(200, 50, THEMES.blue.grid1, THEMES.blue.grid2);
scene.add(grid);

function applyTheme(name, rerender) {
  if (!THEMES[name]) name = 'blue';
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('lens3d-theme', name); } catch (e) {}
  const t = THEMES[name];
  rayBaseColor = t.ray;
  currentTheme = name;
  if (scene.background && scene.background.isColor) scene.background.set(t.bg);
  else scene.background = new THREE.Color(t.bg);
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    if (grid.material) grid.material.dispose();
    grid = new THREE.GridHelper(200, 50, t.grid1, t.grid2);
    scene.add(grid);
  }
  if (typeof setTheme3D === 'function') setTheme3D({ accent: t.accent, accentSoft: t.accentSoft, accentEdge: t.accentEdge });
  const sw = document.getElementById('themeSwitch');
  if (sw) sw.querySelectorAll('.theme-dot').forEach(b => b.classList.toggle('active', b.dataset.theme === name));
  if (rerender) { try { rebuildScene(false); renderLayout2D(); refreshActivePanel(); } catch (e) {} }
}
(function initTheme() {
  let saved = 'blue';
  try { saved = localStorage.getItem('lens3d-theme') || 'blue'; } catch (e) {}
  applyTheme(saved, false);
  const sw = document.getElementById('themeSwitch');
  if (sw) sw.addEventListener('click', e => {
    const b = e.target.closest('.theme-dot');
    if (b) applyTheme(b.dataset.theme, true);
  });
})();
const origin = new THREE.AxesHelper(30); origin.material.opacity = 0.25; origin.material.transparent = true;
scene.add(origin);

const rayGroup = new THREE.Group();
scene.add(rayGroup);

// ---------- 数据与 3D 同步 ----------
let sys = demoSingleElement();
let lensGroup = null;
let surfaceList = [];
let lensMeshes = [];
let highlightObj = null;
let frontZ = null;      // 第一个镜片前表面顶点 z（显示裁切起点，物方不显示）

// ---- 视图预设（参考 Zemax 三维布局的方向）：等轴测 / X-Y / Y-Z / X-Z ----
// 坐标约定：光轴=+Z，像面中心=原点(0,0,0)，镜头实体位于 -Z（物方）侧。
const VIEW_PRESETS = {
  iso: { dir: new THREE.Vector3(0.8, -0.45, -0.8).normalize(), up: new THREE.Vector3(0, 1, 0) },
  xy:  { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) },   // 从物方看入瞳（X-Y 平面）
  yz:  { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },  // 剖面：沿 X 看（Y-Z 平面）
  xz:  { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1) }, // 侧面：沿 Y 看（X-Z 平面）
};

let viewMode = '2d';
function setActiveView(mode) {
  viewMode = mode;
  document.querySelectorAll('#viewSeg .vbtn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === mode));
}

// 镜片包围盒 + 像面中心 + 视场光束(仅首面→像面, 不含物方)，作为取景基准
function sceneBox() {
  const box = new THREE.Box3();
  if (lensMeshes.length) for (const m of lensMeshes) box.expandByObject(m);
  else box.set(new THREE.Vector3(-12, -12, -50), new THREE.Vector3(12, 12, 2));
  box.expandByPoint(new THREE.Vector3(0, 0, 0));     // 把像面中心纳入
  // 纳入视场光束(从首面起)，物方不参与
  const clipMin = (frontZ == null) ? -1e9 : frontZ;
  if (lastTrace.fields) for (const fd of lastTrace.fields) {
    const list = (fd.lams && fd.lams.length) ? fd.lams : [{ chief: fd.chief, rays: fd.rays }];
    for (const lam of list) for (const r of (lam.chief ? [lam.chief] : []).concat(lam.rays || [])) {
      if (!r.pts) continue;
      for (const p of r.pts) { if (p.length < 3 || p[2] < clipMin) continue; box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2])); }
    }
  }
  return box;
}

function showLayout2D(on) {
  const cv = document.getElementById('view');
  if (cv) cv.style.display = on ? 'none' : 'block';
  if (layout2dEl) layout2dEl.classList.toggle('show', on);
}
function fitCamera(mode) {
  if (mode === '2d') {                 // 2D 光路作为 3D 视图区的一种视图
    setActiveView('2d');
    showLayout2D(true);
    renderLayout2D();
    return;
  }
  showLayout2D(false);
  const box = sceneBox();
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxdim = Math.max(size.x, size.y, size.z, 40);
  const p = VIEW_PRESETS[mode] || VIEW_PRESETS.iso;
  controls.enableRotate = true;                    // 3D 可用旋转
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  camera.up.copy(p.up);
  camera.position.copy(center).addScaledVector(p.dir, maxdim * 1.7);
  controls.target.copy(center);
  setActiveView(mode);
  controls.update();
}

// ---- 2D 剖面（常驻面板，位于 3D 上方）----
const layout = { scale: 1, tx: 0, ty: 0 };
function layoutApply() {
  const r = layout2dEl.querySelector('#lgRoot');
  if (r) r.setAttribute('transform', `translate(${layout.tx} ${layout.ty}) scale(${layout.scale})`);
}
let selectedSurface = null;   // 当前选中的面（供 2D 高亮）
function renderLayout2D() {
  if (!surfaceList || !surfaceList.length) return;   // 系统尚未构建
  layout.scale = 1; layout.tx = 0; layout.ty = 0;   // 每次重建回到自适应
  renderLayoutSVG(layout2dEl, sys, surfaceList, {
    rays: collateFieldRays(lastTrace.fields),
    imageMarks: lastTrace.fields.map(fd => ({ y: fd.chief?.imageY, field: fd.field, mode: fd.mode })),
    highlightIdx: selectedSurface,
  });
  layoutApply();
  if (layoutBadgeEl) layoutBadgeEl.textContent = layoutBadge(sys);
}

// ---- M2a：视场光线（瞄准到光阑）+ 一阶量 + 入瞳 ----
const FIELDCOLS = [0xffd633, 0xff8a3c, 0xff5a5a, 0xe06bff, 0x5aa7ff, 0x59e0c0, 0xd0e84a];
let lastTrace = { fields: [], fo: null, EP: null, vig: null, primaryNm: null };
let primaryNm = null;
let waveState = [];
const WLP = { F: 486.13, d: 587.56, C: 656.27, e: 546.07, g: 435.83 };
const wlTableEl = document.getElementById('wltable');

// 按波长自动配色(可见光谱近似, 十六进制): 400紫→486蓝→546绿→588黄→656红
function wlColor(nm) {
  nm = +nm || 587.56;
  const A = [[400, '#7a3bff'], [435, '#5a5aff'], [486, '#0eb6ff'], [546, '#00d24a'], [588, '#ffb300'], [656, '#ff2d00'], [720, '#ff2d00']];
  const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  if (nm <= A[0][0]) return A[0][1];
  for (let i = 1; i < A.length; i++) {
    if (nm <= A[i][0]) {
      const [n1, c1] = A[i - 1], [n2, c2] = A[i];
      const t = (nm - n1) / (n2 - n1), r = rgb(c1), g = rgb(c2);
      return '#' + r.map((v, j) => Math.round(v + (g[j] - v) * t).toString(16).padStart(2, '0')).join('');
    }
  }
  return A[A.length - 1][1];
}
function effColor(w) { return (w && w.color && String(w.color).trim() !== '') ? w.color : wlColor(+w.nm || 587.56); }

function activeLambdas() {
  const list = waveState.length ? waveState : [{ nm: 587.56, weight: 1, color: '#ffb300', primary: true }];
  let primary = list.findIndex(w => w.primary); if (primary < 0) primary = 0;
  return { lambdas: list.map(w => ({ nm: +w.nm || 587.56, weight: Math.max(0, +w.weight || 0), color: effColor(w) })), primary };
}
function renderWaveEditor() {
  if (!wlTableEl) return;
  wlTableEl.innerHTML = waveState.map((w, i) => `
    <div class="wl-row">
      <input type="radio" name="wlpri" data-i="${i}" ${w.primary ? 'checked' : ''} title="主波长">
      <input class="wlnm" data-i="${i}" data-k="nm" value="${w.nm}" spellcheck="false" title="波长 nm">
      <input data-i="${i}" data-k="weight" type="number" step="0.1" min="0" value="${w.weight}" title="权重">
      <span class="sw" style="background:${effColor(w)}"></span>
      <input data-i="${i}" data-k="color" value="${w.color}" placeholder="空=自动" spellcheck="false" title="颜色(留空自动配色)">
      <button class="del" data-i="${i}" data-act="del" title="删除">✕</button>
    </div>`).join('');
}
function bindWaveEditor() {
  if (!wlTableEl) return;
  wlTableEl.addEventListener('input', e => {
    const t = e.target; if (!t.dataset.i || !t.dataset.k) return;
    const i = +t.dataset.i, k = t.dataset.k;
    waveState[i][k] = (k === 'weight') ? parseFloat(t.value || 0) : t.value;
    refreshField();
  });
  wlTableEl.addEventListener('change', e => {
    const t = e.target;
    if (t.name === 'wlpri' && t.dataset.i != null) {
      const i = +t.dataset.i; waveState.forEach((w, j) => w.primary = (j === i));
      renderWaveEditor(); refreshField();
    }
  });
  wlTableEl.addEventListener('click', e => {
    const b = e.target.closest('.del'); if (!b) return;
    const i = +b.dataset.i; waveState.splice(i, 1);
    if (!waveState.length) waveState = [{ nm: 587.56, weight: 1, color: '#ffb300', primary: true }];
    renderWaveEditor(); refreshField();
  });
  document.getElementById('wlAdd').addEventListener('click', () => {
    waveState.push({ nm: 587.56, weight: 1, color: '', primary: false });   // 颜色留空=自动
    renderWaveEditor(); refreshField();
  });
  document.getElementById('wlPreset').addEventListener('click', () => {
    waveState = [
      { nm: 486.13, weight: 1, color: '#0eb6ff', primary: false },
      { nm: 587.56, weight: 1, color: '#ffb300', primary: true },
      { nm: 656.27, weight: 1, color: '#ff2d00', primary: false },
    ];
    renderWaveEditor(); refreshField();
  });
  document.getElementById('wlOnly').addEventListener('click', () => {
    const w = waveState.find(x => x.primary) || waveState[0] || { nm: 587.56, weight: 1, color: '#ffb300' };
    waveState = [{ ...w, weight: w.weight ?? 1, primary: true }];
    renderWaveEditor(); refreshField();
  });
}
function syncWave(newSys) {
  const wl = (newSys.wavelengths && newSys.wavelengths.length)
    ? newSys.wavelengths
    : [{ nm: 587.56, weight: 1, color: '#ffb300' }];
  waveState = wl.map((w, i) => ({ nm: w.nm, weight: w.weight ?? 1, color: w.color || '', primary: i === newSys.primary }));
}
function parseFields(v) {
  return String(v || '').split(/[,;\s]+/).map(s => parseFloat(s)).filter(n => isFinite(n));
}
// 把选定视场映射到 sys.vigCoefs（按视场值就近匹配），供点列/照度/MTF 裁剪光瞳
function vigForFields(fields) {
  const all = sys.vigCoefs;
  if (!Array.isArray(all) || !all.length) return null;
  const fl = sys.fields || [];
  return fields.map(fv => {
    let bi = -1, bd = 1e9;
    for (let i = 0; i < fl.length; i++) { const d = Math.abs((fl[i] ?? 0) - fv); if (d < bd) { bd = d; bi = i; } }
    return bi >= 0 ? (all[bi] || null) : null;
  });
}
function updateRays() {
  rayGroup.clear();
  let fields = [], fo = null, EP = null, vig = null;
  try {
    const wfn = parseFloat(wfnEl?.value);
    if (isFinite(wfn) && wfn > 0) { sys.fno = wfn; sys.apmode = 'fno'; }
    const mode = fmodeEl?.value || 'angle';
    const list = parseFields(fvalsEl?.value); if (!list.length) list.push(0);
    const nPupil = Math.max(1, Math.min(33, parseInt(npupilEl?.value, 10) || 15)) | 0;
    const wl = activeLambdas();
    const res = traceFields(sys, surfaceList, { mode, fields: list, nPupil, lambdas: wl.lambdas, primary: wl.primary, vigCoefs: (sys.vigCoefs || null) });
    fields = res.fields; EP = res.EP; primaryNm = res.primaryNm;
    fo = firstOrder(sys, surfaceList);
    let nRay = 0, nVig = 0, nSample = 0, nTrace = 0;
    const addLine = (tr, col, edge, alpha) => {
      if (!tr || !tr.pts) return;
      const pts = clipPts(tr.pts);
      if (!pts || pts.length < 2) return;
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])));
      const vigDim = tr.vignetted ? Math.max(0.1, 0.25) : alpha;
      rayGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: edge ? col : rayBaseColor, transparent: true,
        opacity: edge ? Math.min(1, vigDim + 0.15) : vigDim * 0.6,
      })));
    };
    for (const fd of fields) {
      for (const lam of fd.lams) {
        const col = adaptHexNum(cssToHex(lam.color));
        for (const r of lam.rays) { nRay++; addLine(r, col, false, 0.5); }
        nSample += lam.nSample || 0;
        nVig += lam.nVig || 0;
        nTrace += lam.nTrace || 0;
        addLine(lam.chief, col, true, lam.primary ? 1.0 : 0.72);
      }
    }
    vig = { nRay, nVig, nSample, nTrace, nField: fields.length };
    // 像面盘直径跟随视场(像高)：刚好包住各视场光线落点
    if (lensGroup) {
      const imgMesh = lensGroup.getObjectByName('imagePlane');
      if (imgMesh) {
        let rImg = 4;
        for (const fd of fields) for (const lam of (fd.lams || [])) {
          for (const r of (lam.chief ? [lam.chief] : []).concat(lam.rays || [])) if (r && r.imageY != null) rImg = Math.max(rImg, Math.abs(r.imageY));
        }
        const R = rImg * 1.12 + 1;
        if (imgMesh.userData.R !== R) {
          imgMesh.userData.R = R;
          imgMesh.geometry.dispose();
          imgMesh.geometry = new THREE.CircleGeometry(R, 96);
          const edge = lensGroup.getObjectByName('imagePlaneEdge');
          if (edge) { edge.geometry.dispose(); edge.geometry = new THREE.EdgesGeometry(new THREE.CircleGeometry(R, 96), 0); }
        }
      }
    }
  } catch (e) { console.error('追迹报错', e); }
  lastTrace = { fields, fo, EP, vig, primaryNm };
  if (renderFo) {
    const f = fo && isFinite(fo.efl);
    const ep = EP ? `入瞳⊙${(EP.epd || 0).toFixed(2)}mm` : '';
    const vt = (vig && vig.nSample) ? `渐晕截断 ${vig.nVig}/${vig.nTrace}/${vig.nSample}` : '';
    const wn = primaryNm ? `@${primaryNm}nm` : '';
    renderFo.textContent = (f ? `EFL=${fo.efl.toFixed(2)}mm · BFL=${fo.bfl.toFixed(2)}mm · F#${fo.fno.toFixed(2)}` : '追迹—') +
      (ep ? ` · ${ep}` : '') + (vt ? ` · ${vt}` : '') + (wn ? ` · ${wn}` : '');
    renderFo.classList.add('show');
  }
  if (vigEl) {
    const ih = fields.map(fd => fd.chief ? (fd.chief.imageY != null ? fd.chief.imageY.toFixed(2) : '—') : '—').join('/');
    const vigOn = Array.isArray(sys.vigCoefs);
    vigEl.textContent = (vig && vig.nSample)
      ? `视场 ${vig.nField} 束 · 被截断/实际追迹/总 ${vig.nVig}/${vig.nTrace}/${vig.nSample} · 显示 ${vig.nRay} · 像高 ${ih}mm` + (vigOn ? ' · 自动渐晕' : '')
      : '未追迹';
    vigEl.classList.toggle('bad', !!(vig && vig.nVig > 0));
  }
  if (autoVigBtn) {
    const on = Array.isArray(sys.vigCoefs);
    autoVigBtn.textContent = on ? '清除渐晕' : '自动渐晕';
    autoVigBtn.classList.toggle('active', on);
  }
}
// 把多视场光线收集成 2D 渲染用数组（按波长分色；从首面起，物方不显示）
function collateFieldRays(fields) {
  const out = [];
  for (const fd of fields) {
    for (const lam of fd.lams) {
      const c = adaptHexStr(lam.color || '#ffd633');
      if (lam.chief) { const pts = clipPts(lam.chief.pts); if (pts && pts.length >= 2) out.push({ pts, color: c, edge: true, alpha: lam.chief.vignetted ? 0.4 : 1.0 }); }
      for (const r of lam.rays) { const pts = clipPts(r.pts); if (pts && pts.length >= 2) out.push({ pts, color: c, alpha: r.vignetted ? 0.25 : 0.7, dash: r.vignetted ? '4 3' : null }); }
    }
  }
  return out;
}
// 裁剪光线到首镜片前表面起（物方不显示）；无 frontZ 时不裁
function clipPts(pts) {
  if (!pts || !pts.length) return pts;
  const c = (frontZ == null) ? -Infinity : (frontZ - 0.5);
  return pts.filter(p => p.length < 3 || p[2] >= c);
}
function cssToHex(c) {
  let s = String(c || '#ffb300');
  if (s[0] === '#') {
    if (s.length === 7) return parseInt(s.slice(1), 16);
    if (s.length === 4) return parseInt('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3].slice(1), 16);
  }
  return 0xffb300;
}
// 浅色主题下把过亮/过浅的颜色压暗，保证白底可读（深色主题原样返回）
function adaptHexNum(n) {
  if (currentTheme !== 'light') return n >>> 0;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const f = lum > 0.55 ? Math.max(0.45, 0.55 / lum) : 1;
  return ((Math.round(r * f) << 16) | (Math.round(g * f) << 8) | Math.round(b * f)) >>> 0;
}
function adaptHexStr(hex) { return '#' + adaptHexNum(cssToHex(hex)).toString(16).padStart(6, '0'); }
// ---- 点列图（M2b 第一步，参照 Zemax 样式）：每视场一子图、按波长分色、含比例尺/RMS·GEO ----
// 艾里斑半径(第一暗环) = 1.22·λ·F#  (λ 转成 mm)
function airyRadius(fno, lambdaUm) {
  if (!isFinite(lambdaUm) || lambdaUm <= 0) return 0;
  return 1.22 * (lambdaUm / 1000) * fno;
}

function setPanelTab(which) {
  const isSpot = which === 'spot';
  const isIllum = which === 'illum';
  const isMtf = which === 'mtf';
  const isAber = which === 'aber';
  if (spotView) spotView.classList.toggle('on', isSpot);
  if (illumView) illumView.classList.toggle('on', isIllum);
  if (mtfView) mtfView.classList.toggle('on', isMtf);
  if (aberView) aberView.classList.toggle('on', isAber);
  if (tabSpot) tabSpot.classList.toggle('active', isSpot);
  if (tabIllum) tabIllum.classList.toggle('active', isIllum);
  if (tabMtf) tabMtf.classList.toggle('active', isMtf);
  if (tabAber) tabAber.classList.toggle('active', isAber);
  if (isSpot) updateSpot();
  else if (isIllum) updateIllum();
  else if (isMtf) updateMtf();
  else if (isAber) updateAber();
}
function populateSpotSelects() {
  if (spotField) {
    const list = parseFields(fvalsEl?.value); if (!list.length) list.push(0);
    const cur = spotField.value;
    spotField.innerHTML = '<option value="all">全部</option>' + list.map(f => `<option value="${f}">${f}</option>`).join('');
    spotField.value = (cur && spotField.querySelector(`option[value="${cur}"]`)) ? cur : 'all';
  }
  if (spotWavelength) {
    const wl = activeLambdas().lambdas;
    const cur = spotWavelength.value;
    spotWavelength.innerHTML = '<option value="all">全部</option>' + wl.map(w => `<option value="${w.nm}">${Math.round(w.nm)}nm</option>`).join('') + '<option value="primary">主波长</option>';
    if (!spotWavelength.querySelector(`option[value="${cur}"]`)) spotWavelength.value = 'all';
  }
}
function updateSpot() {
  if (!spotMain) return;
  const nGrid = Math.max(5, Math.min(41, parseInt(spotGrid?.value, 10) || 15)) | 0;
  const wlAll = activeLambdas().lambdas;
  const pri = wlAll[activeLambdas().primary] || wlAll[0];
  const wsel = spotWavelength?.value || 'all';
  const wlList = wsel === 'all' ? wlAll : (wsel === 'primary' ? [pri] : wlAll.filter(w => String(w.nm) === wsel));
  const fsel = spotField?.value || 'all';
  const fields = fsel === 'all' ? (parseFields(fvalsEl?.value).length ? parseFields(fvalsEl.value) : [0]) : [+fsel];
  const spots = [];
  let gwin = 1e-3;
  const vigs = vigForFields(fields);
  fields.forEach((fv, fi) => {
    const groups = wlList.map(w => {
      const s = traceSpot(sys, surfaceList, { mode: fmodeEl?.value || 'angle', field: fv, lambdaUm: w.nm / 1000, nGrid, vigCoef: vigs ? vigs[fi] : null });
      return { nm: w.nm, weight: w.weight, color: w.color || '#ffb300', points: s.points };
    });
    // 质心 / RMS / GEO：按波长权重加权（权重全为 0 时退化为等权）
    const rawW = gr => { const v = +gr.weight; return (isFinite(v) && v >= 0) ? v : 1; };
    let wsum = 0;
    for (const gr of groups) wsum += rawW(gr) * gr.points.length;
    const wgtOf = gr => (wsum > 0 ? rawW(gr) : 1);
    if (!(wsum > 0)) { wsum = 0; for (const gr of groups) wsum += gr.points.length; }
    let cx = 0, cy = 0;
    for (const gr of groups) { const wgt = wgtOf(gr); for (const p of gr.points) { cx += wgt * p[0]; cy += wgt * p[1]; } }
    cx /= (wsum || 1); cy /= (wsum || 1);
    let rms = 0, geo = 0;
    for (const gr of groups) { const wgt = wgtOf(gr); for (const p of gr.points) { const dx = p[0] - cx, dy = p[1] - cy, d2 = dx * dx + dy * dy; rms += wgt * d2; if (d2 > geo) geo = d2; } }
    rms = Math.sqrt(rms / (wsum || 1)); geo = Math.sqrt(geo);
    gwin = Math.max(gwin, geo * 1.6);
    spots.push({ field: fv, groups, cx, cy, rms, geo, imageY: cy });
  });
  const fno = (lastTrace.fo && isFinite(lastTrace.fo.fno)) ? lastTrace.fo.fno : (sys.fno || 0);
  const airyR = (spotAiry?.checked && fno > 0) ? airyRadius(fno, pri.nm / 1000) : 0;
  renderSpotSVG(spotMain, spots, wlList, gwin, pri.nm, airyR);
}
function renderSpotSVG(el, spots, wlList, win, primaryNm, airyR) {
  const pad = 10, headerH = 30, cellW = 250, plotSize = 168, titleH = 22, imgH = 20, gap = 14, tableH = 78;
  const cols = Math.max(1, spots.length);   // 一字排开：每视场一列
  const rows = Math.ceil(spots.length / cols);
  const W = pad * 2 + cols * cellW + (cols - 1) * gap;
  const H = headerH + rows * (plotSize + titleH + imgH + 10) + (rows - 1) * gap + tableH + pad;
  const mode = fmodeEl?.value || 'angle';
  const g = [];
  g.push(`<text x="${pad}" y="18" fill="#E6EDF1" font-size="13" font-weight="600" font-family="ui-monospace,monospace">点列图 · 面： 像面</text>`);
  // 右上波长图例
  let lx = W - pad - 44;
  for (let i = wlList.length - 1; i >= 0; i--) {
    const w = wlList[i];
    g.push(`<circle cx="${lx + 5}" cy="12" r="4.5" fill="${adaptHexStr(w.color)}"/>`);
    g.push(`<text x="${lx + 14}" y="16" fill="#9caab4" font-size="10" text-anchor="start" font-family="ui-monospace,monospace">${w.nm.toFixed(2)}</text>`);
    lx -= 52;
  }
  const sc = (plotSize / 2) / win;
  spots.forEach((s, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * (cellW + gap), y = headerH + row * (plotSize + titleH + imgH + 10 + gap);
    const fieldLabel = mode === 'height' ? `像高: ${s.field.toFixed(2)} (mm)` : `物面: ${s.field.toFixed(2)} (度)`;
    g.push(`<text x="${x}" y="${y + 12}" fill="#E6EDF1" font-size="11.5" font-family="ui-monospace,monospace">${fieldLabel}</text>`);
    const px = x, py = y + 16;
    // 网格背景
    for (let k = 0; k <= 10; k++) {
      const off = k / 10 * plotSize;
      g.push(`<line x1="${(px + off).toFixed(1)}" y1="${py}" x2="${(px + off).toFixed(1)}" y2="${py + plotSize}" stroke="#1b232d" stroke-width="1"/>`);
      g.push(`<line x1="${px}" y1="${(py + off).toFixed(1)}" x2="${px + plotSize}" y2="${(py + off).toFixed(1)}" stroke="#1b232d" stroke-width="1"/>`);
    }
    g.push(`<rect x="${px}" y="${py}" width="${plotSize}" height="${plotSize}" fill="none" stroke="#4F7D89" stroke-width="1"/>`);
    // 点(按波长分色)；质心为原点
    const cX = px + plotSize / 2, cY = py + plotSize / 2;
    for (const gr of s.groups) for (const p of gr.points)
      g.push(`<circle cx="${(cX + (p[0] - s.cx) * sc).toFixed(2)}" cy="${(cY - (p[1] - s.cy) * sc).toFixed(2)}" r="1.2" fill="${adaptHexStr(gr.color)}" opacity=".92"/>`);
    g.push(`<circle cx="${cX}" cy="${cY}" r="1.6" fill="#4cc2ff"/>`);
    if (airyR > 0) g.push(`<circle cx="${cX}" cy="${cY}" r="${(airyR * sc).toFixed(2)}" fill="none" stroke="#3ddc97" stroke-width="1" stroke-dasharray="3 2" opacity=".8"/>`);
    // 左侧比例尺(窗口半宽 wn=win, 标注盒宽 2*win, μm)
    const sbX = px - 4;
    g.push(`<line x1="${sbX}" y1="${py}" x2="${sbX}" y2="${py + plotSize}" stroke="#9caab4" stroke-width="1"/>`);
    g.push(`<line x1="${sbX - 4}" y1="${py}" x2="${sbX}" y2="${py}" stroke="#9caab4"/>`);
    g.push(`<text x="${sbX - 5}" y="${py + 4}" fill="#9caab4" font-size="9" text-anchor="end" font-family="ui-monospace,monospace">${(win * 2000).toFixed(0)}</text>`);
    // 像面
    g.push(`<text x="${x}" y="${py + plotSize + 18}" fill="#9caab4" font-size="11" font-family="ui-monospace,monospace">像面: ${Math.abs(s.imageY || 0).toFixed(3)} mm</text>`);
  });
  // 底部 RMS / GEO 表
  const ty = headerH + rows * (plotSize + titleH + imgH + 10) + (rows - 1) * gap + 6;
  g.push(`<text x="${pad}" y="${ty + 14}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">视场      : ${spots.map((s, i) => ('' + (i + 1))).join('          ')}</text>`);
  g.push(`<text x="${pad}" y="${ty + 30}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">RMS 半径  : ${spots.map(s => (s.rms * 1000).toFixed(1)).join('       ')}</text>`);
  g.push(`<text x="${pad}" y="${ty + 46}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">GEO 半径  : ${spots.map(s => (s.geo * 1000).toFixed(1)).join('       ')}</text>`);
  g.push(`<text x="${pad}" y="${ty + 64}" fill="#6D7B86" font-size="9" font-family="ui-monospace,monospace">单位 μm · 中心: 加权质心 · RMS 按波长权重 · 窗口 ±${(win * 1000).toFixed(0)}μm @${Math.round(primaryNm)}nm</text>`);
  el.setAttribute('viewBox', `0 0 ${Math.ceil(W)} ${Math.ceil(H)}`);
  el.innerHTML = g.join('');
}

// ---- 像差图（M2b 第二步）：光扇图 / 场曲·像散 / 畸变 ----
function populateAberSelects() {
  if (aberField) {
    const list = parseFields(fvalsEl?.value); if (!list.length) list.push(0);
    const cur = aberField.value;
    aberField.innerHTML = '<option value="all">全部</option>' + list.map(f => `<option value="${f}">${f}</option>`).join('');
    aberField.value = (cur && aberField.querySelector(`option[value="${cur}"]`)) ? cur : 'all';
  }
  if (aberWavelength) {
    const wl = activeLambdas().lambdas; const cur = aberWavelength.value;
    aberWavelength.innerHTML = '<option value="all">全部</option><option value="primary">主波长</option>' + wl.map(w => `<option value="${w.nm}">${Math.round(w.nm)}nm</option>`).join('');
    aberWavelength.value = (cur && aberWavelength.querySelector(`option[value="${cur}"]`)) ? cur : 'all';
  }
}
function updateAber() {
  if (!aberMain) return;
  const type = aberType?.value || 'fan';
  const nGrid = Math.max(5, Math.min(41, parseInt(aberGrid?.value, 10) || 21)) | 0;
  const mode = fmodeEl?.value || 'angle';
  const wlAll = activeLambdas().lambdas; const pri = wlAll[activeLambdas().primary] || wlAll[0];
  const wsel = aberWavelength?.value || 'all';
  const wlList = wsel === 'all' ? wlAll : (wsel === 'primary' ? [pri] : wlAll.filter(w => String(w.nm) === wsel));
  const baseList = parseFields(fvalsEl?.value); if (!baseList.length) baseList.push(0);
  const fsel = aberField?.value || 'all';
  const fields = fsel === 'all' ? baseList : [+fsel];
  const lamPri = pri.nm / 1000;
  if (type === 'fan') {
    const fans = fields.map(fv => ({
      field: fv,
      groups: wlList.map(w => ({ nm: w.nm, color: w.color || '#ffb300', fan: traceRayFan(sys, surfaceList, { mode, field: fv, lambdaUm: w.nm / 1000, nGrid }) })),
    }));
    renderAberFanSVG(aberMain, fans, wlList, mode, pri.nm);
  } else if (type === 'field') {
    const range = Math.max(0, parseFloat(aberRange?.value) || 0.5);
    const res = fieldAberrations(sys, surfaceList, { mode, fields, lambdaUm: lamPri, nPupil: Math.min(15, Math.max(5, nGrid)), nDefocus: 21, range });
    renderAberFieldSVG(aberMain, res, mode);
  } else {
    const res = fieldAberrations(sys, surfaceList, { mode, fields, lambdaUm: lamPri, nPupil: 5, nDefocus: 3, range: 0 });
    renderAberDistSVG(aberMain, res, mode);
  }
}
function renderAberFanSVG(el, fans, wlList, mode, primaryNm) {
  const pad = 10, headerH = 30, cellW = 250, plotSize = 168, titleH = 22, gap = 14;
  const cols = Math.max(1, fans.length);
  const W = pad * 2 + cols * cellW + (cols - 1) * gap;
  const H = headerH + titleH + plotSize + 30 + pad;
  let emax = 0;
  for (const f of fans) for (const grp of f.groups) {
    const fan = grp.fan; if (!fan || !fan.ok) continue;
    for (const a of fan.mer) if (a.e != null) emax = Math.max(emax, Math.abs(a.e));
    for (const a of fan.sag) if (a.e != null) emax = Math.max(emax, Math.abs(a.e));
  }
  if (!(emax > 0)) emax = 1e-3;
  emax *= 1.15;
  const g = [];
  g.push(`<text x="${pad}" y="18" fill="#E6EDF1" font-size="13" font-weight="600" font-family="ui-monospace,monospace">光扇图 (Ray Fan) · 面： 像面</text>`);
  let lx = W - pad - 44;
  for (let i = wlList.length - 1; i >= 0; i--) {
    const w = wlList[i];
    g.push(`<circle cx="${lx + 5}" cy="12" r="4.5" fill="${adaptHexStr(w.color)}"/>`);
    g.push(`<text x="${lx + 14}" y="16" fill="#9caab4" font-size="10" text-anchor="start" font-family="ui-monospace,monospace">${w.nm.toFixed(2)}</text>`);
    lx -= 52;
  }
  const scY = (plotSize / 2) / emax;
  fans.forEach((f, i) => {
    const x = pad + i * (cellW + gap), y = headerH;
    const fieldLabel = mode === 'height' ? `像高: ${f.field.toFixed(2)} (mm)` : `物面: ${f.field.toFixed(2)} (度)`;
    g.push(`<text x="${x}" y="${y + 12}" fill="#E6EDF1" font-size="11.5" font-family="ui-monospace,monospace">${fieldLabel}</text>`);
    const px = x, py = y + 18;
    for (let k = 0; k <= 4; k++) {
      const off = k / 4 * plotSize;
      g.push(`<line x1="${(px + off).toFixed(1)}" y1="${py}" x2="${(px + off).toFixed(1)}" y2="${py + plotSize}" stroke="#1b232d" stroke-width="1"/>`);
      g.push(`<line x1="${px}" y1="${(py + off).toFixed(1)}" x2="${px + plotSize}" y2="${(py + off).toFixed(1)}" stroke="#1b232d" stroke-width="1"/>`);
    }
    const cX = px + plotSize / 2, cY = py + plotSize / 2;
    g.push(`<line x1="${px}" y1="${cY}" x2="${px + plotSize}" y2="${cY}" stroke="#39424d" stroke-width="1"/>`);
    g.push(`<line x1="${cX}" y1="${py}" x2="${cX}" y2="${py + plotSize}" stroke="#39424d" stroke-width="1"/>`);
    g.push(`<rect x="${px}" y="${py}" width="${plotSize}" height="${plotSize}" fill="none" stroke="#4F7D89" stroke-width="1"/>`);
    for (const grp of f.groups) {
      const fan = grp.fan; if (!fan || !fan.ok) continue;
      const pts = (arr) => arr.filter(a => a.e != null).map(a => `${(cX + a.p * (plotSize / 2)).toFixed(1)},${(cY - a.e * scY).toFixed(1)}`).join(' ');
      const mp = pts(fan.mer), sp = pts(fan.sag);
      if (mp) g.push(`<polyline points="${mp}" fill="none" stroke="${adaptHexStr(grp.color)}" stroke-width="1.4"/>`);
      if (sp) g.push(`<polyline points="${sp}" fill="none" stroke="${adaptHexStr(grp.color)}" stroke-width="1.4" stroke-dasharray="4 2"/>`);
    }
    g.push(`<text x="${px - 4}" y="${py + 8}" text-anchor="end" fill="#9caab4" font-size="9" font-family="ui-monospace,monospace">+${(emax * 1000).toFixed(0)}</text>`);
    g.push(`<text x="${px - 4}" y="${py + plotSize}" text-anchor="end" fill="#9caab4" font-size="9" font-family="ui-monospace,monospace">-${(emax * 1000).toFixed(0)}</text>`);
    g.push(`<text x="${cX}" y="${py + plotSize + 14}" text-anchor="middle" fill="#6D7B86" font-size="9" font-family="ui-monospace,monospace">Px/Py → ±1</text>`);
  });
  g.push(`<text x="${pad}" y="${H - 8}" fill="#6D7B86" font-size="9" font-family="ui-monospace,monospace">实线=子午(εy~Py) · 虚线=弧矢(εx~Px) · 纵轴 μm @${Math.round(primaryNm)}nm · 相对主光线像点</text>`);
  el.setAttribute('viewBox', `0 0 ${Math.ceil(W)} ${Math.ceil(H)}`);
  el.innerHTML = g.join('');
}
function renderAberFieldSVG(el, res, mode) {
  const W = 620, H = 360, ml = 74, mr = 26, mt = 44, mb = 78;
  const pw = W - ml - mr, ph = H - mt - mb;
  const items = (res.items || []).filter(o => o.ok);
  const g = [];
  const unit = mode === 'height' ? '像高 mm' : '半视场角 °';
  g.push(`<text x="${ml - 46}" y="22" fill="#E6EDF1" font-size="13" font-weight="600" font-family="ui-monospace,monospace">场曲 / 像散 · 面： 像面</text>`);
  g.push(`<text x="${W - mr}" y="22" text-anchor="end" fill="#9caab4" font-size="11" font-family="ui-monospace,monospace">横轴 ${unit}</text>`);
  if (!items.length) { el.setAttribute('viewBox', `0 0 ${W} ${H}`); el.innerHTML = g.join('') + `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#9caab4" font-size="12">无数据</text>`; return; }
  const fmax = Math.max(...items.map(o => Math.abs(o.field)), 1e-9);
  let vmax = 0;
  for (const o of items) vmax = Math.max(vmax, Math.abs(o.tFocus), Math.abs(o.sFocus));
  if (!(vmax > 0)) vmax = 1e-3;
  vmax *= 1.15;
  const xs = f => ml + (f / fmax) * pw;
  const ys = v => mt + ph / 2 - (v / vmax) * (ph / 2);
  for (let k = -2; k <= 2; k++) {
    const y = ys(vmax * k / 2);
    g.push(`<line x1="${ml}" y1="${y.toFixed(1)}" x2="${ml + pw}" y2="${y.toFixed(1)}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${(vmax * k / 2 * 1000).toFixed(0)}</text>`);
  }
  g.push(`<line x1="${ml}" y1="${ys(0).toFixed(1)}" x2="${ml + pw}" y2="${ys(0).toFixed(1)}" stroke="#6D7B86" stroke-width="1.2"/>`);
  const nxt = 6;
  for (let k = 0; k <= nxt; k++) {
    const f = fmax * k / nxt, x = xs(f);
    g.push(`<line x1="${x.toFixed(1)}" y1="${mt}" x2="${x.toFixed(1)}" y2="${mt + ph}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${x.toFixed(1)}" y="${mt + ph + 16}" text-anchor="middle" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${f.toFixed(fmax < 5 ? 2 : 1)}</text>`);
  }
  g.push(`<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" stroke="#4F7D89" stroke-width="1"/>`);
  if (items.length >= 2) {
    g.push(`<polyline points="${items.map(o => `${xs(Math.abs(o.field)).toFixed(1)},${ys(o.tFocus).toFixed(1)}`).join(' ')}" fill="none" stroke="#4cc2ff" stroke-width="2"/>`);
    g.push(`<polyline points="${items.map(o => `${xs(Math.abs(o.field)).toFixed(1)},${ys(o.sFocus).toFixed(1)}`).join(' ')}" fill="none" stroke="#ff9f43" stroke-width="2" stroke-dasharray="5 3"/>`);
  }
  for (const o of items) {
    g.push(`<circle cx="${xs(Math.abs(o.field)).toFixed(1)}" cy="${ys(o.tFocus).toFixed(1)}" r="1.8" fill="#4cc2ff"/>`);
    g.push(`<circle cx="${xs(Math.abs(o.field)).toFixed(1)}" cy="${ys(o.sFocus).toFixed(1)}" r="1.8" fill="#ff9f43"/>`);
  }
  const ly = H - 30;
  g.push(`<line x1="${ml}" y1="${ly}" x2="${ml + 22}" y2="${ly}" stroke="#4cc2ff" stroke-width="2"/><text x="${ml + 28}" y="${ly + 4}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">子午 T (εy)</text>`);
  g.push(`<line x1="${ml + 150}" y1="${ly}" x2="${ml + 172}" y2="${ly}" stroke="#ff9f43" stroke-width="2" stroke-dasharray="5 3"/><text x="${ml + 178}" y="${ly + 4}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">弧矢 S (εx)</text>`);
  g.push(`<text x="${ml}" y="${ly + 22}" fill="#6D7B86" font-size="9" font-family="ui-monospace,monospace">纵轴 = 场曲(相对像面的轴向焦移) μm (+=朝物方) · 边缘光线与主光线轴向交点 (Zemax 式)</text>`);
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.innerHTML = g.join('');
}
function renderAberDistSVG(el, res, mode) {
  const W = 620, H = 360, ml = 74, mr = 26, mt = 44, mb = 78;
  const pw = W - ml - mr, ph = H - mt - mb;
  const items = (res.items || []).filter(o => o.ok && isFinite(o.dist));
  const g = [];
  const unit = mode === 'height' ? '像高 mm' : '半视场角 °';
  g.push(`<text x="${ml - 46}" y="22" fill="#E6EDF1" font-size="13" font-weight="600" font-family="ui-monospace,monospace">畸变 · 面： 像面</text>`);
  g.push(`<text x="${W - mr}" y="22" text-anchor="end" fill="#9caab4" font-size="11" font-family="ui-monospace,monospace">横轴 ${unit} · 纵轴 %</text>`);
  if (!items.length) { el.setAttribute('viewBox', `0 0 ${W} ${H}`); el.innerHTML = g.join('') + `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#9caab4" font-size="12">无数据</text>`; return; }
  const fmax = Math.max(...items.map(o => Math.abs(o.field)), 1e-9);
  let vmax = 0;
  for (const o of items) vmax = Math.max(vmax, Math.abs(o.dist));
  if (!(vmax > 0)) vmax = 0.1;
  vmax *= 1.2;
  const xs = f => ml + (f / fmax) * pw;
  const ys = v => mt + ph / 2 - (v / vmax) * (ph / 2);
  for (let k = -2; k <= 2; k++) {
    const y = ys(vmax * k / 2);
    g.push(`<line x1="${ml}" y1="${y.toFixed(1)}" x2="${ml + pw}" y2="${y.toFixed(1)}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${(vmax * k / 2).toFixed(2)}</text>`);
  }
  g.push(`<line x1="${ml}" y1="${ys(0).toFixed(1)}" x2="${ml + pw}" y2="${ys(0).toFixed(1)}" stroke="#6D7B86" stroke-width="1.2"/>`);
  const nxt = 6;
  for (let k = 0; k <= nxt; k++) {
    const f = fmax * k / nxt, x = xs(f);
    g.push(`<line x1="${x.toFixed(1)}" y1="${mt}" x2="${x.toFixed(1)}" y2="${mt + ph}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${x.toFixed(1)}" y="${mt + ph + 16}" text-anchor="middle" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${f.toFixed(fmax < 5 ? 2 : 1)}</text>`);
  }
  g.push(`<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" stroke="#4F7D89" stroke-width="1"/>`);
  if (items.length >= 2) g.push(`<polyline points="${items.map(o => `${xs(Math.abs(o.field)).toFixed(1)},${ys(o.dist).toFixed(1)}`).join(' ')}" fill="none" stroke="#3ddc97" stroke-width="2"/>`);
  for (const o of items) g.push(`<circle cx="${xs(Math.abs(o.field)).toFixed(1)}" cy="${ys(o.dist).toFixed(1)}" r="1.8" fill="#3ddc97"/>`);
  const ly = H - 30;
  g.push(`<line x1="${ml}" y1="${ly}" x2="${ml + 22}" y2="${ly}" stroke="#3ddc97" stroke-width="2"/><text x="${ml + 28}" y="${ly + 4}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">畸变 (实际−EFL·tanθ)/EFL·tanθ ×100%</text>`);
  g.push(`<text x="${ml}" y="${ly + 22}" fill="#6D7B86" font-size="9" font-family="ui-monospace,monospace">负=桶形, 正=枕形 · EFL=${(res.efl || 0).toFixed(2)}mm</text>`);
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.innerHTML = g.join('');
}


// ---- 相对照度（一维）: 逐视场采样 -> 曲线 ----
function populateIllumSelects() {
  if (!illumWavelength) return;
  const wl = activeLambdas().lambdas;
  const cur = illumWavelength.value;
  illumWavelength.innerHTML = '<option value="primary">主波长</option>' +
    wl.map(w => `<option value="${w.nm}">${Math.round(w.nm)}nm</option>`).join('');
  if (cur && illumWavelength.querySelector(`option[value="${cur}"]`)) illumWavelength.value = cur;
}
function updateIllum() {
  if (!illumMain) return;
  const nGrid = Math.max(5, Math.min(41, parseInt(illumGrid?.value, 10) || 15)) | 0;
  const nf = Math.max(3, Math.min(41, parseInt(illumN?.value, 10) || 13)) | 0;
  const mode = fmodeEl?.value || 'angle';
  const baseList = parseFields(fvalsEl?.value); if (!baseList.length) baseList.push(0);
  let fmax = Math.max(...baseList.map(Math.abs), 0);
  if (!(fmax > 0)) fmax = (isFinite(sys.maxField) && sys.maxField > 0) ? sys.maxField : (mode === 'height' ? 10 : 20);
  const set = new Set();
  for (let k = 0; k < nf; k++) set.add(fmax * k / (nf - 1));
  for (const f of baseList) set.add(Math.abs(f));            // 设计视场点也精确取样
  const fields = [...set].sort((a, b) => a - b);
  const wlAll = activeLambdas().lambdas; const pri = wlAll[activeLambdas().primary] || wlAll[0];
  const wsel = illumWavelength?.value || 'primary';
  const w = (wsel === 'primary') ? pri : (wlAll.find(x => String(x.nm) === wsel) || pri);
  const res = traceIllumination(sys, surfaceList, { mode, fields, nGrid, lambdaUm: (w.nm || 587.56) / 1000, vigCoefs: vigForFields(fields) });
  renderIllumSVG(illumMain, res, baseList, mode, w.nm || 587.56);
}
function renderIllumSVG(el, res, designFields, mode, nm) {
  const W = 620, H = 350, ml = 56, mr = 22, mt = 38, mb = 74;
  const pw = W - ml - mr, ph = H - mt - mb;
  const items = (res.items || []).filter(o => o.ok);
  const fmax = items.length ? Math.max(...items.map(o => o.field), 1e-9) : 1;
  const xs = (f) => ml + (fmax > 0 ? f / fmax : 0) * pw;
  const ys = (ri) => mt + (1 - Math.max(0, Math.min(1, ri))) * ph;
  const g = [];
  const unit = mode === 'height' ? '像高 mm' : '半视场角 °';
  g.push(`<text x="${ml - 44}" y="20" fill="#E6EDF1" font-size="13" font-weight="600" font-family="ui-monospace,monospace">相对照度图 · 面： 像面</text>`);
  g.push(`<text x="${W - mr}" y="20" text-anchor="end" fill="#9caab4" font-size="11" font-family="ui-monospace,monospace">@${Math.round(nm)}nm · ${unit}</text>`);
  for (let k = 0; k <= 5; k++) {
    const ri = k / 5, y = ys(ri);
    g.push(`<line x1="${ml}" y1="${y.toFixed(1)}" x2="${ml + pw}" y2="${y.toFixed(1)}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${(ri * 100).toFixed(0)}%</text>`);
  }
  const nxt = 6;
  for (let k = 0; k <= nxt; k++) {
    const f = fmax * k / nxt, x = xs(f);
    g.push(`<line x1="${x.toFixed(1)}" y1="${mt}" x2="${x.toFixed(1)}" y2="${mt + ph}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${x.toFixed(1)}" y="${mt + ph + 16}" text-anchor="middle" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${f.toFixed(fmax < 5 ? 2 : 1)}</text>`);
  }
  g.push(`<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" stroke="#4F7D89" stroke-width="1"/>`);
  if (items.length >= 2) {
    g.push(`<polyline points="${items.map(o => `${xs(o.field).toFixed(1)},${ys(o.cos4).toFixed(1)}`).join(' ')}" fill="none" stroke="#6D7B86" stroke-width="1.2" stroke-dasharray="4 3" opacity=".9"/>`);
    g.push(`<polyline points="${items.map(o => `${xs(o.field).toFixed(1)},${ys(o.RI).toFixed(1)}`).join(' ')}" fill="none" stroke="#4cc2ff" stroke-width="2"/>`);
  }
  for (const o of items) g.push(`<circle cx="${xs(o.field).toFixed(1)}" cy="${ys(o.RI).toFixed(1)}" r="1.6" fill="#4cc2ff"/>`);
  for (const f of designFields) {
    const o = nearest(items, Math.abs(+f));
    if (o) g.push(`<circle cx="${xs(o.field).toFixed(1)}" cy="${ys(o.RI).toFixed(1)}" r="3.4" fill="none" stroke="#3ddc97" stroke-width="1.3"/>`);
  }
  // 图例
  const ly = H - 34;
  g.push(`<line x1="${ml}" y1="${ly}" x2="${ml + 22}" y2="${ly}" stroke="#4cc2ff" stroke-width="2"/><text x="${ml + 28}" y="${ly + 4}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">相对照度 RI</text>`);
  g.push(`<line x1="${ml + 122}" y1="${ly}" x2="${ml + 144}" y2="${ly}" stroke="#6D7B86" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${ml + 150}" y="${ly + 4}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">cos⁴θ 自然渐晕</text>`);
  g.push(`<circle cx="${ml + 288}" cy="${ly}" r="3.4" fill="none" stroke="#3ddc97" stroke-width="1.3"/><text x="${ml + 296}" y="${ly + 4}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">设计视场</text>`);
  // 设计视场读数表
  const dv = designFields.map(f => {
    const o = nearest(items, Math.abs(+f));
    return o ? `${(+f).toFixed(2)}→${(o.RI * 100).toFixed(1)}%` : '—';
  }).join('   ');
  g.push(`<text x="${ml}" y="${H - 10}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">设计视场 RI： ${dv}</text>`);
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.innerHTML = g.join('');
}
function nearest(items, f) {
  let best = null, bd = Infinity;
  for (const o of items) { const d = Math.abs(o.field - f); if (d < bd) { bd = d; best = o; } }
  return best;
}

// ---- MTF（几何）：点列 -> 相位和 -> MTF-频率曲线 + 衍射极限参考 ----
function populateMtfSelects() {
  if (mtfField) {
    const list = parseFields(fvalsEl?.value); if (!list.length) list.push(0);
    const cur = mtfField.value;
    mtfField.innerHTML = '<option value="all">全部</option>' + list.map(f => `<option value="${f}">${f}</option>`).join('');
    mtfField.value = (cur && mtfField.querySelector(`option[value="${cur}"]`)) ? cur : 'all';
  }
  if (mtfWavelength) {
    const wl = activeLambdas().lambdas; const cur = mtfWavelength.value;
    mtfWavelength.innerHTML = '<option value="all">全部</option><option value="primary">主波长</option>' + wl.map(w => `<option value="${w.nm}">${Math.round(w.nm)}nm</option>`).join('');
    mtfWavelength.value = (cur && mtfWavelength.querySelector(`option[value="${cur}"]`)) ? cur : 'all';
  }
}
function mtfHex(n) { return '#' + adaptHexNum(n).toString(16).padStart(6, '0'); }
function updateMtf() {
  if (!mtfMain) return;
  if ((mtfMode?.value || 'freq') === 'focus') return updateMtfFocus();
  if (mtfNuLabel) mtfNuLabel.textContent = '最高频率';
  const nGrid = Math.max(7, Math.min(41, parseInt(mtfGrid?.value, 10) || 21)) | 0;
  const nuMax = Math.max(10, Math.min(1000, parseFloat(mtfNu?.value) || 45));
  const mode = fmodeEl?.value || 'angle';
  const baseList = parseFields(fvalsEl?.value); if (!baseList.length) baseList.push(0);
  const fsel = mtfField?.value || 'all';
  const fields = fsel === 'all' ? baseList : [+fsel];
  const algo = mtfAlgo?.value || 'geo';
  const wlAll = activeLambdas().lambdas; const pri = wlAll[activeLambdas().primary] || wlAll[0];
  const wsel = mtfWavelength?.value || 'all';
  const wlList = wsel === 'all' ? wlAll
    : (wsel === 'primary' ? [pri] : wlAll.filter(w => String(w.nm) === wsel));
  const nmPri = pri.nm || 587.56;
  const fno = (lastTrace.fo && isFinite(lastTrace.fo.fno)) ? lastTrace.fo.fno : (sys.fno || 0);
  const nuC = fno > 0 ? 1 / ((nmPri / 1e6) * fno) : 0;          // 衍射截止(主波长) lp/mm
  const NF = 61; const nus = []; for (let i = 0; i < NF; i++) nus.push(nuMax * i / (NF - 1));
  const nSets = wlList.length;
  const vigs = vigForFields(fields);
  const sets = fields.map((fv, fi) => {
    const items = [];
    const geoPts = [];                                // 几何：所有波长落点(带权重)汇总
    let refX, refY;                                   // 复色：各波长共用同一 OPD 参考球心(否则相对相位乱)
    for (const w of wlList) {
      const lam = (w.nm || 587.56) / 1000;
      if (algo === 'diff') {
        const wv = traceWavefront(sys, surfaceList, { mode, field: +fv, lambdaUm: lam, nGrid: 64, refX, refY, vigCoef: vigs ? vigs[fi] : null });
        if (!wv.ok) continue;
        if (refX == null) { refX = wv.cx; refY = wv.cy; }
        items.push({ kind: 'diff', otf: otfFromPupil(wv.re, wv.im, wv.N), N: wv.N, R: wv.R, nuC: wv.nuC, weight: w.weight ?? 1 });
      } else {
        const pts = (traceSpot(sys, surfaceList, { mode, field: +fv, lambdaUm: lam, nGrid, vigCoef: vigs ? vigs[fi] : null }).points) || [];
        const wv = w.weight ?? 1;
        for (const p of pts) geoPts.push([p[0], p[1], wv]);   // 每个落点带该波长权重
      }
    }
    if (algo !== 'diff') items.push({ kind: 'geoAll', pts: geoPts });
    const sw = items.reduce((a, b) => a + (b.weight || 1), 0) || 1;
    const T = new Array(nus.length).fill(0), S = new Array(nus.length).fill(0);
    for (let q = 0; q < nus.length; q++) {
      let rT = 0, iT = 0, rS = 0, iS = 0;
      for (const it of items) {
        if (it.kind === 'diff') {
          const w = (it.weight || 1) / sw;
          const s = it.nuC > 0 ? nus[q] / it.nuC : (nus[q] > 0 ? 1 : 0);
          const cT = sampleOtfComplex(it.otf, it.N, it.R, s, 'T');
          const cS = sampleOtfComplex(it.otf, it.N, it.R, s, 'S');
          rT += w * cT.re; iT += w * cT.im; rS += w * cS.re; iS += w * cS.im;
        } else {   // geoAll：所有波长落点按权重做一次加权复 OTF（与友站一致）
          let srT = 0, siT = 0, srS = 0, siS = 0, sw2 = 0;
          for (const p of it.pts) {
            const wv = p[2]; sw2 += wv;
            const pT = 2 * Math.PI * nus[q] * p[1], pS = 2 * Math.PI * nus[q] * p[0];
            srT += wv * Math.cos(pT); siT -= wv * Math.sin(pT);
            srS += wv * Math.cos(pS); siS -= wv * Math.sin(pS);
          }
          if (sw2 > 0) { rT += srT / sw2; iT += siT / sw2; rS += srS / sw2; iS += siS / sw2; }
        }
      }
      T[q] = Math.min(1, Math.hypot(rT, iT)); S[q] = Math.min(1, Math.hypot(rS, iS));
    }
    return { field: +fv, n: items.length, T, S };
  });
  const wlLabel = wsel === 'all' ? `复色 · ${nSets} 波长` : `@${Math.round(nmPri)}nm`;
  if (wsel !== 'all' && nSets === 1 && String(wlList[0].nm) !== String(nmPri)) { /* 单波长(非主) */ }
  renderMtfSVG(mtfMain, { nus, sets, nuMax, nuC, nm: nmPri, fno, mode, algo, wlLabel });
}
function renderMtfSVG(el, d) {
  const W = 660, H = 380, ml = 56, mr = 24, mt = 40, mb = 92;
  const pw = W - ml - mr, ph = H - mt - mb;
  const xs = nu => ml + (d.nuMax > 0 ? nu / d.nuMax : 0) * pw;
  const ys = m => mt + (1 - Math.max(0, Math.min(1, m))) * ph;
  const g = [];
  const unit = d.mode === 'height' ? '像高 mm' : '半视场角 °';
  g.push(`<text x="${ml - 44}" y="20" fill="#E6EDF1" font-size="13" font-weight="600" font-family="ui-monospace,monospace">MTF 图（${d.algo === 'diff' ? '波前 · 衍射 FFT' : '几何 · 由点列算'}） · 面： 像面</text>`);
  g.push(`<text x="${W - mr}" y="20" text-anchor="end" fill="#9caab4" font-size="11" font-family="ui-monospace,monospace">${d.wlLabel || ('@' + Math.round(d.nm) + 'nm')} · F#${d.fno > 0 ? d.fno.toFixed(2) : '—'} · 截止 ${d.nuC > 0 ? Math.round(d.nuC) : '—'} lp/mm</text>`);
  for (let k = 0; k <= 5; k++) {
    const m = k / 5, y = ys(m);
    g.push(`<line x1="${ml}" y1="${y.toFixed(1)}" x2="${ml + pw}" y2="${y.toFixed(1)}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${(m * 100).toFixed(0)}%</text>`);
  }
  const nx = 6;
  for (let k = 0; k <= nx; k++) {
    const nu = d.nuMax * k / nx, x = xs(nu);
    g.push(`<line x1="${x.toFixed(1)}" y1="${mt}" x2="${x.toFixed(1)}" y2="${mt + ph}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${x.toFixed(1)}" y="${mt + ph + 16}" text-anchor="middle" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${nu.toFixed(0)}</text>`);
  }
  g.push(`<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" stroke="#4F7D89" stroke-width="1"/>`);
  g.push(`<text x="${ml + pw / 2}" y="${mt + ph + 32}" text-anchor="middle" fill="#9caab4" font-size="11" font-family="ui-monospace,monospace">空间频率 (lp/mm)</text>`);
  // 衍射极限参考
  if (d.nuC > 0) {
    const pts = [];
    for (let k = 0; k <= 80; k++) { const nu = d.nuMax * k / 80; pts.push(`${xs(nu).toFixed(1)},${ys(diffractionLimit(nu / d.nuC)).toFixed(1)}`); }
    g.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#6D7B86" stroke-width="1.2" stroke-dasharray="5 3"/>`);
  }
  // 逐视场 T(实线)/S(虚线)
  d.sets.forEach((s, i) => {
    const c = mtfHex(FIELDCOLS[i % FIELDCOLS.length]);
    const pT = s.T.map((m, k) => `${xs(d.nus[k]).toFixed(1)},${ys(m).toFixed(1)}`).join(' ');
    const pS = s.S.map((m, k) => `${xs(d.nus[k]).toFixed(1)},${ys(m).toFixed(1)}`).join(' ');
    g.push(`<polyline points="${pS}" fill="none" stroke="${c}" stroke-width="1.2" stroke-dasharray="4 3" opacity=".85"/>`);
    g.push(`<polyline points="${pT}" fill="none" stroke="${c}" stroke-width="1.8"/>`);
  });
  // 图例：视场色 + T/S + 衍射极限
  const fRef = Math.min(30, d.nuMax);
  const kRef = Math.round(fRef / d.nuMax * (d.nus.length - 1));
  let lx = ml, ly = H - 40;
  for (let i = 0; i < d.sets.length; i++) {
    const s = d.sets[i], c = mtfHex(FIELDCOLS[i % FIELDCOLS.length]);
    const label = `${(+s.field).toFixed(2)}${d.mode === 'height' ? 'mm' : '°'}`;
    const txt = `场 ${label}  T${fRef.toFixed(0)}=${s.T[kRef].toFixed(2)} S${fRef.toFixed(0)}=${s.S[kRef].toFixed(2)}`;
    g.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 16}" y2="${ly}" stroke="${c}" stroke-width="2"/><text x="${lx + 20}" y="${ly + 4}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${txt}</text>`);
    lx += 20 + txt.length * 6.4 + 14;
    if (lx > W - mr - 140 && i < d.sets.length - 1) { lx = ml; ly += 16; }
  }
  g.push(`<text x="${ml}" y="${H - 8}" fill="#6D7B86" font-size="10" font-family="ui-monospace,monospace">${d.algo === 'diff' ? '实线=T(子午) · 虚线=S(弧矢) · 灰虚线=衍射极限(圆孔) · 波前 OPD 以主光线像点为参考球心(离焦未含)' : '实线=T(子午) · 虚线=S(弧矢) · 灰虚线=衍射极限(圆孔) · 几何 MTF 近衍射极限时偏高，仅供参考'}</text>`);
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.innerHTML = g.join('');
}

// ---- P0b：MTF 离焦曲线（真实波前瞳函数 + 离焦相位扫描）----
function updateMtfFocus() {
  if (mtfNuLabel) mtfNuLabel.textContent = '评估频率';
  const mode = fmodeEl?.value || 'angle';
  const baseList = parseFields(fvalsEl?.value); if (!baseList.length) baseList.push(0);
  const fsel = mtfField?.value || 'all';
  const fields = fsel === 'all' ? baseList : [+fsel];
  const wlAll = activeLambdas().lambdas; const pri = wlAll[activeLambdas().primary] || wlAll[0];
  const wsel = mtfWavelength?.value || 'all';
  const wlList = wsel === 'all' ? wlAll : (wsel === 'primary' ? [pri] : wlAll.filter(w => String(w.nm) === wsel));
  const lamPri = (pri.nm || 587.56) / 1000;
  const fno = (lastTrace.fo && isFinite(lastTrace.fo.fno)) ? lastTrace.fo.fno : (sys.fno || 0);
  const unit = mtfFocusUnit?.value === 'mm' ? 'mm' : 'um';
  const toUm = unit === 'mm' ? 1000 : 1;                           // 1 显示单位 = toUm µm
  const wlLabel = wsel === 'all' ? `复色 · ${wlList.length} 波长` : `@${Math.round((wlList[0] && wlList[0].nm) || pri.nm || 587.56)}nm`;
  if (!(fno > 0)) { renderMtfFocusSVG(mtfMain, { dz: [], sets: [], ref: null, nuEval: 0, nm: pri.nm || 587.56, fno: 0, nuC: 0, mode, unit, toUm, wlLabel }); return; }
  const nuC = 1 / (lamPri * fno);                                  // 衍射截止(主波长) lp/mm
  const nuEval = Math.max(1, Math.min(1000, parseFloat(mtfNu?.value) || 45));
  const rangeIn = parseFloat(mtfFocusRange?.value);
  const rangeUm = (isFinite(rangeIn) && rangeIn > 0) ? rangeIn * toUm : (4 * lamPri * fno * fno);  // 轴向 ±µm
  const NSTEP = 41;
  const dz = []; for (let k = 0; k < NSTEP; k++) dz.push(-rangeUm + 2 * rangeUm * k / (NSTEP - 1));
  const vigs = vigForFields(fields);
  const sets = fields.map((fv, fi) => {
    const pupils = [];
    let refX, refY;                                                // 复色：各波长共用同一 OPD 参考球心
    for (const w of wlList) {
      const lamUm = (w.nm || 587.56) / 1000;
      const wv = traceWavefront(sys, surfaceList, { mode, field: +fv, lambdaUm: lamUm, nGrid: 64, refX, refY, vigCoef: vigs ? vigs[fi] : null });
      if (!wv.ok) continue;
      if (refX == null) { refX = wv.cx; refY = wv.cy; }
      pupils.push({ re: wv.re, im: wv.im, N: wv.N, R: wv.R, nuC: wv.nuC, weight: w.weight ?? 1, lambdaUm: lamUm });
    }
    if (!pupils.length) return { field: +fv, T: new Array(NSTEP).fill(0), S: new Array(NSTEP).fill(0), ok: false };
    const { T, S } = throughFocusMultiColor(pupils, nuEval, dz, fno);
    return { field: +fv, T, S, ok: true };
  });
  const s0 = nuC > 0 ? Math.min(0.999, nuEval / nuC) : 0;          // 衍射极限参考(主波长·理想圆孔·同离焦)
  const w20pri = dz.map(z => defocusWaves(z / 1000, fno, lamPri));
  const ref = s0 > 0 ? throughFocusMTF(128, 31, s0, w20pri) : null;
  renderMtfFocusSVG(mtfMain, { dz, sets, ref, nuEval, nm: pri.nm || 587.56, fno, nuC, mode, unit, toUm, wlLabel });
}
function renderMtfFocusSVG(el, d) {
  const W = 660, H = 380, ml = 56, mr = 24, mt = 40, mb = 92;
  const pw = W - ml - mr, ph = H - mt - mb;
  const dmax = Math.max(1e-9, ...d.dz.map(Math.abs));
  const xs = z => ml + (z + dmax) / (2 * dmax) * pw;
  const ys = m => mt + (1 - Math.max(0, Math.min(1, m))) * ph;
  const toUm = d.toUm || 1, unitTxt = d.unit === 'mm' ? 'mm' : 'µm';
  const fmt = v => { const a = Math.abs(v); return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3); };
  const g = [];
  g.push(`<text x="${ml - 44}" y="20" fill="#E6EDF1" font-size="13" font-weight="600" font-family="ui-monospace,monospace">MTF 离焦曲线（波前 · 衍射 FFT） · 面： 像面</text>`);
  g.push(`<text x="${W - mr}" y="20" text-anchor="end" fill="#9caab4" font-size="11" font-family="ui-monospace,monospace">${d.wlLabel || ('@' + Math.round(d.nm) + 'nm')} · F#${d.fno > 0 ? d.fno.toFixed(2) : '—'} · 评估 ${Math.round(d.nuEval)} lp/mm</text>`);
  for (let k = 0; k <= 5; k++) {
    const m = k / 5, y = ys(m);
    g.push(`<line x1="${ml}" y1="${y.toFixed(1)}" x2="${ml + pw}" y2="${y.toFixed(1)}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${ml - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${(m * 100).toFixed(0)}%</text>`);
  }
  const nx = 6;
  for (let k = 0; k <= nx; k++) {
    const z = -dmax + 2 * dmax * k / nx, x = xs(z);
    g.push(`<line x1="${x.toFixed(1)}" y1="${mt}" x2="${x.toFixed(1)}" y2="${mt + ph}" stroke="#1b232d" stroke-width="1"/>`);
    g.push(`<text x="${x.toFixed(1)}" y="${mt + ph + 16}" text-anchor="middle" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${fmt(z / toUm)}</text>`);
  }
  g.push(`<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" stroke="#4F7D89" stroke-width="1"/>`);
  g.push(`<text x="${ml + pw / 2}" y="${mt + ph + 32}" text-anchor="middle" fill="#9caab4" font-size="11" font-family="ui-monospace,monospace">离焦 (${unitTxt})</text>`);
  if (d.ref) {
    const pts = d.ref.map((m, k) => `${xs(d.dz[k]).toFixed(1)},${ys(m).toFixed(1)}`).join(' ');
    g.push(`<polyline points="${pts}" fill="none" stroke="#6D7B86" stroke-width="1.2" stroke-dasharray="5 3"/>`);
  }
  let bestI = 0, bestV = -1;
  for (let k = 0; k < d.dz.length; k++) { let v = 0; for (const s of d.sets) v += s.T[k]; if (v > bestV) { bestV = v; bestI = k; } }
  if (d.dz.length) {
    const xb = xs(d.dz[bestI]);
    g.push(`<line x1="${xb.toFixed(1)}" y1="${mt}" x2="${xb.toFixed(1)}" y2="${mt + ph}" stroke="#3ddc97" stroke-width="1" stroke-dasharray="3 3" opacity=".9"/>`);
    g.push(`<text x="${(xb + 4).toFixed(1)}" y="${mt + 12}" fill="#3ddc97" font-size="10" font-family="ui-monospace,monospace">最佳焦面 ${fmt(d.dz[bestI] / toUm)} ${unitTxt}</text>`);
  }
  d.sets.forEach((s, i) => {
    const c = mtfHex(FIELDCOLS[i % FIELDCOLS.length]);
    const pT = s.T.map((m, k) => `${xs(d.dz[k]).toFixed(1)},${ys(m).toFixed(1)}`).join(' ');
    const pS = s.S.map((m, k) => `${xs(d.dz[k]).toFixed(1)},${ys(m).toFixed(1)}`).join(' ');
    g.push(`<polyline points="${pS}" fill="none" stroke="${c}" stroke-width="1.2" stroke-dasharray="4 3" opacity=".85"/>`);
    g.push(`<polyline points="${pT}" fill="none" stroke="${c}" stroke-width="1.8"/>`);
  });
  let lx = ml, ly = H - 40;
  for (let i = 0; i < d.sets.length; i++) {
    const s = d.sets[i], c = mtfHex(FIELDCOLS[i % FIELDCOLS.length]);
    const label = `${(+s.field).toFixed(2)}${d.mode === 'height' ? 'mm' : '°'}`;
    const pk = s.T.length ? Math.max(...s.T) : 0;
    const txt = `场 ${label}  T峰值=${pk.toFixed(2)}`;
    g.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 16}" y2="${ly}" stroke="${c}" stroke-width="2"/><text x="${lx + 20}" y="${ly + 4}" fill="#9caab4" font-size="10" font-family="ui-monospace,monospace">${txt}</text>`);
    lx += 20 + txt.length * 6.4 + 14;
    if (lx > W - mr - 140 && i < d.sets.length - 1) { lx = ml; ly += 16; }
  }
  g.push(`<text x="${ml}" y="${H - 8}" fill="#6D7B86" font-size="10" font-family="ui-monospace,monospace">实线=T(子午) · 虚线=S(弧矢) · 灰虚线=衍射极限(理想圆孔·同离焦) · 绿虚线=最佳焦面(各视场T之和最大) · ${d.wlLabel && d.wlLabel.indexOf('复色') >= 0 ? '复色(按波长权重复数加权)' : '单色(主波长)'}</text>`);
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.innerHTML = g.join('');
}

function svgPoint(e) {
  const pt = layout2dEl.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const ctm = layout2dEl.getScreenCTM();
  return ctm ? pt.matrixTransform(ctm.inverse()) : null;  // viewBox 用户坐标
}
function bindLayoutInteractions() {
  let drag = null;
  layout2dEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = svgPoint(e); if (!drag) return;
    layout2dEl.setPointerCapture(e.pointerId);
    layout2dEl.classList.add('dragging');
    e.preventDefault();
  });
  layout2dEl.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = svgPoint(e); if (!p) return;
    layout.tx += p.x - drag.x;
    layout.ty += p.y - drag.y;
    drag = p;
    layoutApply();
  });
  const end = () => { drag = null; layout2dEl.classList.remove('dragging'); };
  layout2dEl.addEventListener('pointerup', end);
  layout2dEl.addEventListener('pointercancel', end);
  layout2dEl.addEventListener('wheel', e => {
    e.preventDefault();
    const p = svgPoint(e); if (!p) return;
    const ns = Math.min(8, Math.max(0.2, layout.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const wx = (p.x - layout.tx) / layout.scale;
    const wy = (p.y - layout.ty) / layout.scale;
    layout.scale = ns;
    layout.tx = p.x - wx * ns;
    layout.ty = p.y - wy * ns;
    layoutApply();
  }, { passive: false });
}
bindLayoutInteractions();

// 3D 顶点坐标小窗（实时）
function updateVertReadout(i) {
  if (!vertEl) return;
  if (i == null || !surfaceList.length || !sys.surfaces[i]) { vertEl.innerHTML = '<div class="vr-title">顶点 3D 坐标</div>(未选择面)'; return; }
  const s = sys.surfaces[i], info = surfaceList[i];
  const x = (s.decX || 0), y = (s.decY || 0), z = info.z;
  vertEl.innerHTML =
    `<div class="vr-title">顶点 3D 坐标 · S${i} ${s.type}</div>` +
    `<span class="vr-xyz">(x, y, z) = (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)})</span>`;
}

function highlightByIndex(i) {
  if (highlightObj) { scene.remove(highlightObj); highlightObj = null; }
  selectedSurface = (i == null) ? null : i;
  if (i != null && surfaceList.length) {
    highlightObj = buildSurfaceMarker(sys, surfaceList, i);
    scene.add(highlightObj);
    updateVertReadout(i);
  }
  if (viewMode === '2d') renderLayout2D();   // 2D 图同步高亮
}
function clearHighlight() {
  if (highlightObj) { scene.remove(highlightObj); highlightObj = null; }
}

function freshSys(value) {
  sys = typeof value === 'string' ? System.deserialize(value) : value;
  if (!(sys instanceof System)) sys = System.deserialize(sys);
  syncWave(sys); renderWaveEditor();
}

async function rebuildScene(keepCamera = false) {
  if (lensGroup) { scene.remove(lensGroup); lensGroup = null; }
  clearHighlight();
  lensMeshes = [];
  try {
    const res = buildSystemGroup(sys);
    lensGroup = res.group;
    lensMeshes = res.lensMeshes;
    surfaceList = res.surfaceList;
    // 首镜片前表面顶点 z（物方显示裁切起点=第一个光学面）
    const opts = surfaceList.slice(1, -1).map(s => s && s.z).filter(z => isFinite(z));
    frontZ = opts.length ? Math.min(...opts) : (surfaceList[1] ? surfaceList[1].z : -50);
  } catch (e) {
    console.error(e);
    lensGroup = new THREE.Group();
    setStatus('几何构建报错：' + (e && e.message ? e.message : e), false);
  }
  scene.add(lensGroup);

  updateRays();   // M2a：追迹并显示子午光路 + 一阶量

  // 相机自动框住镜头（镜片包围盒，忽略光轴长线）；原点=像面中心留一点余量
  if (!keepCamera) {
    fitCamera('iso');   // 默认 3/4 等轴测：可同时看到各子午视场(0/14/20°)的扇形与深度
    setStatus(`已载入 «${sys.name}» · 面 ${sys.surfaces.length} · 镜片 ${lensMeshes.length} 片\n原点=像面中心 · 上方 2D 剖面 · 下方切 3D 视角`, true);
  } else {
    setStatus(`已载入 «${sys.name}» · 面数 ${sys.surfaces.length} · 镜片 ${lensMeshes.length} 片`, true);
  }
  renderLayout2D();   // 2D 面板常驻于 3D 上方
  refreshActivePanel();   // 点列图/相对照度/MTF 页激活时同步刷新(含 LDM 改动、导入、刷新按钮)
}

// 若当前叠加面板(点列图/相对照度/MTF)处于激活态，重算并重绘。
// 点列图轻量立即刷新；相对照度/MTF(波前)较重，延后 30ms 并去抖，避免导入/编辑时卡住首屏。
let _panelTimer = null;
function refreshActivePanel() {
  if (spotView && spotView.classList.contains('on')) { populateSpotSelects(); updateSpot(); return; }
  const run = () => {
    if (illumView && illumView.classList.contains('on')) { populateIllumSelects(); updateIllum(); }
    else if (mtfView && mtfView.classList.contains('on')) { populateMtfSelects(); updateMtf(); }
    else if (aberView && aberView.classList.contains('on')) { populateAberSelects(); updateAber(); }
  };
  if (_panelTimer) clearTimeout(_panelTimer);
  _panelTimer = setTimeout(run, 30);
}

function refreshTable(select) { ldm.render(sys, select); }

function syncAll(select, frame) {
  rebuildScene(frame);
  refreshTable(select);
  if (select != null) highlightByIndex(select);   // 同步高亮 + 顶点坐标小窗
}

// ---- 三个窗口(LDM/2D/3D)大小可拖拽调整 ----
const sideEl = document.getElementById('side');
const sideGrip = document.getElementById('sideGrip');
const panel2dEl = document.getElementById('panel2d');
const vGrip = document.getElementById('vGrip');
const appEl = document.getElementById('app');
function makeResize(grip, onMove) {
  if (!grip) return;
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('drag');
    const move = ev => onMove(ev);
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.classList.remove('drag'); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}
makeResize(sideGrip, ev => {   // 调 LDM(左栏)宽度
  const w = Math.max(320, Math.min(900, ev.clientX));
  if (sideEl) { sideEl.style.width = w + 'px'; sideEl.style.flex = '0 0 auto'; }
  resize();
});
makeResize(vGrip, ev => {      // 调 2D/点列 面板高度(3D 随之)
  const top = (appEl ? appEl.getBoundingClientRect().top : 0);
  const h = Math.max(120, Math.min(800, ev.clientY - top - 6));
  if (panel2dEl) { panel2dEl.style.height = h + 'px'; panel2dEl.style.flex = '0 0 auto'; }
  resize();
});

const ldm = new LDM(document.getElementById('ldm'), {
  onChange: () => { sys = ldm.sys; ldm.render(sys, ldm.selected); rebuildScene(true); highlightByIndex(ldm.selected); },   // 撤销/结构操作：表格+图表都重渲染
  onSelect: (i) => highlightByIndex(i),
});
ldm.init(() => { ldm.render(ldm.sys, ldm.selected); }, () => { sys = ldm.sys; rebuildScene(true); highlightByIndex(ldm.selected); });   // 单元格编辑：只重建图表，避免打字丢焦点

// 一键刷新：LDM 表格 + 2D + 3D + 点列图 全部重新渲染
const refreshBtn = document.getElementById('refreshBtn');
if (refreshBtn) refreshBtn.addEventListener('click', () => { sys = ldm.sys; rebuildScene(true); refreshTable(ldm.selected); });

// ---------- 控件 ----------
// 顶部动作
// 示例镜头目录（本地 .zmx + 友站迁移的定焦镜头，按品牌分组）
const LENS_CATALOG = [
  { group: '本地示例', items: [
    ['zmx:Advanced_SC_doubleGauss_final.zmx', '双高斯 Advanced_SC'],
    ['zmx:Cooke 40 degree field.zmx', 'Cooke 40° 三片'],
  ]},
  { group: '索尼 Sony', items: [
    ['json:sony-fe-50mm-f1-2-gm', 'FE 50mm F1.2 GM'],
    ['json:sony-fe-85mm-f1-4-gm', 'FE 85mm F1.4 GM'],
  ]},
  { group: '适马 SIGMA', items: [
    ['json:sigma-50mm-f1-4-dg-hsm-art', '50mm F1.4 DG HSM Art'],
    ['json:sigma-85mm-f1-4-dg-hsm-art', '85mm F1.4 DG HSM Art'],
  ]},
  { group: 'SONGRAW', items: [
    ['json:songraw-af-85mm-f1-2', 'AF 85mm F1.2'],
  ]},
];
function buildLensMenu() {
  if (!demoSel) return;
  demoSel.innerHTML = LENS_CATALOG.map(g =>
    `<optgroup label="${g.group}">` +
    g.items.map(([v, t]) => `<option value="${v}">${t}</option>`).join('') +
    `</optgroup>`).join('');
}
buildLensMenu();
function loadCurrent() {
  const v = demoSel.value;
  if (!v) return;
  const ci = v.indexOf(':');
  const kind = ci < 0 ? 'zmx' : v.slice(0, ci);
  const id = ci < 0 ? v : v.slice(ci + 1);
  const p = kind === 'json' ? loadFriendLens(id) : loadZmxFile(id);
  p.then(s => setStatus(`载入 «${s.name}» · 面 ${s.surfaces.length} · 镜片 ${lensMeshes.length} 片`, true))
   .catch(e => fail(e));
}
document.getElementById('newDemo').addEventListener('click', loadCurrent);
demoSel.addEventListener('change', loadCurrent);
// 重置视角 = 回到 Y-Z 剖面，且之后仍可用左键拖动视角（OrbitControls 始终可用）
resetBtn.addEventListener('click', () => fitCamera('yz'));
document.getElementById('viewSeg').addEventListener('click', e => {
  const b = e.target.closest('.vbtn');
  if (b) fitCamera(b.dataset.view);
});
// 左上信息窗 / 右上坐标窗 显示切换
const hudEl = document.getElementById('hud');
const hudToggle = document.getElementById('hudToggle');
if (hudToggle && hudEl) hudToggle.addEventListener('click', () => {
  const hidden = hudEl.classList.toggle('hidden');
  hudToggle.classList.toggle('active', !hidden);
});
const readoutToggle = document.getElementById('readoutToggle');
if (readoutToggle && vertEl) readoutToggle.addEventListener('click', () => {
  const hidden = vertEl.classList.toggle('hidden');
  readoutToggle.classList.toggle('active', !hidden);
});

// M2a-2：视场/光线数控件 -> 重新追迹（rebuildScene 内部会顺带刷新当前激活的叠加面板）
const refreshField = () => { rebuildScene(true); };
for (const el of [fmodeEl, fvalsEl, npupilEl, wfnEl]) {
  if (el) { el.addEventListener('input', refreshField); el.addEventListener('change', refreshField); }
}
// 点列图/相对照度/MTF 标签页：与 2D 光路共享 panel2d（可切换）
if (tabLayout) tabLayout.addEventListener('click', () => setPanelTab('layout'));
if (tabSpot) tabSpot.addEventListener('click', () => { populateSpotSelects(); setPanelTab('spot'); });
if (tabIllum) tabIllum.addEventListener('click', () => { populateIllumSelects(); setPanelTab('illum'); });
if (tabMtf) tabMtf.addEventListener('click', () => { populateMtfSelects(); setPanelTab('mtf'); });
if (tabAber) tabAber.addEventListener('click', () => { populateAberSelects(); setPanelTab('aber'); });
for (const el of [spotGrid, spotField, spotWavelength, spotAiry]) {
  if (el) el.addEventListener('input', () => updateSpot());
}
for (const el of [illumGrid, illumN, illumWavelength]) {
  if (el) el.addEventListener('input', () => updateIllum());
  if (el) el.addEventListener('change', () => updateIllum());
}
for (const el of [mtfAlgo, mtfField, mtfGrid, mtfNu, mtfWavelength, mtfMode, mtfFocusRange]) {
  if (el) el.addEventListener('input', () => updateMtf());
  if (el) el.addEventListener('change', () => updateMtf());
}
for (const el of [aberType, aberField, aberGrid, aberRange, aberWavelength]) {
  if (el) el.addEventListener('input', () => updateAber());
  if (el) el.addEventListener('change', () => updateAber());
}
// 离焦单位切换：换算「范围」数值并刷新
if (mtfFocusUnit) mtfFocusUnit.addEventListener('change', () => {
  const toUm = mtfFocusUnit.value === 'mm' ? 1000 : 1;
  const prev = parseFloat(mtfFocusUnit.dataset.toUm || '1');
  const rv = parseFloat(mtfFocusRange?.value);
  if (mtfFocusRange && isFinite(rv)) mtfFocusRange.value = +(rv * prev / toUm).toPrecision(6);
  mtfFocusUnit.dataset.toUm = String(toUm);
  if (mtfFocusUnitLabel) mtfFocusUnitLabel.textContent = mtfFocusUnit.value === 'mm' ? 'mm' : 'µm';
  updateMtf();
});
function runAutoVignette() {
  const on = Array.isArray(sys.vigCoefs);
  try {
    if (on) { sys.vigCoefs = null; }
    else {
      const list = parseFields(fvalsEl?.value); if (!list.length) list.push(0);
      const prim = activeLambdas().lambdas[activeLambdas().primary]?.nm ?? 587.56;
      const lamUm = prim / 1000;
      const fno0 = isFinite(sys.fno) && sys.fno > 0 ? sys.fno : null;
      let coefs = autoVignette(sys, surfaceList, { mode: fmodeEl?.value || 'angle', fields: list, lambdaUm: lamUm }) || [];
      // 光带超出净口径（轴视场窗口<1）：重算工作F数，使光带占满净口径，再重算渐晕
      if (coefs.length && coefs[0] && fno0 != null) {
        const c = coefs[0];
        const win = Math.min(c.yHi, -c.yLo, c.xHi, -c.xLo);
        if (win < 0.9995) {
          const fnoNew = fno0 / win;               // F#=EFL/EPD，EPD∝1/F#
          sys.fno = fnoNew; sys.apmode = 'fno';
          if (wfnEl) wfnEl.value = +fnoNew.toFixed(2);
          coefs = autoVignette(sys, surfaceList, { mode: fmodeEl?.value || 'angle', fields: list, lambdaUm: lamUm }) || [];
        }
      }
      sys.vigCoefs = coefs.length ? coefs : null;
      if (!sys.vigCoefs) console.error('自动渐晕：未算出有效系数');
    }
    rebuildScene(true); renderLayout2D();
  } catch (e) { console.error('自动渐晕报错', e); setStatus('自动渐晕报错：' + (e && e.message || e), false); }
}
if (autoVigBtn) autoVigBtn.addEventListener('click', runAutoVignette);
bindWaveEditor();

importBtn.addEventListener('click', () => fileInput.click());
// 导出当前 LDM 为 Zemax .zmx（视场=真实像高/角度、半口径固定=LDM值、孔径=当前工作F#）
const exportBtn = document.getElementById('exportZmx');
if (exportBtn) exportBtn.addEventListener('click', () => {
  try {
    const fno = parseFloat(wfnEl?.value);
    const fields = parseFields(fvalsEl?.value);
    const fmode = fmodeEl?.value === 'angle' ? 'angle' : 'height';
    const text = exportZmx(sys, { fno: isFinite(fno) ? fno : sys.fno, fields: fields.length ? fields : sys.fields, fmode });
    const name = String(sys.name || 'lens').replace(/[\\/:*?"<>|]/g, '_') + '.zmx';
    const buf = new Uint8Array(2 + text.length * 2);          // UTF-16LE + BOM（Zemax 格式）
    buf[0] = 0xFF; buf[1] = 0xFE;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); buf[2 + i * 2] = c & 0xFF; buf[2 + i * 2 + 1] = (c >> 8) & 0xFF; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus('已导出 ' + name, true);
  } catch (e) { fail(e); }
});
fileInput.addEventListener('change', async () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  try {
    const ns = importFile(f.name, lensTextFromBuffer(await f.arrayBuffer()));
    if (!ns) throw new Error('无法识别的文件格式，仅支持 .zmx / .seq');
    freshSys(ns);
    // 先同步左侧面板(视场/模式/波长 -> DOM 与 waveState)，再追迹。
    // 否则 updateRays 读到的是上一系统的 fvals/waveState，导致首屏追迹用错视场/波长(需再刷新才对)。
    applyPanelFromSys();
    syncAll(0);
    if (pendingAutoVig) runAutoVignette();
    const warn = (ns.warnings && ns.warnings.length) ? ' · 提示 ' + ns.warnings.join('；') : '';
    setStatus(`导入 ${f.name} · 面数 ${sys.surfaces.length}${warn}`, true);
  } catch (e) { fail(e); }
});

window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); ldm.undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); ldm.redo(); }
});

function resize() {
  // 3D 画布只占 #stage3d 区域
  const r = document.getElementById('stage3d').getBoundingClientRect();
  const w = Math.max(1, r.width), h = Math.max(1, r.height);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (viewMode === '2d') renderLayout2D();   // 2D 视图激活时按新尺寸重新取景
}
window.addEventListener('resize', resize);

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

window.addEventListener('error', ev => fail(ev.error || ev.message));
window.addEventListener('unhandledrejection', ev => fail(ev.reason));

// ---------- 启动 ----------
// 从 测试zemax文件/ 载入 .zmx（相对路径，兼容本地服务与 Pages 子路径）
const ZMX_DIR = '测试zemax文件';
const DEFAULT_ZMX_FILE = 'Advanced_SC_doubleGauss_final.zmx';
async function loadZmxFile(file, resetView = true) {
  // 本地: /lens-3d/ -> ../测试zemax文件/... = /测试zemax文件/... ; Pages: /repo/lens-3d/ -> /repo/测试zemax文件/...
  const url = '../' + encodeURIComponent(ZMX_DIR) + '/' + encodeURIComponent(file);
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ns = importFile(file, lensTextFromBuffer(await r.arrayBuffer()));
  if (!ns) throw new Error('解析失败');
  freshSys(ns);
  applyPanelFromSys();
  syncAll(0);
  if (pendingAutoVig) runAutoVignette();
  resize();
  if (resetView) fitCamera('2d');   // 默认显示 2D 光路
  return sys;
}
// 载入友站迁移的镜头 JSON（lenses/<id>.json）
async function loadFriendLens(id, resetView = true) {
  const r = await fetch('../lenses/' + encodeURIComponent(id) + '.json');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ns = importFriendJson(await r.json());
  if (!ns) throw new Error('解析失败');
  freshSys(ns);
  applyPanelFromSys();
  syncAll(0);
  if (pendingAutoVig) runAutoVignette();
  resize();
  if (resetView) fitCamera('2d');
  return sys;
}
async function loadDefault() {
  try {
    const s = await loadZmxFile(DEFAULT_ZMX_FILE, true);
    setStatus(`默认载入 «${s.name}» · 面 ${s.surfaces.length} · 镜片 ${lensMeshes.length} 片`, true);
  } catch (e) {
    console.error('默认文件载入失败，回退 demo', e);
    freshSys(demoSingleElement());
    applyPanelFromSys();
    syncAll(0);
    resize();
    fitCamera('2d');
  }
}
loadDefault();
