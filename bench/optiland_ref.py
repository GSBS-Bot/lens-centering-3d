"""bench/optiland_ref.py — 用 Optiland 生成与 snapshot.mjs 同结构的参考数据（P1 对拍）

用法:
    python bench/optiland_ref.py

输出: bench/golden_optiland/<lens>.json
"""
import json
import os

import numpy as np

from optiland.fileio import load_zemax_file
from optiland.analysis import SpotDiagram, FieldCurvature, Distortion
from optiland.mtf import FFTMTF

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "bench", "golden_optiland")
os.makedirs(OUT, exist_ok=True)

NU = 30.0  # lp/mm

LENSES = [
    ("doubleGauss", os.path.join(ROOT, "测试zemax文件", "Advanced_SC_doubleGauss_final.zmx")),
    ("cooke40", os.path.join(ROOT, "测试zemax文件", "Cooke 40 degree field.zmx")),
    ("songraw85", r"C:\Users\lylens\Desktop\songraw-af-85mm-f1-2.zmx"),
]


def spot_rms(optic, fields_deg, primary):
    """逐视场点列 RMS（mm）：用 SpotDiagram 的落点，围绕质心。"""
    idx = 0
    for i, w in enumerate(optic.wavelengths):
        if abs(float(w.value) - primary) < 1e-9:
            idx = i
            break
    sd = SpotDiagram(optic)          # 默认全部视场/波长，按索引取
    out = []
    for fi in range(min(len(fields_deg), len(sd.data))):
        pts = sd.data[fi][idx]
        x = np.asarray(pts.x, dtype=float)
        y = np.asarray(pts.y, dtype=float)
        if x.size < 2:
            out.append(None)
            continue
        x = x - x.mean()
        y = y - y.mean()
        out.append(float(np.sqrt(np.mean(x * x + y * y))))
    return out


def interp(arr, n, target, fmax):
    xs = np.linspace(0.0, fmax, n)
    return float(np.interp(target, xs, np.asarray(arr, dtype=float)))


try:
    for name, path in LENSES:
        if not os.path.exists(path):
            print("[skip]", name, "(文件不存在)")
            continue
        try:
            optic = load_zemax_file(path)
        except Exception as e:  # noqa: BLE001
            print("[err ]", name, repr(e))
            continue

        fvals = [float(f.y) for f in optic.fields]
        fmax = max(fvals) if fvals else 0.0
        wls = [float(w.value) for w in optic.wavelengths]
        try:
            primary = wls[int(optic.wavelengths.primary_index)]
        except Exception:  # noqa: BLE001
            primary = wls[0] if wls else 0.5875618

        # 一阶量
        try:
            efl = float(optic.paraxial.f2())
        except Exception:  # noqa: BLE001
            efl = None
        try:
            fno = float(optic.paraxial.FNO())
        except Exception:  # noqa: BLE001
            try:
                fno = float(optic.paraxial.fno())
            except Exception:  # noqa: BLE001
                fno = None

        rms = spot_rms(optic, fvals, primary)

        # 场曲 / 畸变（逐波长 128 点，取主波长那条，再按设计视场插值）
        fc = FieldCurvature(optic)
        dist = Distortion(optic)
        # 找到主波长索引
        wi = 0
        try:
            for i, w in enumerate(optic.wavelengths):
                if abs(float(w.value) - primary) < 1e-9:
                    wi = i
                    break
        except Exception:  # noqa: BLE001
            wi = 0

        fc_t = fc.data[wi][0]   # tangential
        fc_s = fc.data[wi][1]   # sagittal
        dd = dist.data[wi]
        npts = len(fc_t)

        # MTF@NU（主波长；FFTMTF 只算主波长）
        mtf = FFTMTF(optic)
        rows = []
        for fi, fv in enumerate(fvals):
            t = interp(fc_t, npts, fv, fmax)
            s = interp(fc_s, npts, fv, fmax)
            d = interp(dd, len(dd), fv, fmax)
            # MTF: mtf.mtf[fi] = [T, S]; 各自有自己的 freq 轴
            tmtf = smtf = None
            try:
                T = np.asarray(mtf.mtf[fi][0], dtype=float)
                S = np.asarray(mtf.mtf[fi][1], dtype=float)
                ft = np.asarray(mtf.freq_tang[fi], dtype=float)
                fs = np.asarray(mtf.freq_sag[fi], dtype=float)
                tmtf = float(np.interp(NU, ft, T)) if ft[-1] >= NU else None
                smtf = float(np.interp(NU, fs, S)) if fs[-1] >= NU else None
            except Exception:  # noqa: BLE001
                pass
            rows.append({
                "field": fv,
                "spotRms_um": (rms[fi] * 1000.0) if (fi < len(rms) and rms[fi] is not None) else None,
                "distortion_pct": d,
                "tFocus_mm": t,     # 注意：Optiland 给的是焦面位置(mm)，非相对像面的焦移
                "sFocus_mm": s,
                "mtfT_30": tmtf,
                "mtfS_30": smtf,
            })

        out = {
            "lens": name,
            "file": os.path.relpath(path, ROOT) if path.startswith(ROOT) else path,
            "source": "optiland",
            "version": "0.6.3",
            "primary_nm": primary * 1000.0,
            "nu_eval": NU,
            "efl": efl,
            "fno": fno,
            "fields": rows,
        }
        with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print("[ok  ]", name, "EFL=", None if efl is None else round(efl, 3), "F#=", None if fno is None else round(fno, 2))
except Exception as e:  # noqa: BLE001
    import traceback
    traceback.print_exc()

print("golden_optiland ->", OUT)
