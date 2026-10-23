// analysis/wavefront.js — 波前(OPD)采样：复瞳函数输入，供 mtf.js 的 FFT 衍射 MTF
import { LAM_D } from '../core/glass.js?v=1.5.16';
import { opticalSurfaces } from '../core/surface.js?v=1.5.16';
import { traceRay3, firstOrder } from '../core/raytrace.js?v=1.5.16';
import { traceFieldBundle } from '../core/beam.js?v=1.5.16';


// 3×3 线性方程求解(M·x=Y)，奇异返回 null（用于波前的活塞+倾斜最小二乘）
function solve3(M, Y) {
  const A = [[M[0][0], M[0][1], M[0][2], Y[0]], [M[1][0], M[1][1], M[1][2], Y[1]], [M[2][0], M[2][1], M[2][2], Y[2]]];
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-18) return null;
    const t = A[c]; A[c] = A[p]; A[p] = t;
    for (let r = 0; r < 3; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k]; }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

// ---- 波前(FFT 衍射 MTF)用：在 N×N 瞳网格上采样 OPD(波) ----
// 逐格点追迹：OPD = OPL(到最后一个折射面) + |像点中心 − 最后折射点|；
// 再【最小二乘扣除活塞+倾斜】(a+b·u+c·v)——倾斜只平移 PSF、不影响 MTF，
// 但轴外的巨大倾斜会让 FFT 相位混叠(出现锯齿)。未到达/被挡的格点振幅=0。
// 返回复瞳函数，供 mtf.js 的 otfFromPupil 用。
export function traceWavefront(sys, surfaceList, cfg = {}) {
  const lam = cfg.lambdaUm ?? LAM_D;                  // μm
  const mode = cfg.mode === 'height' ? 'height' : 'angle';
  const fv = cfg.field ?? 0;
  let N = Math.max(32, Math.min(256, cfg.nGrid ?? 128)) | 0;
  if ((N & (N - 1)) !== 0) N = 1 << Math.ceil(Math.log2(N));   // 向上归到 2 的幂
  // FFT 自相关不绕回的前提：孔径半径 R < N/4（否则 OTF 会被周期绕回污染）
  const R = Math.max(8, Math.floor(N / 4) - 1);
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return { ok: false };
  const b = traceFieldBundle(sys, surfaceList, { mode, field: fv, nPupil: 1, lambdaUm: lam });
  const c = b.chief;
  if (!c) return { ok: false };
  const finite = c._finite;
  const param = (c._a != null ? c._a : c._h) || 0;
  const theta = c._theta ?? 0;
  const zEP = c._zEP ?? b.stopZ, zObj = c._zObj, zStart = c._zStart, epd = b.epd || 1;
  const cx = (cfg.refX != null) ? cfg.refX : (c.imageX || 0);   // OPD 参考球心(复色时须用公共点)
  const cy = (cfg.refY != null) ? cfg.refY : (c.imageY || 0);
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  const o = N >> 1;
  const cap = N * N;
  const si = new Int32Array(cap), sj = new Int32Array(cap);       // 采样点，扁平数组避免逐条分配
  const su = new Float64Array(cap), sv = new Float64Array(cap), so = new Float64Array(cap);
  let nHit = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = (i - o) / R, v = (j - o) / R;
    if (u * u + v * v > 1.0000001) continue;          // 圆瞳内
    const vc = cfg.vigCoef;
    if (vc && (u < vc.xLo || u > vc.xHi || v < vc.yLo || v > vc.yHi)) continue;   // 渐晕窗口外
    let P0, D0;
    if (finite) {
      const dx = u * epd / 2, dy = v * epd / 2 - param, dz = zEP - zObj;
      const L = Math.hypot(dx, dy, dz) || 1; P0 = [0, param, zObj]; D0 = [dx / L, dy / L, dz / L];
    } else {
      const ang = theta * Math.PI / 180;
      P0 = [u * epd / 2, param + v * epd / 2, zStart]; D0 = [0, Math.sin(ang), Math.cos(ang)];
    }
    const tr = traceRay3(sys, surfaceList, P0, D0, lam, false, true);   // noCollect：免逐条建点数组
    if (!tr.ok) continue;                             // 振幅 0（被挡/未命中/全反射）
    const lh = tr.lastHit;
    const dx = cx - lh[0], dy = cy - lh[1], dz = -lh[2];
    si[nHit] = i; sj[nHit] = j; su[nHit] = u; sv[nHit] = v;
    so[nHit] = (tr.opl || 0) + Math.hypot(dx, dy, dz); nHit++;
  }
  let coef = [0, 0, 0];
  if (nHit >= 3) {
    let S00 = 0, S01 = 0, S02 = 0, S11 = 0, S12 = 0, S22 = 0, T0 = 0, T1 = 0, T2 = 0;
    for (let k = 0; k < nHit; k++) { const u = su[k], v = sv[k], y = so[k]; S00 += 1; S01 += u; S02 += v; S11 += u * u; S12 += u * v; S22 += v * v; T0 += y; T1 += u * y; T2 += v * y; }
    const M = [[S00, S01, S02], [S01, S11, S12], [S02, S12, S22]], Y = [T0, T1, T2];
    const cc = solve3(M, Y); if (cc) coef = cc; else coef = [so[0], 0, 0];
  } else if (nHit) coef = [so[0], 0, 0];
  const lamMm = lam / 1000;
  const opd = new Float64Array(N * N), mask = new Uint8Array(N * N);
  for (let k = 0; k < nHit; k++) {
    const w = so[k] - (coef[0] + coef[1] * su[k] + coef[2] * sv[k]);
    const idx = sj[k] * N + si[k];
    opd[idx] = w; mask[idx] = 1;
    const ph = 2 * Math.PI * w / lamMm;               // OPD(mm)/λ(mm)
    re[idx] = Math.cos(ph); im[idx] = Math.sin(ph);
  }
  const fno = (isFinite(sys.fno) && sys.fno > 0) ? sys.fno : ((firstOrder(sys, surfaceList, lam) || {}).fno || 0);
  const nuC = fno > 0 ? 1 / ((lam / 1000) * fno) : 0;   // 衍射截止 lp/mm
  return { ok: nHit > 0, N, R, re, im, opd, mask, nuC, nHit, cx, cy, fno };
}
