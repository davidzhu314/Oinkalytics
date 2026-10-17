"""Egyptian fruit bats: cut each annotated call out of its recording and embed it with Perch.

Data: Prat, Taub, Pratt & Yovel 2017, "An annotated dataset of Egyptian fruit bat vocalizations across
varying contexts and during vocal ontogeny", Scientific Data; Figshare collection 10.6084/m9.figshare.c.3666502
(audio archives files220 + files222, Annotations.csv, FileInfo.csv; CC0). Lab colony, Tel Aviv University.

data/bat_labels.csv (one row per annotated call, built from Annotations.csv + FileInfo.csv) gives the file,
the call's start/end sample, which bat called, the day, and the context. Recordings are 250 kHz; calls are
resampled to Perch's 32 kHz, which keeps everything below 16 kHz.

python -m ml.bat_prep  ->  data/emb/bats.npz (rows aligned with data/bat_labels.csv)
"""

from pathlib import Path

import librosa
import numpy as np
import pandas as pd
import soundfile as sf

from .embed import SR, embed_waveforms

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/bats"
LABELS = ROOT / "data/bat_labels.csv"
OUT = ROOT / "data/emb/bats.npz"
BAT_SR = 250_000


def load_call(row) -> np.ndarray:
    y, sr = sf.read(RAW / row.folder / row.file, start=int(row.start) - 1, stop=int(row.end), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    return librosa.resample(y, orig_sr=sr, target_sr=SR).astype(np.float32)


def main():
    lab = pd.read_csv(LABELS)
    parts = []
    for s in range(0, len(lab), 256):
        waves = [load_call(r) for r in lab.iloc[s:s + 256].itertuples()]
        parts.append(embed_waveforms(waves))
        print(f"{min(s + 256, len(lab))}/{len(lab)}", flush=True)
    res = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    np.savez_compressed(OUT, row=np.arange(len(lab)), **res)
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
