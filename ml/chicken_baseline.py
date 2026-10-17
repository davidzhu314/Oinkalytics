"""The confound check: how far do seven trivial features get, on the honest split?

    python -m ml.chicken_baseline

This is the number behind the slide. Perch plus logistic regression scores 0.996
leave-recording-out on this dataset; seven features any first-year student could
compute score 0.938 on the same split, and loudness alone 0.811. That gap is the
whole reason docs/CHICKEN.md refuses to present 0.996 as an accuracy result.

No embeddings needed: this reads the wav files directly, so it runs in a couple of
minutes without Perch or TensorFlow.

The features are deliberately dumb and global, computed over the first 5 s of each
recording:

  rms_db     overall loudness
  peak       peak amplitude
  dc         mean offset
  hi_frac    share of energy above 15 kHz   (a mic or codec difference shows here)
  mid_frac   share of energy 2-8 kHz
  lo_frac    share of energy below 500 Hz
  zcr        zero-crossing rate

Same split as the real model: GroupKFold on the recording id, which is the
strictest this dataset allows (there is no bird or session metadata).
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import soundfile as sf
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
LABELS = ROOT / "data/chicken_labels.csv"
OUT = ROOT / "data/chicken_baseline.csv"

HEAD_S = 5.0        # only the first few seconds, so one long file cannot dominate
NFFT = 1 << 16
FOLDS = 5
FEATURES = ["rms_db", "peak", "dc", "hi_frac", "mid_frac", "lo_frac", "zcr"]


def features(path: Path) -> dict | None:
    try:
        info = sf.info(path)
        y, sr = sf.read(path, frames=int(HEAD_S * info.samplerate), dtype="float32")
    except Exception:  # noqa: BLE001 - unreadable files are skipped
        return None
    if y.ndim > 1:
        y = y.mean(axis=1)
    if len(y) == 0:
        return None
    n = min(len(y), NFFT)
    spec = np.abs(np.fft.rfft(y[:n] * np.hanning(n), n=NFFT))
    freqs = np.fft.rfftfreq(NFFT, 1 / sr)
    total = spec.sum() + 1e-12
    return {
        "rms_db": float(20 * np.log10(np.sqrt(np.mean(y.astype(np.float64) ** 2)) + 1e-12)),
        "peak": float(np.abs(y).max()),
        "dc": float(y.mean()),
        "hi_frac": float(spec[freqs > 15000].sum() / total),
        "mid_frac": float(spec[(freqs > 2000) & (freqs <= 8000)].sum() / total),
        "lo_frac": float(spec[freqs <= 500].sum() / total),
        "zcr": float(np.mean(np.abs(np.diff(np.sign(y))) > 0)),
    }


def honest_score(X: np.ndarray, y: np.ndarray, groups: np.ndarray) -> float:
    """Leave-recording-out balanced accuracy, pooled over out-of-fold predictions."""
    oof = np.zeros(len(y))
    folds = max(2, min(FOLDS, len(np.unique(groups))))
    for a, b in GroupKFold(folds).split(X, y, groups):
        clf = make_pipeline(StandardScaler(),
                            LogisticRegression(max_iter=2000, class_weight="balanced"))
        oof[b] = clf.fit(X[a], y[a]).decision_function(X[b])
    return balanced_accuracy_score(y, (oof >= 0).astype(int))


def main():
    if not LABELS.exists():
        sys.exit(f"{LABELS} missing; run python -m ml.chicken_labels first")
    lab = pd.read_csv(LABELS)
    lab = lab[lab.sick.notna()].reset_index(drop=True)

    rows = []
    for n, r in enumerate(lab.itertuples(), 1):
        f = features(ROOT / r.path)
        if f is None:
            continue
        rows.append({"id": r.id, "sick": int(r.sick), **f})
        if n % 50 == 0:
            print(f"  {n}/{len(lab)} recordings measured", flush=True)
    if not rows:
        sys.exit("no readable audio")

    d = pd.DataFrame(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    d.to_csv(OUT, index=False)

    print(f"\n{len(d)} recordings: {int((d.sick == 0).sum())} healthy / {int((d.sick == 1).sum())} unhealthy")
    print("\nclass means:")
    print(d.groupby("sick")[FEATURES].mean().round(4).to_string())

    X, y, g = d[FEATURES].to_numpy(), d.sick.to_numpy(), d.id.to_numpy()
    print("\n--- leave-recording-out balanced accuracy ---")
    all_seven = honest_score(X, y, g)
    print(f"  all {len(FEATURES)} features together : {all_seven:.3f}")
    singles = {f: honest_score(d[[f]].to_numpy(), y, g) for f in FEATURES}
    for f, s in sorted(singles.items(), key=lambda kv: -kv[1]):
        print(f"    {f:9} alone            : {s:.3f}")
    print(f"\n  for comparison, Perch + logreg  : see python -m ml.chicken_train")
    print(f"  chance (balanced)               : 0.500")
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
