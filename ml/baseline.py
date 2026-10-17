"""Tier 0 baseline: the key's acoustic features only, under random vs leave-session-out vs leave-team-out.

Predictions are pooled out-of-fold, so leave-team-out works even when a team has only one valence.
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score
from sklearn.model_selection import GroupKFold, LeaveOneGroupOut, StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .labels import FEATURES, OUT

SEED = 0


def models():
    return {
        "logreg": lambda: make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler(),
                                        LogisticRegression(max_iter=2000, class_weight="balanced")),
        "hgb": lambda: HistGradientBoostingClassifier(class_weight="balanced", random_state=SEED),
    }


def splits(t):
    return {
        "random": StratifiedKFold(5, shuffle=True, random_state=SEED).split(t, t.valence),
        "leave-session-out": GroupKFold(5).split(t, t.valence, t.session),
        "leave-team-out": LeaveOneGroupOut().split(t, t.valence, t.team),
    }


def oof(make, X, y, folds):
    pred = np.empty(len(y), dtype=int)
    for tr, te in folds:
        pred[te] = make().fit(X[tr], y[tr]).predict(X[te])
    return pred


if __name__ == "__main__":
    t = pd.read_csv(OUT)
    t = t[t[FEATURES].notna().any(axis=1)].reset_index(drop=True)  # drop calls with no key features at all
    X, y = t[FEATURES].to_numpy(), t.valence.to_numpy()
    print(f"{len(t)} calls; majority-class accuracy {max(y.mean(), 1 - y.mean()):.3f}, balanced chance 0.500\n")
    rows = []
    for mname, make in models().items():
        for sname, folds in splits(t).items():
            p = oof(make, X, y, folds)
            rows.append(dict(model=mname, split=sname, acc=accuracy_score(y, p),
                             bal_acc=balanced_accuracy_score(y, p), macro_f1=f1_score(y, p, average="macro")))
    r = pd.DataFrame(rows).round(3)
    print(r.to_string(index=False))
    r.to_csv(OUT.parent / "baseline_results.csv", index=False)

    # Per-team accuracy under leave-team-out (hgb): does the model transfer to an unseen lab?
    p = oof(models()["hgb"], X, y, splits(t)["leave-team-out"])
    print("\nleave-team-out accuracy per held-out team (hgb):")
    print(t.assign(ok=(p == y)).groupby("team").agg(n=("ok", "size"), acc=("ok", "mean"),
                                                     pct_distressed=("valence", "mean")).round(3).to_string())
