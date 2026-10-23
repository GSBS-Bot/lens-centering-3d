// bench/regress.mjs — P3 内核分层「零回归」指纹
// 用法:
//   node bench/prep.mjs && node bench/regress.mjs out.json     # 采集
//   node bench/regress.mjs --diff a.json b.json                # 对比
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = path.join(__dirname, '.tmp');

if (process.argv[2] === '--diff') {
  const a = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const b = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  let n = 0, bad = 0, worst = { d: 0, p: '' };
  const walk = (x, y, p) => {
    if (typeof x === 'number' && typeof y === 'number') {
      n++;
      if (x !== y) {
        const d = Math.abs(x - y);
        bad++;
        if (d > worst.d) worst = { d, p };
      }
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) { console.log('LEN DIFF @' + p, x.length, y.length); bad++; return; }
      for (let i = 0; i < x.length; i++) walk(x[i], y[i], p + '[' + i + ']');
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const ks = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of ks) {
        if (!(k in x) || !(k in y)) { console.log('KEY DIFF @' + p + '.' + k); bad++; continue; }
        walk(x[k], y[k], p + '.' + k);
      }
      return;
    }
    if (x !== y) { console.log('VAL DIFF @' + p, JSON.stringify(x), JSON.stringify(y)); bad++; }
  };
  walk(a, b, '');
  console.log(bad === 0 ? `IDENTICAL (${n} numbers)` : `DIFF ${bad}/${n} · worst ${worst.d} @${worst.p}`);
  process.exit(bad === 0 ? 0 : 1);
}

const { parseZmx, importFriendJson } = await import('file://' + path.join(tmp, 'import_bench.mjs').replace(/\\/g, '/'));
const T = await import('file://' + path.join(tmp, 'trace_bench.mjs').replace(/\\/g, '/'));

const LENSES = [
  { name: 'doubleGauss', file: '测试zemax文件/Advanced_SC_doubleGauss_final.zmx' },
  { name: 'cooke40', file: '测试zemax文件/Cooke 40 degree field.zmx' },
  { name: 'songraw85', file: 'lenses/songraw-af-85mm-f1-2.json' },
  { name: 'sony50', file: 'lenses/sony-fe-50mm-f1-2-gm.json' },
  { name: 'sigma85', file: 'lenses/sigma-85mm-f1-4-dg-hsm-art.json' },
];
const R = (v) => (v == null || typeof v !== 'number' || !isFinite(v)) ? null : +v.toFixed(12);

function loadLens(p) {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  if (!fs.existsSync(abs)) return null;
  if (/\.json$/i.test(abs)) return importFriendJson(JSON.parse(fs.readFileSync(abs, 'utf8')));
  const b = fs.readFileSync(abs);
  const text = (b[0] === 0xFF && b[1] === 0xFE) ? b.toString('utf16le').replace(/^\uFEFF/, '') : b.toString('utf8').replace(/^\uFEFF/, '');
  return parseZmx(text);
}
function slist(sys) {
  const n = sys.surfaces.length, zS = -sys.surfaceZ(n - 1), a = [];
  for (let i = 0; i < n; i++) {
    const s = sys.surfaces[i];
    a.push({ idx: i, z: sys.surfaceZ(i) + zS, semi: s.semi, mSemi: s.mSemi, type: s.type });
  }
  return a;
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

const out = {};
for (const spec of LENSES) {
  const sys = loadLens(spec.file);
  if (!sys) { out[spec.name] = { missing: true }; continue; }
  const sl = slist(sys);
  const mode = sys.fmode;
  const wls = (sys.wavelengths && sys.wavelengths.length) ? sys.wavelengths : [{ nm: 587.56, weight: 1 }];
  let pi = wls.findIndex(w => w && w.primary);
  if (pi < 0) pi = (Number.isInteger(sys.primary) && sys.primary >= 0 && sys.primary < wls.length) ? sys.primary : 0;
  const LAM = (+((wls[pi] || {}).nm) || 587.56) / 1000;
  const fields = (sys.fields && sys.fields.length) ? sys.fields.slice() : [0];
  const lamAll = wls.map(w => ({ nm: +w.nm, weight: w.weight ?? 1, color: w.color || '#fff' }));

  const fo = T.firstOrder(sys, sl, LAM) || {};
  const ep = T.entrancePupil(sys, sl, LAM) || {};
  const vig = T.autoVignette(sys, sl, { mode, fields, lambdaUm: LAM }) || [];
  const ab = T.fieldAberrations(sys, sl, { mode, fields, lambdas: lamAll });
  const lsa = T.longitudinalAberration(sys, sl, { lambdas: lamAll, nGrid: 11 });
  const bf = T.bestFocus(sys, sl, { mode, fields, lambdas: lamAll, nGrid: 11, vigCoefs: vig });

  const rows = [];
  for (let fi = 0; fi < fields.length; fi++) {
    const fv = +fields[fi];
    const sp = T.traceSpot(sys, sl, { mode, field: fv, lambdaUm: LAM, nGrid: 11, vigCoef: vig[fi] || null });
    const fan = T.traceRayFan(sys, sl, { mode, field: fv, lambdaUm: LAM, nGrid: 11 });
    const il = T.traceIllumination(sys, sl, { mode, fields: [fv], nGrid: 11, lambdaUm: LAM, vigCoefs: [vig[fi] || null] });
    const wf = T.traceWavefront(sys, sl, { mode, field: fv, lambdaUm: LAM, nGrid: 64, vigCoef: vig[fi] || null });
    const it = (ab.items || []).find(o => o.ok && Math.abs(o.field - fv) < 1e-9);
    let opdSum = null, opdSq = null, samples = null;
    if (wf && wf.ok) {
      let s = 0, s2 = 0; const arr = [];
      for (let i = 0; i < wf.N * wf.N; i++) { if (!wf.mask[i]) continue; s += wf.opd[i]; s2 += wf.opd[i] * wf.opd[i]; if (i % 977 === 0) arr.push(R(wf.opd[i])); }
      opdSum = R(s); opdSq = R(s2); samples = arr;
    }
    rows.push({
      field: fv,
      spotRms_um: R(rmsOf(sp.points) == null ? null : rmsOf(sp.points) * 1000),
      spotN: sp.points.length,
      fanMer: fan.ok ? fan.mer.map(a => R(a.e)) : null,
      fanSag: fan.ok ? fan.sag.map(a => R(a.e)) : null,
      aber: it ? it.perWl.map(p => ({ nm: R(p.nm), ok: !!p.ok, dist: R(p.dist), t: R(p.tFocus), s: R(p.sFocus), realY: R(p.realY), idealY: R(p.idealY) })) : null,
      illum: il.items && il.items[0] ? { ok: !!il.items[0].ok, V: R(il.items[0].V), cos4: R(il.items[0].cos4), RI: R(il.items[0].RI), nTot: il.items[0].nTot, nPass: il.items[0].nPass } : null,
      wf: wf && wf.ok ? { N: wf.N, R: wf.R, nuC: R(wf.nuC), nHit: wf.nHit, opdSum, opdSq, samples } : null,
    });
  }
  out[spec.name] = {
    mode, efl: R(fo.efl), fno: R(fo.fno), bfl: R(fo.bfl),
    ep: { zEP: R(ep.zEP), pupilMag: R(ep.pupilMag), epd: R(ep.epd) },
    vig: vig.map(v => v ? { yLo: R(v.yLo), yHi: R(v.yHi), xLo: R(v.xLo), xHi: R(v.xHi) } : null),
    zParax: R(lsa.zParax),
    lsa: lsa.perWl.map(w => ({ nm: R(w.nm), ok: !!w.ok, zParax: R(w.zParax), pts: w.pts.map(q => [R(q.p), R(q.lsa)]) })),
    best: bf ? { shift: R(bf.shift), rms0: R(bf.rms0), rmsBest: R(bf.rmsBest), nRays: bf.nRays } : null,
    fields: rows,
  };
  console.log('[ok] ' + spec.name + '  EFL=' + (out[spec.name].efl ?? 0).toFixed(3) + '  场=' + rows.length);
}
const outFile = process.argv[2] || path.join(__dirname, '.tmp', 'regress.json');
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log('written ->', outFile);
