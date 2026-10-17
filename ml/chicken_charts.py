"""Chicken slide charts, in the same style as ml/slide_charts.py.

python -m ml.chicken_charts  ->  docs/slides/4_chicken_gap.png, docs/slides/5_chicken_features.png

Numbers come from runs on David's Mac and are logged in docs/DECISIONS.md:
  pigs      docs/slides/numbers.csv (python -m ml.slide_charts)
  chickens  python -m ml.chicken_train     (random split 0.997, leave-recording-out 0.996)
            python -m ml.chicken_baseline  (7 simple features 0.939; mid-band 0.825, zcr 0.819,
                                            loudness 0.815, peak 0.740; same leave-recording-out split)
"""

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "docs/slides"
SURFACE, INK, INK2, MUTED, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
SERIES, SERIES2, SERIES_DARK = "#2a78d6", "#eb6834", "#184f95"  # categorical slots 1-2 (validated), blue 600
plt.rcParams.update({
    "font.family": ["Helvetica Neue", "Arial", "sans-serif"], "font.size": 15,
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "xtick.color": MUTED, "ytick.color": MUTED,
    "text.color": INK, "axes.spines.top": False, "axes.spines.right": False,
})

CHICKEN = {"random": 0.997, "honest": 0.996}
FEATURES = [  # (label, balanced accuracy on recordings it never heard)
    ("Perch 2.0 model", 0.996),
    ("All 7 simple features", 0.939),
    ("Mid-band energy alone", 0.825),
    ("Zero-crossing rate alone", 0.819),
    ("Loudness alone", 0.815),
    ("Peak level alone", 0.740),
]


def coin_flip(ax, x, horizontal=False):
    if horizontal:
        ax.axvline(50, color=MUTED, linewidth=1.5, linestyle=(0, (4, 3)))
        ax.text(50.6, x, "coin flip", color=MUTED, fontsize=13, ha="left", va="center")
    else:
        ax.axhline(50, color=MUTED, linewidth=1.5, linestyle=(0, (4, 3)))
        ax.text(x, 51, "coin flip", color=MUTED, fontsize=13, ha="right", va="bottom")


def gap_chart():
    nums = pd.read_csv(OUT / "numbers.csv")
    pig = nums[nums.chart == "gap"].set_index("metric").value
    groups = ["Pigs\n(calm vs distressed)", "Chickens\n(healthy vs sick)"]
    random_ = [100 * pig["Random split (the usual way)"], 100 * CHICKEN["random"]]
    honest = [100 * pig["Recordings it never heard"], 100 * CHICKEN["honest"]]

    fig, ax = plt.subplots(figsize=(10, 5.6))
    w = 0.34
    xs = range(len(groups))
    for off, vals, color, name in [(-w / 2, random_, SERIES, "Random split (the usual way)"),
                                   (w / 2, honest, SERIES2, "Recordings it never heard")]:
        bars = ax.bar([x + off for x in xs], vals, width=w - 0.02, color=color, edgecolor=SURFACE, linewidth=2, label=name)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, v + 1.2, f"{v:.1f}%", ha="center", va="bottom",
                    fontsize=20, fontweight="bold", color=INK)
    for x, (r, h) in enumerate(zip(random_, honest)):
        drop = r - h
        ax.text(x, 8, f"{drop:.1f} points lost",
                ha="center", va="bottom", fontsize=14, fontweight="bold", color=SURFACE,
                bbox=dict(boxstyle="round,pad=0.35", facecolor=INK2, edgecolor="none"))
    coin_flip(ax, 1.52)
    ax.set_xticks(list(xs)); ax.set_xticklabels(groups)
    ax.set_ylim(0, 122); ax.set_yticks([0, 25, 50, 75, 100]); ax.set_yticklabels(["0", "25", "50", "75", "100%"])
    ax.yaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    ax.tick_params(axis="x", colors=INK, labelsize=15, length=0)
    ax.legend(loc="upper left", frameon=False, fontsize=13, ncol=2, bbox_to_anchor=(0.0, 1.02))
    ax.set_title("Pigs lose 23 points on recordings they never heard. Chickens lose almost none.",
                 loc="left", fontsize=17, color=INK, pad=28)
    ax.set_ylabel("Balanced accuracy")
    fig.text(0.01, 0.01, "Same pipeline for both. A model that loses nothing on unseen recordings is usually "
             "reading something constant within each class.", fontsize=11, color=MUTED)
    fig.tight_layout(rect=(0, 0.03, 1, 1)); fig.savefig(OUT / "4_chicken_gap.png", dpi=200); plt.close(fig)


def features_chart():
    labels = [f for f, _ in FEATURES][::-1]
    vals = [100 * v for _, v in FEATURES][::-1]
    colors = [SERIES_DARK if lab.startswith("Perch") else SERIES for lab in labels]
    fig, ax = plt.subplots(figsize=(10, 5.6))
    bars = ax.barh(labels, vals, height=0.6, color=colors, edgecolor=SURFACE, linewidth=2)
    for b, v in zip(bars, vals):
        ax.text(v + 1, b.get_y() + b.get_height() / 2, f"{v:.1f}%", va="center", ha="left",
                fontsize=17, fontweight="bold", color=INK)
    ax.set_ylim(-0.6, 5.95)
    coin_flip(ax, 5.68, horizontal=True)
    ax.set_xlim(0, 112); ax.set_xticks([0, 25, 50, 75, 100]); ax.set_xticklabels(["0", "25", "50", "75", "100%"])
    ax.xaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    ax.tick_params(axis="y", colors=INK, labelsize=14, length=0)
    fig.suptitle("On chickens, simple loudness and noisiness measures almost match the model",
                 x=0.01, ha="left", fontsize=17, color=INK)
    ax.set_xlabel("Balanced accuracy, healthy vs sick, on recordings it never heard")
    fig.text(0.01, 0.01, "Mendeley poultry vocalization set (346 recordings, CC BY 4.0). No metadata, so a different "
             "microphone or room per folder can't be ruled out.", fontsize=11, color=MUTED)
    fig.tight_layout(rect=(0, 0.03, 1, 0.97)); fig.savefig(OUT / "5_chicken_features.png", dpi=200); plt.close(fig)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    gap_chart()
    features_chart()
    print(f"saved {OUT / '4_chicken_gap.png'} and {OUT / '5_chicken_features.png'}")
