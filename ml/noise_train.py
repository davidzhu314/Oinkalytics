"""Noise-augmented training + recalibration, tested on noise recordings it never saw.

The 86 Bowen poultry-farm noise recordings are split in half by recording. Every training call (demo
hold-out sessions excluded, as always) gets one noisy copy using only the TRAIN half, at a random level
in LEVELS. The valence classifier is refitted on clean + noisy calls; temperature and the "distressed"
threshold are refitted on leave-session-out out-of-fold logits of both. The pig detector, distance check
and neighbour index are unchanged.

Then the old and new models are compared on (a) leave-session-out clean data, the 67.5% headline, and
(b) the 226 demo hold-out calls mixed with the TEST half of the noise.

python -m ml.noise_train  ->  models/oink_noise.joblib, data/noise_compare.csv (does not touch oink.joblib)
"""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import soundfile as sf
from sklearn.metrics import balanced_accuracy_score
from sklearn.model_selection import GroupKFold

from .embed import embed_waveforms, load_audio
from .noise_test import CALLS, LEVELS, NOISE_DIR, SEED, mix, noise_segment, score, show
from .perch_eval import load
from .train_final import CALM_BELOW, DEMO_SESSIONS, MAX_FALSE_ALARM, fit_temperature, sigmoid, valence_model
from .verdict import verdict

ROOT = Path(__file__).resolve().parents[1]
NOISY_CACHE = ROOT / "data/emb/soundwel_noisy_train.npz"
OUT = ROOT / "models/oink_noise.joblib"
TRAIN_LEVELS = [20, 10, 5, 0, -5]


def split_noise():
    files = sorted(NOISE_DIR.glob("*.wav"))
    order = np.random.default_rng(SEED).permutation(len(files))
    half = len(files) // 2
    return [files[i] for i in order[:half]], [files[i] for i in order[half:]]


def noisy_training_embeddings(paths, train_noise):
    if NOISY_CACHE.exists():
        z = np.load(NOISY_CACHE)
        if len(z["emb_call"]) == len(paths):
            print(f"using cached {NOISY_CACHE.name}")
            return z["emb_call"], z["snr"]
    rng = np.random.default_rng(SEED + 7)
    durations = [sf.info(f).duration for f in train_noise]
    out, snrs = [], []
    for s in range(0, len(paths), 512):
        waves = []
        for p in paths[s:s + 512]:
            y = load_audio(ROOT / p)
            snr = int(rng.choice(TRAIN_LEVELS))
            waves.append(mix(y, noise_segment(rng, train_noise, durations, len(y)), snr))
            snrs.append(snr)
        out.append(embed_waveforms(waves)["emb_call"])
        print(f"  noisy training copies: {min(s + 512, len(paths))}/{len(paths)}", flush=True)
    E, snrs = np.concatenate(out), np.array(snrs)
    np.savez_compressed(NOISY_CACHE, emb_call=E, snr=snrs)
    return E, snrs


def oof_logits(X, y, g):
    out = np.zeros(len(y))
    for a, b in GroupKFold(5).split(X, y, g):
        out[b] = valence_model().fit(X[a], y[a]).decision_function(X[b])
    return out


def band_metrics(p, y, alarm_at, calm_below=CALM_BELOW):
    st = np.where(p >= alarm_at, 1, np.where(p < calm_below, 0, -1))
    d = st >= 0
    return {"bal_acc_all": balanced_accuracy_score(y, (p >= 0.5).astype(int)),
            "decided": d.mean(), "bal_acc_decided": balanced_accuracy_score(y[d], st[d]),
            "calm_flagged": (st[y == 0] == 1).mean(), "distressed_caught": (st[y == 1] == 1).mean()}


def main():
    M = joblib.load(ROOT / "models/oink.joblib")
    t, z = load()
    tr = ~np.isin(t.session.to_numpy(), DEMO_SESSIONS)
    E, y, g = z["emb_call"][tr], t.valence.to_numpy()[tr], t.session.to_numpy()[tr]
    paths = pd.read_csv(ROOT / "data/manifest_soundwel.csv").set_index("id").loc[t.file[tr], "path"].to_numpy()
    train_noise, test_noise = split_noise()
    print(f"{len(y)} training calls; noise split {len(train_noise)} train / {len(test_noise)} test recordings")

    En, snr_n = noisy_training_embeddings(paths, train_noise)

    # Leave-session-out comparison inside the training sessions (a session's clean + noisy copies share a fold).
    old_lg = oof_logits(E, y, g)                      # old recipe: clean only
    old_p_clean = sigmoid(old_lg / M["temperature"])
    old_noisy_lg = np.zeros(len(y))                   # old recipe scored on noisy copies of held-out sessions
    for a, b in GroupKFold(5).split(E, y, g):
        old_noisy_lg[b] = valence_model().fit(E[a], y[a]).decision_function(En[b])
    old_p_noisy = sigmoid(old_noisy_lg / M["temperature"])

    X2, y2, g2 = np.vstack([E, En]), np.concatenate([y, y]), np.concatenate([g, g])
    new_lg = oof_logits(X2, y2, g2)
    T = fit_temperature(new_lg, y2)
    p2 = sigmoid(new_lg / T)
    alarm_at = max(0.5, float(np.quantile(p2[y2 == 0], 1 - MAX_FALSE_ALARM)))
    n = len(y)
    print(f"new temperature {T:.2f} (old {M['temperature']:.2f}); distressed if p >= {alarm_at:.2f} (old {M['alarm_at']:.2f})")
    for name, pc, pn, a in [("old", old_p_clean, old_p_noisy, M["alarm_at"]), ("new", p2[:n], p2[n:], alarm_at)]:
        mc, mn = band_metrics(pc, y, a), band_metrics(pn, y, a)
        print(f"  {name} leave-session-out CLEAN: all-calls {mc['bal_acc_all']:.3f} | decides {mc['decided']:.0%} at "
              f"{mc['bal_acc_decided']:.3f} | calm flagged {mc['calm_flagged']:.0%}")
        print(f"  {name} leave-session-out NOISY: all-calls {mn['bal_acc_all']:.3f} | decides {mn['decided']:.0%} at "
              f"{mn['bal_acc_decided']:.3f} | calm flagged {mn['calm_flagged']:.0%}")

    M2 = {**M, "valence": valence_model().fit(X2, y2), "temperature": T, "alarm_at": alarm_at,
          "noise_training": {"levels": TRAIN_LEVELS, "train_noise": [f.name for f in train_noise]}}
    joblib.dump(M2, OUT)
    print(f"saved {OUT}")

    # Demo hold-out calls + the TEST half of the noise, old vs new.
    demo = pd.read_csv(ROOT / "data/demo_clips.csv")
    truth = demo.truth.to_numpy()
    calls = [load_audio(CALLS / f) for f in demo.file]
    rng = np.random.default_rng(SEED)
    durations = [sf.info(f).duration for f in test_noise]
    noises = [noise_segment(rng, test_noise, durations, len(c)) for c in calls]
    rows = []
    for snr in LEVELS:
        mixed = [c if snr is None else mix(c, nz, snr) for c, nz in zip(calls, noises)]
        emb = embed_waveforms(mixed)["emb_call"]
        for name, model in [("old", M), ("new", M2)]:
            row = {"model": name, **score(snr, truth, verdict(emb, model), np.random.default_rng(SEED + 1))}
            rows.append(row)
            show(row, f"{name} ")
    pd.DataFrame(rows).to_csv(ROOT / "data/noise_compare.csv", index=False)
    print(f"saved {ROOT / 'data/noise_compare.csv'}")
    plot(pd.DataFrame(rows))




def plot(df: pd.DataFrame):
    """Old vs new on the demo hold-out + unseen noise -> docs/slides/6_noise.png."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from .slide_charts import GRID, INK, INK2, MUTED, SURFACE

    NEW, OLD = "#2a78d6", "#eb6834"  # validated palette slots 1-2
    levels = list(df[df.model == "new"].level)
    x = np.arange(len(levels))
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.6), sharex=True)
    panels = [("bal_acc_answered", "Accuracy on the calls it answers"),
              ("calm_flagged_distressed", "Calm pigs wrongly flagged as distressed")]
    for ax, (col, title) in zip(axes, panels):
        for name, color, marker, label in [("old", OLD, "s", "Before"), ("new", NEW, "o", "Trained with farm noise")]:
            d = df[df.model == name]
            y = 100 * d[col].to_numpy()
            if col == "bal_acc_answered" and name == "new":
                ax.fill_between(x, 100 * d.ci_lo, 100 * d.ci_hi, color=NEW, alpha=0.12, linewidth=0)
            ax.plot(x, y, color=color, linewidth=2.5, marker=marker, markersize=9, markeredgecolor=SURFACE,
                    markeredgewidth=2, label=label)
            ax.text(x[-1] + 0.15, y[-1], f"{y[-1]:.0f}%", color=INK, fontsize=13, fontweight="bold", va="center")
        ax.set_title(title, loc="left", fontsize=15, color=INK, pad=10)
        ax.set_xticks(x, ["No noise" if l == "clean" else l for l in levels])
        ax.set_xlim(-0.3, len(x) - 0.3)
        ax.yaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
        ax.set_xlabel("Farm noise added (0 dB = as loud as the call)", fontsize=12)
    axes[0].set_ylim(40, 100); axes[0].axhline(50, color=MUTED, linewidth=1.2, linestyle=(0, (4, 3)))
    axes[0].set_yticks([40, 50, 60, 70, 80, 90, 100]); axes[0].set_yticklabels(["40", "50", "60", "70", "80", "90", "100%"])
    axes[1].set_ylim(0, 40); axes[1].set_yticks([0, 10, 20, 30, 40]); axes[1].set_yticklabels(["0", "10", "20", "30", "40%"])
    axes[0].legend(loc="upper right", frameon=False, fontsize=12)
    fig.suptitle("Trained with farm noise, it stops crying wolf when the barn gets loud", x=0.01, ha="left",
                 fontsize=18, color=INK)
    fig.text(0.01, 0.01, "226 held-out pig calls mixed with farm-noise recordings neither model trained on "
             "(Bowen University poultry-farm noise, Mendeley doi:10.17632/zp4nf2dxbh.1, CC BY 4.0).\n"
             "Balanced accuracy; band = 95% bootstrap interval; dashed line = 50%. Added noise only, not barn echo "
             "or distance.", fontsize=9.5, color=MUTED)
    fig.tight_layout(rect=(0, 0.07, 1, 0.95))
    out = ROOT / "docs/slides/6_noise.png"
    fig.savefig(out, dpi=200); plt.close(fig)
    print(f"saved {out}")


if __name__ == "__main__":
    import sys
    if "--plot" in sys.argv:
        plot(pd.read_csv(ROOT / "data/noise_compare.csv"))
    else:
        main()
