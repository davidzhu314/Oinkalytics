"""Bat research card chart -> docs/slides/7_bats.png (numbers recomputed here; see DECISIONS.md, Hour 21-22).

Left: aggression vs all other calls, Perch, balanced accuracy by how it's tested.
Right: aggression vs feeding + general calls, AUC on days it never heard: Perch vs metadata alone,
and Perch with time of day held roughly fixed (night only, bats it never heard).
"""

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import balanced_accuracy_score, roc_auc_score  # noqa: E402
from sklearn.model_selection import GroupKFold, LeaveOneGroupOut, StratifiedKFold  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import OneHotEncoder  # noqa: E402

from .bat_eval import oof  # noqa: E402
from .slide_charts import GRID, INK, INK2, MUTED, SERIES, SURFACE  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
META = "#898781"  # muted: "not the model" bars


def main():
    lab = pd.read_csv(ROOT / "data/bat_labels.csv")
    fi = pd.read_csv(ROOT / "data/raw/bats/FileInfo.csv", usecols=["FileID", "Recording channel", "Recording time"])
    lab = lab.merge(fi, on="FileID", how="left")
    lab["hour"] = pd.to_datetime(lab["Recording time"]).dt.hour
    E = np.load(ROOT / "data/emb/bats.npz")["emb_call"]
    y = lab.aggression.to_numpy()

    left = {}
    for name, split in [("Random\nsplit", StratifiedKFold(5, shuffle=True, random_state=0).split(E, y)),
                        ("Days it\nnever heard", GroupKFold(5).split(E, y, lab.day)),
                        ("Chamber groups\nit never heard", LeaveOneGroupOut().split(E, y, lab.treatment)),
                        ("Bats it\nnever heard", LeaveOneGroupOut().split(E, y, lab.bat))]:
        left[name] = 100 * balanced_accuracy_score(y, (oof(E, y, split) > 0).astype(int))

    m = lab.context.isin(["Biting", "Fighting", "Mating protest", "Threat-like", "Feeding", "General"]).to_numpy()
    l, X, yy = lab[m].reset_index(drop=True), E[m], y[m]

    def meta_auc(cols):
        Z = l[cols].astype(str).to_numpy()
        lg = np.zeros(len(yy))
        for a, b in GroupKFold(5).split(Z, yy, l.day):
            mdl = make_pipeline(OneHotEncoder(handle_unknown="ignore"),
                                LogisticRegression(max_iter=2000, class_weight="balanced")).fit(Z[a], yy[a])
            lg[b] = mdl.decision_function(Z[b])
        return roc_auc_score(yy, lg)

    night = l.hour.isin(range(0, 6)).to_numpy()
    right = {
        "Perch\n(days never heard)": (roc_auc_score(yy, oof(X, yy, GroupKFold(5).split(X, yy, l.day))), SERIES),
        "Time of day\nonly": (meta_auc(["hour"]), META),
        "Mic channel\nonly": (meta_auc(["Recording channel"]), META),
        "Perch, night only\n(bats never heard)": (roc_auc_score(yy[night], oof(X[night], yy[night], LeaveOneGroupOut().split(
            X[night], yy[night], l.bat.to_numpy()[night]))), SERIES),
    }
    print({k.replace("\n", " "): round(v, 1) for k, v in left.items()},
          {k.replace("\n", " "): round(v[0], 3) for k, v in right.items()})

    fig, (a1, a2) = plt.subplots(1, 2, figsize=(14, 5.8), gridspec_kw={"width_ratios": [1, 1]})
    names, vals = list(left), list(left.values())
    bars = a1.bar(names, vals, width=0.58, color=SERIES, edgecolor=SURFACE, linewidth=2)
    for b, v in zip(bars, vals):
        a1.text(b.get_x() + b.get_width() / 2, v + 1.2, f"{v:.0f}%", ha="center", fontsize=20, fontweight="bold", color=INK)
    a1.axhline(50, color=MUTED, linewidth=1.3, linestyle=(0, (4, 3)))
    a1.set_ylim(0, 100); a1.set_yticks([0, 25, 50, 75, 100]); a1.set_yticklabels(["0", "25", "50", "75", "100%"])
    a1.set_title("Is this call aggression? (vs all other calls)", loc="left", fontsize=15, pad=10)
    a1.set_ylabel("Balanced accuracy (guessing = 50%)")

    names, vals, cols = list(right), [v[0] for v in right.values()], [v[1] for v in right.values()]
    bars = a2.bar(names, vals, width=0.58, color=cols, edgecolor=SURFACE, linewidth=2)
    for b, v in zip(bars, vals):
        a2.text(b.get_x() + b.get_width() / 2, v + 0.012, f"{v:.2f}", ha="center", fontsize=20, fontweight="bold", color=INK)
    a2.axhline(0.5, color=MUTED, linewidth=1.3, linestyle=(0, (4, 3)))
    a2.set_ylim(0, 1); a2.set_yticks([0, 0.25, 0.5, 0.75, 1]); a2.set_yticklabels(["0", ".25", ".50", ".75", "1"])
    a2.set_title("Aggression vs feeding: the clock knows more", loc="left", fontsize=15, pad=10)
    a2.set_ylabel("AUC (guessing = 0.50)")
    for ax in (a1, a2):
        ax.yaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
        ax.tick_params(axis="x", colors=INK, labelsize=11.5, length=0)
    fig.suptitle("Fruit bats: it hears who is calling, not whether they're fighting", x=0.01, ha="left", fontsize=18, color=INK)
    fig.text(0.01, 0.01, "5,536 calls from 10 young Egyptian fruit bats in a lab colony, 28 days (Prat et al. 2017, "
             "Scientific Data; Figshare, CC0). Perch 2.0 + logistic regression.\nGrey bars use only when or where a call "
             "was recorded, no audio. Dashed line = guessing.", fontsize=9.5, color=MUTED)
    fig.tight_layout(rect=(0, 0.07, 1, 0.94))
    out = ROOT / "docs/slides/7_bats.png"
    fig.savefig(out, dpi=200); plt.close(fig)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
