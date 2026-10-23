// bench/prep.mjs — 把应用模块复制到 bench/.tmp/（去掉浏览器用的 ?v= 查询后缀），供 Node 直接 import
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'lens-3d', 'js');
const dst = path.join(__dirname, '.tmp');
fs.mkdirSync(dst, { recursive: true });

// 源文件 -> 扁平化输出名（P3 分层后 core/ 与 analysis/ 都要带上）
const map = {
  'model.js': 'model_bench.mjs',
  'glassdb.js': 'glassdb_bench.mjs',
  'glassdb-plastic.js': 'glassdb-plastic_bench.mjs',
  'mtf.js': 'mtf_bench.mjs',
  'import.js': 'import_bench.mjs',
  'trace.js': 'trace_bench.mjs',
  'core/glass.js': 'core_glass.mjs',
  'core/surface.js': 'core_surface.mjs',
  'core/raytrace.js': 'core_raytrace.mjs',
  'core/beam.js': 'core_beam.mjs',
  'analysis/spot.js': 'an_spot.mjs',
  'analysis/fan.js': 'an_fan.mjs',
  'analysis/aberr.js': 'an_aberr.mjs',
  'analysis/illum.js': 'an_illum.mjs',
  'analysis/wavefront.js': 'an_wavefront.mjs',
};
const flat = { glass: 'core_glass.mjs', surface: 'core_surface.mjs', raytrace: 'core_raytrace.mjs', beam: 'core_beam.mjs',
  spot: 'an_spot.mjs', fan: 'an_fan.mjs', aberr: 'an_aberr.mjs', illum: 'an_illum.mjs', wavefront: 'an_wavefront.mjs' };

function rewrite(t) {
  // 1) 去掉 ?v=xxx
  t = t.replace(/(['"])(\.{1,2}\/[^'"]+?)\?v=[\w.]+(['"])/g, '$1$2$3');
  // 2) 扁平化路径（core/、analysis/ 以及同目录的拆分模块）
  t = t.replace(/(['"])(?:\.\.?\/)?(?:core|analysis)\/(\w+)\.js(['"])/g, (m, q1, n, q2) => q1 + './' + (flat[n] || n) + q2);
  t = t.replace(/(['"])\.\.?\/(glass|surface|raytrace|beam|spot|fan|aberr|illum|wavefront)\.js(['"])/g, (m, q1, n, q2) => q1 + './' + (flat[n] || n) + q2);
  t = t.replace(/(['"])\.\.?\/model\.js(['"])/g, '$1./model_bench.mjs$2');
  t = t.replace(/(['"])\.\.?\/glassdb-plastic\.js(['"])/g, '$1./glassdb-plastic_bench.mjs$2');
  t = t.replace(/(['"])\.\.?\/glassdb\.js(['"])/g, '$1./glassdb_bench.mjs$2');
  t = t.replace(/(['"])\.\.?\/mtf\.js(['"])/g, '$1./mtf_bench.mjs$2');
  t = t.replace(/(['"])\.\/(model|glassdb|glassdb-plastic|mtf)\.js(['"])/g, (m, q1, n, q2) => q1 + './' + n + '_bench.mjs' + q2);
  return t;
}

for (const [f, out] of Object.entries(map)) {
  const p = path.join(src, f);
  if (!fs.existsSync(p)) { console.log('[skip]', f); continue; }
  fs.writeFileSync(path.join(dst, out), rewrite(fs.readFileSync(p, 'utf8')));
}
console.log('[bench] prepared ->', dst);
