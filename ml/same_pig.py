"""'Same pig, two moods': the ungulate dataset (Zenodo 14636641) has animal IDs.

1. Overlap check: are these pig calls copies of SoundWel calls (and so in our training data)?
2. Leave-pig-out vs random split, within this dataset (30 pigs, 26 recorded in both moods).
3. The shipped model on wild boar, a species it was never trained on.
"""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score
from sklearn.model_selection import GroupKFold, StratifiedKFold

from .baseline import oof
from .train_final import sigmoid, unit, valence_model

ROOT = Path(__file__).resolve().parents[1]

if __name__ == "__main__":
    z = np.load(ROOT / "data/emb/ungulate_pig.npz", allow_pickle=True)
    lab = pd.read_csv(ROOT / "data/ungulate_labels.csv").set_index("id").loc[z["ids"]].reset_index()
    lab["y"] = (lab.valence == "Negative").astype(int)
    pig = (lab.species == "Pig").to_numpy()
    boar = lab.species.str.contains("Boar").to_numpy()
    M = joblib.load(ROOT / "models/oink.joblib")
    E = z["emb_call"]

    best = (unit(E) @ M["index"]["emb"].T).max(axis=1)
    print(f"pig calls: best match to SoundWel training calls: median {np.median(best[pig]):.3f}, "
          f"share >= 0.99 (near-identical) {(best[pig] >= 0.99).mean():.0%}")

    X, y, g = E[pig], lab.y[pig].to_numpy(), lab.animal[pig].to_numpy()
    print(f"pigs: {len(np.unique(g))} animals, {len(y)} calls, {y.mean():.0%} negative")
    for name, folds in [("random split", StratifiedKFold(5, shuffle=True, random_state=0).split(X, y)),
                        ("leave-pig-out", GroupKFold(5).split(X, y, g))]:
        print(f"  {name:14s} balanced acc {balanced_accuracy_score(y, oof(valence_model, X, y, folds)):.3f}")

    p = sigmoid(M["valence"].decision_function(E[boar]) / M["temperature"])
    yb = lab.y[boar].to_numpy()
    st = np.where(p >= M["alarm_at"], 1, np.where(p < M["calm_below"], 0, -1)); d = st >= 0
    pig_p = M["pig"].predict_proba(E[boar])[:, 1]
    print(f"wild boar (never trained on): {boar.sum()} calls from {lab.animal[boar].nunique()} animals; "
          f"balanced acc answering all {balanced_accuracy_score(yb, (p >= 0.5).astype(int)):.3f}; "
          f"shipped band decides {d.mean():.0%} at {balanced_accuracy_score(yb[d], st[d]):.3f}; "
          f"pig detector says 'pig' for {(pig_p >= 0.5).mean():.0%}")
