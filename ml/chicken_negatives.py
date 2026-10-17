"""Not-a-chicken negatives: ESC-50 (minus the poultry classes) plus SoundWel pig calls.

    python -m ml.chicken_negatives        # writes data/chicken_negatives.csv

Why this exists: the barn now sends every call to both the pig model and the
chicken model, so the chicken server's not-a-chicken check has to reject a pig
squeal, not just the dataset's own `noise` recordings. Training the detector only
on in-dataset noise says nothing about pigs.

Reads whatever is on disk and skips the rest, so it works on a machine with only
one of the two sets:

  data/raw/esc50/ESC-50-master/   (meta/esc50.csv + audio/)   -> `esc50` rows
  data/raw/soundwel/                                          -> `soundwel` rows

ESC-50's own poultry classes are excluded: a hen or a rooster is close enough to
the target species that calling it "not a chicken" would be wrong.

Held-out slices are marked here rather than in the trainer, so the same clips are
held out on every machine:

  * ESC-50 keeps its published fold 5 as the test fold (its folds are designed so
    clips from one source recording stay together).
  * SoundWel pig calls are split by recording session, the same grouping the pig
    pipeline calls honest; every 4th session is held out.
"""

import re
import sys
from pathlib import Path

import pandas as pd
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
ESC = ROOT / "data/raw/esc50/ESC-50-master"
SOUNDWEL = ROOT / "data/raw/soundwel"
OUT = ROOT / "data/chicken_negatives.csv"

# Too close to the target species to count as a negative.
POULTRY = {"hen", "rooster", "chicken"}
ESC_TEST_FOLD = 5
# Cap the pig side so it cannot swamp ESC-50; sampled evenly across sessions.
MAX_PIG = 800


def esc50_rows() -> list[dict]:
    meta = ESC / "meta/esc50.csv"
    if not meta.exists():
        print(f"  no ESC-50 at {ESC} - skipping (run scripts/get_chicken.sh --all)", file=sys.stderr)
        return []
    m = pd.read_csv(meta)
    kept = m[~m.category.isin(POULTRY)]
    dropped = sorted(set(m.category) & POULTRY)
    print(f"  ESC-50: {len(kept)} clips over {kept.category.nunique()} classes"
          f" (excluded {', '.join(dropped) or 'nothing'})")
    rows = []
    for r in kept.itertuples():
        p = ESC / "audio" / r.filename
        if not p.exists():
            continue
        rows.append({
            "id": f"esc50_{Path(r.filename).stem}",
            "path": p.relative_to(ROOT).as_posix(),
            "source": "esc50",
            "category": r.category,
            "group": f"esc50_fold{r.fold}",
            "held_out": int(r.fold == ESC_TEST_FOLD),
        })
    return rows


def soundwel_session(path: Path) -> str:
    """Group pig calls the way the pig pipeline does: by recording team, falling back to folder."""
    parts = [q for q in path.relative_to(SOUNDWEL).parts[:-1] if q]
    if parts:
        return f"soundwel_{parts[0]}"
    m = re.match(r"([A-Za-z]+)", path.stem)
    return f"soundwel_{m.group(1) if m else 'unknown'}"


def soundwel_rows() -> list[dict]:
    if not SOUNDWEL.is_dir():
        print(f"  no SoundWel at {SOUNDWEL} - skipping", file=sys.stderr)
        return []
    wavs = sorted(SOUNDWEL.rglob("*.wav"))
    if not wavs:
        print(f"  no wav files under {SOUNDWEL} - skipping "
              "(scripts/get_chicken.sh --all prints the archive links)", file=sys.stderr)
        return []
    rows = []
    for p in wavs:
        rows.append({
            "id": f"soundwel_{p.stem}",
            "path": p.relative_to(ROOT).as_posix(),
            "source": "soundwel",
            "category": "pig",
            "group": soundwel_session(p),
            "held_out": 0,     # set below, by session
        })
    df = pd.DataFrame(rows)
    # Every 4th session is the test side, so held-out pig calls come from
    # recording sessions the detector never saw.
    sessions = sorted(df.group.unique())
    test = set(sessions[::4])
    df["held_out"] = df.group.isin(test).astype(int)
    if len(df) > MAX_PIG:                      # sample evenly across sessions
        per = max(1, MAX_PIG // max(1, df.group.nunique()))
        df = (df.sort_values("id").groupby("group", group_keys=False).head(per)).head(MAX_PIG)
    print(f"  SoundWel: {len(df)} pig calls over {df.group.nunique()} sessions "
          f"({len(test)} held out: {', '.join(sorted(test)) or 'none'})")
    return df.to_dict("records")


def build() -> pd.DataFrame:
    rows = esc50_rows() + soundwel_rows()
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    keep, bad = [], 0
    for r in df.itertuples():
        try:
            sf.info(ROOT / r.path)
            keep.append(True)
        except Exception:  # noqa: BLE001 - unreadable clips are skipped, not fatal
            keep.append(False)
            bad += 1
    if bad:
        print(f"  skipped {bad} unreadable clips")
    return df[keep].reset_index(drop=True)


def main():
    df = build()
    if df.empty:
        sys.exit("no negatives found; run scripts/get_chicken.sh --all first")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT, index=False)
    print(f"\n{len(df)} negatives -> {OUT}")
    print(df.groupby(["source", "held_out"]).size().rename("clips").to_string())


if __name__ == "__main__":
    main()
