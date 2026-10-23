// core/beam.js — 「束」层：视场光束/主光线瞄准/自动渐晕/逐视场调度
import { LAM_D, indexOf } from './glass.js?v=1.5.15';
import { opticalSurfaces, intersect, surfaceNormal, refract } from './surface.js?v=1.5.15';
import { traceRay3, firstOrder, entrancePupil, beamEPD } from './raytrace.js?v=1.5.15';


// 追迹「轴上平行光」在光阑口径内的 nRay 条子午光线
export function traceAxialBundle(sys, surfaceList, opts = {}) {
  const nRay = opts.nRay ?? 7;
  const lambdaUm = opts.lambdaUm ?? LAM_D;
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return { rays: [], points: null };
  const st = sys.surfaces[sys.stopIndex];
  const hPupil = opts.pupilH ?? Math.max(st?.semi ?? st?.mSemi ?? 5, 1e-3);
  const lead = Math.max(8, Math.abs(S[0].z) * 0.08);
  const zStart = S[0].z - lead;
  const rays = [];
  for (let k = 0; k < nRay; k++) {
    const y0 = (nRay === 1) ? 0 : -hPupil + 2 * hPupil * k / (nRay - 1);
    let P = [y0, zStart], D = [0, 1], n1 = indexOf(sys.surfaces[0]?.glass, lambdaUm);
    const pts = [[P[0], P[1]]];
    let ok = true;
    for (let i = 0; i < S.length; i++) {
      const si = S[i];
      const n2 = indexOf(si.glass, lambdaUm);
      const hit = intersect(P, D, si.z, si.shape);
      if (!hit) { ok = false; break; }
      pts.push([hit[0], hit[1]]);
      const N = surfaceNormal(hit[0], si.shape);
      const D2 = refract(D, N, n1, n2);
      if (!D2) { ok = false; break; }
      const L = Math.hypot(D2[0], D2[1]); D = [D2[0] / L, D2[1] / L];
      P = hit; n1 = n2;
    }
    if (ok && Math.abs(D[1]) > 1e-9) {
      const t = (0 - P[1]) / D[1];
      pts.push([P[0] + t * D[0], 0]);                     // 投到像面 z=0
    }
    rays.push({ pts, ok });
  }
  return { rays, hPupil, zStart, nRay };
}

// ====================================================================
// M2a-2 —— 视场光线 / 光阑瞄准 / 入瞳 / 渐晕（仍为子午面 Y-Z，x=0）
// 约定：沿每条光线记录「打在哪个面、y 多少」，光阑瞄准 = 牛顿/二分让入射条件
//       使光线恰好落在光阑面目标高度；渐晕 = 任一折射面 |y| 超过其半孔径即截断。
// ====================================================================

// 追迹一条光线，返回逐面命中点 [y,z] + 像面落点 + 渐晕/未命中信息。
function traceHits(sys, surfaceList, P0, D0, lambdaUm, ignoreAp) {
  const S = opticalSurfaces(sys, surfaceList);
  let P = [P0[0], P0[1]], D = [D0[0], D0[1]];
  const L0 = Math.hypot(D[0], D[1]) || 1; D = [D[0] / L0, D[1] / L0];
  let n = indexOf(sys.surfaces[0]?.glass, lambdaUm);
  const pts = [[P[0], P[1]]], hits = [];
  for (let i = 0; i < S.length; i++) {
    const si = S[i];
    const hit = intersect(P, D, si.z, si.shape);
    if (!hit) return { ok: false, hits, pts, blockedAt: i, imageY: null };
    pts.push([hit[0], hit[1]]);
    hits.push({ i: si.i, z: si.z, y: hit[0] });
    const semi = sys.surfaces[si.i].semi ?? sys.surfaces[si.i].mSemi ?? Infinity;
    if (!ignoreAp && isFinite(semi) && Math.abs(hit[0]) > semi * 1.0000001)
      return { ok: false, hits, pts, blockedAt: i, vignetted: true, imageY: null };
    const n2 = indexOf(si.glass, lambdaUm);
    const N = surfaceNormal(hit[0], si.shape);
    const D2 = refract(D, N, n, n2);
    if (!D2) return { ok: false, hits, pts, blockedAt: i, tir: true, imageY: null };
    const L = Math.hypot(D2[0], D2[1]); D = [D2[0] / L, D2[1] / L];
    P = hit; n = n2;
  }
  let imageY = null;
  if (Math.abs(D[1]) > 1e-9) {
    const t = (0 - P[1]) / D[1];
    imageY = P[0] + t * D[0];
    pts.push([imageY, 0]);                         // 投到像面 z=0
  }
  return { ok: true, hits, pts, blockedAt: -1, imageY, vignetted: false };
}

// 1D 求解目标量：寻找参数 x 使 F(x) 的「光阑面落点 y」等于 target。
// 通用单调/近似单调求解：牛顿有限差分 + 二分兜底。obj(r) 提取光阑面落点 y。
function solveMono(F, target, guess, span, obj) {
  const g = (x) => { const v = obj(F(x)); return v == null ? NaN : v - target; };
  let x = guess, gx = g(x);
  if (!isFinite(gx)) { x = guess + span * 0.3; gx = g(x); }
  for (let k = 0; k < 60; k++) {
    if (Math.abs(gx) < 1e-4) return x;
    const dx = Math.max(1e-4, Math.abs(x) * 1e-3 + 1e-4);
    const g2 = g(x + dx);
    if (!isFinite(g2)) { x = (x + guess) / 2; gx = g(x); continue; }
    const df = (g2 - gx) / dx;
    if (!isFinite(df) || Math.abs(df) < 1e-12) break;
    const nx = x - gx / df;
    if (!isFinite(nx) || Math.abs(nx) > 1e9) break;
    if (Math.abs(nx - x) < 1e-7) { x = nx; break; }
    x = nx; gx = g(x);
  }
  // 二分兜底
  let lo = guess - span, hi = guess + span, glo = g(lo), ghi = g(hi);
  for (let k = 0; k < 40 && isFinite(glo) && isFinite(ghi) && glo * ghi > 0; k++) { lo *= 1.5; hi *= 1.5; glo = g(lo); ghi = g(hi); }
  if (!isFinite(glo)) return x;
  if (!isFinite(ghi)) { ghi = g(hi = x + span); }
  for (let it = 0; it < 120; it++) {
    if (Math.abs(hi - lo) < 1e-7) break;
    const mid = (lo + hi) / 2, gm = g(mid);
    if (isFinite(gm) && gm * ghi <= 0) { lo = mid; glo = gm; } else { hi = mid; ghi = gm; }
  }
  return (lo + hi) / 2;
}

// 视场光线束：一条主光线(瞄到光阑中心 y=0) + 入瞳内 2D 采样的 nPupil 条光线(3D)。
// mode='angle'：field 为物方角度(°)；mode='height'：field 为主光线打在像面的高度(mm)。
// 视场光线束：主光线(瞄到光阑中心) + 入瞳 2D 采样 nPupil 条光线(3D)。
// mode='angle'|'height'；对象在无穷远(objectDist=∞)→平行光束；有限共轭→自物点发散光束，
// 物距(sys.objectDist)真正参与追迹。
export function traceFieldBundle(sys, surfaceList, o) {
  const lam = o.lambdaUm ?? LAM_D;
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return { mode: o.mode, field: o.field, chief: null, rays: [] };
  const stopI = sys.stopIndex;
  const st = sys.surfaces[stopI];
  const stopSemi = st?.semi ?? st?.mSemi ?? 1e-3;
  const mode = o.mode === 'height' ? 'height' : 'angle';
  const fv = o.field ?? 0;
  const zStart = S[0].z - Math.max(8, Math.abs(S[0].z) * 0.08);
  const stopZ = surfaceList[stopI]?.z ?? 0;
  const epd = beamEPD(sys, surfaceList, lam);
  const ep = entrancePupil(sys, surfaceList, lam);
  const zEP = (ep && isFinite(ep.zEP)) ? ep.zEP : stopZ;
  const finite = isFinite(sys.objectDist) && sys.objectDist > 0 && sys.objectDist < 1e7;
  const zObj = finite ? S[0].z - sys.objectDist : null;

  const stopYOf = (r) => { if (!r || !r.ok) return null; const h = r.hits.find(q => q.i === stopI); return h ? h.y : null; };
  const imageYOf = (tr) => tr ? tr.imageY : null;

  let chief = null, param = 0;         // param: 无穷远=入瞳y偏移；有限=物高
  if (!finite) {
    const chiefAt = (deg) => {
      const ang = deg * Math.PI / 180;
      const dir = [0, Math.sin(ang), Math.cos(ang)];
      const f = (a) => traceRay3(sys, surfaceList, [0, a, zStart], dir, lam, true);
      const a = solveMono(f, 0, -Math.tan(ang) * (stopZ - zStart), Math.max(60, Math.abs(deg) * 2 + 40), stopYOf);
      if (a == null) return null;
      const tr = traceRay3(sys, surfaceList, [0, a, zStart], dir, lam, true);
      tr._a = a; tr._theta = deg; tr._finite = false; tr._zStart = zStart; tr._zEP = zEP; tr._zObj = null; tr._epd = epd;
      return tr;
    };
    let thetaDeg;
    if (mode === 'angle') thetaDeg = fv;
    else {
      // 初值用真实 EFL 反推半视场角，而非假设焦距=30mm。此前硬编码 30 在高像高/长焦时初值严重偏离，
      // 使牛顿/二分收敛到错误大角度，主光线撞上非球面被挡(TIR/miss) -> 大视场追不到像面。
      const eflEst = Math.abs((firstOrder(sys, surfaceList, lam) || {}).efl) || 30;
      thetaDeg = solveMono((deg) => chiefAt(deg), fv, Math.atan(fv / eflEst) * 180 / Math.PI, 90, imageYOf);
    }
    chief = chiefAt(thetaDeg);
    param = chief ? chief._a : 0;
  } else {
    const finiteChief = (h) => {
      const gs = -h / (stopZ - zObj);
      const f = (s) => { const L = Math.hypot(s, 1); return traceRay3(sys, surfaceList, [0, h, zObj], [0, s / L, 1 / L], lam, true); };
      const s = solveMono(f, 0, gs, 2, stopYOf);
      if (s == null) return null;
      const L = Math.hypot(s, 1);
      const tr = traceRay3(sys, surfaceList, [0, h, zObj], [0, s / L, 1 / L], lam, true);
      tr._h = h; tr._theta = Math.atan2(h, zEP - zObj) * 180 / Math.PI; tr._finite = true; tr._zStart = zStart; tr._zEP = zEP; tr._zObj = zObj; tr._epd = epd;
      return tr;
    };
    let h;
    if (mode === 'angle') { const th = fv * Math.PI / 180; h = -Math.tan(th) * (zEP - zObj); }
    else {
      const tr1 = finiteChief(1); const mag = tr1 ? tr1.imageY : NaN;
      h = solveMono((hh) => finiteChief(hh), fv, (isFinite(mag) && Math.abs(mag) > 1e-9) ? fv / mag : fv, Math.max(20, Math.abs(fv) * 3 + 30), imageYOf);
    }
    chief = finiteChief(h);
    param = h;
  }

  // 入瞳 2D 采样：主光线(px=0,py=0) + 子午(py) + 弧矢(px)。自动渐晕(vc)裁剪窗口外光线。
  const N = Math.max(1, o.nPupil ?? 9);
  const vc = o.vigCoef || null;
  const inWin = (px, py) => !vc || ((px >= vc.xLo && px <= vc.xHi) && (py >= vc.yLo && py <= vc.yHi));
  const rays = [];
  let nSample = 0, nVig = 0, nTrace = 0;   // 总采样 / 被截断 / 实际追迹(未被瞳窗口提前剔除)
  const addAt = (px, py) => {
    nSample++;
    if (!inWin(px, py)) { nVig++; return; }   // 自动渐晕窗口外：不追迹，计入被截断
    nTrace++;
    let P0, D0;
    if (finite) {
      P0 = [0, param, zObj];
      const dx = px * epd / 2, dy = py * epd / 2 - param, dz = zEP - zObj;
      const L = Math.hypot(dx, dy, dz) || 1; D0 = [dx / L, dy / L, dz / L];
    } else {
      const ang = (chief && chief._theta != null ? chief._theta : 0) * Math.PI / 180;
      P0 = [px * epd / 2, param + py * epd / 2, zStart]; D0 = [0, Math.sin(ang), Math.cos(ang)];
    }
    const tr = traceRay3(sys, surfaceList, P0, D0, lam, false);
    if (tr.vignetted) {
      nVig++;
      if (vc) return;                                        // 自动渐晕：被渐晕光线不显示
    }
    rays.push({ px, py, pts: tr.pts, ok: tr.ok, imageX: tr.imageX, imageY: tr.imageY, blockedAt: tr.blockedAt, vignetted: !!tr.vignetted, autoVig: !!vc });
  };
  for (let k = 0; k < N; k++) { const py = (N === 1) ? 0 : (-1 + 2 * k / (N - 1)); if (py === 0) continue; addAt(0, py); }
  for (let k = 0; k < N; k++) { if (N === 1) break; const px = -1 + 2 * k / (N - 1); if (px === 0) continue; addAt(px, 0); }

  const toOut = (tr) => tr ? { pts: tr.pts, ok: tr.ok, imageX: tr.imageX, imageY: tr.imageY, blockedAt: tr.blockedAt, vignetted: !!tr.vignetted } : null;
  return {
    mode, field: fv, stopSemi, stopZ, epd, finite, nSample, nVig, nTrace,
    chief: chief ? { ...toOut(chief), _theta: chief._theta, _a: chief._a, _h: chief._h, _finite: chief._finite, _zStart: chief._zStart, _zEP: chief._zEP, _zObj: chief._zObj } : null,
    rays, vigCoef: vc,
  };
}

// ---- 自动渐晕：按「净口径/半孔径」逐视场求入瞳窗口(归一化 pupil 上下界) ----
// 对每视场在 ±Y(子午) / ±X(弧矢) 方向二分，找到「刚好能全程通过所有真实通光」的瞳坐标，
// 得到 {yLo,yHi,xLo,xHi}（=参考站 setVig 的 vly/vuy/vlx/vux 反向）。窗口外光线即渐晕。
export function autoVignette(sys, surfaceList, cfg = {}) {
  const lam = cfg.lambdaUm ?? LAM_D;
  const list = (cfg.fields && cfg.fields.length) ? cfg.fields : [0];
  const epd = beamEPD(sys, surfaceList, lam);
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return list.map(() => null);
  const zStart = S[0].z - Math.max(8, Math.abs(S[0].z) * 0.08);
  return list.map((fv) => {
    // 主光线(瞄到光阑中心)给出物体角与入瞳中心偏移/物高
    const b = traceFieldBundle(sys, surfaceList, { mode: cfg.mode, field: +fv, nPupil: 1, lambdaUm: lam });
    const c = b.chief;
    const finite = !!(c && c._finite);
    const theta = c && c._theta != null ? c._theta : 0;
    const aC = c ? (c._a ?? c._h ?? 0) : 0;
    const zObj = c ? c._zObj : null;
    const zEP = c ? c._zEP : 0;
    const z0 = c ? c._zStart : zStart;
    const blocked = (px, py) => {
      let P0, D0;
      if (finite) {
        P0 = [0, aC, zObj];
        const dx = px * epd / 2, dy = py * epd / 2 - aC, dz = zEP - zObj;
        const L = Math.hypot(dx, dy, dz) || 1; D0 = [dx / L, dy / L, dz / L];
      } else {
        const ang = theta * Math.PI / 180;
        P0 = [px * epd / 2, aC + py * epd / 2, z0]; D0 = [0, Math.sin(ang), Math.cos(ang)];
      }
      const tr = traceRay3(sys, surfaceList, P0, D0, lam, false);
      return !tr.ok || tr.vignetted;
    };
    const edge = (which, sgn) => {                 // which='y'|'x'，sgn=±1 => 上下沿
      const at = (u) => which === 'y' ? blocked(0, sgn * u) : blocked(sgn * u, 0);
      if (!at(1)) return sgn;                      // 满瞳都能过 -> 无渐晕
      let a = 0, b = 1;                            // a 过、b 挡
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (at(m)) b = m; else a = m; }
      return sgn * a;
    };
    return { yLo: edge('y', -1), yHi: edge('y', 1), xLo: edge('x', -1), xHi: edge('x', 1) };
  });
}

// 总入口：按 cfg 数组做多视场追迹，返回 { fields, EP }。
// 支持逐波长：cfg.lambdas=[{nm,weight,color}] + cfg.primary；每个视场生成 lams[]，
// 并把主波长的那一束作为该视场的 chief/rays（供读数/光路）。
export function traceFields(sys, surfaceList, cfg = {}) {
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return { fields: [], EP: null };
  const EP = entrancePupil(sys, surfaceList, cfg.lambdaUm ?? LAM_D);
  const wls = (cfg.lambdas && cfg.lambdas.length)
    ? cfg.lambdas
    : [{ nm: 587.6, weight: 1, color: '#ffb300' }];
  const pri = Math.max(0, Math.min(wls.length - 1, cfg.primary ?? 0));
  const list = (cfg.fields && cfg.fields.length) ? cfg.fields : [0];
  const vigCoefs = cfg.vigCoefs || [];
  const fields = [];
  list.forEach((fv, i) => {
    const lams = wls.map((w, li) => {
      const b = traceFieldBundle(sys, surfaceList, {
        mode: cfg.mode, field: +fv, nPupil: cfg.nPupil ?? 9, lambdaUm: (w.nm ?? 587.6) / 1000, vigCoef: vigCoefs[i],
      });
      return {
        nm: w.nm, weight: w.weight ?? 1, color: w.color || '#ffb300', primary: li === pri,
        chief: b.chief, rays: b.rays, stopSemi: b.stopSemi, stopZ: b.stopZ, epd: b.epd,
        nSample: b.nSample || 0, nVig: b.nVig || 0, nTrace: b.nTrace || 0,
        mode: cfg.mode, field: +fv,
      };
    });
    const m = lams[pri];
    fields.push({
      mode: cfg.mode, field: +fv, lams, chief: m.chief, rays: m.rays, epd: m.epd,
      nSample: m.nSample || 0, nVig: m.nVig || 0, nTrace: m.nTrace || 0,
    });
  });
  return { fields, EP, primaryNm: wls[pri].nm ?? 587.6, wavelengths: wls.map(w => ({ nm: w.nm, weight: w.weight, color: w.color })) };
}
