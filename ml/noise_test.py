"""Farm-noise robustness: held-out pig calls + poultry-farm noise at several levels, through the full pipeline.

Noise: the 86 `noise` recordings of the Bowen University "Poultry Vocalization Signal Dataset for Early
Disease Detection" (Mendeley doi:10.17632/zp4nf2dxbh.1, CC BY 4.0), recorded on a poultry farm in Nigeria,
not a pig barn. Calls: every demo hold-out call (data/demo_clips.csv), never seen by any model.

Each call gets one random noise segment, reused at every level, scaled to an SNR relative to the call's own
RMS. Mixtures are embedded exactly as the server embeds uploads (ml.embed.embed_waveforms) and judged by the
shipped rule (ml.verdict). "Not sure" counts as a miss in the overall score.

python -m ml.noise_test  ->  data/noise_results.csv, docs/slides/6_noise.png
"""

from pathlib import Path

import joblib
import librosa
import numpy as np
import pandas as pd
import soundfile as sf

from .embed import SR, embed_waveforms, load_audio
from .verdict import verdict

ROOT = Path(__file__).resolve().parents[1]
NOISE_DIR = ROOT / "data/raw/chicken/noise"
CALLS = ROOT / "data/raw/soundwel/Soundwel Dataset - Audio and Spectrograms"
LEVELS = [None, 20, 10, 5, 0, -5]  # SNR in dB; None = clean
SEED = 0
BOOT = 1000


def rms(x):
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-12)


def noise_segment(rng, files, durations, n):
    """A random n-sample stretch of a random noise recording (looped if the recording is shorter)."""
    i = rng.integers(len(files))
    dur = n / SR
    off = float(rng.uniform(0, max(0.0, durations[i] - dur)))
    seg, _ = librosa.load(files[i], sr=SR, mono=True, offset=off, duration=dur + 0.05)
    if len(seg) == 0 or rms(seg) < 1e-6:
        return noise_segment(rng, files, durations, n)
    return np.resize(seg, n).astype(np.float32)


def balanced(truth, status, answered_only):
    """Mean per-class recall. answered_only: score only decided calls; else 'unsure' counts as wrong."""
    recalls = []
    for c in ("calm", "distressed"):
        m = truth == c
        if answered_only:
            m = m & (status != "unsure")
        if m.sum():
            recalls.append(float((status[m] == c).mean()))
    return float(np.mean(recalls)) if recalls else float("nan")


def boot_ci(truth, status, answered_only, rng):
    n, vals = len(truth), []
    for _ in range(BOOT):
        i = rng.integers(0, n, n)
        vals.append(balanced(truth[i], status[i], answered_only))
    return np.nanpercentile(vals, [2.5, 97.5])


def mix(y, nz, snr):
    """Call + noise scaled to `snr` dB below the call's RMS, peak-limited to avoid clipping."""
    x = y + nz * (rms(y) / rms(nz)) / (10 ** (snr / 20))
    peak = np.abs(x).max()
    return (x / peak * 0.99 if peak > 1 else x).astype(np.float32)


def score(snr, truth, v, boot_rng):
    st, ab = v["status"], v["abstain"]
    ans = st != "unsure"
    lo, hi = boot_ci(truth, st, True, boot_rng)
    return dict(
        level="clean" if snr is None else f"{snr} dB",
        snr=np.nan if snr is None else snr,
        answered=float(ans.mean()),
        not_sure=float((~ans).mean()),
        not_pig=float((ab == "not_pig").mean()),
        low_conf=float((ab == "low_confidence").mean()),
        bal_acc_answered=balanced(truth, st, True), ci_lo=lo, ci_hi=hi,
        bal_acc_overall=balanced(truth, st, False),
        calm_flagged_distressed=float((st[truth == "calm"] == "distressed").mean()),
        distressed_caught=float((st[truth == "distressed"] == "distressed").mean()),
        n_answered=int(ans.sum()),
    )


def show(row, tag=""):
    print(f"{tag}{row['level']:>6}: answered {row['answered']:.0%} (not-a-pig {row['not_pig']:.0%}, "
          f"low-conf {row['low_conf']:.0%}) | bal acc on answered {row['bal_acc_answered']:.3f} "
          f"[{row['ci_lo']:.2f}-{row['ci_hi']:.2f}], n={row['n_answered']} | overall {row['bal_acc_overall']:.3f} | "
          f"calm->distressed {row['calm_flagged_distressed']:.0%}", flush=True)


def main():
    M = joblib.load(ROOT / "models/oink.joblib")
    demo = pd.read_csv(ROOT / "data/demo_clips.csv")
    truth = demo.truth.to_numpy()
    calls = [load_audio(CALLS / f) for f in demo.file]
    files = sorted(NOISE_DIR.glob("*.wav"))
    durations = [sf.info(f).duration for f in files]
    rng = np.random.default_rng(SEED)
    noises = [noise_segment(rng, files, durations, len(y)) for y in calls]
    print(f"{len(calls)} held-out calls ({(truth == 'distressed').sum()} distressed), {len(files)} noise recordings")

    rows, boot_rng = [], np.random.default_rng(SEED + 1)
    for snr in LEVELS:
        mixed = [y if snr is None else mix(y, nz, snr) for y, nz in zip(calls, noises)]
        v = verdict(embed_waveforms(mixed)["emb_call"], M)
        row = score(snr, truth, v, boot_rng)
        rows.append(row)
        show(row)

    r = pd.DataFrame(rows)
    r.to_csv(ROOT / "data/noise_results.csv", index=False)
    print(f"saved {ROOT / 'data/noise_results.csv'}")
    plot(r)


def plot(r: pd.DataFrame):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from .slide_charts import GRID, INK, INK2, MUTED, SURFACE  # same look as the other slide charts

    x = np.arange(len(r))
    lines = [  # (column, label, colour, marker): validated palette slots 1-3, direct-labelled
        ("bal_acc_answered", "Accuracy on the calls it answers", "#2a78d6", "o"),
        ("not_sure", "Says \"not sure\"", "#eb6834", "s"),
        ("bal_acc_overall", "Overall (\"not sure\" counts as a miss)", "#1baf7a", "^"),
    ]
    fig, ax = plt.subplots(figsize=(10, 5.8))
    ax.axhline(50, color=MUTED, linewidth=1.2, linestyle=(0, (4, 3)))
    ax.fill_between(x, 100 * r.ci_lo, 100 * r.ci_hi, color="#2a78d6", alpha=0.12, linewidth=0)
    for col, label, color, marker in lines:
        y = 100 * r[col]
        ax.plot(x, y, color=color, linewidth=2.5, marker=marker, markersize=9, markeredgecolor=SURFACE, markeredgewidth=2)
        ax.text(len(r) - 1 + 0.08, y.iloc[-1], f"{label}\n{y.iloc[-1]:.0f}%", color=INK2, fontsize=11.5, va="center")
    for i in (0,):
        ax.text(x[i], 100 * r.bal_acc_answered[i] + 3, f"{100 * r.bal_acc_answered[i]:.0f}%", ha="center",
                fontsize=13, fontweight="bold", color=INK)
    ax.set_xticks(x, ["No noise" if l == "clean" else l for l in r.level])
    ax.set_xlim(-0.3, len(r) - 1 + 1.9)
    ax.set_ylim(0, 100); ax.set_yticks([0, 25, 50, 75, 100]); ax.set_yticklabels(["0", "25", "50", "75", "100%"])
    ax.yaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    ax.set_xlabel("Farm noise added (signal-to-noise ratio; 0 dB = noise as loud as the call)")
    ax.set_title("Add farm noise and it gets less accurate, not more cautious", loc="left", fontsize=17, color=INK, pad=14)
    fig.text(0.01, 0.01, "226 held-out pig calls (never trained on) + poultry-farm noise: Bowen University, Mendeley "
             "doi:10.17632/zp4nf2dxbh.1, CC BY 4.0.\nBalanced accuracy; shaded band = 95% bootstrap interval for "
             "accuracy on answered calls; dashed line = 50%, what guessing scores.\nAdded noise only, not barn echo or distance.", fontsize=9.5, color=MUTED)
    fig.tight_layout(rect=(0, 0.08, 1, 1))
    out = ROOT / "docs/slides/6_noise.png"
    fig.savefig(out, dpi=200); plt.close(fig)
    print(f"saved {out}")


if __name__ == "__main__":
    import sys
    if "--plot" in sys.argv:
        plot(pd.read_csv(ROOT / "data/noise_results.csv"))
    else:
        main()
