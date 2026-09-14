// =====================================================================
// mtf.js — 衍射 MTF 内核（P0a：纯解析波前，未接触追迹器）
//
// 纯计算：无 DOM、无外部依赖、不引用 trace.js。建立并校验：
//   FFT → PSF → OTF → MTF 的完整数学闭环，供后续 P0b 接入真实光线 OPD。
//
// 约定：
//   · 瞳面采样 N×N（2 的幂），圆孔半径 R（样本），圆心 (N/2, N/2)；
//     amp = 圆内覆盖率（边缘 S×S 超采样），phase = 2π·W(ρ)。
//   · OTF = IFFT(|FFT(P)|²)（= 瞳函数的自相关），DC 在 index 0，归一化 OTF(0)=1；
//     MTF = |OTF|。沿 +x 的 OTF 样本 index m 对应自相关平移 m 个样本。
//   · 归一化空间频率 s = m/(2R)；s = 1 即截止频率（圆孔自相关支撑半径 = 2R）。
//   · W20 = 瞳边缘处离焦波差，单位“波”(waves)；相位 φ = 2π·W20·ρ²（ρ 归一到边缘=1）。
// =====================================================================

/* ---------- 1D 原地 FFT（radix-2, decimation-in-time） ---------- */
export function fft1d(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h;
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
  if (inverse) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
}

/* ---------- 2D FFT（先逐行、再逐列；原地） ---------- */
export function fft2d(re, im, N, inverse = false) {
  const rr = new Float64Array(N), ii = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    const o = y * N;
    for (let x = 0; x < N; x++) { rr[x] = re[o + x]; ii[x] = im[o + x]; }
    fft1d(rr, ii, inverse);
    for (let x = 0; x < N; x++) { re[o + x] = rr[x]; im[o + x] = ii[x]; }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { rr[y] = re[y * N + x]; ii[y] = im[y * N + x]; }
    fft1d(rr, ii, inverse);
    for (let y = 0; y < N; y++) { re[y * N + x] = rr[y]; im[y * N + x] = ii[y]; }
  }
}

/* ---------- 圆孔瞳函数：振幅=覆盖率(边缘 S×S 超采样), 相位=2π·waveWaves(ρ) ----------
   waveWaves(rho)：ρ∈[0,1] 归一到瞳边缘；返回波差(单位 波)。null = 无波差。 */
export function circlePupil(N, R, waveWaves = null, S = 2) {
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  const c = N / 2, R2 = R * R, inv = 1 / (S * S);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let cover = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const px = x - c + (sx + 0.5) / S - 0.5;
      const py = y - c + (sy + 0.5) / S - 0.5;
      if (px * px + py * py <= R2) cover++;
    }
    if (!cover) continue;
    const amp = cover * inv;
    const dx = x - c, dy = y - c;
    const rho = Math.sqrt(dx * dx + dy * dy) / R;
    const ph = waveWaves ? 2 * Math.PI * waveWaves(rho) : 0;
    re[y * N + x] = amp * Math.cos(ph);
    im[y * N + x] = amp * Math.sin(ph);
  }
  return { re, im };
}

/* ---------- OTF = IFFT(|FFT(P)|²)，归一化 DC=1；返回 {re, im} ---------- */
export function otfFromPupil(re, im, N) {
  const fr = Float64Array.from(re), fi = Float64Array.from(im);
  fft2d(fr, fi, N, false);
  const gr = new Float64Array(N * N), gi = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) gr[k] = fr[k] * fr[k] + fi[k] * fi[k];
  fft2d(gr, gi, N, true);
  const dc = gr[0] || 1;
  for (let k = 0; k < N * N; k++) { gr[k] /= dc; gi[k] /= dc; }
  return { re: gr, im: gi };
}

/* ---------- 独立对照：沿 +x 的直接自相关 G(m)=Σ P(x+m)·conj(P(x))，归一化 G(0)=1 ---------- */
export function otfDirect(re, im, N, maxM) {
  const pts = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x; if (re[k] || im[k]) pts.push(x, y);
  }
  let dc = 0;
  for (let p = 0; p < pts.length; p += 2) { const k = pts[p + 1] * N + pts[p]; dc += re[k] * re[k] + im[k] * im[k]; }
  dc = dc || 1;
  const R = new Float64Array(maxM + 1), I = new Float64Array(maxM + 1);
  R[0] = 1;
  for (let m = 1; m <= maxM; m++) {
    let sr = 0, si = 0;
    for (let p = 0; p < pts.length; p += 2) {
      const x = pts[p], y = pts[p + 1], xn = x + m;
      if (xn >= N) continue;
      const k1 = y * N + x, k2 = y * N + xn;
      sr += re[k2] * re[k1] + im[k2] * im[k1];
      si += im[k2] * re[k1] - re[k2] * im[k1];
    }
    R[m] = sr / dc; I[m] = si / dc;
  }
  return { re: R, im: I };
}

/* ---------- 圆孔衍射极限 MTF（解析）：s = ν/νc ∈ [0,1] ---------- */
export function diffractionLimit(s) {
  if (s <= 0) return 1;
  if (s >= 1) return 0;
  return (2 / Math.PI) * (Math.acos(s) - s * Math.sqrt(1 - s * s));
}

/* ---------- 离焦波差(波) <- 轴向离焦量(mm)（小角近似，供 P0b 用） ----------
   OPD(边缘) = (1/2)·Δz·NA² = Δz/(8·F#²)  [mm]；除以 λ 得波数。 */
export function defocusWaves(dzMm, fno, lambdaUm) {
  return (dzMm / (8 * fno * fno)) / (lambdaUm / 1000);
}

/* ---------- 离焦扫描：沿 +x 的 MTF(s0) 随 W20 变化 ---------- */
export function throughFocusMTF(N, R, s0, w20List) {
  const m0 = Math.round(s0 * 2 * R);
  return w20List.map(w => {
    const p = circlePupil(N, R, rho => w * rho * rho, 2);
    const g = otfFromPupil(p.re, p.im, N);
    return Math.hypot(g.re[m0], g.im[m0]);
  });
}

/* ---------- 由真实复瞳函数生成离焦 MTF 曲线（P0b 接入）----------
   re,im: 真实瞳函数(N×N, 半径 R 样本, 含真实 OPD)；
   nuC: 衍射截止(lp/mm)；nu: 评估频率(lp/mm)；w20List: 离焦波差(波)。
   对每个 W20 叠加离焦相位 exp(i·2π·W20·ρ²) 后求 MTF，返回 { T:[], S:[] }。 */
export function throughFocusFromPupil(re, im, N, R, nuC, nu, w20List) {
  const o = N >> 1, R2 = R * R, s = nuC > 0 ? nu / nuC : 0;
  const T = [], S = [];
  for (let q = 0; q < w20List.length; q++) {
    const w = w20List[q];
    const rr = new Float64Array(N * N), ii = new Float64Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = y * N + x, pr = re[k], pi = im[k];
      if (!pr && !pi) continue;
      const dx = x - o, dy = y - o;
      const ph = 2 * Math.PI * w * (dx * dx + dy * dy) / R2;
      const cs = Math.cos(ph), sn = Math.sin(ph);
      rr[k] = pr * cs - pi * sn;
      ii[k] = pr * sn + pi * cs;
    }
    const g = otfFromPupil(rr, ii, N);
    const cT = sampleOtfComplex(g, N, R, s, 'T');
    const cS = sampleOtfComplex(g, N, R, s, 'S');
    T.push(Math.min(1, Math.hypot(cT.re, cT.im)));
    S.push(Math.min(1, Math.hypot(cS.re, cS.im)));
  }
  return { T, S };
}

/* ---------- 复色离焦（P2）：多波长按权重复数加权 ----------
   pupils = [{ re, im, N, R, nuC, weight, lambdaUm }]（各波长共用同一 OPD 参考球心）；
   nu: 评估频率(lp/mm)；dzUmList: 轴向离焦(µm)；fno: 工作F数。
   对每个 dz：逐 λ 由 W20=Δz/(8F#²λ) 加离焦相位 → OTF → 在 ν 处取复值 → Σw·OTF → |·|。
   返回 { T:[], S:[] }。 */
export function throughFocusMultiColor(pupils, nu, dzUmList, fno) {
  const T = [], S = [];
  for (let q = 0; q < dzUmList.length; q++) {
    const dzMm = dzUmList[q] / 1000;
    let rT = 0, iT = 0, rS = 0, iS = 0, wsum = 0;
    for (const p of pupils) {
      const w = p.weight ?? 1;
      const w20 = defocusWaves(dzMm, fno, p.lambdaUm);
      const N = p.N, R = p.R, o = N >> 1, R2 = R * R;
      const rr = new Float64Array(N * N), ii = new Float64Array(N * N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const k = y * N + x, pr = p.re[k], pi = p.im[k];
        if (!pr && !pi) continue;
        const dx = x - o, dy = y - o;
        const ph = 2 * Math.PI * w20 * (dx * dx + dy * dy) / R2;
        const cs = Math.cos(ph), sn = Math.sin(ph);
        rr[k] = pr * cs - pi * sn; ii[k] = pr * sn + pi * cs;
      }
      const g = otfFromPupil(rr, ii, N);
      const s = p.nuC > 0 ? nu / p.nuC : 0;
      const cT = sampleOtfComplex(g, N, R, s, 'T');
      const cS = sampleOtfComplex(g, N, R, s, 'S');
      rT += w * cT.re; iT += w * cT.im; rS += w * cS.re; iS += w * cS.im; wsum += w;
    }
    const d = wsum || 1;
    T.push(Math.min(1, Math.hypot(rT / d, iT / d)));
    S.push(Math.min(1, Math.hypot(rS / d, iS / d)));
  }
  return { T, S };
}

/* ---------- 几何 MTF（由点列直接算，无需 OPD/离焦/FFT 网格）----------
   几何 PSF 视作等权重光线落点 (1/N)Σ δ(x−x_k, y−y_k)；
   沿某方向的 1D OTF = (1/N)Σ e^{−i2π·ν·coord}，MTF = |OTF| ∈ [0,1]。
   axis='y' 子午(T)，'x' 弧矢(S)。points: [[x,y],…]（mm），nu: 空间频率(lp/mm)。
   注意：几何 MTF 只在像差/离焦远大于衍射时可信；近衍射极限时偏高，需配衍射极限参考。 */
export function geometricOTF(points, nu, axis = 'y') {
  if (!points || !points.length) return 0;
  let sr = 0, si = 0;
  for (let i = 0; i < points.length; i++) {
    const v = axis === 'y' ? points[i][1] : points[i][0];
    const ph = 2 * Math.PI * nu * v;
    sr += Math.cos(ph); si -= Math.sin(ph);
  }
  return Math.hypot(sr, si) / points.length;
}

/* 几何 MTF 曲线：对频率数组 nus 逐点求 |OTF| */
export function geometricMTFCurve(points, nus, axis = 'y') {
  return nus.map(nu => geometricOTF(points, nu, axis));
}

/* 几何 OTF 的复数相位和（供复色加权求和用） */
export function geometricOTFComplex(points, nu, axis = 'y') {
  if (!points || !points.length) return { re: 0, im: 0 };
  let sr = 0, si = 0;
  for (let i = 0; i < points.length; i++) {
    const v = axis === 'y' ? points[i][1] : points[i][0];
    const ph = 2 * Math.PI * nu * v;
    sr += Math.cos(ph); si -= Math.sin(ph);
  }
  return { re: sr / points.length, im: si / points.length };
}

/* 在归一化频率 s 处对复 OTF(N×N, 孔径半径 R)采样(线性插值)。
   axis='T' → 子午(index m*N)，'S' → 弧矢(index m)。 */
export function sampleOtfComplex(otf, N, R, s, axis = 'S') {
  const mM = Math.min(2 * R, (N >> 1) - 1);
  const sStep = 1 / (2 * R);
  if (s <= 0) return { re: otf.re[0], im: otf.im[0] };
  if (s >= mM * sStep) return { re: 0, im: 0 };
  const x = s / sStep, i0 = Math.floor(x), t = x - i0, i1 = Math.min(i0 + 1, mM);
  const k0 = axis === 'T' ? i0 * N : i0, k1 = axis === 'T' ? i1 * N : i1;
  return { re: otf.re[k0] + (otf.re[k1] - otf.re[k0]) * t, im: otf.im[k0] + (otf.im[k1] - otf.im[k0]) * t };
}

/* ---------- 由复瞳函数(FFT 网格 N×N, 孔径半径 R 样本)算 MTF 曲线 ----------
   T = 子午(y)方向 → OTF 在 (my=m, mx=0)，即 index m*N；
   S = 弧矢(x)方向 → OTF 在 (my=0, mx=m)，即 index m。
   归一化频率 s = m/(2R)，绝对频率 ν = s·nuC；在 s 上线性插值到给定 nus。 */
export function mtfCurveFromPupil(re, im, N, R, nuC, nus) {
  const g = otfFromPupil(re, im, N);
  const mM = Math.min(2 * R, (N >> 1) - 1);
  const sStep = 1 / (2 * R);
  const mS = [], mT = [];
  for (let m = 0; m <= mM; m++) {
    mS.push(Math.hypot(g.re[m], g.im[m]));            // x 方向(弧矢)
    mT.push(Math.hypot(g.re[m * N], g.im[m * N]));    // y 方向(子午)
  }
  const at = (arr, s) => {
    if (s <= 0) return arr[0] || 1;
    if (s >= mM * sStep) return 0;
    const x = s / sStep, i0 = Math.floor(x), t = x - i0;
    const a = arr[i0] || 0, b = arr[Math.min(i0 + 1, mM)] || 0;
    return a + (b - a) * t;
  };
  const T = [], S = [];
  for (const nu of nus) {
    const s = nuC > 0 ? nu / nuC : (nu > 0 ? 1 : 0);
    T.push(Math.min(1, at(mT, s)));
    S.push(Math.min(1, at(mS, s)));
  }
  return { T, S };
}

/* ---------- 硬校验：全解析波前，不涉及追迹器 ---------- */
export function selfTest() {
  const results = [];
  const push = (name, pass, info) => results.push({ name, pass, info });

  // ① 无像差圆孔：FFT-OTF vs 解析衍射极限；并检查收敛(误差随分辨率下降)
  const runLimit = (N, R) => {
    const p = circlePupil(N, R, null, 2);
    const g = otfFromPupil(p.re, p.im, N);
    let maxErr = 0;
    for (let m = 1; m <= Math.floor(1.8 * R); m++) {
      const s = m / (2 * R);
      if (s > 0.9) break;
      maxErr = Math.max(maxErr, Math.abs(Math.hypot(g.re[m], g.im[m]) - diffractionLimit(s)));
    }
    return maxErr;
  };
  const eLo = runLimit(256, 32), eHi = runLimit(512, 64);
  push('① 圆孔衍射极限 (FFT vs 解析)', eHi < 3e-2 && eHi < eLo,
    `max|ΔMTF|: R32=${eLo.toExponential(2)} → R64=${eHi.toExponential(2)} (s≤0.9)`);

  // ② FFT-OTF vs 独立直接自相关（W20=0 与 W20=1 两种波前）
  const runCross = (W) => {
    const N = 512, R = 64;
    const p = circlePupil(N, R, rho => W * rho * rho, 2);
    const gfft = otfFromPupil(p.re, p.im, N);
    const gdir = otfDirect(p.re, p.im, N, 2 * R);
    let maxErr = 0, den = 0;
    for (let m = 1; m <= 2 * R; m++) {
      const a = Math.hypot(gfft.re[m], gfft.im[m]);
      const b = Math.hypot(gdir.re[m], gdir.im[m]);
      maxErr = Math.max(maxErr, Math.abs(a - b)); den = Math.max(den, Math.abs(b));
    }
    return maxErr / (den || 1);
  };
  const c0 = runCross(0), c1 = runCross(1);
  push('② FFT-OTF vs 独立自相关', Math.max(c0, c1) < 1e-6,
    `相对误差: W20=0 → ${c0.toExponential(2)}, W20=1 → ${c1.toExponential(2)}`);

  // ③ OTF 支撑半径 = 2R（自相关支撑）
  {
    const N = 512, R = 64; const p = circlePupil(N, R, null, 2); const g = otfFromPupil(p.re, p.im, N);
    const tail = Math.hypot(g.re[2 * R + 3], g.im[2 * R + 3]);
    const inside = Math.abs(Math.hypot(g.re[2 * R - 3], g.im[2 * R - 3]) - diffractionLimit((2 * R - 3) / (2 * R)));
    push('③ OTF 支撑 = 2R', tail < 1e-3 && inside < 3e-2,
      `|OTF(2R+3)|=${tail.toExponential(2)}, |OTF(2R−3)−解析|=${inside.toExponential(2)}`);
  }

  // ④ 纯离焦：MTF(W20) 关于 0 对称 + 最佳焦面在 W20=0（给定 s0）
  {
    const N = 512, R = 64, s0 = 0.25, ws = [];
    for (let w = -1.5; w <= 1.5001; w += 0.1) ws.push(+w.toFixed(2));
    const mt = throughFocusMTF(N, R, s0, ws);
    let symErr = 0; for (let i = 0; i < ws.length; i++) symErr = Math.max(symErr, Math.abs(mt[i] - mt[ws.length - 1 - i]));
    let peak = 0; for (let i = 1; i < mt.length; i++) if (mt[i] > mt[peak]) peak = i;
    push('④ 离焦对称 + 最佳焦面在 W20=0', symErr < 1e-9 && Math.abs(ws[peak]) < 1e-9,
      `对称误差=${symErr.toExponential(2)}, MTF峰值@W20=${ws[peak]}, MTF(s=0.25,W20=0)=${mt[peak].toFixed(4)}`);
  }

  // ⑤ Parseval：Σ|PSF|（=Σ|F|²）= N²·Σ|P|²
  {
    const N = 512, R = 64; const p = circlePupil(N, R, null, 2);
    const fr = Float64Array.from(p.re), fi = Float64Array.from(p.im);
    fft2d(fr, fi, N, false);
    let e1 = 0; for (let k = 0; k < N * N; k++) e1 += fr[k] * fr[k] + fi[k] * fi[k];
    let e0 = 0; for (let k = 0; k < N * N; k++) e0 += p.re[k] * p.re[k] + p.im[k] * p.im[k];
    const rel = Math.abs(e1 - N * N * e0) / (N * N * e0);
    push('⑤ Parseval 能量守恒', rel < 1e-9, `相对误差=${rel.toExponential(2)}`);
  }

  return { pass: results.every(r => r.pass), results };
}
