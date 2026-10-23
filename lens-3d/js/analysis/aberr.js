// analysis/aberr.js — 像差分析：场曲/像散、F-Tan(Theta) 畸变、纵向球差、最佳对焦
import { LAM_D, indexOf } from '../core/glass.js?v=1.5.15';
import { opticalSurfaces } from '../core/surface.js?v=1.5.15';
import { traceRay3, firstOrder } from '../core/raytrace.js?v=1.5.15';
import { traceFieldBundle } from '../core/beam.js?v=1.5.15';


// ---- 近轴主光线像高：主光线(过入瞳中心)的近轴追迹（与 Zemax「参考高度」一致）----
function paraxChiefHeight(sys, surfaceList, thetaDeg, lam, zEP) {
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return 0;
  const u0 = Math.tan(thetaDeg * Math.PI / 180);
  let u = u0, y = -u0 * (zEP || 0), n = indexOf(sys.surfaces[0]?.glass, lam);
  for (let k = 0; k < S.length; k++) {
    const i = S[k].i;
    const R = sys.surfaces[i].radius;
    const c = (R && isFinite(R) && R !== 0) ? 1 / R : 0;
    const n2 = indexOf(sys.surfaces[i].glass, lam);
    u = (n * u - y * c * (n2 - n)) / n2; n = n2;
    const t = (k < S.length - 1) ? (S[k + 1].z - S[k].z) : (0 - S[k].z);
    y += u * t;
  }
  return y;
}

// ---- 场曲/像散 + 畸变：逐视场、逐波长 求 主光线像高(畸变) 与 子午 T / 弧矢 S 焦移 ----
// 场角：角度模式=场值；高度模式按【近轴像高】反推 θ=atan(h/EFL)（与 Zemax 场定义一致）。
// 畸变% = (|实像高| − |近轴主光像高|)/|近轴主光像高| ×100（近轴值由 paraxChiefHeight 追迹）。
// 场曲 Z 式：T/S = 边缘光线(py/px=±1)与主光线的轴向交点。每波长各算一组（Zemax 场曲图按波长分色）。
export function fieldAberrations(sys, surfaceList, cfg = {}) {
  const mode = cfg.mode === 'height' ? 'height' : 'angle';
  const lambdas = (cfg.lambdas && cfg.lambdas.length) ? cfg.lambdas
    : [{ nm: (cfg.lambdaUm ?? LAM_D) * 1000, color: '#ffb300' }];
  const list = (cfg.fields && cfg.fields.length) ? cfg.fields : [0];
  const efl = (firstOrder(sys, surfaceList, lambdas[0].nm / 1000) || {}).efl || 0;
  // 近轴倍率(逐波长)：用极小视场(0.001mm)实追迹主光线得到"近轴像高/视场"之比。
  // 近轴参考像高 = (EFL·tanθ) × 倍率；高度模式下 EFL·tanθ 即视场值，故参考≈近轴实像高，近轴区畸变≈0，曲线平滑。
  const tinyH = 0.1;
  const scales = lambdas.map(wl => {
    const L = wl.nm / 1000;
    const thT = Math.atan(tinyH / (Math.abs(efl) > 1e-9 ? efl : 1)) * 180 / Math.PI;
    const bT = traceFieldBundle(sys, surfaceList, { mode: 'angle', field: thT, nPupil: 1, lambdaUm: L });
    const cT = bT.chief;
    if (!cT) return 1;
    const pT = (cT._a != null ? cT._a : cT._h) || 0, zsT = cT._zStart, aT = thT * Math.PI / 180;
    const tr = traceRay3(sys, surfaceList, [0, pT, zsT], [0, Math.sin(aT), Math.cos(aT)], L, true);
    return (tr.ok && tr.imageY != null && Math.abs(tr.imageY) > 1e-12) ? Math.abs(tr.imageY) / tinyH : 1;
  });
  const scaleOf = i => (scales[i] && isFinite(scales[i]) && scales[i] > 0) ? scales[i] : 1;
  const items = [];
  for (const fv of list) {
    const thetaDeg = (mode === 'height') ? Math.atan(fv / (Math.abs(efl) > 1e-9 ? efl : 1)) * 180 / Math.PI : fv;
    const b = traceFieldBundle(sys, surfaceList, { mode: 'angle', field: thetaDeg, nPupil: 1, lambdaUm: lambdas[0].nm / 1000 });
    const c = b.chief;
    if (!c) { items.push({ field: fv, ok: false }); continue; }
    const finite = c._finite;
    const param = (c._a != null ? c._a : c._h) || 0;
    const zEP = c._zEP ?? b.stopZ, zObj = c._zObj, zStart = c._zStart, epd = b.epd || 1;
    const ang = thetaDeg * Math.PI / 180;
    const buildRay = (px, py) => {
      if (finite) {
        const dx = px * epd / 2, dy = py * epd / 2 - param, dz = zEP - zObj;
        const L = Math.hypot(dx, dy, dz) || 1;
        return { P0: [0, param, zObj], D0: [dx / L, dy / L, dz / L] };
      }
      return { P0: [px * epd / 2, param + py * epd / 2, zStart], D0: [0, Math.sin(ang), Math.cos(ang)] };
    };
    const hitAt = (px, py, L) => {
      const rb = buildRay(px, py);
      const tr = traceRay3(sys, surfaceList, rb.P0, rb.D0, L, true);   // 参考光线放开孔径(否则边缘光线被渐晕会出尖点)
      if (!(tr.ok && tr.imageX != null && tr.imageY != null)) return null;
      const D = tr.dir || [0, 0, 1], uz = Math.abs(D[2]) > 1e-12 ? D[2] : 1;
      return { x: tr.imageX, y: tr.imageY, ux: D[0] / uz, uy: D[1] / uz };
    };
    const perWl = lambdas.map((wl, wi) => {
      const L = wl.nm / 1000;
      const ch = hitAt(0, 0, L);
      if (!ch) return { nm: wl.nm, color: wl.color, ok: false };
      const hp = ((Math.abs(efl) > 1e-9) ? efl * Math.tan(ang) : (mode === 'height' ? fv : 0)) * scaleOf(wi);
      const refH = Math.abs(hp) > 1e-9 ? Math.abs(hp) : 1e-9;
      const dist = (Math.abs(ch.y) - Math.abs(hp)) / refH * 100;
      const chiefCross = (e, key) => {
        const ax = key === 'y' ? 'y' : 'x', ak = key === 'y' ? 'uy' : 'ux';
        const ref = key === 'y' ? ch.y : ch.x, refU = key === 'y' ? ch.uy : ch.ux;
        const du = e[ak] - refU;
        if (Math.abs(du) < 1e-9) return null;              // 边缘光线近似平行 -> 无有效交点，剔除
        const z = (ref - e[ax]) / du;
        return (isFinite(z) && Math.abs(z) < 1e4) ? z : null;
      };
      const tz = [hitAt(0, 1, L)].map(e => e && chiefCross(e, 'y')).filter(z => z !== null && z !== undefined);
      const sz = [hitAt(1, 0, L), hitAt(-1, 0, L)].map(e => e && chiefCross(e, 'x')).filter(z => z !== null && z !== undefined);
      const avg = arr => arr.length ? arr.reduce((a, b2) => a + b2, 0) / arr.length : 0;
      return {
        nm: wl.nm, color: wl.color, ok: true, realY: ch.y, idealY: hp, dist,
        _rawT: avg(tz), tFocus: avg(tz), sFocus: avg(sz),
      };
    });
    items.push({ field: fv, ok: true, theta: thetaDeg, perWl });
  }
  // 子午场曲按 Zemax 口径：+1 边缘光线×主光线，相对轴上归零
  const axis = items.find(it => it.ok && Math.abs(it.field) < 1e-9);
  if (axis) {
    const aT = axis.perWl.map(p => (p.ok ? p._rawT : 0));
    for (const it of items) {
      if (!it.ok) continue;
      for (let wi = 0; wi < it.perWl.length; wi++) {
        const p = it.perWl[wi];
        if (p.ok) p.tFocus = p._rawT - aT[wi];
      }
    }
  }
  return { mode, efl, wl: lambdas.map(w => ({ nm: w.nm, color: w.color })), items };
}

// ---- 纵向球差(LSA)：轴上视场，逐波长沿子午方向扫描入瞳高度 ----
// 每条光线与光轴的交点 z 相对近轴焦点(z = 末面顶点 + BFL)的偏移即 LSA(mm)。
// Zemax「纵向球差」口径：纵轴=归一化瞳高(-1..+1)，横轴=焦移 mm，0 = 近轴焦面。
export function longitudinalAberration(sys, surfaceList, cfg = {}) {
  const lambdas = (cfg.lambdas && cfg.lambdas.length) ? cfg.lambdas
    : [{ nm: (cfg.lambdaUm ?? LAM_D) * 1000, color: '#ffb300' }];
  const N = Math.max(5, Math.min(81, cfg.nGrid ?? 41)) | 0;
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return { zParax: 0, zImage: 0, perWl: [] };
  const zLast = S[S.length - 1].z;
  const perWl = lambdas.map((wl) => {
    const L = wl.nm / 1000;
    const fo = firstOrder(sys, surfaceList, L);
    const zParax = (fo && isFinite(fo.bfl)) ? zLast + fo.bfl : 0;
    const b = traceFieldBundle(sys, surfaceList, { mode: 'angle', field: 0, nPupil: 1, lambdaUm: L });
    const c = b.chief;
    if (!c) return { nm: wl.nm, color: wl.color, ok: false, zParax, pts: [] };
    const finite = c._finite;
    const param = (c._a != null ? c._a : c._h) || 0;
    const zEP = c._zEP ?? b.stopZ, zObj = c._zObj, zStart = c._zStart, epd = b.epd || 1;
    const ang = (c._theta ?? 0) * Math.PI / 180;
    const pts = [];
    for (let k = 0; k < N; k++) {
      const p = -1 + 2 * k / (N - 1);
      let P0, D0;
      if (finite) {
        const dy = p * epd / 2 - param, dz = zEP - zObj;
        const L0 = Math.hypot(dy, dz) || 1;
        P0 = [0, param, zObj]; D0 = [0, dy / L0, dz / L0];
      } else {
        P0 = [0, param + p * epd / 2, zStart]; D0 = [0, Math.sin(ang), Math.cos(ang)];
      }
      const tr = traceRay3(sys, surfaceList, P0, D0, L, true);
      let lsa = null;
      if (tr.ok && tr.lastHit && tr.dir && Math.abs(tr.dir[1]) > 1e-12) {
        const zc = tr.lastHit[2] - tr.lastHit[1] * tr.dir[2] / tr.dir[1];
        if (isFinite(zc)) lsa = zc - zParax;
      }
      pts.push({ p, h: p * epd / 2, lsa });
    }
    return { nm: wl.nm, color: wl.color, ok: pts.some(q => q.lsa != null), zParax, pts };
  });
  return { zParax: perWl[0] ? perWl[0].zParax : 0, zImage: 0, perWl };
}

// ---- 最佳对焦：使所选视场/波长的 RMS 点列半径最小的像面平移量 ----
// 像面沿 +z 平移 s 后落点 x(s)=x0+s·ux, y(s)=y0+s·uy（ux=dx/dz, uy=dy/dz）。
// RMS²(s) 是 s 的二次函数，闭式最优 s* = -B/A（A、B 为去质心后的加权二阶/交叉矩）。
export function bestFocus(sys, surfaceList, cfg = {}) {
  const mode = cfg.mode === 'height' ? 'height' : 'angle';
  const lambdas = (cfg.lambdas && cfg.lambdas.length) ? cfg.lambdas : [{ nm: (cfg.lambdaUm ?? LAM_D) * 1000, weight: 1 }];
  const list = (cfg.fields && cfg.fields.length) ? cfg.fields : [0];
  const N = Math.max(3, Math.min(41, cfg.nGrid ?? 11)) | 0;
  const S = opticalSurfaces(sys, surfaceList);
  const vigCoefs = cfg.vigCoefs || [];
  if (!S.length) return null;
  const groups = [];
  list.forEach((fv, fi) => {
    const vc = vigCoefs[fi] || null;
    const inWin = (px, py) => !vc || (px >= vc.xLo && px <= vc.xHi && py >= vc.yLo && py <= vc.yHi);
    const pts = [];
    groups.push(pts);
    lambdas.forEach((wl) => {
      const L = wl.nm / 1000, w = (wl.weight == null ? 1 : wl.weight) || 0;
      if (!(w > 0)) return;
      const b = traceFieldBundle(sys, surfaceList, { mode, field: +fv, nPupil: 1, lambdaUm: L });
      const c = b.chief; if (!c) return;
      const finite = c._finite;
      const param = (c._a != null ? c._a : c._h) || 0;
      const zEP = c._zEP ?? b.stopZ, zObj = c._zObj, zStart = c._zStart, epd = b.epd || 1;
      const ang = (c._theta ?? 0) * Math.PI / 180;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const px = -1 + 2 * i / (N - 1), py = -1 + 2 * j / (N - 1);
        if (!inWin(px, py)) continue;
        let P0, D0;
        if (finite) {
          const dx = px * epd / 2, dy = py * epd / 2 - param, dz = zEP - zObj;
          const L0 = Math.hypot(dx, dy, dz) || 1; P0 = [0, param, zObj]; D0 = [dx / L0, dy / L0, dz / L0];
        } else {
          P0 = [px * epd / 2, param + py * epd / 2, zStart]; D0 = [0, Math.sin(ang), Math.cos(ang)];
        }
        const tr = traceRay3(sys, surfaceList, P0, D0, L, false);
        if (!(tr.ok && tr.imageX != null && tr.imageY != null)) continue;
        const D = tr.dir || [0, 0, 1], uz = Math.abs(D[2]) > 1e-12 ? D[2] : 1;
        pts.push({ x: tr.imageX, y: tr.imageY, u: D[0] / uz, v: D[1] / uz, w });
      }
    });
  });
  // 逐视场各去各的质心（点列 RMS 按场定义），再按权重汇总；A/B/C 可跨场相加。
  let A = 0, B = 0, C = 0, W = 0, n = 0;
  for (const pts of groups) {
    if (pts.length < 3) continue;
    let w = 0, X = 0, Y = 0, U = 0, V = 0;
    for (const p of pts) { w += p.w; X += p.w * p.x; Y += p.w * p.y; U += p.w * p.u; V += p.w * p.v; }
    if (!(w > 0)) continue;
    const xb = X / w, yb = Y / w, ub = U / w, vb = V / w;
    for (const p of pts) {
      const dx = p.x - xb, dy = p.y - yb, du = p.u - ub, dv = p.v - vb;
      A += p.w * (du * du + dv * dv);
      B += p.w * (dx * du + dy * dv);
      C += p.w * (dx * dx + dy * dy);
    }
    W += w; n += pts.length;
  }
  if (!(W > 0)) return null;
  const shift = A > 1e-16 ? -B / A : 0;
  const rms0 = Math.sqrt(C / W);
  const rmsBest = A > 1e-16 ? Math.sqrt(Math.max(0, C / W - (B * B) / (A * W))) : rms0;
  return { shift, rms0, rmsBest, nRays: n, mode, fields: list.slice() };
}
