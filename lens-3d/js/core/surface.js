// core/surface.js — 面型几何与折射（2D 子午 + 3D 全空间）
// 纯函数层：矢高/求交/法向/斯涅尔折射；输入面形状 {c,k,asph} 与全局坐标，不依赖模型层。

// 带 WeakMap 记忆：同一 surfaceList 数组(每次 rebuildScene 新建)只构建一次，
// 避免逐条光线重建（MTF 上万条光线时这是主要分配来源）。
const _SURF_CACHE = new WeakMap();
export function opticalSurfaces(sys, surfaceList) {
  if (!sys || !surfaceList || surfaceList.length !== sys.surfaces.length) return [];   // 未就绪/几何未重建
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
export function intersect(P, D, zVertex, shape) {
  const t = intersectionT([0, P[0], P[1]], [0, D[0], D[1]], zVertex, shape);
  if (t == null) return null;
  return [P[0] + t * D[0], P[1] + t * D[1]];
}

export function surfaceNormal(y, shape) {
  const ds = dsagdrAn(Math.abs(y), shape);               // d(sag)/dh（正量级）
  if (!isFinite(ds)) return [0, 1];                      // 异常：退化为平面法向（仰赖后面判 miss）
  const sgn = Math.sign(y) || 0;                          // d(sag)/dy = dsgn(y)·ds
  let nx = -ds * sgn, nz = 1;
  const L = Math.hypot(nx, nz); nx /= L; nz /= L;
  return [nx, nz];                                       // 指向 +z（像方）的单位法向
}

// 斯涅尔折射（矢量形式），D 单位方向、N 单位法向；返回 [dy,dz] 或 null（全反射）
export function refract(D, N, n1, n2) {
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
export function intersect3(P, D, zVertex, shape) {
  const t = intersectionT(P, D, zVertex, shape);
  if (t == null) return null;
  return [P[0] + t * D[0], P[1] + t * D[1], P[2] + t * D[2]];
}

// 3D 面法向（旋转对称面，法向指向 +z；解析斜率）
export function surfaceNormal3(x, y, shape) {
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
export function refract3(D, N, n1, n2) {
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
