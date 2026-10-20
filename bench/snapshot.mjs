// bench/snapshot.mjs — 生成"黄金镜头集"的 JS 引擎基准快照（P0）
// 用法: node bench/prep.mjs && node bench/snapshot.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = path.join(__dirname, '.tmp');

const { parseZmx, importFriendJson } = await import('file://' + path.join(tmp, 'import_bench.mjs').replace(/\\/g, '/'));
const trace = await import('file://' + path.join(tmp, 'trace_bench.mjs').replace(/\\/g, '/'));
const mtf = await import('file://' + path.join(tmp, 'mtf_bench.mjs').replace(/\\/g, '/'));

const LAM = 0.587562;
const LENSES = [
  { name: 'doubleGauss', file: '测试zemax文件/Advanced_SC_doubleGauss_final.zmx' },
  { name: 'cooke40', file: '测试zemax文件/Cooke 40 degree field.zmx' },
  { name: 'songraw85', file: 'lenses/songraw-af-85mm-f1-2.json' },
  { name: 'sony50', file: 'lenses/sony-fe-50mm-f1-2-gm.json' },
  { name: 'ind9mm', file: 'C:/Users/lylens/Desktop/工业镜头 9mm .zmx', optional: true },
];

function slist(sys) {
  const n = sys.surfaces.length, zS = -sys.surfaceZ(n - 1), a = [];
  for (let i = 0; i < n; i++) {
    const s = sys.surfaces[i];
    a.push({ idx: i, z: sys.surfaceZ(i) + zS, semi: s.semi, mSemi: s.mSemi, type: s.type });
  }
  return a;
}
function loadLens(p) {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  if (!fs.existsSync(abs)) return null;
  if (/\.json$/i.test(abs)) return importFriendJson(JSON.parse(fs.readFileSync(abs, 'utf8')));
  const b = fs.readFileSync(abs);
  const text = (b[0] === 0xFF && b[1] === 0xFE) ? b.toString('utf16le').replace(/^\uFEFF/, '') : b.toString('utf8').replace(/^\uFEFF/, '');
  return parseZmx(text);
}
function rmsOf(points) {
  if (!points || points.length < 2) return null;
  let cx = 0, cy = 0;
  for (const p of points) { cx += p[0]; cy += p[1]; }
  cx /= points.length; cy /= points.length;
  let s = 0;
  for (const p of points) { const dx = p[0] - cx, dy = p[1] - cy; s += dx * dx + dy * dy; }
  return Math.sqrt(s / points.length);
}
function mtfAt(wv, nu, axis) {
  if (!wv || !wv.ok) return null;
  const otf = mtf.otfFromPupil(wv.re, wv.im, wv.N);
  const s = wv.nuC > 0 ? nu / wv.nuC : 0;
  const c = mtf.sampleOtfComplex(otf, wv.N, wv.R, s, axis);
  return Math.min(1, Math.hypot(c.re, c.im));
}

const outDir = path.join(__dirname, 'golden');
fs.mkdirSync(outDir, { recursive: true });
const NU = 30;   // 固定评估频率 lp/mm

for (const spec of LENSES) {
  const abs = path.isAbsolute(spec.file) ? spec.file : path.join(root, spec.file);
  if (!fs.existsSync(abs)) { console.log('[skip] ' + spec.name + ' (文件不存在)'); continue; }
  let sys;
  try { sys = loadLens(spec.file); } catch (e) { console.log('[err ] ' + spec.name + ': ' + e.message); continue; }
  if (!sys) { console.log('[err ] ' + spec.name + ': 解析失败'); continue; }
  const sl = slist(sys);
  const mode = sys.fmode;
  const fo = trace.firstOrder(sys, sl, LAM) || {};
  const fields = (sys.fields && sys.fields.length) ? sys.fields.slice() : [0];

  const ab = trace.fieldAberrations(sys, sl, { mode, fields, lambdas: [{ nm: LAM * 1000, color: '#fff' }] });
  const abByField = new Map();
  for (const it of ab.items) if (it.ok && it.perWl && it.perWl[0] && it.perWl[0].ok) abByField.set(it.field, it.perWl[0]);

  const rows = [];
  let nuC = null;
  for (const fv of fields) {
    const sp = trace.traceSpot(sys, sl, { mode, field: +fv, lambdaUm: LAM, nGrid: 15 });
    const wv = trace.traceWavefront(sys, sl, { mode, field: +fv, lambdaUm: LAM, nGrid: 64 });
    if (wv && wv.ok && nuC == null && wv.nuC > 0) nuC = wv.nuC;
    const a = abByField.get(+fv);
    rows.push({
      field: +fv,
      spotRms_um: rmsOf(sp.points) != null ? rmsOf(sp.points) * 1000 : null,
      distortion_pct: a ? a.dist : null,
      tFocus_um: a ? a.tFocus * 1000 : null,
      sFocus_um: a ? a.sFocus * 1000 : null,
      mtfT_30: mtfAt(wv, NU, 'T'),
      mtfS_30: mtfAt(wv, NU, 'S'),
    });
  }
  const out = {
    lens: spec.name, file: spec.file, mode,
    efl: fo.efl ?? null, fno: fo.fno ?? null, bfl: fo.bfl ?? null,
    lambda_nm: LAM * 1000, nu_eval: NU, nuC, fields: rows,
  };
  fs.writeFileSync(path.join(outDir, spec.name + '.json'), JSON.stringify(out, null, 2));
  console.log('[ok  ] ' + spec.name + '  EFL=' + (fo.efl ?? 0).toFixed(3) + '  F#=' + (fo.fno ?? 0).toFixed(2) + '  场数=' + rows.length);
}
console.log('golden ->', outDir);
