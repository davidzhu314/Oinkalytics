"""Build the label table from the SoundWel key. One row per call; everything downstream reads this."""

from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
KEY = ROOT / "data/raw/SoundwelDatasetKey.xlsx"
OUT = ROOT / "data/labels.csv"

FEATURES = ["F0Mean", "Q25", "Q50", "Q75", "Fpeak", "Dur", "AMVar", "AMRate", "AMExtent",
            "Harmonicity", "WienEntrMean", "DFMin", "LPC1", "LPC2", "LPC3", "LPC4", "LPC5", "LPC6"]


def build() -> pd.DataFrame:
    df = pd.read_excel(KEY)
    out = pd.DataFrame({
        "file": df["Audio Filename"],
        "team": df["Recording Team"],
        # 737 NMBU "Transit" calls have no date (and no key features); they get their own session.
        "session": df["Recording Team"] + "_" + pd.to_datetime(df["Recording Date"]).dt.strftime("%Y-%m-%d").fillna("Transit"),
        "valence": df["Valence"].map({"Neg": 1, "Pos": 0}),  # 1 = distressed
        "context": df["Context Category"],
        "age": df["Age Category"],
        "sex": df["Sex"],
        "call_type": df["Call Type (Freq)"],
    })
    for f in FEATURES:
        out[f] = pd.to_numeric(df[f], errors="coerce")
    return out


if __name__ == "__main__":
    t = build()
    t.to_csv(OUT, index=False)
    print(f"{len(t)} calls, {t.session.nunique()} sessions, {t.team.nunique()} teams -> {OUT}")
    print("missing feature values:", int(t[FEATURES].isna().sum().sum()))
