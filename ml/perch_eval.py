"""Tier 0 with Perch: valence from embeddings, random vs leave-session-out vs leave-team-out.

Compares the padded-window embedding (emb) with the call-only one (emb_call), and reports on the
same 6,150-call subset as the feature baseline for an apples-to-apples comparison.
"""

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .baseline import oof, splits
from .labels import FEATURES, OUT

EMB = OUT.parent / "emb/soundwel.npz"


def load():
    z = np.load(EMB, allow_pickle=True)
    t = pd.read_csv(OUT).set_index("file").loc[z["ids"]].reset_index()
    return t, z


def logreg(C=0.1):
    return lambda: make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=3000, class_weight="balanced"))


if __name__ == "__main__":
    t, z = load()
    has_feats = t[FEATURES].notna().any(axis=1).to_numpy()
    rows = []
    for subset, mask in [("all 6887", np.ones(len(t), bool)), ("6150 (= baseline)", has_feats)]:
        ts = t[mask].reset_index(drop=True)
        y = ts.valence.to_numpy()
        for rep in ["emb", "emb_call"]:
            X = z[rep][mask]
            for sname, folds in splits(ts).items():
                p = oof(logreg(), X, y, folds)
                rows.append(dict(subset=subset, rep=rep, split=sname, acc=accuracy_score(y, p),
                                 bal_acc=balanced_accuracy_score(y, p), macro_f1=f1_score(y, p, average="macro")))
            print(rows[-1]["subset"], rep, "done", flush=True)
    r = pd.DataFrame(rows).round(3)
    print(r.to_string(index=False))
    r.to_csv(OUT.parent / "perch_results.csv", index=False)
