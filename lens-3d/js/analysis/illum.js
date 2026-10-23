// analysis/illum.js — 相对照度（一维）：入瞳圆内采样 → 通过率 × cos⁴θ
import { LAM_D } from '../core/glass.js?v=1.5.16';
import { opticalSurfaces } from '../core/surface.js?v=1.5.16';
import { traceRay3, firstOrder } from '../core/raytrace.js?v=1.5.16';
import { traceFieldBundle } from '../core/beam.js?v=1.5.16';


// ---- 相对照度（一维）------------------------------------------------------
// 逐视场在【入瞳圆内】均匀网格实光线追迹：
//   通过率 V    = 到达像面的样本数 / 圆内样本数(即有效通光面积比, 含渐晕/口径)；
//   自然渐晕     cos⁴θ, θ = 物方半视场角；
//   RI(v) = V·cos⁴θ, 再归一化到轴上 RI(0)=1。
// 物方半角 θ 取名义值：角度模式=场值；像高模式=atan(h/EFL)，避免 height 主光线解的多解退化；
// 有限共轭用主光线真实物角(主光线解在有限共轭下无退化)。
// 取单个波长(cfg.lambdaUm, 默认主波长)。返回逐视场 V/cos⁴/RI 与轴上参考值。
export function traceIllumination(sys, surfaceList, cfg = {}) {
  const lam = cfg.lambdaUm ?? LAM_D;
  const mode = cfg.mode === 'height' ? 'height' : 'angle';
  const list = (cfg.fields && cfg.fields.length) ? cfg.fields : [0];
  const N = Math.max(5, Math.min(41, cfg.nGrid ?? 15)) | 0;
  const S = opticalSurfaces(sys, surfaceList);
  const items = [];
  if (!S.length) return { mode, fields: list, items, ref: 1 };
  const finiteSys = isFinite(sys.objectDist) && sys.objectDist > 0 && sys.objectDist < 1e7;
  const efl = Math.abs((firstOrder(sys, surfaceList, lam) || {}).efl) || 1;
  const vigCoefs = cfg.vigCoefs || [];
  for (let fi = 0; fi < list.length; fi++) {
    const fv = list[fi];
    const vc = vigCoefs[fi] || null;
    // 名义物方半视场角(°): 角度=场值; 像高=atan(|h|/EFL)
    let thetaDeg = (mode === 'angle') ? +fv : Math.atan2(Math.abs(+fv), efl) * 180 / Math.PI;
    const b = traceFieldBundle(sys, surfaceList, {
      mode: finiteSys ? mode : 'angle',           // 无穷远一律走 angle 光束(避免 height 退化)
      field: finiteSys ? +fv : thetaDeg,
      nPupil: 1, lambdaUm: lam,
    });
    const c = b.chief;
    if (!c) { items.push({ field: +fv, ok: false }); continue; }
    if (finiteSys && c._theta != null) thetaDeg = c._theta;   // 有限共轭：真实物角
    const finite = c._finite;
    const param = (c._a != null ? c._a : c._h) || 0;
    const zEP = c._zEP ?? b.stopZ, zObj = c._zObj, zStart = c._zStart, epd = b.epd || 1;
    let nTot = 0, nPass = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const px = -1 + 2 * i / (N - 1), py = -1 + 2 * j / (N - 1);
      if (px * px + py * py > 1.0000001) continue;              // 圆瞳内(面积均匀)
      nTot++;
      if (vc && (px < vc.xLo || px > vc.xHi || py < vc.yLo || py > vc.yHi)) continue;  // 渐晕窗口外→未通过
      let P0, D0;
      if (finite) {
        const dx = px * epd / 2, dy = py * epd / 2 - param, dz = zEP - zObj;
        const L = Math.hypot(dx, dy, dz) || 1; P0 = [0, param, zObj]; D0 = [dx / L, dy / L, dz / L];
      } else {
        const ang = thetaDeg * Math.PI / 180;
        P0 = [px * epd / 2, param + py * epd / 2, zStart]; D0 = [0, Math.sin(ang), Math.cos(ang)];
      }
      const tr = traceRay3(sys, surfaceList, P0, D0, lam, false);
      if (tr.ok && tr.imageX != null && tr.imageY != null) nPass++;
    }
    const V = nTot ? nPass / nTot : 0;
    const cos4 = Math.pow(Math.cos(thetaDeg * Math.PI / 180), 4);
    items.push({ field: +fv, ok: true, V, cos4, nTot, nPass, theta: thetaDeg, raw: V * cos4 });
  }
  let ref = 1;
  const onAx = items.find(o => o.ok && Math.abs(o.field) < 1e-9);
  if (onAx && onAx.raw > 0) ref = onAx.raw;
  for (const o of items) if (o.ok) o.RI = o.raw / ref;
  return { mode, fields: list, items, ref };
}
