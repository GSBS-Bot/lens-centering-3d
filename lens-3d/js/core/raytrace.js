// core/raytrace.js — 单条光线追迹与一阶量（EFL/BFL/F#、入瞳、光束口径）
import { radiusToCurv } from '../model.js?v=0.8.4';
import { LAM_D, indexOf } from './glass.js?v=1.5.16';
import { opticalSurfaces, intersect3, surfaceNormal3, refract3 } from './surface.js?v=1.5.16';


// 3D 全光线追迹：返回逐面命中点 [x,y,z]、像面(x,y)、光程 opl 与渐晕/未命中信息。
export function traceRay3(sys, surfaceList, P0, D0, lam, ignoreAp, noCollect) {
  const S = opticalSurfaces(sys, surfaceList);
  let P = [P0[0], P0[1], P0[2]], D = [D0[0], D0[1], D0[2]];
  const L0 = Math.hypot(D[0], D[1], D[2]) || 1; D = [D[0] / L0, D[1] / L0, D[2] / L0];
  let n = indexOf(sys.surfaces[0]?.glass, lam);
  const pts = noCollect ? null : [[P[0], P[1], P[2]]], hits = noCollect ? null : [];
  let opl = 0;                                              // 光程 Σ n·L（从起点到最后一个折射面）
  for (let i = 0; i < S.length; i++) {
    const si = S[i];
    const hit = intersect3(P, D, si.z, si.shape);
    if (!hit) return { ok: false, hits, pts, opl, lastHit: P, blockedAt: i, why: 'miss', imageX: null, imageY: null };
    opl += n * Math.hypot(hit[0] - P[0], hit[1] - P[1], hit[2] - P[2]);   // 介质 = 入射侧折射率
    if (!noCollect) { pts.push([hit[0], hit[1], hit[2]]); hits.push({ i: si.i, z: si.z, x: hit[0], y: hit[1] }); }
    const semi = sys.surfaces[si.i].semi ?? sys.surfaces[si.i].mSemi ?? Infinity;
    const rh = Math.hypot(hit[0], hit[1]);
    if (!ignoreAp && isFinite(semi) && rh > semi * 1.0000001)
      return { ok: false, hits, pts, opl, lastHit: hit, blockedAt: i, why: 'vign', imageX: null, imageY: null, vignetted: true };
    const n2 = indexOf(si.glass, lam);
    const Nn = surfaceNormal3(hit[0], hit[1], si.shape);
    const D2 = refract3(D, Nn, n, n2);
    if (!D2) return { ok: false, hits, pts, opl, lastHit: hit, blockedAt: i, why: 'tir', imageX: null, imageY: null };
    const L = Math.hypot(D2[0], D2[1], D2[2]); D = [D2[0] / L, D2[1] / L, D2[2] / L];
    P = hit; n = n2;
  }
  let imageX = null, imageY = null;
  if (Math.abs(D[2]) > 1e-9) {
    const t = (0 - P[2]) / D[2];
    imageX = P[0] + t * D[0]; imageY = P[1] + t * D[1];
    if (!noCollect) pts.push([imageX, imageY, 0]);  // 投到像面 z=0
  }
  return { ok: true, hits, pts, opl, lastHit: P, blockedAt: -1, why: 'ok', imageX, imageY, dir: [D[0], D[1], D[2]], vignetted: false };
}

// 一阶量（近轴旁轴追迹，物在无穷远）：EFL/BFL/F#。用单位高度 h=1 的旁轴边缘光线。
export function firstOrder(sys, surfaceList, lambdaUm = LAM_D) {
  const S = opticalSurfaces(sys, surfaceList);
  if (!S.length) return null;
  const glass = (i) => sys.surfaces[i]?.glass;
  const idx = (g) => indexOf(g, lambdaUm);
  const cOf = (r) => (r === 0 || !isFinite(r)) ? 0 : 1 / r;
  let y = 1, u = 0;                                       // 边缘光线：h=1, 平行于轴
  for (let k = 0; k < S.length; k++) {
    const i = S[k].i;
    if (k > 0) y = y + u * sys.surfaces[i - 1].thi;       // 顶点间传递（介质 glass[i-1]）
    const nb = idx(glass(i - 1));                         // 入射介质 = glass[i-1]
    const na = idx(glass(i));                             // 出射介质 = glass[i]
    const phi = (na - nb) * cOf(sys.surfaces[i].radius);  // 面光焦度
    u = (nb * u - y * phi) / na;                          // 旁轴折射
  }
  const nL = idx(glass(S[S.length - 1].i));               // 像方介质
  const efl = Math.abs(1 / (nL * u));                     // h=1
  const bfl = -y / u;                                     // 自最后一面顶点的后焦距
  const stopSemi = Math.max(sys.surfaces[sys.stopIndex]?.semi ?? sys.surfaces[sys.stopIndex]?.mSemi ?? 1, 1e-3);
  const fno = sys.fno ?? (efl / (2 * stopSemi));          // 有文件 F# 用之，否则按光阑口径近似
  return { efl, bfl, fno, tanU: u, h: 1 };
}

// 入瞳（近轴）：光阑面之前折射面构成的传输矩阵求 pupilMag 与入瞳位置。
// 光阑=首面时退化为入瞳=光阑。用于 HUD 读报；渐晕用逐面半孔径，不依赖入瞳。
export function entrancePupil(sys, surfaceList, lambdaUm = LAM_D) {
  const stopI = sys.stopIndex;
  const st = sys.surfaces[stopI];
  const stopSemi = (st?.semi ?? st?.mSemi ?? 1e-3);
  const stopZ = surfaceList[stopI]?.z ?? 0;
  const S = opticalSurfaces(sys, surfaceList);
  const front = S.filter(s => s.i < stopI);        // 光阑物侧的折射面
  const idx = (gi) => indexOf(gi, lambdaUm);
  if (!front.length) return { zEP: stopZ, pupilMag: 1, epd: 2 * stopSemi, stopSemi, stopZ };

  let A0 = 1, A1 = 0, A2 = 0, A3 = 1, nb = 1;      // [a b; c d] 折减角口径
  for (let j = 0; j < front.length; j++) {
    const s = front[j], si = s.i;
    const na = idx(sys.surfaces[si].glass);
    const c = radiusToCurv(sys.surfaces[si].radius);
    const phi = (na - nb) * c;
    // 折射 [[1,0],[-phi,1]]
    A2 = -phi * A0 + A2; A3 = -phi * A1 + A3;
    // 转移到下一个顶点（折减厚度 T/n）
    const nxt = (j + 1 < front.length) ? front[j + 1].z : stopZ;
    const dd = Math.abs(nxt - s.z) / na;
    A0 = A0 + dd * A2; A1 = A1 + dd * A3;
    nb = na;
  }
  const pupilMag = A0, zEP_rel = (Math.abs(A0) > 1e-12) ? A1 / A0 : 0;
  const zEP = front[0].z + zEP_rel;
  return { zEP, pupilMag, epd: 2 * stopSemi / Math.abs(pupilMag || 1), stopSemi, stopZ };
}

// 光束入瞳直径：优先工作F#(=|EFL|/F#)，其次 enpd，最后按光阑(近轴入瞳)。
// 用于光线采样与自动渐晕，保证两者一致。
export function beamEPD(sys, surfaceList, lambdaUm = LAM_D) {
  const st = sys.surfaces[sys.stopIndex];
  const stopSemi = (st?.semi ?? st?.mSemi ?? 1e-3);
  const epEP = entrancePupil(sys, surfaceList, lambdaUm);
  let epd = epEP.epd || (2 * stopSemi);
  if (sys.apmode === 'enpd' && isFinite(sys.enpd) && sys.enpd > 0) epd = sys.enpd;
  else if (sys.apmode !== 'stop' && isFinite(sys.fno) && sys.fno > 0) {
    const fo = firstOrder(sys, surfaceList, lambdaUm);
    if (fo && isFinite(fo.efl) && Math.abs(fo.efl) > 1e-6) epd = Math.abs(fo.efl) / sys.fno;
  }
  return epd;
}
