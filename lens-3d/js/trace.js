// trace.js — M2a 第一步：子午面（Y-Z）实光线追迹
// 共轴系统：光线在 Y-Z 平面内传播（x=0），面型为球面/圆锥/偶次非球面。
// 输出：过光阑口径的「轴上平行光」光线折线与一阶量（EFL/BFL/F#）。
import { surfaceSag, surfaceSagSlope, radiusToCurv, SURF } from './model.js?v=0.8.4';
import { GLASS_DB } from './glassdb.js?v=0.8.4';

const LAM_D = 0.58756, LAM_F = 0.48613, LAM_C = 0.65627;
// 少量常用牌号 [nd, vd]；其余可用 "nd/vd" 写法
const GLASSES = {
  'N-BK7': [1.51680, 64.17], 'BK7': [1.51680, 64.17], 'K9': [1.51680, 64.17],
  'N-SK16': [1.62041, 60.34], 'SK16': [1.62041, 60.34],
  'F2': [1.62004, 36.37], 'N-SF5': [1.67270, 32.24], 'SF6': [1.80518, 25.43],
  'N-SF6': [1.80518, 25.43], 'LAK9': [1.69100, 54.70], 'N-SF56': [1.78472, 25.68],
};

function parseGlassOptics(glass) {
  const src = String(glass || '').trim();
  if (!src || /^AIR$/i.test(src)) return null;
  const toks = src.split(/\s+/);
  const name = toks[0];
  // 0) 内置标准牌号小表优先: SK16/F2/N-BK7 等是公认定义。多目录同名玻璃折射率可能不同(如 "F2" 在
  //    Schott=1.62 而其目录=1.87), 若被目录同名冲突覆盖会算错，故标准牌号用内置值(Cauchy)。
  const g0 = GLASSES[name.toUpperCase()];
  if (g0) return { nd: g0[0], vd: g0[1], sell: null };
  // 1) 2026 玻璃库(CDGM 等目录外牌号，带 Sellmeier 系数) — 覆盖 .zmx 占位折射率(如 H-K9L/H-FK61=1.5/40)
  const db = GLASS_DB[name.toUpperCase()];
  if (db) { const sell = db.slice(2); return { nd: db[0], vd: db[1], sell: sell.some(v => v) ? sell : null }; }
  // 2) 行内 "名 nd/vd"（Zemax GLAS 行带真折射率，目录外牌号也能用）
  for (const tok of toks) { const m = tok.match(/^([\d.]+)\/([\d.]+)$/); if (m) return { nd: +m[1], vd: +m[2], sell: null }; }
  return null;
}

// 精确玻璃色散(Sellmeier, 用玻璃目录 CD 系数) —— 与 Zemax 玻璃模型一致:
//   n² = 1 + Σ_{k=0..4} D(2k)·λ²/(λ² − D(2k+1)), λ 单位 μm。
// 目录外/无系数时回退 Cauchy: n(λ)=A+B/λ² (由 nd/vd 拟合)。
export function indexOf(glass, lambdaUm = LAM_D) {
  const p = parseGlassOptics(glass);
  if (!p) return 1;
  if (p.sell) {
    const sel = (lam) => { const l2 = lam * lam; let n2 = 1; for (let k = 0; k < 5; k++) { const K = p.sell[2 * k], L = p.sell[2 * k + 1]; if (isFinite(K) && isFinite(L) && Math.abs(L) > 1e-12) n2 += K * l2 / (l2 - L); } return Math.sqrt(Math.max(0, n2)); };
    // 校验 Sellmeier 能否复现目录同折射率(nd)。个别玻璃(如某些兰冠 H-ZLAF68B)色散异常/CD 系数不适配
    // 简单 Sellmeier, 算不回 nd -> 回退 Cauchy, 保证 nd 正确。
    const nD = sel(LAM_D);
    if (isFinite(nD) && Math.abs(nD - p.nd) < 0.001) { const v = sel(lambdaUm); if (isFinite(v) && v > 1) return v; }
    // 部分厂商(HOYA 等 .AGF)用 Laurent 幂级数: n² = c0 + c1λ² + c2/λ² + c3/λ⁴ + c4/λ⁶ + c5/λ⁸
    // 其系数被存进了同一 D0..D9 槽位，上面按 Sellmeier 算不回 nd 会落到 Cauchy(蓝端误差大)。
    // 这里再试 Laurent：若能复现 nd 就用它。
    const D = p.sell;
    const lau = (lam) => { const l2 = lam * lam; const n2 = D[0] + D[1] * l2 + D[2] / l2 + D[3] / (l2 * l2) + D[4] / (l2 * l2 * l2) + D[5] / (l2 * l2 * l2 * l2); return n2 > 0 ? Math.sqrt(n2) : NaN; };
    const nD2 = lau(LAM_D);
    if (isFinite(nD2) && Math.abs(nD2 - p.nd) < 0.001) { const v = lau(lambdaUm); if (isFinite(v) && v > 1) return v; }
  }
  const b = 1 / (LAM_F * LAM_F), c = 1 / (LAM_C * LAM_C);
  const B = (p.nd - 1) / (p.vd * (b - c));
  const A = p.nd - B / (LAM_D * LAM_D);
  return A + B / (lambdaUm * lambdaUm);
}

// 面顶点三元组：取「物面(0)、像面(n-1)」之外的折射面
// 带 WeakMap 记忆：同一 surfaceList 数组(每次 rebuildScene 新建)只构建一次，
// 避免逐条光线重建（MTF 上万条光线时这是主要分配来源）。
const _SURF_CACHE = new WeakMap();
function opticalSurfaces(sys, surfaceList) {
  const c = _SURF_CACHE.get(surfaceList);
  if (c && c.sys === sys) return c.S;
  const S = [];
  for (let i = 1; i < sys.surfaces.length - 1; i++) {
    S.push({ i, z: surfaceList[i].z, shape: sys.surfaces[i].toShape(), glass: sys.surfaces[i].glass });
  }
  _SURF_CACHE.set(surfaceList, { sys, S });
  return S;
}

// ---- 非球面求交（参考站式）：圆锥二次解 → 牛顿精修 → 宽区间扫描+二分 ----
// 完整矢高（高次项按 r² 幂递推）；基准圆锥域外（根号内 <0）返回 NaN。
function sagFull(r2, sh) {
  const c = sh.c, k = sh.k; let z = 0;
  if (c !== 0) { const d = 1 - (1 + k) * c * c * r2; if (d < 0) return NaN; z = c * r2 / (1 + Math.sqrt(d)); }
  const A = sh.asph || []; let p = r2 * r2;               // r⁴
  for (let i = 0; i < A.length; i++) { if (A[i]) z += A[i] * p; p *= r2; }
  return z;
}
// 解析一阶导 d(sag)/dh（对照参考站 dsagdr）
function dsagdrAn(h, sh) {
  const c = sh.c, k = sh.k; let d = 0;
  if (c !== 0) { const q = 1 - (1 + k) * c * c * h * h; if (q <= 0) return NaN; d = c * h / Math.sqrt(q); }
  const A = sh.asph || []; let p = h * h * h;             // r³
  for (let i = 0; i < A.length; i++) { if (A[i]) d += (4 + 2 * i) * A[i] * p; p *= h * h; }
  return d;
}
// 沿光线扫 f(t)=z−sag(r) 找第一次变号再二分。处理「基准圆锥无交点但实际非球面能打到」
// 的情况（高次项把面压到基准锥之外，光线擦过基准锥却仍打在真面上）。
function asphHitTrace(P, D, zVertex, sh) {
  const px = P[0], py = P[1], pz = P[2] - zVertex;
  const r0 = Math.hypot(px, py);
  const span = Math.max(Math.abs(sh.c ? 1 / sh.c : 0) || 0, r0) * 4 + 10;
  const N = 240, lo = -span * 0.25, hi = span;
  let prevF = null, prevT = 0;
  const fAt = (t) => { const x = px + t * D[0], y = py + t * D[1], z = pz + t * D[2]; const sg = sagFull(x * x + y * y, sh); return isFinite(sg) ? z - sg : null; };
  for (let i = 0; i <= N; i++) {
    const t = lo + (hi - lo) * i / N, f = fAt(t);
    if (f === null) { prevF = null; prevT = t; continue; }
    if (prevF !== null && ((prevF <= 0 && f >= 0) || (prevF >= 0 && f <= 0))) {
      let a = prevT, b = t, fa = prevF;
      for (let j = 0; j < 60; j++) { const m = (a + b) / 2, fm = fAt(m); if (fm === null) { b = m; continue; } if ((fa <= 0 && fm >= 0) || (fa >= 0 && fm <= 0)) b = m; else { a = m; fa = fm; } }
      return (a + b) / 2;
    }
    prevF = f; prevT = t;
  }
  return null;
}
// 核心求交：光线 P+tD 与面（顶点在 zVertex，+z 沿光轴）的交点参数 t。
// 局部系：先平移到顶点切平面（pz=P[2]-zVertex），解基准圆锥二次方程，取 |t| 最小根；
// 非球面再牛顿精修，失败退回扫描+二分。
function intersectionT(P, D, zVertex, sh) {
  const px = P[0], py = P[1], pz = P[2] - zVertex, c = sh.c, k = sh.k;
  let t = null;
  if (c === 0) { if (Math.abs(D[2]) >= 1e-14) t = -pz / D[2]; }
  else {
    const A = c * (D[0] * D[0] + D[1] * D[1] + (1 + k) * D[2] * D[2]);
    const B = 2 * (c * (px * D[0] + py * D[1] + (1 + k) * pz * D[2]) - D[2]);
    const C = c * (px * px + py * py + (1 + k) * pz * pz) - 2 * pz;
    if (Math.abs(A) < 1e-14) { if (Math.abs(B) >= 1e-16) t = -C / B; }
    else { const disc = B * B - 4 * A * C; if (disc >= 0) { const sq = Math.sqrt(disc); const q = -0.5 * (B + (B >= 0 ? sq : -sq)); const t1 = q / A, t2 = (Math.abs(q) < 1e-300) ? t1 : C / q; t = Math.abs(t1) < Math.abs(t2) ? t1 : t2; } }
  }
  const hasAsp = (sh.asph || []).some(v => v);
  if (!hasAsp) return (t == null || !isFinite(t)) ? null : t;

  if (t == null || !isFinite(t)) { t = asphHitTrace(P, D, zVertex, sh); if (t == null) return null; }
  let ok = false;
  for (let it = 0; it < 40; it++) {
    const x = px + t * D[0], y = py + t * D[1], z = pz + t * D[2];
    const r2 = x * x + y * y, r = Math.sqrt(r2);
    const sg = sagFull(r2, sh); if (!isFinite(sg)) break;
    const f = z - sg; if (Math.abs(f) < 1e-11) { ok = true; break; }
    const ds = r > 1e-12 ? dsagdrAn(r, sh) : 0; if (!isFinite(ds)) break;
    const drdt = r > 1e-12 ? (x * D[0] + y * D[1]) / r : 0;
    const fp = D[2] - ds * drdt; if (Math.abs(fp) < 1e-14) break;
    t -= f / fp; if (!isFinite(t)) break;
  }
  if (ok) return t;
  t = asphHitTrace(P, D, zVertex, sh);
  return t == null ? null : t;
}

// 找光线 P+tD 与该面的交点（子午面，返回 [y,z]；x=0）
function intersect(P, D, zVertex, shape) {
  const t = intersectionT([0, P[0], P[1]], [0, D[0], D[1]], zVertex, shape);
  if (t == null) return null;
  return [P[0] + t * D[0], P[1] + t * D[1]];
}

function surfaceNormal(y, shape) {
  const ds = dsagdrAn(Math.abs(y), shape);               // d(sag)/dh（正量级）
  if (!isFinite(ds)) return [0, 1];                      // 异常：退化为平面法向（仰赖后面判 miss）
  const sgn = Math.sign(y) || 0;                          // d(sag)/dy = dsgn(y)·ds
  let nx = -ds * sgn, nz = 1;
  const L = Math.hypot(nx, nz); nx /= L; nz /= L;
  return [nx, nz];                                       // 指向 +z（像方）的单位法向
}

// 斯涅尔折射（矢量形式），D 单位方向、N 单位法向；返回 [dy,dz] 或 null（全反射）
function refract(D, N, n1, n2) {
  let nx = N[0], nz = N[1];
  if (D[0] * nx + D[1] * nz > 0) { nx = -nx; nz = -nz; } // 法向朝向入射侧
  const eta = n1 / n2;
  const cosI = -(D[0] * nx + D[1] * nz);
  const sin2T = eta * eta * (1 - cosI * cosI);
  if (sin2T > 1) return null;                            // 全反射
  const cosT = Math.sqrt(1 - sin2T);
  return [eta * D[0] + (eta * cosI - cosT) * nx, eta * D[1] + (eta * cosI - cosT) * nz];
}

// ---- 3D 追迹（x,y,z）：供 X-Y / Y-Z / X-Z 各视角都能看到光线 ----
// 面求交：光线 P+tD（长度 3），解 t 使 (z-zVertex)=sag(h)，h=√(x²+y²)
function intersect3(P, D, zVertex, shape) {
  const t = intersectionT(P, D, zVertex, shape);
  if (t == null) return null;
  return [P[0] + t * D[0], P[1] + t * D[1], P[2] + t * D[2]];
}

// 3D 面法向（旋转对称面，法向指向 +z；解析斜率）
function surfaceNormal3(x, y, shape) {
  const h = Math.hypot(x, y);
  if (h > 1e-9) {
    const ds = dsagdrAn(h, shape);                // d(sag)/dh（解析）
    if (!isFinite(ds)) return [0, 0, 1];          // 异常：退化为平面法向
    let nx = -ds * (x / h), ny = -ds * (y / h), nz = 1;
    const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
    return [nx, ny, nz];
  }
  return [0, 0, 1];                               // 轴上：法向沿光轴
}

// 3D 斯涅尔折射
function refract3(D, N, n1, n2) {
  let nx = N[0], ny = N[1], nz = N[2];
  if (D[0] * nx + D[1] * ny + D[2] * nz > 0) { nx = -nx; ny = -ny; nz = -nz; }
  const eta = n1 / n2;
  const cosI = -(D[0] * nx + D[1] * ny + D[2] * nz);
  const sin2T = eta * eta * (1 - cosI * cosI);
  if (sin2T > 1) return null;
  const cosT = Math.sqrt(1 - sin2T);
  return [
    eta * D[0] + (eta * cosI - cosT) * nx,
    eta * D[1] + (eta * cosI - cosT) * ny,
    eta * D[2] + (eta * cosI - cosT) * nz,
  ];
}

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
function beamEPD(sys, surfaceList, lambdaUm = LAM_D) {
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
      const tz = [hitAt(0, 1, L), hitAt(0, -1, L)].map(e => e && chiefCross(e, 'y')).filter(z => z !== null && z !== undefined);
      const sz = [hitAt(1, 0, L), hitAt(-1, 0, L)].map(e => e && chiefCross(e, 'x')).filter(z => z !== null && z !== undefined);
      const avg = arr => arr.length ? arr.reduce((a, b2) => a + b2, 0) / arr.length : 0;
      return {
        nm: wl.nm, color: wl.color, ok: true, realY: ch.y, idealY: hp, dist,
        tFocus: avg(tz), sFocus: avg(sz),
      };
    });
    items.push({ field: fv, ok: true, theta: thetaDeg, perWl });
  }
  return { mode, efl, wl: lambdas.map(w => ({ nm: w.nm, color: w.color })), items };
}

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

