// bench/compare.mjs — JS 与 Optiland 逐项对比
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsDir = path.join(__dirname, 'golden');
const opDir = path.join(__dirname, 'golden_optiland');

const names = fs.readdirSync(jsDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
const f3 = v => (v == null || !isFinite(v)) ? '  —  ' : (v >= 0 ? ' ' : '') + v.toFixed(3);

for (const name of names) {
  const jp = path.join(jsDir, name + '.json');
  const op = path.join(opDir, name + '.json');
  const a = JSON.parse(fs.readFileSync(jp, 'utf8'));
  if (!fs.existsSync(op)) { console.log(`${name}: 无 Optiland 参考`); continue; }
  const b = JSON.parse(fs.readFileSync(op, 'utf8'));
  console.log(`\n=== ${name} ===  JS λ=${a.lambda_nm.toFixed(2)}  Opt λ=${b.primary_nm.toFixed(2)}  ESL ${a.efl?.toFixed(3)}/${b.efl?.toFixed(3)}`);
  console.log('field |  spotRMS JS/Opt  |  dist% JS/Opt  |  T(µm) JS/Opt  |  S(µm) JS/Opt  |  MTF30 T JS/Opt');
  const bf = new Map((b.fields || []).map(o => [o.field, o]));
  for (const x of a.fields) {
    const y = bf.get(x.field) || {};
    const optT = y.tFocus_mm != null ? y.tFocus_mm * 1000 : null;
    const optS = y.sFocus_mm != null ? y.sFocus_mm * 1000 : null;
    console.log(
      String(x.field).padStart(5) + ' | ' +
      f3(x.spotRms_um).padStart(7) + '/' + f3(y.spotRms_um).padStart(7) + ' | ' +
      f3(x.distortion_pct).padStart(7) + '/' + f3(y.distortion_pct).padStart(7) + ' | ' +
      f3(x.tFocus_um).padStart(7) + '/' + f3(optT).padStart(7) + ' | ' +
      f3(x.sFocus_um).padStart(7) + '/' + f3(optS).padStart(7) + ' | ' +
      f3(x.mtfT_30).padStart(5) + '/' + f3(y.mtfT_30).padStart(5)
    );
  }
}
