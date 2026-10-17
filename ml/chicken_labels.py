"""Label table for the chicken health add-on.

    python -m ml.chicken_labels          # writes data/chicken_labels.csv

The Mendeley poultry set (doi:10.17632/zp4nf2dxbh.1) is three folders of whole
recordings: healthy (139), unhealthy (121) and noise (86). Unlike SoundWel there
is no per-bird or per-session metadata at all, and the filenames restart at 1 in
every folder, so the row id carries the folder.

One row per source file. The honest grouping is the file itself: see
ml/chicken_embed.py, which cuts each recording into 5 s windows. Windows from one
recording are near-duplicates, so they must never straddle a train/test split.
"""

import sys
from pathlib import Path

import pandas as pd
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/raw/chicken"
OUT = ROOT / "data/chicken_labels.csv"

# sick=1 for unhealthy, 0 for healthy; noise is neither (it is the not-a-chicken set).
LABELS = {"healthy": 0, "unhealthy": 1, "noise": None}


def build() -> pd.DataFrame:
    rows = []
    for folder, sick in LABELS.items():
        d = RAW / folder
        if not d.is_dir():
            print(f"  missing {d} - run scripts/get_chicken.sh", file=sys.stderr)
            continue
        for p in sorted(d.glob("*.wav"), key=lambda q: (len(q.stem), q.stem)):
            try:
                info = sf.info(p)
            except Exception as e:  # noqa: BLE001 - report and skip unreadable files
                print(f"  unreadable {p.name}: {str(e)[:60]}", file=sys.stderr)
                continue
            rows.append({
                "id": f"{folder}_{p.stem}",
                "path": p.relative_to(ROOT).as_posix(),
                "label": folder,
                "sick": sick,
                "duration_s": round(info.duration, 2),
                "sr": info.samplerate,
            })
    return pd.DataFrame(rows)


def main():
    df = build()
    if df.empty:
        sys.exit("no audio found; run scripts/get_chicken.sh first")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT, index=False)

    print(f"{len(df)} recordings -> {OUT}")
    print(df.groupby("label").agg(
        files=("id", "size"),
        total_min=("duration_s", lambda s: round(s.sum() / 60, 1)),
        median_s=("duration_s", "median"),
        shortest_s=("duration_s", "min"),
        longest_s=("duration_s", "max"),
    ).to_string())
    print(f"\nsample rates: {sorted(df.sr.unique())}")
    print(f"total audio: {df.duration_s.sum() / 60:.0f} min")
    labelled = df[df.sick.notna()]
    print(f"healthy vs unhealthy: {len(labelled)} files, "
          f"{int((labelled.sick == 0).sum())} healthy / {int((labelled.sick == 1).sum())} unhealthy")


if __name__ == "__main__":
    main()
