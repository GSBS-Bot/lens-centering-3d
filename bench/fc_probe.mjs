// 找能复现 Zemax 场曲(T=66.6,S=153.8@21.6mm)的口径
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(__dirname, '.tmp');
const { parseZmx } = await import('file://' + path.join(tmp, 'import_bench.mjs').replace(/\\/g, '/'));
const { traceFieldBundle, traceRay3 } = await import('file://' + path.join(tmp, 'trace_bench.mjs').replace(/\\/g, '/'));

const p = 'C:/Users/lylens/Desktop/3d可视化镜头调芯模型9-9/3d可视化镜头调芯模型/3d可视化镜头调芯模型/测试zemax文件/Advanced_SC_doubleGauss_final.zmx';
const b0 = fs.readFileSync(p);
const text = (b0[0] === 0xFF && b0[1] === 0xFE) ? b0.toString('utf16le').replace(/^\uFEFF/, '') : b0.toString('utf8');
const sys = parseZmx(text);
const sl = []; { const n = sys.surfaces.length, zS = -sys.surfaceZ(n - 1); for (let i = 0; i < n; i++) { const s = sys.surfaces[i]; sl.push({ idx: i, z: sys.surfaceZ(i) + zS, semi: s.semi, mSemi: s.mSemi, type: s.type }); } }
const LAM = 0.587562, MODE = sys.fmode;

function setup(fv) {
  const b = traceFieldBundle(sys, sl, { mode: MODE, field: fv, nPupil: 1, lambdaUm: LAM });
  const c = b.chief; if (!c) return null;
  const param = c._a ?? c._h ?? 0, zs = c._zStart, epd = b.epd || 1, ang = (c._theta ?? 0) * Math.PI / 180;
  const hit = (px, py) => {
    const P0 = [px * epd / 2, param + py * epd / 2, zs], D0 = [0, Math.sin(ang), Math.cos(ang)];
    const tr = traceRay3(sys, sl, P0, D0, LAM, true);
    if (!(tr.ok && tr.imageX != null)) return null;
    const D = tr.dir, uz = Math.abs(D[2]) > 1e-12 ? D[2] : 1;
    return { x: tr.imageX, y: tr.imageY, ux: D[0] / uz, uy: D[1] / uz };
  };
  return hit;
}
const cross = (e1, e2, k) => { const ax = k === 'y' ? 'y' : 'x', ak = k === 'y' ? 'uy' : 'ux'; const du = e1[ak] - e2[ak]; if (Math.abs(du) < 1e-9) return null; const z = (e2[ax] - e1[ax]) / du; return isFinite(z) && Math.abs(z) < 1e4 ? z : null; };
const axis = (e, k) => { const ax = k === 'y' ? 'y' : 'x', ak = k === 'y' ? 'uy' : 'ux'; if (Math.abs(e[ak]) < 1e-9) return null; const z = -e[ax] / e[ak]; return isFinite(z) ? z : null; };
const u = z => z == null ? NaN : z * 1000;

for (const fv of [0, 21.6]) {
  const hit = setup(fv); if (!hit) { console.log(fv + ' 无解'); continue; }
  const c = hit(0, 0), mu = hit(0, 1), md = hit(0, -1), su = hit(1, 0), sd = hit(-1, 0);
  console.log(`\n== 场 ${fv}mm (µm, 相对像面) ==`);
  console.log('  T: 边缘x主光(avg)=' + u((cross(mu, c, 'y') + cross(md, c, 'y')) / 2) +
    '  边缘互交=' + u(cross(mu, md, 'y')) +
    '  +1x主光=' + u(cross(mu, c, 'y')) +
    '  -1x主光=' + u(cross(md, c, 'y')) +
    '  边缘x光轴(avg)=' + u((axis(mu, 'y') + axis(md, 'y')) / 2));
  console.log('  S: 边缘x主光(avg)=' + u((cross(su, c, 'x') + cross(sd, c, 'x')) / 2) +
    '  边缘互交=' + u(cross(su, sd, 'x')) +
    '  边缘x光轴(avg)=' + u((axis(su, 'x') + axis(sd, 'x')) / 2));
}
