"""Quick sweep on the honest split: regularisation, per-session normalisation, Perch + key features."""

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import balanced_accuracy_score
from sklearn.model_selection import GroupKFold, LeaveOneGroupOut

from .baseline import oof
from .labels import FEATURES
from .perch_eval import load, logreg


def session_norm(X, groups):
    """Standardise each session separately (deploy-time analogue: normalise per barn on recent calls)."""
    X = X.copy()
    for g in np.unique(groups):
        m = groups == g
        X[m] = (X[m] - X[m].mean(0)) / (X[m].std(0) + 1e-6)
    return X


if __name__ == "__main__":
    t, z = load()
    mask = t[FEATURES].notna().any(axis=1).to_numpy()   # 6150 subset, comparable with the baseline
    t, E = t[mask].reset_index(drop=True), z["emb_call"][mask]
    y, sess, team = t.valence.to_numpy(), t.session.to_numpy(), t.team.to_numpy()
    F = SimpleImputer(strategy="median").fit_transform(t[FEATURES])
    E_norm = session_norm(E, sess)

    def score(make, X):
        out = {}
        for name, folds in [("session", GroupKFold(5).split(X, y, sess)), ("team", LeaveOneGroupOut().split(X, y, team))]:
            out[name] = round(balanced_accuracy_score(y, oof(make, X, y, folds)), 3)
        return out

    hgb = lambda: HistGradientBoostingClassifier(class_weight="balanced", random_state=0)
    trials = {
        "features hgb (baseline)": (hgb, t[FEATURES].to_numpy()),
        **{f"perch logreg C={C}": (logreg(C), E) for C in (0.001, 0.01, 0.1)},
        "perch session-norm C=0.01": (logreg(0.01), E_norm),
        "perch + features C=0.01": (logreg(0.01), np.hstack([E, F])),
        "perch session-norm + features C=0.01": (logreg(0.01), np.hstack([E_norm, session_norm(F, sess)])),
    }
    for name, (make, X) in trials.items():
        print(f"{name:40s}", score(make, X), flush=True)
