// analysis/spot.js — 点列图：入瞳内 N×N 网格 → 像面落点
import { LAM_D } from '../core/glass.js?v=1.5.15';
import { opticalSurfaces } from '../core/surface.js?v=1.5.15';
import { traceRay3 } from '../core/raytrace.js?v=1.5.15';
import { traceFieldBundle } from '../core/beam.js?v=1.5.15';


// ---- 点列图（M2b 第一步）：对某视场在入瞳内做 N×N 网格采样，记录像面(x,y)落点 ----
// 返回 { field, mode, points:[[x,y],...], epd }。仅收录能到达像面的光线(自动含渐晕/被挡剔除)。 
export function traceSpot(sys, surfaceList, cfg = {}) {
  const lam = cfg.lambdaUm ?? LAM_D;
  const mode = cfg.mode === 'height' ? 'height' : 'angle';
  const fv = cfg.field ?? 0;
  const N = Math.max(3, cfg.nGrid ?? 15) | 0;
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return { field: fv, mode, points: [], epd: 0, n: N };
  // 复用视场束得到主光线元数据(物角/物高/物距/入瞳):
  const b = traceFieldBundle(sys, surfaceList, { mode, field: fv, nPupil: 1, lambdaUm: lam });
  const c = b.chief;
  if (!c) return { field: fv, mode, points: [], epd: b.epd, n: N };
  const finite = c._finite;
  const param = (c._a != null ? c._a : c._h) || 0;
  const theta = c._theta ?? 0;
  const zEP = c._zEP ?? b.stopZ, zObj = c._zObj, zStart = c._zStart, epd = b.epd || 1;
  const points = [];
  const vc = cfg.vigCoef || null;
  const inWin = (px, py) => !vc || (px >= vc.xLo && px <= vc.xHi && py >= vc.yLo && py <= vc.yHi);
  const buildRay = (px, py) => {
    if (finite) {
      const dx = px * epd / 2, dy = py * epd / 2 - param, dz = zEP - zObj;
      const L = Math.hypot(dx, dy, dz) || 1;
      return { P0: [0, param, zObj], D0: [dx / L, dy / L, dz / L] };
    }
    const ang = theta * Math.PI / 180;
    return { P0: [px * epd / 2, param + py * epd / 2, zStart], D0: [0, Math.sin(ang), Math.cos(ang)] };
  };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const px = -1 + 2 * i / (N - 1), py = -1 + 2 * j / (N - 1);
    if (!inWin(px, py)) continue;                       // 渐晕窗口外不采样
    const rb = buildRay(px, py);
    const tr = traceRay3(sys, surfaceList, rb.P0, rb.D0, lam, false);
    if (tr.ok && tr.imageX != null && tr.imageY != null) points.push([tr.imageX, tr.imageY]);
  }
  return { field: fv, mode, points, epd, n: N };
}
