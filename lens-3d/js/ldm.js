// ldm.js — LDM 面表格 UI（M1）。view 不含计算，只知道"读了 sys，改了 sys，触发 onChange"。
import { Surface, System, SURF, makeElement } from './model.js?v=0.8.4';

const TYPE_LABEL = {
  [SURF.OBJECT]: '物面', [SURF.STO]: '光阑', [SURF.IMAGE]: '像面',
  [SURF.STD]: '镜面', [SURF.ASP]: '非球面', [SURF.FLAT]: '平面',
};

export class LDM {
  constructor(container, { onChange, onSelect } = {}) {
    this.el = container;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.selected = null;
    this.historyStack = [];
    this.futureStack = [];
    this.setupToolbar();
    this.setupTable();
  }

  setToolbar(html) { this.toolbar.innerHTML = html; }
  setupToolbar() {
    const t = document.createElement('div');
    t.className = 'ldm-toolbar';
    t.innerHTML = `
      <label class="lbl">元件库
        <select id="eleSel">
          <option value="biconvex">双凸镜片</option>
          <option value="planoconvex">平凸镜片</option>
          <option value="planoconcave">平凹镜片</option>
          <option value="meniscus">弯月镜片</option>
        </select>
      </label>
      <button data-act="insertElement">插入镜片元件</button>
      <button data-act="insert">插入面</button>
      <button data-act="delete">删除面</button>
      <span class="sep"></span>
      <button data-act="undo">撤销</button>
      <button data-act="redo">重做</button>`;
    this.eleSel = t.querySelector('#eleSel');
    t.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      this[b.dataset.act]?.();
      // 结构性操作后重绘表格 + 刷新 3D
      this.render(this.sys, this.selected);
      this.onChange?.();
    });
    this.el.appendChild(t);
    this.toolbar = t;
  }

  setupTable() {
    const wrap = document.createElement('div');
    wrap.className = 'ldm-wrap';
    wrap.innerHTML = `
      <table class="ldm">
        <thead><tr></tr></thead>
        <tbody></tbody>
      </table>`;
    this.el.appendChild(wrap);
    this.tbody = wrap.querySelector('tbody');
    this.thead = wrap.querySelector('thead tr');
    this.table = wrap.querySelector('table');
  }

  // 非球面系数列数：至少 4 列(A4,A6,A8,A10)，按数据延伸，最多 12 列(A26)
  asphCols() {
    let m = 0;
    (this.sys?.surfaces || []).forEach(s => {
      const a = s.asph || [];
      for (let i = 0; i < a.length; i++) if (a[i]) m = Math.max(m, i + 1);
    });
    return Math.min(12, Math.max(4, m + 1));
  }

  render(sys, select) {
    this.sys = sys;
    this.selected = select ?? this.selected;
    const NA = this.asphCols();
    // 表头（含圆锥系数 k 与动态 A 系数列）
    let hd = '<th title="点击设为光阑">#</th><th>类型</th><th>Y 半径 R</th><th>厚度 THI</th>' +
      '<th>玻璃</th><th title="净口径通光半半径">净口径 CA</th><th title="机械半直径">机械半径 M</th>' +
      '<th title="圆锥系数">圆锥 k</th>';
    for (let j = 0; j < NA; j++) hd += `<th class="ac${j ? '' : ' ac0'}" title="偶次非球面系数">A${4 + 2 * j}</th>`;
    this.thead.innerHTML = hd;

    this.tbody.innerHTML = '';
    sys.surfaces.forEach((s, i) => {
      const tr = document.createElement('tr');
      if (i === this.selected) tr.classList.add('sel');
      if (s.type === SURF.STO) tr.classList.add('sto');
      if (s.type === SURF.IMAGE || s.type === SURF.OBJECT) tr.classList.add('fixed');
      if (s.type === SURF.OBJECT) tr.classList.add('objrow');
      const num = s.type === SURF.OBJECT ? '物件' : (s.type === SURF.IMAGE ? '像面' : String(i));
      let aCells = '';
      for (let j = 0; j < NA; j++) aCells += this.cellA(s, j, asphDisp(s.asph[j]));
      tr.innerHTML = `
        <td class="num">${s.type === SURF.STO ? '⨀' : '○'} ${num}${i === sys.stopIndex ? ' <b title="光阑">A</b>' : ''}</td>
        <td class="type" data-typ="${i}" title="点击设为光阑">${s.isAspheric() ? '非球面' : (TYPE_LABEL[s.type] ?? s.type)}</td>
        ${this.cell(s, 'radius', { step: 0.001 })}
        ${this.cell(s, 'thi', { step: 0.001 })}
        ${this.cell(s, 'glass')}
        ${this.cell(s, 'semi', { step: 0.001 })}
        ${this.cell(s, 'mSemi', { step: 0.001 })}
        ${this.cell(s, 'k', { step: 0.0001 })}
        ${aCells}`;

      if (s.type === SURF.OBJECT) {
        const ti = tr.querySelector('input[data-key="thi"]');
        if (ti) ti.value = LDM.fmtDist(s.thi);          // 物距显示 ∞ 或数值
        tr.querySelectorAll('input[data-key="semi"],input[data-key="mSemi"],input[data-key="radius"]').forEach(inp => { inp.value = '—'; });
      }

      tr.addEventListener('click', () => { this.selectRow(i); });
      const typeCell = tr.querySelector('.type');
      typeCell.addEventListener('click', e => {
        e.stopPropagation();
        this.setStop(i);
      });
      // 输入框点击/聚焦时不冒泡到行，避免重绘打断编辑
      tr.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('pointerdown', e => e.stopPropagation());
        inp.addEventListener('click', e => e.stopPropagation());
      });
      this.tbody.appendChild(tr);
    });

    // 像面/其它固定行禁编辑；物面行仅「厚度=物距」可编辑并显示 ∞
    this.tbody.querySelectorAll('tr.fixed').forEach(tr => {
      tr.style.color = '#71808f';
      tr.querySelectorAll('input').forEach(inp => {
        if (tr.classList.contains('objrow') && inp.dataset.key === 'thi') {
          inp.disabled = false; inp.style.opacity = 1;
          inp.title = '物距(Zemax 物面厚度)：∞ 或留空=物在无穷远';
          return;
        }
        inp.disabled = true; inp.style.opacity = 0.45;
      });
    });
  }

  // 物距/厚度显示：∞ 或留空=无穷远
  static fmtDist(d) { return (d == null || !isFinite(d) || d >= 1e7) ? '∞' : String(d); }

  // 非球面系数单元格
  cellA(s, j, v) {
    return `<td class="ac${j ? '' : ' ac0'}"><input type="text" value="${v}" spellcheck="false" data-key="asph" data-a="${j}" data-i="${this.idx(s)}"></td>`;
  }

  selectRow(i) {
    this.selected = i;
    const rows = this.tbody.querySelectorAll('tr');
    rows.forEach((tr, k) => {
      if (k === i) tr.classList.add('sel'); else tr.classList.remove('sel');
    });
    if (this.onSelect) this.onSelect(i);
  }

  cell(s, key, opt = {}) {
    const v = s[key];
    const isDim = (key === 'semi' || key === 'mSemi');
    const disp = (v == null || (isDim && v === null)) ? '—' : formatNum(v);
    return `<td><input data-key="${key}" data-i="${this.idx(s)}" type="text" value="${disp}"
      step="${opt.step ?? 'any'}"></td>`;
  }

  idx(s) { return this.sys.surfaces.indexOf(s); }

  // 输入事件代理：改变模型 -> 压栈 -> onChange
  init(render, onChange) {
    this.tbody.addEventListener('input', e => {
      const inp = e.target.closest('input');
      if (!inp) return;
      const i = +inp.dataset.i, key = inp.dataset.key;
      const s = this.sys.surfaces[i];
      if (!s) return;
      if (s.type === SURF.IMAGE) return;
      // 物面：仅「厚度=物距」可编辑，写入 sys.objectDist
      if (s.type === SURF.OBJECT) {
        if (key === 'thi') {
          this.push();
          const raw = inp.value.trim();
          const d = parseFloat(raw);
          const dist = (raw === '' || /^∞$/i.test(raw) || !isFinite(d) || d <= 0) ? Infinity : d;
          s.thi = dist; this.sys.objectDist = dist;
          this.onChange?.();
        }
        return;
      }
      this.push();
      const raw = inp.value.trim();
      if (key === 'asph') {                     // 非球面指数项：data-a = 下标(0=A4,1=A6,…)
        const j = +inp.dataset.a;
        s.asph[j] = raw === '' ? 0 : parseNum(raw);
      }
      else if (key === 'glass') { s.glass = raw; }
      else if (key === 'semi') { s.semi = raw === '—' ? null : parseNum(raw); }
      else if (key === 'mSemi') { s.mSemi = raw === '—' ? null : parseNum(raw); }
      else { s[key] = parseNum(raw); }
      if (key === 'radius') s.type = s.radius === 0 || !isFinite(s.radius) ? SURF.FLAT : SURF.STD;
      // 刷新「球面/非球面」类型标签
      const tc = this.tbody.querySelector(`.type[data-typ="${i}"]`);
      if (tc) tc.textContent = s.isAspheric() ? '非球面' : (TYPE_LABEL[s.type] ?? s.type);
      onChange?.();
    });
  }

  push() {
    this.historyStack.push(this.sys.serialize());
    if (this.historyStack.length > 200) this.historyStack.shift();
    this.futureStack.length = 0;
  }

  undo() {
    const prev = this.historyStack.pop();
    if (prev == null) return;
    this.futureStack.push(this.sys.serialize());
    this.restore(prev);
  }
  redo() {
    const next = this.futureStack.pop();
    if (next == null) return;
    this.historyStack.push(this.sys.serialize());
    this.restore(next);
  }
  restore(json) {
    this.sys.replace?.(json) ?? (this.sys = System.deserialize(json));
    this.onChange?.();
  }

  insert() {
    const i = this.selected == null ? this.sys.surfaces.length - 1 : this.selected;
    this.push();
    this.sys.surfaces.splice(i, 0, new Surface({ type: SURF.STD, thi: 0, glass: 'AIR' }));
    if (i <= this.sys.stopIndex) this.sys.stopIndex++;
    this.selected = i;
    this.onChange?.();
  }
  insertElement() {
    const kind = this.eleSel?.value || 'biconvex';
    const [front, back] = makeElement(kind);
    const at = this._globalSelected();
    this.push();
    // 在所选面之后插入整片镜片
    const i = at == null ? this.sys.surfaces.length - 1 : at + 1;
    this.sys.surfaces.splice(i, 0, back, front);
    // 前表面设为光阑 = 新镜片首面
    this.sys.stopIndex = i;
    this.selected = i;
    this.onChange?.();
  }
  _globalSelected() {
    return this.selected == null ? null : this.selected;
  }
  delete() {
    if (this.selected == null) return;
    const i = this.selected;
    this.push();
    this.sys.surfaces.splice(i, 1);
    if (this.sys.stopIndex >= i && this.sys.stopIndex > 0) this.sys.stopIndex--;
    this.selected = Math.min(i, this.sys.surfaces.length - 1);
    this.onChange?.();
  }
  setStop(i) {
    this.push();
    // 旧光阑面恢复为镜面；新光阑面标记为光阑类型
    const prev = this.sys.surfaces[this.sys.stopIndex];
    if (prev && prev.type === SURF.STO) {
      prev.type = (prev.radius === 0 || !isFinite(prev.radius)) ? SURF.FLAT : SURF.STD;
    }
    const s = this.sys.surfaces[i];
    if (s && s.type !== SURF.IMAGE && s.type !== SURF.OBJECT) s.type = SURF.STO;
    this.sys.stopIndex = i;
    this.render(this.sys, i);
    this.onChange?.();
  }
}

// 非球面系数很小，统一按指数记法显示，省列宽又不丢精度（参考站做法）
export function asphDisp(t) {
  if (t == null || t === '') return '';
  const v = typeof t === 'number' ? t : parseFloat(t);
  if (!isFinite(v) || v === 0) return '';
  if (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e6) return String(t);
  return v.toExponential();
}

export function parseNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
export function formatNum(v, digits = 4) {
  if (v == null) return '';
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return typeof v === 'string' ? v : '';
  const s = n.toPrecision(6);
  return s.length > 12 ? n.toFixed(digits) : s;
}
