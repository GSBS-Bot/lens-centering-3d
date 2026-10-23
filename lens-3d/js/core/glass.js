// core/glass.js — 玻璃折射率层：常用牌号小表 / "nd/vd" 写法 / 色散模型
// 桌面牌号库(GLASS_DB)优先，其次 5 项 Sellmeier，再退回 Laurent/Cauchy。
import { GLASS_DB } from '../glassdb.js?v=0.9.0';

export const LAM_D = 0.58756, LAM_F = 0.48613, LAM_C = 0.65627;
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
