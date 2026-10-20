# bench/ —— 黄金镜头基准与 Optiland 对拍（P0 / P1）

## 用途
给核心数值建立**可回归的基准快照**，并用 Optiland 做独立的数值对拍。

## 文件
| 文件 | 说明 |
|---|---|
| `prep.mjs` | 把 `lens-3d/js/*` 复制到 `bench/.tmp/`（去掉 `?v=`，供 Node import） |
| `snapshot.mjs` | 对黄金镜头集生成 JS 引擎基准快照 → `golden/*.json` |
| `golden/` | 生成的快照（EFL/F#、逐视场点列 RMS、畸变、T/S 场曲、MTF@30lp/mm） |
| `.tmp/` | 运行时临时目录（已 gitignore） |

## 运行
```bash
node bench/prep.mjs
node bench/snapshot.mjs
```

## 黄金镜头集
- 双高斯 `测试zemax文件/Advanced_SC_doubleGauss_final.zmx`
- Cooke 40° `测试zemax文件/Cooke 40 degree field.zmx`
- SONGRAW 85/1.2 `lenses/songraw-af-85mm-f1-2.json`
- SONY FE 50/1.2 GM `lenses/sony-fe-50mm-f1-2-gm.json`
- （可选）工业镜头 9mm（本机桌面，外部文件）

## 当前基准（双高斯 @587.6nm）
| 量 | 本引擎 | Zemax | 结论 |
|---|---|---|---|
| 畸变 @21.6mm | −0.9902% | −0.9901% | ✓ |
| 弧矢 S 场曲 @21.6mm | +157.96µm | +156.8µm | ✓ |
| 子午 T 场曲 @21.6mm | −11.86µm | +69.7µm | ✗ 待查 |
| 点列 RMS（0/15.1/21.6mm） | 4.40 / 4.54 / 8.48 µm | — | — |
| MTF@30（T/S） | 见 golden | — | — |

## P1 进展：Optiland（v0.6.3，已安装）
已确认可用 API：
```python
from optiland.fileio import load_zemax_file          # 直接读 .zmx
from optiland.analysis import SpotDiagram, FieldCurvature, Distortion, RayFan
from optiland.mtf import FFTMTF                      # 另有 GeometricMTF / HuygensMTF

optic = load_zemax_file(path)
SpotDiagram(optic).data[field][wav].x/.y             # 落点
FieldCurvature(optic).data[wav] -> [tangential, sagittal]  # 128 点场焦面
Distortion(optic).data[wav]                           # 128 点畸变 %
FFTMTF(optic).mtf[field] -> [T, S]; .freq_tang/.freq_sag
```
注意：`Distortion()` 默认 `f-tan`、`paraxial`，其读数口径需与 Zemax/本站核对后再用于判定。

## 下一步（P1 收尾）
1. 写 `bench/optiland_ref.py`：对黄金集输出与 `snapshot.mjs` 同结构的 JSON。
2. 写 `bench/compare.mjs`：逐项 diff（点列 RMS / 畸变 / T·S 场曲 / MTF@30）。
3. 用 Optiland 的 `FieldCurvature` 反推**子午 T** 的定义，定位本站 T 的差异。
