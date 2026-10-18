"""Bat colony "Who's calling?": train the identity model on some days, hold out whole days for the demo.

Every 5th recording day (6 of 28) is held out of training entirely. The model (Perch emb_call +
logistic regression, C=0.001) learns the 10 bats' voices from the other days. Demo clips are cut only
from the held-out days, so the colony page shows "days it never heard" live.

python -m ml.bat_train  ->  models/bats.joblib, data/bat_demo/*.wav, data/bat_demo.csv
"""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import soundfile as sf
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .bat_prep import load_call
from .embed import SR

ROOT = Path(__file__).resolve().parents[1]
DEMO_DIR = ROOT / "data/bat_demo"
PER_BAT = 15


def main():
    lab = pd.read_csv(ROOT / "data/bat_labels.csv")
    E = np.load(ROOT / "data/emb/bats.npz")["emb_call"]
    days = sorted(lab.day.unique())
    held = days[2::5]
    test = lab.day.isin(held).to_numpy()
    who = lab.bat.to_numpy()
    print(f"held-out days {held}: {test.sum()} calls; training on {(~test).sum()} calls from {len(days) - len(held)} days")

    model = make_pipeline(StandardScaler(), LogisticRegression(C=0.001, max_iter=3000)).fit(E[~test], who[~test])
    pred = model.predict(E[test])
    acc, bal = (pred == who[test]).mean(), balanced_accuracy_score(who[test], pred)
    top3 = np.argsort(model.predict_proba(E[test]), axis=1)[:, -3:]
    in_top3 = np.mean([w in model.classes_[t] for w, t in zip(who[test], top3)])
    print(f"held-out days: accuracy {acc:.0%}, balanced {bal:.0%}, right bat in top 3 {in_top3:.0%} (chance 10% / 30%)")
    per_bat = pd.Series(pred == who[test]).groupby(who[test]).agg(["size", "mean"]).round(2)
    print(per_bat.T.to_string())

    # Demo clips: up to PER_BAT calls per bat from held-out days, 0.3-3 s long, written as 32 kHz WAV.
    DEMO_DIR.mkdir(exist_ok=True)
    pool = lab[test & lab.dur_s.between(0.3, 3.0).to_numpy()]
    picks = pool.groupby("bat", group_keys=False).apply(lambda g: g.sample(min(PER_BAT, len(g)), random_state=0))
    rows = []
    for i, r in picks.iterrows():
        y = load_call(r)
        y = (y / (np.abs(y).max() + 1e-9) * 0.9).astype(np.float32)
        name = f"bat{r.bat}-{i}.wav"
        sf.write(DEMO_DIR / name, y, SR, subtype="PCM_16")
        rows.append({"clip": name, "row": i, "bat": int(r.bat), "day": r.day, "context": r.context,
                     "dur_s": round(float(r.dur_s), 2)})
    pd.DataFrame(rows).to_csv(ROOT / "data/bat_demo.csv", index=False)

    joblib.dump({"model": model, "classes": [int(c) for c in model.classes_], "held_days": held,
                 "heldout_accuracy": float(acc), "heldout_balanced": float(bal), "heldout_top3": float(in_top3),
                 "n_train": int((~test).sum()), "n_test": int(test.sum())}, ROOT / "models/bats.joblib")
    print(f"saved models/bats.joblib and {len(rows)} demo clips")


if __name__ == "__main__":
    main()
