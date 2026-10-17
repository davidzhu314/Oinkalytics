"""Train everything the real API needs and save it to models/oink.joblib.

- Demo sessions are held out of *everything* (classifier, calibration, neighbours, pig detector),
  so demo clips are genuinely unseen recordings.
- Valence: LogisticRegression on Perch emb_call, temperature-scaled on leave-session-out
  out-of-fold logits, with a calm/unsure/distressed band chosen to cut false alarms.
- Context: top 3 (random-split quality only; contexts are tied to sessions).
- Not-a-pig: pig-vs-ESC-50 detector + distance to the nearest training call.

Run after ml.embed has produced data/emb/soundwel.npz and data/emb/esc50.npz.
"""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .labels import OUT
from .perch_eval import load

ROOT = Path(__file__).resolve().parents[1]
MODEL_OUT = ROOT / "models/oink.joblib"
DEMO_CLIPS = ROOT / "data/demo_clips.csv"
DEMO_SESSIONS = ["ETHZ_2014-08-26", "NMBU_2017-06-09", "FBN_2014-04-24"]
MAX_FALSE_ALARM = 0.20   # per-call rate at which calm calls may be called distressed
CALM_BELOW = 0.40        # p_distressed under this is "calm"; between this and the alarm threshold is "unsure"
SEED = 0


def valence_model():
    return make_pipeline(StandardScaler(), LogisticRegression(C=0.001, max_iter=3000, class_weight="balanced"))


def unit(X):
    return X / np.linalg.norm(X, axis=1, keepdims=True)


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def fit_temperature(logits, y):
    def nll(T):
        p = np.clip(sigmoid(logits / T), 1e-7, 1 - 1e-7)
        return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
    return minimize_scalar(nll, bounds=(0.05, 20), method="bounded").x


def ece(p, y, bins=10):
    conf, pred = np.maximum(p, 1 - p), (p >= 0.5).astype(int)
    edges, total = np.linspace(0.5, 1, bins + 1), 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf >= lo) & (conf < hi + (hi == 1))
        if m.any():
            total += m.mean() * abs((pred[m] == y[m]).mean() - conf[m].mean())
    return total


def main():
    t, z = load()
    E, sess = z["emb_call"], t.session.to_numpy()
    y = t.valence.to_numpy()
    demo = np.isin(sess, DEMO_SESSIONS)
    tr = ~demo
    Etr, ytr, str_ = E[tr], y[tr], sess[tr]
    print(f"train {tr.sum()} calls / {len(np.unique(str_))} sessions; demo hold-out {demo.sum()} calls")

    # 1. Out-of-fold logits on training sessions (leave-session-out) for calibration and thresholds
    oof_logit = np.zeros(tr.sum())
    for a, b in GroupKFold(5).split(Etr, ytr, str_):
        oof_logit[b] = valence_model().fit(Etr[a], ytr[a]).decision_function(Etr[b])
    T = fit_temperature(oof_logit, ytr)
    p_oof = sigmoid(oof_logit / T)
    print(f"temperature {T:.2f}; ECE raw {ece(sigmoid(oof_logit), ytr):.3f} -> calibrated {ece(p_oof, ytr):.3f}")

    calm_p = np.sort(p_oof[ytr == 0])
    alarm_at = max(0.5, float(np.quantile(calm_p, 1 - MAX_FALSE_ALARM)))
    status = np.where(p_oof >= alarm_at, 1, np.where(p_oof < CALM_BELOW, 0, -1))
    decided = status >= 0
    print(f"distressed if p >= {alarm_at:.2f}, calm if p < {CALM_BELOW}; "
          f"decides {decided.mean():.0%} of calls, balanced acc on those {balanced_accuracy_score(ytr[decided], status[decided]):.3f}")
    print(f"  calm calls called distressed: {(status[ytr == 0] == 1).mean():.0%}; "
          f"distressed calls caught: {(status[ytr == 1] == 1).mean():.0%}")

    # 2. Final models on all training sessions
    val = valence_model().fit(Etr, ytr)
    ctx = make_pipeline(StandardScaler(), LogisticRegression(C=0.01, max_iter=3000, class_weight="balanced"))
    ctx.fit(Etr, t.context.to_numpy()[tr])

    # 3. Not-a-pig: SoundWel (train) + ESC-50 'pig' vs ESC-50 everything else; ESC fold 5 held out
    esc = np.load(ROOT / "data/emb/esc50.npz", allow_pickle=True)
    meta = pd.read_csv(ROOT / "data/raw/esc50/ESC-50-master/meta/esc50.csv").set_index("filename").loc[esc["ids"]]
    esc_pig = (meta.category == "pig").to_numpy()
    esc_test = (meta.fold == 5).to_numpy()
    Xp = np.vstack([Etr, esc["emb_call"][~esc_test]])
    yp = np.concatenate([np.ones(len(Etr)), esc_pig[~esc_test].astype(float)])
    pig = make_pipeline(StandardScaler(), LogisticRegression(C=0.01, max_iter=3000, class_weight="balanced")).fit(Xp, yp)
    test_X = np.vstack([E[demo], esc["emb_call"][esc_test]])
    test_y = np.concatenate([np.ones(demo.sum()), esc_pig[esc_test]])
    pp = pig.predict_proba(test_X)[:, 1]
    print(f"pig detector on unseen data: AUC {roc_auc_score(test_y, pp):.3f}; "
          f"demo pig calls kept {(pp[:demo.sum()] >= 0.5).mean():.0%}; "
          f"ESC non-pig rejected {(pp[demo.sum():][~esc_pig[esc_test]] < 0.5).mean():.0%}")

    # 4. Nearest-neighbour index and an out-of-distribution distance threshold
    U = unit(Etr).astype(np.float32)
    other_sess = str_[:, None] != str_[None, :]
    sims = U @ U.T
    nn_sim_oos = np.where(other_sess, sims, -1).max(axis=1)   # each call's best match in *other* sessions
    ood_sim = float(np.quantile(nn_sim_oos, 0.01))
    print(f"OOD: flag if best cosine match < {ood_sim:.3f} (1st percentile of cross-session matches)")
    esc_sim = (unit(esc["emb_call"][~esc_pig]) @ U.T).max(axis=1)
    print(f"  ESC non-pig clips below it: {(esc_sim < ood_sim).mean():.0%}")

    # 5. Typical measured values per valence, for explanations
    lab = pd.read_csv(OUT)
    typical = {name: {"duration_s": round(float(g.Dur.median()), 3), "f0_mean_hz": round(float(g.F0Mean.median()), 1)}
               for name, g in [("calm", lab[lab.valence == 0]), ("distressed", lab[lab.valence == 1])]}

    MODEL_OUT.parent.mkdir(exist_ok=True)
    joblib.dump({
        "valence": val, "temperature": T, "alarm_at": alarm_at, "calm_below": CALM_BELOW,
        "context": ctx, "pig": pig, "ood_sim": ood_sim, "typical": typical,
        "index": {"emb": U.astype(np.float32), "id": t.file.to_numpy()[tr], "valence": ytr,
                  "context": t.context.to_numpy()[tr], "session": str_,
                  "path": pd.read_csv(ROOT / "data/manifest_soundwel.csv").set_index("id").loc[t.file[tr], "path"].to_numpy()},
        "demo_sessions": DEMO_SESSIONS,
    }, MODEL_OUT)

    # 6. Demo clip list: every held-out call with the final model's verdict
    pd_ = sigmoid(val.decision_function(E[demo]) / T)
    d = t[demo][["file", "session", "valence", "context"]].assign(p_distressed=pd_.round(3))
    d["status"] = np.where(pd_ >= alarm_at, "distressed", np.where(pd_ < CALM_BELOW, "calm", "unsure"))
    d["truth"] = np.where(d.valence == 1, "distressed", "calm")
    d.drop(columns="valence").to_csv(DEMO_CLIPS, index=False)
    dec = d.status != "unsure"
    print(f"demo hold-out: decided {dec.mean():.0%}, correct on decided {(d.status[dec] == d.truth[dec]).mean():.0%}, "
          f"balanced acc {balanced_accuracy_score(d.truth[dec], d.status[dec]):.3f}")
    print(d.groupby(["session", "truth"]).status.value_counts().unstack(fill_value=0).to_string())
    print(f"saved {MODEL_OUT} and {DEMO_CLIPS}")


if __name__ == "__main__":
    main()
