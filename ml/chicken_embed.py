"""Perch 2.0 embeddings for the chicken recordings, one row per 5 s window.

    python -m ml.chicken_embed            # data/chicken_labels.csv -> data/emb/chicken.npz

Why windows and not whole files, as ml.embed does for pigs:

  * A pig call is a fraction of a second, so one call is one Perch window and
    ml.embed's `emb_call` trick (average only the frames the call occupies)
    recovers the call from the zero padding.
  * A chicken recording here runs from half a second to five minutes of a flock.
    Pooling that into one vector throws nearly all of it away, and the per-class
    durations differ wildly, which would make clip length itself a feature.

So each recording is cut into non-overlapping 5 s windows (Perch's native input)
and every window becomes a training row, tagged with the recording it came from.
The recording id is the grouping key: windows from one file are near duplicates,
so they must never straddle a train/test split. See ml/chicken_train.py.

Reuses ml.embed.embed_waveforms unchanged, so the embeddings are produced exactly
the way the pig pipeline produces them.
"""

import os
import sys
from pathlib import Path

import librosa
import numpy as np
import pandas as pd

from .embed import SR, WIN, embed_waveforms

ROOT = Path(__file__).resolve().parents[1]
LABELS = ROOT / "data/chicken_labels.csv"
# A tail shorter than this is dropped rather than zero-padded into a mostly-empty window.
MIN_TAIL_S = 1.0
BATCH_FILES = 16

# CHICKEN_NORM=1 scales every window to a fixed RMS before embedding, and writes to
# chicken_norm.npz instead. This exists because the raw recordings give the label
# away: unhealthy files are about 9 dB louder than healthy ones, so loudness alone
# scores 0.81 leave-recording-out. Normalising removes that particular giveaway;
# compare the two runs in ml/chicken_train.py to see how much signal is left.
NORM = os.environ.get("CHICKEN_NORM", "0") == "1"
TARGET_RMS = 0.05
OUT = ROOT / ("data/emb/chicken_norm.npz" if NORM else "data/emb/chicken.npz")


def normalize(w: np.ndarray) -> np.ndarray:
    rms = float(np.sqrt(np.mean(w.astype(np.float64) ** 2)))
    return w if rms < 1e-6 else np.clip(w * (TARGET_RMS / rms), -1.0, 1.0).astype(np.float32)


def file_windows(path: Path) -> list[np.ndarray]:
    """Non-overlapping 5 s windows at Perch's sample rate; short files give one padded window."""
    y, _ = librosa.load(path, sr=SR, mono=True)
    if len(y) == 0:
        return []
    if len(y) <= WIN:
        out = np.zeros(WIN, np.float32)
        out[:len(y)] = y
        return [normalize(out) if NORM else out]
    wins = []
    for s in range(0, len(y), WIN):
        seg = y[s:s + WIN]
        if len(seg) < MIN_TAIL_S * SR and wins:
            break
        w = np.zeros(WIN, np.float32)
        w[:len(seg)] = seg
        wins.append(normalize(w) if NORM else w)
    return wins


def main():
    if not LABELS.exists():
        sys.exit(f"{LABELS} missing; run python -m ml.chicken_labels first")
    df = pd.read_csv(LABELS)

    ids, widx, parts, bad = [], [], [], []
    pending_waves, pending_meta = [], []

    def flush():
        if not pending_waves:
            return
        parts.append(embed_waveforms(pending_waves))
        for fid, k in pending_meta:
            ids.append(fid)
            widx.append(k)
        pending_waves.clear()
        pending_meta.clear()

    for n, row in enumerate(df.itertuples(), 1):
        try:
            wins = file_windows(ROOT / row.path)
            if not wins:
                raise ValueError("empty audio")
        except Exception as e:  # noqa: BLE001 - log and skip
            bad.append((row.id, str(e)[:80]))
            continue
        for k, w in enumerate(wins):
            pending_waves.append(w)
            pending_meta.append((row.id, k))
        # embed_waveforms batches internally; flush every few files to bound memory
        if len(pending_waves) >= BATCH_FILES * 4:
            flush()
        if n % 25 == 0:
            print(f"  {n}/{len(df)} files, {len(ids) + len(pending_meta)} windows", flush=True)
    flush()

    if not parts:
        sys.exit("nothing embedded")
    res = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(OUT, ids=np.array(ids), window=np.array(widx), **res)
    if bad:
        pd.DataFrame(bad, columns=["id", "error"]).to_csv(OUT.with_suffix(".errors.csv"), index=False)
    print(f"saved {len(ids)} windows from {df.id.nunique() - len(bad)} recordings -> {OUT}"
          + ("  (RMS-normalised)" if NORM else ""))
    if bad:
        print(f"  {len(bad)} unreadable, see {OUT.with_suffix('.errors.csv')}")


if __name__ == "__main__":
    main()
