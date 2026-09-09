// model.js — 光学系统数据模型（M1）
// 纯数据层，不依赖 Three.js，便于后续导入器 / 表格 / 3D/2D 共用。

export const SURF = {
  OBJECT: 'obj',   // 物体面
  STO: 'sto',      // 光阑面
  IMAGE: 'ima',    // 像面
  STD: 'std',      // 标准球面/二次曲面
  ASP: 'asp',      // 偶次非球面
  FLAT: 'flat',    // 平面
};

export function radiusToCurv(radius) {
  if (radius == null || !isFinite(radius)) return 0;
  return radius === 0 ? 0 : 1 / radius;
}

// 标准面矢高（顶点在原点，沿光学轴 +z）。c=曲率, k=锥度, 高次项按 A4,A6,A8…
// 偶次非球面矢高。asph 数组：asph[0]=A4, asph[1]=A6, ...（A(4+2i)），最多支持到 A26（12 项）。
export function surfaceSag(h, { c = 0, k = 0, asph = [] } = {}) {
  const hasAsph = asph && asph.some(v => v);
  if (c === 0 && !hasAsph) return 0;
  const h2 = h * h;
  const cc = c * c;
  const base = c * h2 / (1 + Math.sqrt(Math.max(0, 1 - (1 + k) * cc * h2)));
  let extra = 0, p = h2 * h2;      // p 从 h^4 起
  for (let i = 0; i < (asph ? asph.length : 0); i++) { const v = asph[i]; if (v) extra += v * p; p *= h2; }
  return base + extra;
}

export function surfaceSagSlope(h, s) {
  // 数值微分（M1 用于光路/成像演示足够；后续 M2 实光线追迹会换解析式）
  const d = Math.max(1e-4, Math.abs(h) * 1e-3 + 1e-5);
  return (surfaceSag(h + d, s) - surfaceSag(h - d, s)) / (2 * d);
}

export class Surface {
  constructor(opt = {}) {
    this.id = opt.id ?? crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    this.type = opt.type ?? SURF.STD;
    this.radius = opt.radius ?? 0;         // 曲率半径 mm（0/Infinity=平面）
    this.thi = opt.thi ?? 0;               // 到下一面顶点的轴向间隔 mm
    this.glass = opt.glass ?? '';          // 玻璃牌号或 nd/vd
    this.semi = opt.semi ?? null;          // 净口径 CA（通光半口径）mm（null=未定）
    this.mSemi = opt.mSemi ?? null;        // 机械半直径 mm（null=未定，默认按净口径）
    this.k = opt.k ?? 0;                   // 圆锥常数
    // 偶次非球面指数项：asph[i] = A(4+2i)，即 [A4,A6,A8,…]，最多 12 项（A26）
    this.asph = Array.from({ length: 12 }, (_, i) => (opt.asph ? (opt.asph[i] ?? 0) : 0));
    // M4 将启用：偏心/倾斜
    this.decX = opt.decX ?? 0; this.decY = opt.decY ?? 0;
    this.tiltX = opt.tiltX ?? 0; this.tiltY = opt.tiltY ?? 0; this.tiltZ = opt.tiltZ ?? 0;
    this.comment = opt.comment ?? '';
  }

  isAspheric() { return !!(this.k || this.asph.some(v => v)); }

  toShape() {
    const c = radiusToCurv(this.radius);
    return { c, k: this.k, asph: this.asph.slice() };
  }

  toJSON() {
    return {
      type: this.type, radius: this.radius, thi: this.thi, glass: this.glass,
      semi: this.semi, mSemi: this.mSemi, k: this.k, asph: [...this.asph],
      decX: this.decX, decY: this.decY,
      tiltX: this.tiltX, tiltY: this.tiltY, tiltZ: this.tiltZ, comment: this.comment,
    };
  }
}

export class System {
  constructor(opt = {}) {
    this.name = opt.name ?? 'Untitled';
    this.surfaces = [];
    this.stopIndex = opt.stopIndex ?? 1;      // 光阑面在 surfaces 中的下标
    this.fno = opt.fno ?? null;               // 像方工作 F/#
    this.enpd = opt.enpd ?? null;             // 入瞳直径 mm
    this.apmode = opt.apmode ?? 'fno';         // 'fno' | 'enpd'
    this.fmode = opt.fmode ?? 'angle';         // 'angle' | 'height' | 'field'
    this.maxField = opt.maxField ?? 21.6;      // 角度° 或 实像高 mm
    this.fields = opt.fields ?? null;          // 视场列表(导入自 YFLN)：角度° 或 像高 mm
    this.objectDist = opt.objectDist ?? Infinity; // 物距 mm（=Infinity 表示物在无穷远）
    this.wavelengths = opt.wavelengths?.length ? opt.wavelengths
      : [{ nm: 486.13, weight: 1, color: '#0eb6ff' },   // F
         { nm: 587.56, weight: 2, color: '#ffb300' },   // d (主)
         { nm: 656.27, weight: 1, color: '#ff2d00' }];  // C
    this.primary = opt.primary ?? this.wavelengths.findIndex(w => Math.abs(w.nm - 587.56) < 1);
    if (this.primary < 0) this.primary = 1;
    this.vigCoefs = opt.vigCoefs ?? null;   // 自动渐晕：逐视场入瞳窗口 {yLo,yHi,xLo,xHi}
    this.warnings = opt.warnings ?? [];
  }

  get stopSurface() { return this.surfaces[this.stopIndex]; }
  get isFiniteConjugate() { return isFinite(this.objectDist); }
  get length() { let s = 0; for (let j = 1; j < this.surfaces.length; j++) s += this.surfaces[j].thi; return s; }

  // 以顶点位置为准给每个面标定轴向坐标（物体=0）
  surfaceZ(i) {
    let z = 0;
    // 从光轴第一个有效面算起；物面(下标0)的 thi 是物距，不计入系统长度
    for (let j = 1; j < i; j++) { const t = this.surfaces[j].thi; if (isFinite(t)) z += t; }
    return z;
  }

  toJSON() {
    return {
      name: this.name, stopIndex: this.stopIndex, fno: this.fno, enpd: this.enpd,
      apmode: this.apmode, fmode: this.fmode, maxField: this.maxField, fields: this.fields,
      objectDist: this.objectDist, wavelengths: this.wavelengths, primary: this.primary,
      surfaces: this.surfaces.map(s => s.toJSON()),
    };
  }

  serialize() { return JSON.stringify(this.toJSON()); }

  static deserialize(json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
      const sys = new System({
        name: d.name, stopIndex: d.stopIndex, fno: d.fno, enpd: d.enpd,
        apmode: d.apmode, fmode: d.fmode, maxField: d.maxField, fields: d.fields,
        objectDist: d.objectDist, wavelengths: d.wavelengths, primary: d.primary,
      });
    sys.surfaces = (d.surfaces || []).map(s => new Surface(s));
    return sys;
  }
}

// ---- 示例镜头：单片双凸物镜（F=50mm, N-BK7, 高6）----
export function demoSingleElement() {
  const sys = new System({ name: '单片双凸物镜 (F=50mm)', fno: 4, apmode: 'fno', fmode: 'height' });
  sys.surfaces = [
    new Surface({ type: SURF.OBJECT, radius: 0, thi: Infinity, comment: '物面(无穷远)' }),
    new Surface({ type: SURF.STO, radius: 44.2, thi: 6, glass: 'N-BK7', semi: 15, comment: '首面/光阑, R=+44.2' }),
    new Surface({ type: SURF.STD, radius: -57.7, thi: 46.5, glass: 'AIR', semi: 15, comment: '背表面, R=-57.7' }),
    new Surface({ type: SURF.IMAGE, radius: 0, thi: 0, semi: 21.6, comment: '像面' }),
  ];
  sys.stopIndex = 1;
  return sys;
}

// 示例：平凸物镜（F=80mm, N-BK7, 高10）半径由透镜公式解出 R=+41.344
export function demoPlanoConvex() {
  const sys = new System({ name: '平凸物镜 (F=80mm)', fno: 6, apmode: 'fno', fmode: 'height' });
  sys.surfaces = [
    new Surface({ type: SURF.OBJECT, thi: Infinity, comment: '物面(无穷远)' }),
    new Surface({ type: SURF.STO, radius: 41.344, thi: 10, glass: 'N-BK7', semi: 20, comment: '凸面/光阑, R=+41.344' }),
    new Surface({ type: SURF.FLAT, radius: 0, thi: 80, glass: 'AIR', semi: 20, comment: '平面(背)' }),
    new Surface({ type: SURF.IMAGE, radius: 0, thi: 0, semi: 21.6, comment: '像面' }),
  ];
  sys.stopIndex = 1;
  return sys;
}

// 空白系统：只有 物面 + 光阑镜面 + 像面，供用户在界面手动搭镜片
export function newBlankSystem() {
  const sys = new System({ name: '空白系统', fno: 6, apmode: 'fno', fmode: 'height' });
  sys.surfaces = [
    new Surface({ type: SURF.OBJECT, thi: Infinity, comment: '物面(无穷远)' }),
    new Surface({ type: SURF.STO, radius: 50, thi: 10, glass: 'N-BK7', semi: 20, comment: '光阑面(可编辑)' }),
    new Surface({ type: SURF.IMAGE, radius: 0, thi: 0, semi: 21.6, comment: '像面' }),
  ];
  sys.stopIndex = 1;
  return sys;
}

// 元件库：返回一片镜片对应的 [前表面, 后表面]，供插入系统任意位置
export function makeElement(kind, opt = {}) {
  const base = { glass: 'N-BK7', thi: 8, semi: 20 };
  Object.assign(base, opt);
  let front, back;
  switch (kind) {
    case 'planoconvex':           // 平凸：凸面朝物(左), 平面朝像(右)
      front = new Surface({ type: SURF.STO, radius: base.curvFront ?? 41.34, thi: base.thi, glass: base.glass, semi: base.semi, comment: '凸面(光阑)' });
      back  = new Surface({ type: SURF.FLAT, radius: 0, thi: base.thi, glass: 'AIR', semi: base.semi, comment: '平面' });
      break;
    case 'planoconcave':          // 平凹
      front = new Surface({ type: SURF.STO, radius: base.curvFront ?? -41.34, thi: base.thi, glass: base.glass, semi: base.semi, comment: '凹面(光阑)' });
      back  = new Surface({ type: SURF.FLAT, radius: 0, thi: base.thi, glass: 'AIR', semi: base.semi, comment: '平面' });
      break;
    case 'meniscus':              // 弯月(正)
      front = new Surface({ type: SURF.STO, radius: base.curvFront ?? 40, thi: base.thi, glass: base.glass, semi: base.semi, comment: '凹面(光阑)' });
      back  = new Surface({ type: SURF.STD, radius: base.curvBack ?? 60, thi: base.thi, glass: 'AIR', semi: base.semi, comment: '凸面' });
      break;
    case 'biconvex':              // 双凸(F=50): R=±50.098
    default:
      const R = 50.098;
      front = new Surface({ type: SURF.STO, radius: base.curvFront ?? R, thi: base.thi, glass: base.glass, semi: base.semi, comment: '凸面(光阑)' });
      back  = new Surface({ type: SURF.STD, radius: base.curvBack ?? -R, thi: base.thi, glass: 'AIR', semi: base.semi, comment: '凸面' });
      break;
  }
  return [front, back];
}

export const ELEMENTS = {
  biconvex: '双凸镜片', planoconvex: '平凸镜片',
  planoconcave: '平凹镜片', meniscus: '弯月镜片',
};

export const DEMO_LENSES = { single: demoSingleElement, planoconvex: demoPlanoConvex, blank: () => newBlankSystem() };
