// analysis/fan.js — 光扇图(Ray Fan)：子午/弧矢横向像差 εy/εx
import { LAM_D } from '../core/glass.js?v=1.5.15';
import { opticalSurfaces } from '../core/surface.js?v=1.5.15';
import { traceRay3 } from '../core/raytrace.js?v=1.5.15';
import { traceFieldBundle } from '../core/beam.js?v=1.5.15';


// ---- 光扇图(Ray Fan)：某视场/波长，沿子午(px=0, py 扫描)与弧矢(py=0, px 扫描)采样，
//      记录相对主光线像点的横向像差 (εy, εx)，单位 mm。 ----
export function traceRayFan(sys, surfaceList, cfg = {}) {
  const lam = cfg.lambdaUm ?? LAM_D;
  const mode = cfg.mode === 'height' ? 'height' : 'angle';
  const fv = cfg.field ?? 0;
  const N = Math.max(3, Math.min(41, cfg.nGrid ?? 21)) | 0;
  const S = opticalSurfaces(sys, surfaceList);
  const base = { field: fv, mode, mer: [], sag: [], ok: false, epd: 0 };
  if (!S.length) return base;
  const b = traceFieldBundle(sys, surfaceList, { mode, field: fv, nPupil: 1, lambdaUm: lam });
  const c = b.chief;
  if (!c) return { ...base, epd: b.epd };
  const finite = c._finite;
  const param = (c._a != null ? c._a : c._h) || 0;
  const theta = c._theta ?? 0;
  const zEP = c._zEP ?? b.stopZ, zObj = c._zObj, zStart = c._zStart, epd = b.epd || 1;
  const buildRay = (px, py) => {
    if (finite) {
      const dx = px * epd / 2, dy = py * epd / 2 - param, dz = zEP - zObj;
      const L = Math.hypot(dx, dy, dz) || 1;
      return { P0: [0, param, zObj], D0: [dx / L, dy / L, dz / L] };
    }
    const ang = theta * Math.PI / 180;
    return { P0: [px * epd / 2, param + py * epd / 2, zStart], D0: [0, Math.sin(ang), Math.cos(ang)] };
  };
  const hit = (px, py) => {
    const rb = buildRay(px, py);
    const tr = traceRay3(sys, surfaceList, rb.P0, rb.D0, lam, false);
    if (!(tr.ok && tr.imageX != null && tr.imageY != null)) return null;
    const D = tr.dir || [0, 0, 1], uz = Math.abs(D[2]) > 1e-12 ? D[2] : 1;
    return { x: tr.imageX, y: tr.imageY, ux: D[0] / uz, uy: D[1] / uz };
  };
  const ch = hit(0, 0);
  if (!ch) return { ...base, ok: false, epd };
  const cx = ch.x, cy = ch.y;
  const mer = [], sag = [];
  for (let k = 0; k < N; k++) { const p = -1 + 2 * k / (N - 1); const a = hit(0, p); mer.push({ p, e: a ? a.y - cy : null }); }
  for (let k = 0; k < N; k++) { const p = -1 + 2 * k / (N - 1); const a = hit(p, 0); sag.push({ p, e: a ? a.x - cx : null }); }
  return { field: fv, mode, mer, sag, ok: true, epd, chiefX: cx, chiefY: cy };
}
