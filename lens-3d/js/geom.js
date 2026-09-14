// geom.js — 用面数据生成镜片回转体，并负责表面高亮与像面显示
// 坐标约定：原点 = 像面中心，光轴 = +Z，像面 z=0，镜头位于 z<0（物方）侧。
import * as THREE from '../vendor/three/three.module.js?v=0.8.4';
import { surfaceSag, SURF } from './model.js?v=0.8.4';

// 3D 主题调色板（由 main.js 的 applyTheme 设置；默认=深色主题）
const THEME3D = { accent: 0x4cc2ff, accentSoft: 0x66d9ff, accentEdge: 0x8fe6ff };
export function setTheme3D(o) { if (o) Object.assign(THEME3D, o); }

// 面顶点 z（相对系统原点=物面）。为把原点移到“像面中心”，整体减去像面顶点 z。
// 注意 surfaceZ(i) 在 model.js 里已跳过物面(下标0)的无穷厚物距。

// 用表面矢高把回转轮廓采样成一串 (radius, z)
function surfaceProfile(s, half, samples, zAtVertex) {
  const pts = [];
  const shape = s.toShape();
  for (let i = 0; i <= samples; i++) {
    const h = (i / samples) * half;
    pts.push([h, zAtVertex + surfaceSag(h, shape)]);
  }
  return pts;
}

// 镜片边缘半径（机械优先，回退净口径，再回退默认）；镜体边缘=机械半径，不放大
export function mechRadius(front, back, gapFactor = 1.0, def = 20) {
  const fm = front.mSemi ?? front.semi ?? def;
  const bm = back.mSemi ?? back.semi ?? def;
  return Math.max(fm, bm) * gapFactor;
}

export function buildLensBody(front, back, { segments = 64, samples = 40 } = {}) {
  const half = mechRadius(front, back);
  const zf = 0;                 // 前表面顶点（局部）
  const zb = front.thi;         // 后表面顶点 = 前+中心厚
  const prof = [];

  const fp = surfaceProfile(front, half, samples, zf);
  for (const p of fp) prof.push(p);
  prof.push([half, zb]);
  const bp = surfaceProfile(back, half, samples, zb);
  for (let i = bp.length - 1; i >= 0; i--) prof.push(bp[i]);
  prof.push([0, zf]);

  const pts2d = prof.map(([r, z]) => new THREE.Vector2(r, z));
  const geo = new THREE.LatheGeometry(pts2d, segments);
  geo.rotateX(Math.PI / 2);     // 绕 Y 旋转 -> 对齐 +Z
  return geo;
}

// 由系统数据构建整条镜头；返回 { group, lensMeshes, surfaceList }
// surfaceList: 每个面的世界坐标顶点 z（已把像面中心平移到原点 0）
export function buildSystemGroup(sys, kind = 'solid') {
  const imageZ = sys.surfaceZ(sys.surfaces.length - 1);  // 像面顶点（系统轴位）
  const zShift = -imageZ;                                 // 平移使像面中心 = 0

  const group = new THREE.Group();

  // 镜片配对：面 i 的 GLAS 表示“面 i 与 i+1 之间”填该玻璃
  const lenses = [];
  for (let i = 0; i < sys.surfaces.length - 1; i++) {
    const s = sys.surfaces[i];
    if (s.type === SURF.IMAGE || s.type === SURF.OBJECT) continue;
    const isGlass = s.glass && s.glass.toUpperCase() !== 'AIR' && s.glass.toUpperCase() !== '';
    if (isGlass) lenses.push([s, sys.surfaces[i + 1]]);
  }

  const lensMeshes = [];

  for (const [front, back] of lenses) {
    const geo = buildLensBody(front, back);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3f8fdd, metalness: 0.05, roughness: 0.28,
      transparent: false, opacity: 1, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const fi = sys.surfaces.indexOf(front);
    const bi = sys.surfaces.indexOf(back);
    const z = sys.surfaceZ(fi) + zShift;      // 前表面顶点（世界，像面中心=0）
    mesh.position.z = z;
    mesh.name = 'lens';
    mesh.userData.z = z;
    mesh.userData.frontIdx = fi;
    mesh.userData.backIdx = bi;
    lensMeshes.push(mesh);
    group.add(mesh);
  }

  // 每个面的顶点 z（世界，像面中心=0）—— 供高亮/标注/取景用
  const surfaceList = [];
  for (let i = 0; i < sys.surfaces.length; i++) {
    surfaceList.push({
      idx: i,
      z: sys.surfaceZ(i) + zShift,
      semi: sys.surfaces[i].semi,
      mSemi: sys.surfaces[i].mSemi,
      type: sys.surfaces[i].type,
    });
  }

  // 像面：以像面中心为原点、直径 21.6mm 的圆盘，盘面垂直于光轴 +Z
  // CircleGeometry 默认在 xy 平面、法线沿 Z，本就垂直于光轴，无需再旋转
  const imageDisk = new THREE.Mesh(
    new THREE.CircleGeometry(10.8, 96),
    new THREE.MeshBasicMaterial({ color: THEME3D.accentSoft, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  imageDisk.position.z = 0;
  imageDisk.name = 'imagePlane';
  imageDisk.userData.z = 0;
  group.add(imageDisk);
  const discEdge = new THREE.LineLoop(
    new THREE.EdgesGeometry(imageDisk.geometry, 0),
    new THREE.LineBasicMaterial({ color: THEME3D.accentEdge, transparent: true, opacity: 0.9 })
  );
  discEdge.position.z = 0;
  discEdge.name = 'imagePlaneEdge';
  group.add(discEdge);

  // 原点标记：像面中心处的十字（x=dashed red, y=green, 轴 z=蓝）
  const origin = new THREE.Group();
  for (const [axis, color, len] of [[new THREE.Vector3(1, 0, 0), 0xff5555, 6], [new THREE.Vector3(0, 1, 0), 0x55ff88, 6]]) {
    const g = new THREE.BufferGeometry().setFromPoints([axis.clone().multiplyScalar(-len), axis.clone().multiplyScalar(len)]);
    origin.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })));
  }
  origin.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -3), new THREE.Vector3(0, 0, 3)]),
    new THREE.LineBasicMaterial({ color: THEME3D.accent, transparent: true, opacity: 0.9 })
  ));
  origin.position.z = 0;
  origin.name = 'originCross';
  group.add(origin);

  // 光轴参考线（+Z 箭头），像面为起点
  const axis = new THREE.Group();
  const axLen = Math.max(Math.abs(surfaceList[surfaceList.length - 1].z - surfaceList[0].z), 40) + 12;
  const axGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -axLen - 6),
  ]);
  axis.add(new THREE.Line(axGeo, new THREE.LineBasicMaterial({ color: THEME3D.accent, transparent: true, opacity: 0.9 })));
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(1.1, 4, 16),
    new THREE.MeshBasicMaterial({ color: THEME3D.accent })
  );
  arrow.rotation.x = -Math.PI / 2;       // 锥尖指向 -Z（物方）
  arrow.position.z = -axLen - 6;
  axis.add(arrow);
  group.add(axis);

  return { group, lensMeshes, surfaceList, zShift };
}

// 给某表面生成“高亮标注子组”：机械口径环 + 净口径环（均贴合该面实际矢高）
// + 中心点 + 标签 Sprite。净口径 CA=通光半口(semi)，机械口 M=机械半直径(mSemi)。
export function buildSurfaceMarker(sys, surfaceList, surfaceIdx) {
  const info = surfaceList[surfaceIdx];
  if (!info) return new THREE.Group();
  const group = new THREE.Group();
  const surf = sys.surfaces[surfaceIdx];
  const shape = surf ? surf.toShape() : { c: 0, k: 0 };
  const z0 = info.z;
  // 环在径向 r 处贴合表面：z = 顶点 z + 该半径的矢高
  const onSurf = (z, r) => z + surfaceSag(r, shape);

  const me = info.mSemi ?? info.semi ?? 10.8;   // 机械半直径（默认回退净口径）
  const ca = info.semi ?? info.mSemi ?? 10.8;   // 净口径（通光半口径）

  // 机械边缘环（细、浅蓝）
  const mechRing = new THREE.Mesh(
    new THREE.RingGeometry(me, me * 1.03, 96),
    new THREE.MeshBasicMaterial({ color: THEME3D.accentEdge, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
  );
  mechRing.position.z = onSurf(z0, me);
  group.add(mechRing);

  // 净口径环（亮黄，突出光学通光口径）
  const caRing = new THREE.Mesh(
    new THREE.RingGeometry(ca, ca * 1.10, 64),
    new THREE.MeshBasicMaterial({ color: 0xffd633, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
  );
  caRing.position.z = onSurf(z0, ca);
  group.add(caRing);

  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xff4d2e })
  );
  dot.position.set(0, 0, z0);              // 该表面中心点（共轴系统中位于光轴上）
  dot.name = 'surfaceCenter';
  group.add(dot);

  const fmt = v => (v == null ? '—' : v.toFixed(2));
  const lbl = makeLabel(`S${surfaceIdx}  净口径CA=${fmt(ca)}  机械口M=${fmt(me)}\n顶点 z=${z0.toFixed(2)}`);
  lbl.position.set(0, Math.max(ca, me) + 3, Math.max(z0, onSurf(z0, me)) - 1);
  group.add(lbl);

  return group;
}

function makeLabel(text) {
  const lines = text.split('\n');
  const fontSize = 30;
  const padX = 24, padY = 20, lineH = 36;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `bold ${fontSize}px monospace`;
  const w = Math.max(...lines.map(l => measure.measureText(l).width)) + padX * 2;
  const h = lineH * lines.length + padY;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#ffe9a3';
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((ln, i) => ctx.fillText(ln, c.width / 2, padY / 2 + lineH * i + lineH / 2));
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const scale = 0.05;   // 像素 -> 世界单位
  spr.scale.set(c.width * scale, c.height * scale, 1);
  return spr;
}

// ---------------- 2D 布局（参考站形式）：SVG 绘制 Y-Z 剖面 ----------------
// 镜片回转轮廓（渐变矢高）+ 光学轴虚线 + 光阑/像面刻线与标注 + 光线(opts.rays)
export function renderLayoutSVG(svg, sys, surfaceList, opts = {}) {
  const zImg = surfaceList[surfaceList.length - 1].z;   // 像面 z（通常=0）
  const elements = [];
  let minZ = 1e9, maxZ = -1e9, maxY = 0;

  // 光学面只画到净口径(CA=semi)，超出的机械边缘平切到 bodyR —— 使 CA 与 2D 图对应
  const profile = (s, zVertex, ownSd, drawSd) => {
    const shape = s.toShape();
    const lim = Math.min(ownSd, drawSd);
    const flat = drawSd > lim + 1e-9;
    const zEdge = zVertex + surfaceSag(lim, shape);
    const pts = [];
    if (flat) pts.push([zEdge, -drawSd]);
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const r = -lim + 2 * lim * i / N;
      pts.push([zVertex + surfaceSag(Math.abs(r), shape), r]);
    }
    if (flat) pts.push([zEdge, drawSd]);
    return pts;
  };
  const acc = (pts) => pts.forEach(p => {
    if (p[0] < minZ) minZ = p[0]; if (p[0] > maxZ) maxZ = p[0];
    const ay = Math.abs(p[1]); if (ay > maxY) maxY = ay;
  });

  for (let i = 0; i < sys.surfaces.length - 1; i++) {
    const s = sys.surfaces[i];
    if (s.type === SURF.IMAGE || s.type === SURF.OBJECT) continue;
    const glass = s.glass && s.glass.toUpperCase() !== 'AIR' && s.glass.toUpperCase() !== '';
    if (!glass) continue;
    const back = sys.surfaces[i + 1];
    const bodyR = Math.max(s.mSemi ?? s.semi ?? 10, back.mSemi ?? back.semi ?? 10); // 机械边缘半径
    const fp = profile(s, surfaceList[i].z, s.semi ?? bodyR, bodyR);
    const bp = profile(back, surfaceList[i + 1].z, back.semi ?? bodyR, bodyR);
    elements.push({ front: fp, back: bp, fi: i, bi: i + 1 });
    acc(fp); acc(bp);
  }

  // 主题色（参考站暗色布局）
  const GLASS = '#1D3038', GSTROKE = '#4F7D89';
  const INK = '#E6EDF1', INK2 = '#9CAAB4', INK3 = '#6D7B86';

  if (minZ > maxZ) { svg.setAttribute('viewBox', '0 0 40 40'); svg.innerHTML = ''; return; }
  // 把光线范围纳入取景，避免光线被裁剪；光线点为 [x, y, z]，Y-Z 剖面只取 y/z
  if (opts.rays) for (const r of opts.rays) for (const p of r.pts) {
    if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
    const ay = Math.abs(p[1]); if (ay > maxY) maxY = ay;
  }
  minZ = Math.min(minZ, zImg); maxZ = Math.max(maxZ, zImg);
  maxY = Math.max(maxY, 0.1) * 1.13;

  const padZ = (maxZ - minZ) * 0.035 + 1;
  const W = maxZ - minZ + 2 * padZ, H = 2 * maxY;
  const rect = svg.getBoundingClientRect();
  const availW = rect.width || 480, availH = rect.height || 360;
  const scale = Math.min(availW / W, availH / H);
  const PX = Math.round(W * scale), PY = Math.round(H * scale);
  const X = z => (z - minZ + padZ) * scale;
  const Y = y => (PY / 2) - y * scale;

  const g = ['<g id="lgRoot">'];
  // 光学轴（虚线）
  g.push(`<line x1="0" y1="${Y(0)}" x2="${PX}" y2="${Y(0)}" stroke="${INK3}" stroke-width="1" stroke-dasharray="7 4" opacity=".5"/>`);
  // 镜片轮廓（参考站填充风格）
  elements.forEach(e => {
    const d = 'M' + e.front.map(p => `${X(p[0]).toFixed(2)} ${Y(p[1]).toFixed(2)}`).join(' L') +
      ' L' + e.back.slice().reverse().map(p => `${X(p[0]).toFixed(2)} ${Y(p[1]).toFixed(2)}`).join(' L') + ' Z';
    g.push(`<path d="${d}" fill="${GLASS}" fill-opacity=".9" stroke="${GSTROKE}" stroke-width="1.15" stroke-linejoin="round"/>`);
  });
  // 光阑刻线 + 标注
  const st = surfaceList[sys.stopIndex];
  if (st) {
    const hs = Math.min(Math.max(st.mSemi ?? st.semi ?? 5, 0.5), maxY);
    const topH = Math.min(hs * 1.4 + 0.5, maxY);
    const zs = st.z;
    g.push(`<line x1="${X(zs)}" y1="${Y(hs)}" x2="${X(zs)}" y2="${Y(topH)}" stroke="${INK}" stroke-width="2"/>`);
    g.push(`<line x1="${X(zs)}" y1="${Y(-hs)}" x2="${X(zs)}" y2="${Y(-topH)}" stroke="${INK}" stroke-width="2"/>`);
    if (opts.highlightIdx != null && sys.stopIndex === opts.highlightIdx) {
      g.push(`<line x1="${X(zs)}" y1="${Y(hs)}" x2="${X(zs)}" y2="${Y(topH)}" stroke="#ffd633" stroke-width="3"/>`);
      g.push(`<line x1="${X(zs)}" y1="${Y(-hs)}" x2="${X(zs)}" y2="${Y(-topH)}" stroke="#ffd633" stroke-width="3"/>`);
    }
    g.push(`<text x="${X(zs)}" y="${Y(topH) - 5}" fill="${INK2}" font-size="10.5" text-anchor="middle" font-family="ui-monospace, monospace">光阑</text>`);
  }
  // 像面刻线 + 标注：高度跟随视场/像高(取各视场主光线落点最大 |y|)
  const fh = (opts.imageMarks || []).reduce((m, x) => Math.max(m, Math.abs(x.y || 0)), 0);
  const ih = Math.max(fh * 1.06, maxY * 0.2, 0.6);
  g.push(`<line x1="${X(zImg)}" y1="${Y(ih)}" x2="${X(zImg)}" y2="${Y(-ih)}" stroke="${INK}" stroke-width="2"/>`);
  g.push(`<text x="${X(zImg) - 5}" y="${Y(ih) - 5}" fill="${INK2}" font-size="10.5" text-anchor="end" font-family="ui-monospace, monospace">像面</text>`);

  // 主光线在像面的落点刻度（核对像高）：黄色圆点 + 像高读数
  if (opts.imageMarks) for (const m of opts.imageMarks) {
    if (m.y == null || !isFinite(m.y)) continue;
    const yy = Y(m.y);
    const lbl = m.mode === 'height' ? `${m.y.toFixed(2)}mm` : `θ${m.field}°→${m.y.toFixed(2)}mm`;
    g.push(`<circle cx="${X(zImg)}" cy="${yy}" r="2.6" fill="#ffd633" opacity=".95" stroke="#7a5a00" stroke-width=".6"/>`);
    g.push(`<text x="${X(zImg) - 6}" y="${yy - 5}" fill="#ffe9a3" font-size="9.5" text-anchor="end" font-family="ui-monospace, monospace">${lbl}</text>`);
  }

  // 光线（M2a：子午光路。每条光线可带 color/alpha/dash/edge；渐晕光线淡虚线）
  if (opts.rays && opts.rays.length) {
    const cols = ['#ffd633', '#ff8a3c', '#ff5a5a', '#e06bff', '#5aa7ff', '#59e0c0', '#d0e84a'];
    opts.rays.forEach((r, idx) => {
      if (!r.pts || r.pts.length < 2) return;
      const c = r.color || (r.edge ? '#ffd633' : cols[idx % cols.length]);
      const dash = r.dash ? ' stroke-dasharray="' + r.dash + '"' : '';
      const alpha = r.alpha != null ? r.alpha : .9;
      const wid = r.edge ? 1.6 : 1.1;
      const d = r.pts.map((p, j) => (j ? 'L' : 'M') + X(p[2]).toFixed(2) + ' ' + Y(p[1]).toFixed(2)).join(' ');
      g.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="${wid}" opacity="${alpha}"${dash}/>`);
    });
  }

  // 选中面高亮（点击面表时在 2D 图上也体现）：把该面轮廓再描一遍
  const hlIdx = opts.highlightIdx;
  if (hlIdx != null) {
    const drawHl = (pts) => {
      if (!pts || pts.length < 2) return;
      const dd = 'M' + pts.map(p => `${X(p[0]).toFixed(2)} ${Y(p[1]).toFixed(2)}`).join(' L');
      g.push(`<path d="${dd}" fill="none" stroke="#ffd633" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" opacity=".95"/>`);
    };
    for (const e of elements) {
      if (hlIdx === e.fi) drawHl(e.front);
      if (hlIdx === e.bi) drawHl(e.back);
    }
  }

  g.push('</g>');
  svg.setAttribute('viewBox', `0 0 ${PX} ${PY}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = g.join('');
}

// 2D 布局图例徽标：镜片数
export function layoutBadge(sys) {
  let n = 0;
  for (let i = 0; i < sys.surfaces.length - 1; i++) {
    const s = sys.surfaces[i];
    if (s.type === SURF.IMAGE || s.type === SURF.OBJECT) continue;
    const glass = s.glass && s.glass.toUpperCase() !== 'AIR' && s.glass.toUpperCase() !== '';
    if (glass) n++;
  }
  return `${n} 片`;
}
