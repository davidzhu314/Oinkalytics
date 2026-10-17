"""Does adding other species' calm/stressed calls to training improve the pig model?

Extra data: the non-pig calls of the ungulate valence database (Lefèvre, Sypherd & Briefer 2025,
Zenodo 14636641, CC BY 4.0): cow, goat, sheep, horse, Przewalski's horse, wild boar. Its pig calls are
excluded: they are near-copies of SoundWel's ETHZ recordings, one of which is a demo hold-out session.

Same honest test as the headline (ml/slide_charts.py): leave-session-out on SoundWel, every training fold
gets the shipped recipe (clean + noisy copies), scored on clean pig calls. Variants only add extra
species to every training fold. Also scored on the 226 demo hold-out calls.

python -m ml.cross_species  ->  data/cross_species.csv (does not change any model)
"""

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import balanced_accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold

from .perch_eval import load
from .slide_charts import noisy_copies
from .train_final import DEMO_SESSIONS, valence_model

ROOT = Path(__file__).resolve().parents[1]
VARIANTS = {
    "pigs only (shipped)": [],
    "+ cow, goat, sheep, horse": ["Cow", "Goat", "Sheep", "Horse", "PrzewalskiHorse"],
    "+ wild boar only": ["WildBoar"],
    "+ all other species": ["Cow", "Goat", "Sheep", "Horse", "PrzewalskiHorse", "WildBoar"],
}


def extra_species():
    z = np.load(ROOT / "data/emb/ungulate_other.npz", allow_pickle=True)
    lab = pd.read_csv(ROOT / "data/ungulate_labels.csv").set_index("id").loc[z["ids"]].reset_index()
    sp = lab.species.replace({"WidlBoar": "WildBoar"}).to_numpy()
    return z["emb_call"], (lab.valence == "Negative").astype(int).to_numpy(), sp


def fit_predict(Xa, ya, Xb, extra):
    if extra is not None:
        Xa, ya = np.vstack([Xa, extra[0]]), np.concatenate([ya, extra[1]])
    return valence_model().fit(Xa, ya).decision_function(Xb)


def scores(y, logit):
    pred = (logit > 0).astype(int)
    return {"auc": roc_auc_score(y, logit), "bal_acc": balanced_accuracy_score(y, pred),
            "calm_flagged": float((pred[y == 0] == 1).mean()), "distressed_caught": float((pred[y == 1] == 1).mean())}


def main():
    t, z = load()
    X, y, sess = z["emb_call"], t.valence.to_numpy(), t.session.to_numpy()
    noisy = noisy_copies(t)
    demo = np.isin(sess, DEMO_SESSIONS)
    E_x, y_x, sp_x = extra_species()

    rows = []
    for name, species in VARIANTS.items():
        m = np.isin(sp_x, species)
        extra = (E_x[m], y_x[m]) if m.any() else None

        # 1. Leave-session-out on all SoundWel calls (the 67.5% headline test)
        oof = np.zeros(len(y))
        for a, b in GroupKFold(5).split(X, y, sess):
            aa = a[~np.isnan(noisy[a, 0])]
            oof[b] = fit_predict(np.vstack([X[a], noisy[aa]]), np.concatenate([y[a], y[aa]]), X[b], extra)
        s1 = scores(y, oof)

        # 2. Train on all training sessions, score the 226 demo hold-out calls
        tr = ~demo
        logit = fit_predict(np.vstack([X[tr], noisy[tr]]), np.concatenate([y[tr], y[tr]]), X[demo], extra)
        s2 = scores(y[demo], logit)

        rows.append({"variant": name, "extra_calls": int(m.sum()),
                     **{f"lso_{k}": v for k, v in s1.items()}, **{f"demo_{k}": v for k, v in s2.items()}})
        r = rows[-1]
        print(f"{name:28s} +{r['extra_calls']:4d} calls | leave-session-out bal acc {r['lso_bal_acc']:.3f} "
              f"AUC {r['lso_auc']:.3f} calm flagged {r['lso_calm_flagged']:.0%} | demo hold-out bal acc "
              f"{r['demo_bal_acc']:.3f} AUC {r['demo_auc']:.3f}", flush=True)
    pd.DataFrame(rows).to_csv(ROOT / "data/cross_species.csv", index=False)


if __name__ == "__main__":
    main()
