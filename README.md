# 光学镜头 3D 可视化 · Lens-3D

浏览器端的光学镜头设计与仿真可视化工具。**纯前端、零后端、无需构建**——所有计算（实光线追迹、像差、MTF）都在浏览器内完成，不上传任何数据。

- 在线使用（启动台）：**https://gsbs-bot.github.io/lens-centering-3d/**
- 3D 工程（主应用）：**https://gsbs-bot.github.io/lens-centering-3d/lens-3d/**

---

## 功能

| 模块 | 内容 |
|---|---|
| **数据管理器 LDM** | 面表直接编辑（球面 / 圆锥 / 偶次非球面）、插入删除、设光阑、撤销重做；导入 `.zmx` / `.seq`；一键导出 `.zmx` |
| **实光线追迹** | 3D 旋转对称追迹 + 斯涅尔矢量折射；一阶量 EFL / BFL / F#；入瞳与光阑瞄准；逐面渐晕 / 自动渐晕 |
| **2D 光路剖面** | 镜片轮廓 + 光轴 + 光阑/像面标注，可平移缩放，主光线像高核对 |
| **3D 可视化** | 镜片实体 + 玻璃材质 + 3D 光线；视图切换：等轴测 / X-Y / Y-Z / X-Z / 2D |
| **点列图** | Zemax 样式、按波长分色、艾里斑参考、RMS / GEO 半径 |
| **相对照度** | 一维曲线 + cos⁴θ 参考 + 设计视场标记 |
| **MTF** | 几何 / 波前（衍射 FFT）两种算法；子午 T / 弧矢 S；复色加权；**离焦曲线**（through-focus，支持 µm/mm） |
| **像差** | **光扇图（Ray Fan）**、**场曲 / 像散**、**畸变**；Zemax 口径、按波长分色、视场竖轴 |
| **玻璃库** | 2026 玻璃目录（Sellmeier，1200+ 种）+ **塑料库 PLASTIC+**（41 种，按其 Schott 公式）；支持 Laurent / Cauchy 回退 |
| **界面** | 5 套主题（含日间浅色）、移动端适配、信息窗/坐标窗可显隐、启动台（版本记录 / 访问计数 / 留言板） |

### 已迁移的镜头（下拉按品牌分组）
共 21 颗定焦：索尼 FE 14/20/24/50(F1.2、F1.4 GM、F1.4 ZA)/55/85(F1.4、F1.4 II)/135mm；适马 20/35/35 Art II/40/50/70 Macro/85(F1.4、F1.2 DN)/105/135mm；SONGRAW AF 85mm F1.2。另含双高斯、Cooke 40° 等本地示例。

---

## 本地运行

ES modules 需通过 HTTP 访问（直接双击 `index.html` 会因跨域无法加载模块）。任选其一：

```bash
# Windows：双击 serve.bat，或
python -m http.server 8000
# 然后打开 http://localhost:8000
```

也可直接使用在线版（GitHub Pages），无需本地环境。

---

## 技术栈

- **纯前端**：原生 ES Modules，无打包/无依赖注入；Three.js 以 vendor 形式内置。
- **渲染**：3D 用 Three.js，2D/图表用内联 SVG。
- **计算**：自研实光线追迹内核 + FFT（MTF/PSF/OTF）。
- **部署**：GitHub Pages 静态托管。

---

## 目录结构

```
index.html                    启动台（导航 / 版本记录 / 留言板）
lens-3d/                      主应用
  index.html
  css/style.css
  js/
    main.js                   入口与 UI 接线
    model.js                  光学系统数据模型
    ldm.js                    数据管理器（面表）
    trace.js                  实光线追迹 / 一阶量 / 视场 / 渐晕 / 点列 / 照度 / 像差
    mtf.js                    FFT / OTF / MTF / 离焦
    geom.js                   3D 几何与 2D 布局 SVG
    import.js                 .zmx / .seq 解析、友站 JSON、导出 .zmx
    glassdb.js                玻璃库（2026 目录）
    glassdb-plastic.js        塑料玻璃库（PLASTIC+，Schott）
  version.txt                 版本自检用
lenses/                       迁移的友站镜头 JSON
测试zemax文件/                 本地示例 .zmx
镜头调芯3D可视化网站开发计划.txt  开发计划与决策台账
```

> `reference/`（友站镜像）仅用于本地对照，已被 `.gitignore` 排除，不随仓库发布。

---

## 版本与缓存约定（维护必读）

1. 改任何 JS 都要升 `?v=` 并**级联**：`glassdb → import/trace → main.js → index.html`。
2. 同步更新两处，否则旧缓存无法自动刷新：
   - `lens-3d/version.txt`（内容 = 版本号）
   - `lens-3d/index.html` 里的 `var APP = 'x.y.z'`
3. 页面加载会拉 `version.txt`（禁缓存），与 `APP` 不同则带 `?appv=` 强制重载 HTML。
4. 发布后仍见旧版 → 硬刷新一次（`Ctrl+Shift+R` / `Ctrl+F5`）。
5. GitHub Pages 偶发 deploy 失败 → 推空提交重新触发即可。

---

## 路线图

- [x] M1 数据管理器 / 2D / 3D 同步
- [x] M2a 点列图 / 相对照度
- [x] M2b 像差三图（Ray Fan / 场曲像散 / 畸变）+ MTF（含离焦、复色）
- [ ] 子午场曲 T 与 Zemax 完全对齐、纵向球差单列、最佳对焦读数
- [ ] M4 公差分析（蒙特卡洛 / 灵敏度；先旋转对称，后偏心/倾斜）
- [ ] 6-DOF 偏心 / 倾斜（真实参与追迹）
- [ ] 桌面安装包（Electron）

详见 [`镜头调芯3D可视化网站开发计划.txt`](镜头调芯3D可视化网站开发计划.txt)。

---

## 说明与致谢

- 本项目以 [lens-bench](https://anvcor.github.io/lens-bench) 作为**规格参考与数值验收基准**；其仓库无开源许可证，本项目**代码全部重写、不复制其源码**（算法与公式属公开理论）。
- 玻璃数据来自公开厂商目录（Zemax `.AGF`）。若涉及版权，请联系删除。
- 光学计算的正确性依赖与 Zemax / 参考站的逐点比对；欢迎通过 [Issues](https://github.com/GSBS-Bot/lens-centering-3d/issues) 或留言板反馈。

**交流与反馈**：https://github.com/GSBS-Bot/lens-centering-3d/issues
