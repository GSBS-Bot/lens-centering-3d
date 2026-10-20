// bench/prep.mjs — 把应用模块复制到 bench/.tmp/（去掉浏览器用的 ?v= 查询后缀），供 Node 直接 import
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'lens-3d', 'js');
const dst = path.join(__dirname, '.tmp');
fs.mkdirSync(dst, { recursive: true });

const map = {
  'model.js': 'model_bench.mjs',
  'glassdb.js': 'glassdb_bench.mjs',
  'glassdb-plastic.js': 'glassdb-plastic_bench.mjs',
  'mtf.js': 'mtf_bench.mjs',
  'import.js': 'import_bench.mjs',
  'trace.js': 'trace_bench.mjs',
};
for (const [f, out] of Object.entries(map)) {
  let t = fs.readFileSync(path.join(src, f), 'utf8');
  t = t.replace(/\.\/model\.js\?v=[\w.]+/g, './model_bench.mjs')
       .replace(/\.\/glassdb-plastic\.js\?v=[\w.]+/g, './glassdb-plastic_bench.mjs')
       .replace(/\.\/glassdb\.js\?v=[\w.]+/g, './glassdb_bench.mjs')
       .replace(/\.\/mtf\.js\?v=[\w.]+/g, './mtf_bench.mjs');
  fs.writeFileSync(path.join(dst, out), t);
}
console.log('[bench] prepared ->', dst);
