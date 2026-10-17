"""Perch 2.0 embeddings, run once and cached.

Usage: python -m ml.embed <manifest.csv> <out.npz>
The manifest needs columns `id` and `path`. Output arrays, aligned by row:
  ids          (N,)
  emb          (N, 1536)  Perch's pooled embedding of the (padded) 5 s window
  emb_call     (N, 1536)  spatial embedding averaged over only the frames the call occupies
                          (calls are often < 1 s, so this skips the zero padding)
  sound_logits (N, K)     Perch's general-sound classes (SOUND_CLASSES), for the "not a pig" check
  duration_s   (N,)
"""

import sys
from functools import lru_cache
from pathlib import Path

import librosa
import numpy as np
import pandas as pd

PERCH = Path.home() / ".cache/kagglehub/models/google/bird-vocalization-classifier/tensorFlow2/perch_v2_cpu/1"
SR = 32000
WIN = 5 * SR
FRAMES = 16  # spatial_embedding time frames per window
SOUND_CLASSES = ["Animal", "Livestock_and_farm_animals_and_working_animals", "Domestic_animals_and_pets",
                 "Wild_animals", "Clapping", "Cough", "Speech", "Bark"]
BATCH = 32


@lru_cache(maxsize=1)
def model():
    import tensorflow as tf
    sig = tf.saved_model.load(str(PERCH)).signatures["serving_default"]
    labels = pd.read_csv(PERCH / "assets/labels.csv").iloc[:, 0].tolist()
    idx = [labels.index(c) for c in SOUND_CLASSES]
    return sig, idx


def load_audio(path) -> np.ndarray:
    y, _ = librosa.load(path, sr=SR, mono=True)
    return y.astype(np.float32)


def windows(y: np.ndarray):
    """Split into 5 s windows (zero-padding the last); returns (windows, frames used in each)."""
    n = max(1, int(np.ceil(len(y) / WIN)))
    out, used = np.zeros((n, WIN), np.float32), []
    for i in range(n):
        seg = y[i * WIN:(i + 1) * WIN]
        out[i, :len(seg)] = seg
        used.append(max(1, int(np.ceil(len(seg) / (WIN / FRAMES)))))
    return out, used


def embed_waveforms(waves: list[np.ndarray]) -> dict:
    """Embed a list of 32 kHz mono waveforms. Long clips are averaged over their windows."""
    import tensorflow as tf
    sig, idx = model()
    wins, owners, used = [], [], []
    for i, y in enumerate(waves):
        w, u = windows(y)
        wins.append(w); owners += [i] * len(w); used += u
    wins = np.concatenate(wins)
    emb, emb_call, logits = [], [], []
    for s in range(0, len(wins), BATCH):
        out = sig(inputs=tf.constant(wins[s:s + BATCH]))
        sp = out["spatial_embedding"].numpy()          # (b, 16, 4, 1536)
        emb.append(out["embedding"].numpy())
        emb_call.append(np.stack([sp[j, :used[s + j]].mean(axis=(0, 1)) for j in range(len(sp))]))
        logits.append(out["label"].numpy()[:, idx])
    emb, emb_call, logits = map(np.concatenate, (emb, emb_call, logits))
    owners = np.array(owners)
    pool = lambda a: np.stack([a[owners == i].mean(0) for i in range(len(waves))])
    return {"emb": pool(emb), "emb_call": pool(emb_call), "sound_logits": pool(logits),
            "duration_s": np.array([len(y) / SR for y in waves])}


def main(manifest: str, out: str):
    m = pd.read_csv(manifest)
    parts, ok_ids, bad = [], [], []
    chunk = 256
    for s in range(0, len(m), chunk):
        rows = m.iloc[s:s + chunk]
        waves, ids = [], []
        for r in rows.itertuples():
            try:
                y = load_audio(r.path)
                if len(y) == 0:
                    raise ValueError("empty")
                waves.append(y); ids.append(r.id)
            except Exception as e:  # noqa: BLE001 - log and skip unreadable files
                bad.append((r.id, str(e)[:80]))
        if waves:
            parts.append(embed_waveforms(waves)); ok_ids += ids
        print(f"{min(s + chunk, len(m))}/{len(m)} done, {len(bad)} unreadable", flush=True)
    res = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    np.savez_compressed(out, ids=np.array(ok_ids), sound_classes=np.array(SOUND_CLASSES), **res)
    if bad:
        pd.DataFrame(bad, columns=["id", "error"]).to_csv(Path(out).with_suffix(".errors.csv"), index=False)
    print(f"saved {len(ok_ids)} embeddings -> {out}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
