"""Fruit bats: is a call aggression (biting, fighting, mating protest, threat-like) or not?

Same method as the pigs: Perch emb_call + class-balanced logistic regression, scored under a naive random
split and under splits that hold out whole bats, whole days and whole chamber groups. Plus a shortcut check:
how far does call duration alone get?

Bats: 10 juveniles (born in the lab, ~7-9 months old), groups of five in two colony chambers (treatments
16-19 of Prat et al. 2017). See ml/bat_prep.py for data and licence.

python -m ml.bat_eval  ->  data/bat_results.csv
"""

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold, LeaveOneGroupOut, StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]


def model(C=0.001):
    return make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=3000, class_weight="balanced"))


def oof(X, y, folds, C=0.001):
    out = np.zeros(len(y))
    for a, b in folds:
        out[b] = model(C).fit(X[a], y[a]).decision_function(X[b])
    return out


def main():
    lab = pd.read_csv(ROOT / "data/bat_labels.csv")
    E = np.load(ROOT / "data/emb/bats.npz")["emb_call"]
    y = lab.aggression.to_numpy()
    print(f"{len(y)} calls, {y.sum()} aggression ({y.mean():.0%}), {lab.bat.nunique()} bats, {lab.day.nunique()} days")

    splits = {
        "random split": lambda X: StratifiedKFold(5, shuffle=True, random_state=0).split(X, y),
        "bats it never heard": lambda X: LeaveOneGroupOut().split(X, y, lab.bat),
        "days it never heard": lambda X: GroupKFold(5).split(X, y, lab.day),
        "chamber groups it never heard": lambda X: LeaveOneGroupOut().split(X, y, lab.treatment),
    }
    feats = {
        "Perch": E,
        "call duration only": np.log(lab[["dur_s"]].to_numpy()),
    }
    rows = []
    for fname, X in feats.items():
        for sname, split in splits.items():
            lg = oof(X, y, split(X), C=0.001 if fname == "Perch" else 1.0)
            rows.append({"features": fname, "split": sname, "auc": roc_auc_score(y, lg),
                         "bal_acc": balanced_accuracy_score(y, (lg > 0).astype(int)),
                         "aggr_caught": float(((lg > 0) & (y == 1)).sum() / y.sum()),
                         "calm_flagged": float(((lg > 0) & (y == 0)).sum() / (y == 0).sum())})
            r = rows[-1]
            print(f"{fname:20s} {sname:30s} bal acc {r['bal_acc']:.3f}  AUC {r['auc']:.3f}  "
                  f"aggression caught {r['aggr_caught']:.0%}  others flagged {r['calm_flagged']:.0%}", flush=True)

    # Which bat? If Perch identifies individuals easily, a bat-level shortcut is possible.
    who = LogisticRegression(C=0.001, max_iter=3000)
    acc = []
    for a, b in StratifiedKFold(5, shuffle=True, random_state=0).split(E, lab.bat):
        m = make_pipeline(StandardScaler(), who).fit(E[a], lab.bat.to_numpy()[a])
        acc.append((m.predict(E[b]) == lab.bat.to_numpy()[b]).mean())
    print(f"identify the bat from one call (10 bats, chance 10%): {np.mean(acc):.0%}")
    pd.DataFrame(rows).to_csv(ROOT / "data/bat_results.csv", index=False)


if __name__ == "__main__":
    main()
