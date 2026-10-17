"""Slide charts, all from one consistent run of the shipped model (Perch emb_call + LR C=0.001).

The shipped model is noise-augmented (ml/noise_train.py): in every fold the classifier trains on the
training calls plus their noisy copies (data/emb/soundwel_noisy_train.npz) and is scored on clean calls only.
Temperature and thresholds are the shipped ones from models/oink.joblib.

python -m ml.slide_charts  ->  docs/slides/*.png and docs/slides/numbers.csv
"""

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.metrics import balanced_accuracy_score  # noqa: E402
from sklearn.model_selection import GroupKFold, LeaveOneGroupOut, StratifiedKFold  # noqa: E402

from .perch_eval import load  # noqa: E402
from .train_final import DEMO_SESSIONS, sigmoid, valence_model  # noqa: E402
import joblib  # noqa: E402

NOISY_CACHE = Path(__file__).resolve().parents[1] / "data/emb/soundwel_noisy_train.npz"

OUT = Path(__file__).resolve().parents[1] / "docs/slides"
SURFACE, INK, INK2, MUTED, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
SERIES = "#2a78d6"
plt.rcParams.update({
    "font.family": ["Helvetica Neue", "Arial", "sans-serif"], "font.size": 15,
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "xtick.color": MUTED, "ytick.color": MUTED,
    "text.color": INK, "axes.spines.top": False, "axes.spines.right": False,
})


def oof_logits(X, y, folds, noisy=None):
    """Out-of-fold logits on clean calls; training folds also get their noisy copies when available."""
    out = np.zeros(len(y))
    for a, b in folds:
        Xa, ya = X[a], y[a]
        if noisy is not None:
            aa = a[~np.isnan(noisy[a, 0])]
            Xa, ya = np.vstack([Xa, noisy[aa]]), np.concatenate([ya, y[aa]])
        out[b] = valence_model().fit(Xa, ya).decision_function(X[b])
    return out


def noisy_copies(t):
    """Noisy embedding for each call (NaN for demo hold-out calls, which never get one)."""
    noisy = np.full((len(t), 1536), np.nan, dtype=np.float32)
    noisy[~np.isin(t.session.to_numpy(), DEMO_SESSIONS)] = np.load(NOISY_CACHE)["emb_call"]
    return noisy


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    t, z = load()
    X, y = z["emb_call"], t.valence.to_numpy()
    split_defs = {
        "Random split\n(the usual way)": StratifiedKFold(5, shuffle=True, random_state=0).split(X, y),
        "Recordings it\nnever heard": GroupKFold(5).split(X, y, t.session),
        "Labs it\nnever heard": LeaveOneGroupOut().split(X, y, t.team),
    }
    noisy = noisy_copies(t)
    logits = {k: oof_logits(X, y, f, noisy) for k, f in split_defs.items()}
    bal = {k: balanced_accuracy_score(y, (v > 0).astype(int)) for k, v in logits.items()}
    print({k.replace("\n", " "): round(v, 3) for k, v in bal.items()})

    # 1. The gap
    fig, ax = plt.subplots(figsize=(10, 5.6))
    names, vals = list(bal), [100 * v for v in bal.values()]
    bars = ax.bar(names, vals, width=0.55, color=SERIES, edgecolor=SURFACE, linewidth=2)
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + 1.2, f"{v:.0f}%", ha="center", va="bottom",
                fontsize=26, fontweight="bold", color=INK)
    ax.axhline(50, color=MUTED, linewidth=1.5, linestyle=(0, (4, 3)))
    ax.text(2.42, 51, "coin flip", color=MUTED, fontsize=13, ha="right", va="bottom")
    ax.set_ylim(0, 105); ax.set_yticks([0, 25, 50, 75, 100]); ax.set_yticklabels(["0", "25", "50", "75", "100%"])
    ax.yaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    ax.tick_params(axis="x", colors=INK, labelsize=15, length=0)
    ax.set_title("Same model, same pig calls: how you test changes the answer",
                 loc="left", fontsize=18, color=INK, pad=16)
    ax.set_ylabel("Balanced accuracy, calm vs distressed")
    fig.text(0.01, 0.01, "SoundWel, 6,887 calls. Perch 2.0 embeddings + logistic regression. "
             "Balanced accuracy: guessing scores 50%.", fontsize=11, color=MUTED)
    fig.tight_layout(rect=(0, 0.03, 1, 1)); fig.savefig(OUT / "1_gap.png", dpi=200); plt.close(fig)

    # 2. Calibration (honest split; temperature fitted on the same out-of-fold logits, as shipped)
    lg = logits["Recordings it\nnever heard"]
    T = joblib.load(OUT.parents[1] / "models/oink.joblib")["temperature"]  # shipped temperature
    p = sigmoid(lg / T)
    conf, pred = np.maximum(p, 1 - p), (p >= 0.5).astype(int)
    edges = np.linspace(0.5, 1.0, 6)
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf >= lo) & (conf <= hi if hi == 1 else conf < hi)
        if m.sum() >= 30:
            rows.append((conf[m].mean(), (pred[m] == y[m]).mean(), m.sum()))
    rc = np.array(rows)
    ece = sum(n / len(y) * abs(a - c) for c, a, n in rows)
    fig, ax = plt.subplots(figsize=(7.5, 6.4))
    ax.plot([50, 100], [50, 100], color=MUTED, linewidth=1.5, linestyle=(0, (4, 3)))
    ax.text(80, 77.5, "perfectly honest", color=MUTED, fontsize=12, rotation=45, ha="center", va="top")
    ax.plot(100 * rc[:, 0], 100 * rc[:, 1], color=SERIES, linewidth=2.5, marker="o", markersize=10,
            markeredgecolor=SURFACE, markeredgewidth=2)
    for c, a, n in rc:
        ax.annotate(f"{int(n):,} calls", (100 * c, 100 * a), textcoords="offset points", xytext=(10, -16),
                    fontsize=11, color=INK2)
    ax.set_xlim(50, 100); ax.set_ylim(50, 100)
    ax.set_xlabel("How confident the model said it was (%)"); ax.set_ylabel("How often it was actually right (%)")
    ax.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    ax.set_title("When it says 80% sure, it's right about 80% of the time", loc="left", fontsize=16, pad=14)
    fig.text(0.01, 0.01, f"Recordings it never heard. Calibration error {ece:.3f} (0 = perfect).",
             fontsize=11, color=MUTED)
    fig.tight_layout(rect=(0, 0.03, 1, 1)); fig.savefig(OUT / "2_calibration.png", dpi=200); plt.close(fig)

    # 3. The shipped verdict band: calm / unsure / distressed, vs answering every call
    M = joblib.load(OUT.parents[1] / "models/oink.joblib")
    status = np.where(p >= M["alarm_at"], 1, np.where(p < M["calm_below"], 0, -1))
    dec = status >= 0
    band_acc, band_cov = 100 * balanced_accuracy_score(y[dec], status[dec]), 100 * dec.mean()
    false_alarm = 100 * (status[y == 0] == 1).mean()
    every = 100 * balanced_accuracy_score(y, pred)
    fig, ax = plt.subplots(figsize=(9, 5.6))
    names = ["Answers every call", f"Says \"not sure\" on {100 - band_cov:.0f}%\n(what we ship)"]
    bars = ax.bar(names, [every, band_acc], width=0.5, color=SERIES, edgecolor=SURFACE, linewidth=2)
    for b, v in zip(bars, [every, band_acc]):
        ax.text(b.get_x() + b.get_width() / 2, v + 1.2, f"{v:.0f}%", ha="center", va="bottom",
                fontsize=26, fontweight="bold", color=INK)
    ax.axhline(50, color=MUTED, linewidth=1.5, linestyle=(0, (4, 3)))
    ax.text(1.42, 51, "coin flip", color=MUTED, fontsize=13, ha="right", va="bottom")
    ax.set_ylim(0, 105); ax.set_yticks([0, 25, 50, 75, 100]); ax.set_yticklabels(["0", "25", "50", "75", "100%"])
    ax.yaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    ax.tick_params(axis="x", colors=INK, labelsize=15, length=0)
    ax.set_ylabel("Balanced accuracy on the calls it answers")
    ax.set_title("Knowing when to say \"I'm not sure\"", loc="left", fontsize=18, pad=16)
    fig.text(0.01, 0.01, f"Recordings it never heard. Calm calls wrongly flagged as distressed: {false_alarm:.0f}%.",
             fontsize=11, color=MUTED)
    fig.tight_layout(rect=(0, 0.03, 1, 1)); fig.savefig(OUT / "3_confidence.png", dpi=200); plt.close(fig)

    nums = [{"chart": "gap", "metric": k.replace("\n", " "), "value": round(v, 3)} for k, v in bal.items()]
    nums.append({"chart": "calibration", "metric": "ECE (honest split)", "value": round(ece, 3)})
    nums += [{"chart": "verdict band", "metric": "answers every call: balanced acc %", "value": round(every, 1)},
             {"chart": "verdict band", "metric": "shipped band: share decided %", "value": round(band_cov, 1)},
             {"chart": "verdict band", "metric": "shipped band: balanced acc on decided %", "value": round(band_acc, 1)},
             {"chart": "verdict band", "metric": "calm calls flagged distressed %", "value": round(false_alarm, 1)}]
    pd.DataFrame(nums).to_csv(OUT / "numbers.csv", index=False)
    print(pd.DataFrame(nums).to_string(index=False))


if __name__ == "__main__":
    main()
