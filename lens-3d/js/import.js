// import.js — .zmx / .seq 导入器（M1 基础版：读取常用关键词）
import { Surface, System, SURF } from './model.js?v=0.8.4';

function fixGlass(g) {
  if (!g) return 'AIR';
  return g.trim().replace(/^["']|["']$/g, '').replace(/_HIKARI$/i, '');
}

// ---------------- Zemax .zmx ----------------
export function parseZmx(text) {
  // 若文本像 UTF-16（BOM 或含 NUL 字节），按 UTF-16LE 重新解码
  if (text.charCodeAt(0) === 0xFEFF || /\x00/.test(text.slice(0, 300))) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes.push(c & 0xff, (c >>> 8) & 0xff); }
    text = new TextDecoder('utf-16le').decode(new Uint8Array(bytes));
  }

  const lines = text.split(/\r?\n/);
  const sys = new System({ name: 'zemax' });
  const surfaces = [];
  let cur = null, curIdx = -1, stopIdx = -1;
  let fnum = null, enpd = null, wlStarted = false;
  let wavmList = [];                                   // 全部 WAVM 原始条目（用于按出现次数过滤）

  // 按面编号（SURF n）为每个面分配槽位，避免重复/幽灵面
  const ensureSurface = (idx) => {
    while (surfaces.length <= idx) surfaces.push(null);
    if (!surfaces[idx]) surfaces[idx] = new Surface({});
    return surfaces[idx];
  };

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const [kw, ...rest] = line.split(/\s+/);
    const val = rest.join(' ');
    switch (kw.toUpperCase()) {
      case 'NAME': sys.name = val; break;
      case 'SURF': {
        const n = parseInt(rest[0], 10);
        cur = ensureSurface(n);
        if (n === 0) { cur.type = SURF.OBJECT; cur.thi = Infinity; }
        curIdx = n;
        break;
      }
      case 'STOP': stopIdx = curIdx; break;   // Zemax 用该标记标注当前面为光阑
      case 'TYPE': {
        if (cur && rest[0]?.toUpperCase() === 'STANDARD' && cur.type !== SURF.OBJECT && cur.type !== SURF.IMAGE)
          cur.type = SURF.STD;
        break;
      }
      case 'CURV': { const c = parseFloat(rest[0]); if (cur) cur.radius = (c === 0 || !isFinite(c)) ? 0 : 1 / c; break; }
      case 'DISZ': {
        if (cur) { const v = rest[0]; cur.thi = /^INFINITY$/i.test(v || '') ? Infinity : parseFloat(v); }
        break;
      }
      case 'GLAS': {
        // Zemax GLAS 行常带真折射率：`<名> 0 0 <nd> <vd> ...`。优先提取 (nd,vd)，
        // 存成「名 nd/vd」形式，供 trace.parseGlassOptics 用真实折射率追迹（CDGM 等目录外牌号也能用）。
        const toks = val.trim().split(/\s+/);
        const name = fixGlass(toks[0] ?? 'AIR');
        let nd = NaN, vd = NaN;
        for (let i = 0; i < toks.length - 1; i++) {
          const a = parseFloat(toks[i]), b = parseFloat(toks[i + 1]);
          if (isFinite(a) && isFinite(b) && a > 1.30 && a < 2.60 && b > 15 && b < 95) { nd = a; vd = b; break; }
        }
        if (cur) {
          if (isFinite(nd) && isFinite(vd)) cur.glass = `${name} ${nd}/${vd}`;   // 名 + 真实折射率
          else cur.glass = name === 'AIR' ? 'AIR' : name;
        }
        break;
      }
      case 'DIAM': if (cur) cur.semi = parseFloat(rest[0]); break;                 // 净口径 CA（通光半口径）
      case 'MDIA': case 'MEMA': if (cur) cur.mSemi = parseFloat(rest[0]); break;    // 机械半直径
      case 'SCAA': case 'SCYA': case 'SCAX': break;                                // 非圆形通光，暂忽略
      case 'CONI': if (cur) cur.k = parseFloat(rest[0]); break;
      case 'PARM': { // Zemax 偶次非球面：PARM n = ρ^(2n) 项（PARM1=ρ², PARM2=ρ⁴, PARM3=ρ⁶,…）
        const n = parseInt(rest[0], 10); const p = parseFloat(rest[1]);
        if (cur && isFinite(p)) {
          if (n >= 2) {
            const idx = n - 2;              // ρ^(2n) -> asph[idx] = ρ^(4+2·idx)
            if (idx >= 0 && idx < cur.asph.length) { cur.asph[idx] = p; cur.type = SURF.ASP; }
          } else if (n === 1) {
            // 本模型从 ρ⁴ 起，无 ρ² 项；保留警告以便反查，避免与 ρ⁴ 混淆
            sys.warnings.push(`第${curIdx}面偶次非球面含 ρ² 项(PARM 1=${p})，模型从 ρ⁴ 起，已忽略`);
          }
        }
        break;
      }
      case 'FNUM': fnum = parseFloat(rest[0]); break;
      case 'ENPD': enpd = parseFloat(rest[0]); break;
      case 'WAVM': {
        // Zemax: WAVM <序号> <波长um> <权重>。仅收集原始条目，最后统一按「出现次数」过滤。
        // 同一波长被重复多次（如 19 个 550nm）属无效项，整组删除、不保留首个。
        let nm = parseFloat(rest[1]); const w = parseFloat(rest[2]);
        if (isFinite(nm)) {
          if (nm < 100) nm *= 1000;                        // 微米 -> nm
          wavmList.push({ nm, weight: isNaN(w) ? 0 : w });
        }
        break;
      }
      case 'PWAV': sys.primary = Math.max(0, parseInt(rest[0], 10) - 1); break;
      case 'FTYP': sys.fmode = rest[0] === '0' ? 'angle' : rest[0] === '1' ? 'field' : 'height'; break;
      case 'YFLN': {
        // YFLN <v1> <v2> ...（本文件 "0 3.024 -3.024 ..." = 视场列表）。
        // 与波长一致：重复值只保留首个；且 Zemax 的「±半视场对」(如 ±3.024) 是对称系统的无效重复，
        // 按 |值| 合并成单个正半视场（如 3.024），避免同一视场被追两次。
        const vals = rest.map(s => parseFloat(s)).filter(n => isFinite(n));
        for (const v of vals) {
          if (!sys.fields) sys.fields = [];
          const av = Math.abs(v);
          if (!sys.fields.some(x => Math.abs(Math.abs(x) - av) < 1e-9)) sys.fields.push(av);  // 存正量级
        }
        if (vals.length) sys.maxField = Math.max(sys.maxField ?? 0, ...vals.map(v => Math.abs(v)));
        break;
      }
      default: break; // 其它关键词忽略
    }
  }

  // 波长去重（整组删重复）：同一 nm 出现多次（如大量重复的 550nm）是 Zemax 无效项，全部删除；
  // 只保留「恰好出现一次」的真实设计波长。这样 436/486/546/587.6/656.3 各保留一次，550nm 完全移除。
  if (wavmList.length) {
    const cnt = {};
    for (const w of wavmList) { const key = Math.round(w.nm * 100) / 100; cnt[key] = (cnt[key] || 0) + 1; }
    sys.wavelengths = wavmList
      .filter(w => cnt[Math.round(w.nm * 100) / 100] === 1)
      .map((w, i) => ({ nm: w.nm, weight: w.weight, color: '' }));
  }

  // 过滤空槽位（面编号跳跃时产生）
  const kept = surfaces.filter(s => s != null);
  if (!kept.length) return null;
  // 物面当作首面（若无）
  if (kept[0].type !== SURF.OBJECT) kept.unshift(new Surface({ type: SURF.OBJECT, thi: Infinity }));
  // 收尾：Zemax 的最后一个面(R=0)即像面，直接标记而非重复添加
  const last = kept[kept.length - 1];
  if (last && last.type !== SURF.IMAGE) last.type = SURF.IMAGE;
  sys.surfaces = kept;
  sys.fno = fnum; sys.enpd = enpd;
  // 有入瞳直径(ENPD)且未给 F# -> 用 ENPD 定义孔径
  if (isFinite(enpd) && enpd > 0 && (fnum == null || !isFinite(fnum))) sys.apmode = 'enpd';
  if (stopIdx >= 0 && stopIdx < kept.length) sys.stopIndex = stopIdx;
  // 若首面是物面则厚度应为物距
  const obj = kept[0];
  if (obj && obj.type === SURF.OBJECT) {
    sys.objectDist = isFinite(obj.thi) && obj.thi > 0 && obj.thi < 1e6 ? obj.thi : Infinity;
  }
  return sys;
}

// ---------------- CODE V .seq ----------------
export function parseSeq(text) {
  const lines = text.split(/\r?\n/);
  const sys = new System({ name: 'codev' });
  const surfaces = [];
  let cur = null;
  let pendingObj = true;

  const startNew = () => { const s = new Surface({}); cur = s; surfaces.push(s); return s; };

  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('!')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9]*)\s+(.*)$/);
    if (!m) continue;
    const [, kw, rest] = m;
    const toks = rest.trim().split(/\s+/);
    // CODE V 偶次非球面系数行：A4 / A6 / A8 ...（度数 -4)/2 = asph 下标
    const aM = kw.match(/^A(\d+)$/i);
    if (aM) {
      const idx = (parseInt(aM[1], 10) - 4) / 2;
      if (cur && idx >= 0 && idx < cur.asph.length) { cur.asph[idx] = parseFloat(toks[0]); cur.type = SURF.ASP; }
      continue;
    }
    switch (kw.toUpperCase()) {
      case 'RDY': cur.radius = parseFloat(toks[0]); cur.type = cur.radius === 0 || !isFinite(cur.radius) ? SURF.FLAT : SURF.STD; break;
      case 'THI': cur.thi = parseFloat(toks[0]); break;
      case 'GLA': cur.glass = fixGlass(toks[0]); break;
      case 'SDIA': cur.semi = parseFloat(toks[0]); break;
      case 'UDIM': cur.mSemi = parseFloat(toks[0]); break;   // 用户机械孔径
      case 'CIR': { const r = parseFloat(toks[0]); if (isFinite(r) && cur.mSemi == null) cur.mSemi = r; break; }
      case 'CONI': cur.k = parseFloat(toks[0]); break;
      case 'STO': break; // 代码V里光阑面由 S 列给定
      case 'ASP': { cur.type = SURF.ASP; break; }
      case 'K': { break; } // 高阶系数 K1.. 在 K 行，忽略或后续处理
      case 'S': case 'S0': { // CODE V 用 S<n> 开始一面
        const n = parseInt(kw.slice(1), 10);
        if (n > 0) startNew();
        if (n === 0) { surfaces.unshift(new Surface({ type: SURF.OBJECT, thi: Infinity })); cur = surfaces[0]; }
        break;
      }
      case 'FNO': sys.fno = parseFloat(toks[0]); break;
      case 'WL': case 'WVL': {
        const nm = parseFloat(toks[0]);
        if (isFinite(nm)) sys.wavelengths.push({ nm, weight: 1, color: '' });
        break;
      }
      case 'REF': sys.primary = Math.max(0, parseInt(toks[0], 10) - 1); break;
      case 'YRI': case 'YAN': { const f = Math.abs(parseFloat(toks[0])); if (isFinite(f)) sys.maxField = Math.max(sys.maxField ?? 0, f); break; }
      default: break;
    }
  }

  if (!surfaces.length) return null;
  const last = surfaces[surfaces.length - 1];
  if (last.type !== SURF.IMAGE) surfaces.push(new Surface({ type: SURF.IMAGE, thi: 0 }));
  sys.surfaces = surfaces;
  return sys;
}

export function importFile(filename, text) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'zmx') return parseZmx(text);
  if (ext === 'seq') return parseSeq(text);
  return null;
}
