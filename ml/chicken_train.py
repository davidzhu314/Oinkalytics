"""Train the chicken healthy-vs-sick model and save it to models/chicken.joblib.

    python -m ml.chicken_train

Same method as ml/train_final.py for the pigs, and deliberately a new file rather
than an edit of it: balanced logistic regression on Perch embeddings, temperature
scaling on out-of-fold logits, an abstain band chosen to cap false alarms, a
not-a-chicken detector plus a distance-to-training-set check, and a
nearest-neighbour index.

What differs from the pig version, and why:

  * The unit is a 5 s window, not a file (see ml/chicken_embed.py). Windows from
    one recording are near duplicates, so the honest split is leave-recording-out
    (GroupKFold on the recording id). Splitting windows at random is the naive
    split, and the gap between the two is this model's version of the pig gap.
  * There is no bird, pen or session metadata in this dataset, so
    leave-recording-out is the strictest split available. It does NOT show that
    the model generalises to a new farm, and we say so.
  * `noise` (86 recordings) is the dataset's own not-a-chicken class, better
    matched to this audio than ESC-50.
  * A duration-only baseline is reported, because the two classes have very
    different clip lengths here and a model that only measures length would look
    good for the wrong reason.
"""

import os
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold, KFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
LABELS = ROOT / "data/chicken_labels.csv"

# CHICKEN_NORM=1 trains on the RMS-normalised embeddings instead, and saves to a
# separate model file. The raw recordings leak the label through loudness alone
# (unhealthy files are ~9 dB louder), so the normalised run is the honest one.
NORM = os.environ.get("CHICKEN_NORM", "0") == "1"
EMB = ROOT / ("data/emb/chicken_norm.npz" if NORM else "data/emb/chicken.npz")
MODEL_OUT = ROOT / ("models/chicken_norm.joblib" if NORM else "models/chicken.joblib")
DEMO_OUT = ROOT / ("data/chicken_demo_clips_norm.csv" if NORM else "data/chicken_demo_clips.csv")

N_DEMO_PER_CLASS = 6     # whole recordings held out of everything, for demo clips
MAX_FALSE_ALARM = 0.20   # share of healthy windows we allow to be called sick
HEALTHY_BELOW = 0.40     # p_sick below this is "healthy"; between it and the alarm point is "unsure"
SEED = 0
FOLDS = 5


def model(C: float = 0.001):
    return make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=3000, class_weight="balanced"))


def unit(X):
    return X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)


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


def oof_logits(X, y, splits):
    out = np.zeros(len(y))
    for a, b in splits:
        out[b] = model().fit(X[a], y[a]).decision_function(X[b])
    return out


def load():
    if not EMB.exists():
        sys.exit(f"{EMB} missing; run python -m ml.chicken_embed first")
    z = np.load(EMB, allow_pickle=True)
    lab = pd.read_csv(LABELS).set_index("id")
    w = pd.DataFrame({"id": z["ids"], "window": z["window"]})
    w = w.join(lab[["label", "sick", "duration_s"]], on="id")
    if w.label.isna().any():
        sys.exit("embeddings contain ids missing from the label table; rebuild both")
    return w, z


def typical_values(call: pd.DataFrame, per_class: int = 40) -> dict:
    """Median of ml.evidence.measure per class, so explanations compare like with like."""
    import librosa

    from .embed import SR
    from .evidence import measure

    lab = pd.read_csv(LABELS).set_index("id")
    out = {}
    for cls, name in [(0, "healthy"), (1, "sick")]:
        ids = pd.unique(call.id[call.sick == cls])[:per_class]
        rows = []
        for i in ids:
            try:
                y, _ = librosa.load(ROOT / lab.loc[i, "path"], sr=SR, mono=True)
                rows.append(measure(y, SR))
            except Exception:  # noqa: BLE001 - typical values are best effort
                continue
        if not rows:
            continue
        m = pd.DataFrame(rows)
        med = lambda col: float(m[col].dropna().median()) if m[col].notna().any() else None
        out[name] = {
            "duration_s": round(med("duration_s"), 2),
            "f0_mean_hz": round(med("f0_mean_hz"), 0) if med("f0_mean_hz") is not None else None,
            "loudness_db": round(med("loudness_db"), 1),
            "spectral_centroid_hz": round(med("spectral_centroid_hz"), 0),
            "am_rate_hz": round(med("am_rate_hz"), 1) if med("am_rate_hz") is not None else None,
        }
    return out


def main():
    w, z = load()
    which = "emb"   # full 5 s windows, so emb_call would average the same frames
    X_all = z[which]
    print(f"{len(w)} windows from {w.id.nunique()} recordings, using {which!r} ({X_all.shape[1]}-d)"
          + ("  [RMS-normalised audio]" if NORM else "  [raw audio]"))
    print(w.groupby("label").agg(recordings=("id", "nunique"), windows=("id", "size")).to_string())

    is_call = w.sick.notna().to_numpy()
    if is_call.sum() == 0:
        sys.exit("no healthy/unhealthy windows")
    noise = ~is_call

    # Carry the source path so the API can serve a neighbour's audio back.
    w = w.join(pd.read_csv(LABELS).set_index("id")[["path"]], on="id")
    call = w[is_call].reset_index(drop=True)
    Xc = X_all[is_call]
    yc = call.sick.to_numpy().astype(int)
    gc = call.id.to_numpy()

    # Demo hold-out: whole recordings, so no window of them is ever trained on.
    rng = np.random.RandomState(SEED)
    demo_ids = []
    for cls in (0, 1):
        pool = np.unique(call.id[call.sick == cls])
        demo_ids += list(rng.choice(pool, size=min(N_DEMO_PER_CLASS, max(0, len(pool) - FOLDS)), replace=False))
    demo = np.isin(gc, demo_ids)
    tr = ~demo
    Xtr, ytr, gtr = Xc[tr], yc[tr], gc[tr]
    n_groups = len(np.unique(gtr))
    print(f"\ntrain {tr.sum()} windows / {n_groups} recordings; "
          f"demo hold-out {demo.sum()} windows / {len(demo_ids)} recordings")
    if n_groups < FOLDS * 2:
        print(f"  WARNING only {n_groups} training recordings; these numbers will be noisy")
    folds = max(2, min(FOLDS, n_groups))

    # --------------------------------------------- the gap: naive vs honest ----
    chance = max(np.mean(ytr), 1 - np.mean(ytr))
    naive_l = oof_logits(Xtr, ytr, KFold(folds, shuffle=True, random_state=SEED).split(Xtr))
    honest_l = oof_logits(Xtr, ytr, GroupKFold(folds).split(Xtr, ytr, gtr))
    naive_ba = balanced_accuracy_score(ytr, (naive_l >= 0).astype(int))
    honest_ba = balanced_accuracy_score(ytr, (honest_l >= 0).astype(int))
    print("\n--- window-level balanced accuracy ---")
    print(f"  random split over windows (naive) : {naive_ba:.3f}")
    print(f"  leave-recording-out (honest)      : {honest_ba:.3f}")
    print(f"  gap                               : {naive_ba - honest_ba:+.3f}")
    print(f"  always-majority accuracy          : {chance:.3f} (balanced acc 0.500)")

    # Confound check: if clip length alone scores this well, Perch is not the story.
    dur = call.duration_s.to_numpy()[tr].reshape(-1, 1)
    dur_l = oof_logits(dur, ytr, GroupKFold(folds).split(dur, ytr, gtr))
    dur_ba = balanced_accuracy_score(ytr, (dur_l >= 0).astype(int))
    print(f"  duration only, leave-recording-out: {dur_ba:.3f}   <- confound check")

    # ------------------------------------------ calibration and abstain band ----
    T = fit_temperature(honest_l, ytr)
    p_oof = sigmoid(honest_l / T)
    print(f"\ntemperature {T:.2f}; ECE raw {ece(sigmoid(honest_l), ytr):.3f} -> calibrated {ece(p_oof, ytr):.3f}")

    healthy_p = np.sort(p_oof[ytr == 0])
    alarm_at = max(0.5, float(np.quantile(healthy_p, 1 - MAX_FALSE_ALARM))) if len(healthy_p) else 0.5
    status = np.where(p_oof >= alarm_at, 1, np.where(p_oof < HEALTHY_BELOW, 0, -1))
    decided = status >= 0
    print(f"sick if p >= {alarm_at:.2f}, healthy if p < {HEALTHY_BELOW}; decides {decided.mean():.0%} of windows")
    if decided.any() and len(np.unique(ytr[decided])) > 1:
        print(f"  balanced acc on decided windows: {balanced_accuracy_score(ytr[decided], status[decided]):.3f}")
    print(f"  healthy windows called sick: {(status[ytr == 0] == 1).mean():.0%}; "
          f"sick windows caught: {(status[ytr == 1] == 1).mean():.0%}")

    # --------------------------------------------- recording-level verdicts ----
    # What a farm would act on: average the windows of one recording.
    rec = pd.DataFrame({"id": gtr, "y": ytr, "p": p_oof}).groupby("id").agg(y=("y", "first"), p=("p", "mean"))
    rec_pred = (rec.p >= alarm_at).astype(int)
    rec_ba = balanced_accuracy_score(rec.y, rec_pred) if len(np.unique(rec.y)) > 1 else float("nan")
    print(f"\nrecording-level (mean of its windows), leave-recording-out: "
          f"balanced acc {rec_ba:.3f} over {len(rec)} recordings")
    if len(np.unique(rec.y)) > 1:
        print(f"  AUC {roc_auc_score(rec.y, rec.p):.3f}")

    clf = model().fit(Xtr, ytr)

    # ------------------------------------------------ not-a-chicken detector ----
    detector = None
    if noise.sum() > 0:
        nz = w[noise].reset_index(drop=True)
        Xn, gn = X_all[noise], nz.id.to_numpy()
        hold = set(np.unique(gn)[::4])          # every 4th noise recording held out
        n_tr, n_te = ~np.isin(gn, list(hold)), np.isin(gn, list(hold))
        if n_tr.sum() > 0:
            Xd = np.vstack([Xtr, Xn[n_tr]])
            yd = np.concatenate([np.ones(len(Xtr)), np.zeros(n_tr.sum())])
            detector = model(C=0.01).fit(Xd, yd)
            te_X = np.vstack([Xc[demo], Xn[n_te]]) if demo.any() or n_te.any() else None
            te_y = np.concatenate([np.ones(demo.sum()), np.zeros(n_te.sum())])
            if te_X is not None and len(np.unique(te_y)) > 1:
                pp = detector.predict_proba(te_X)[:, 1]
                print(f"\nnot-a-chicken detector on unseen recordings: AUC {roc_auc_score(te_y, pp):.3f}; "
                      f"demo chicken windows kept {(pp[:demo.sum()] >= 0.5).mean():.0%}; "
                      f"held-out noise rejected {(pp[demo.sum():] < 0.5).mean():.0%}")

    # ------------------------------------------ neighbours and OOD distance ----
    U = unit(Xtr).astype(np.float32)
    other = gtr[:, None] != gtr[None, :]
    best_other = np.where(other, U @ U.T, -1).max(axis=1)
    ood_sim = float(np.quantile(best_other, 0.01))
    print(f"OOD: flag if best cosine match < {ood_sim:.3f} (1st percentile of cross-recording matches)")

    typical = typical_values(call[tr].reset_index(drop=True))
    print(f"typical measured values: {typical}")

    MODEL_OUT.parent.mkdir(exist_ok=True)
    joblib.dump({
        "clf": clf, "temperature": float(T), "alarm_at": alarm_at, "healthy_below": HEALTHY_BELOW,
        "detector": detector, "ood_sim": ood_sim, "typical": typical, "embedding": which,
        # path + window locate a neighbour's 5 s slice so the API can play it back
        "index": {"emb": U, "id": gtr, "sick": ytr,
                  "path": call.path.to_numpy()[tr], "window": call.window.to_numpy()[tr]},
        "demo_ids": demo_ids,
        "scores": {
            "naive_ba": float(naive_ba), "honest_ba": float(honest_ba),
            "duration_only_ba": float(dur_ba), "recording_ba": float(rec_ba),
            "temperature": float(T), "alarm_at": float(alarm_at),
            "n_windows": int(len(w)), "n_recordings": int(w.id.nunique()),
            "n_train_recordings": int(n_groups),
        },
    }, MODEL_OUT)

    # ------------------------------------------------------------ demo clips ----
    p_demo = sigmoid(clf.decision_function(Xc[demo]) / T) if demo.any() else np.array([])
    if demo.any():
        d = pd.DataFrame({"id": gc[demo], "p_sick": p_demo,
                          "truth": np.where(yc[demo] == 1, "sick", "healthy")})
        per_file = d.groupby("id").agg(p_sick=("p_sick", "mean"), truth=("truth", "first")).reset_index()
        per_file["p_sick"] = per_file.p_sick.round(3)
        per_file["status"] = np.where(per_file.p_sick >= alarm_at, "sick",
                                      np.where(per_file.p_sick < HEALTHY_BELOW, "healthy", "unsure"))
        per_file.to_csv(DEMO_OUT, index=False)
        dec = per_file.status != "unsure"
        line = f"\ndemo hold-out recordings: decided {dec.mean():.0%}"
        if dec.any():
            line += f", correct on decided {(per_file.status[dec] == per_file.truth[dec]).mean():.0%}"
        print(line)
        print(per_file.to_string(index=False))
    print(f"\nsaved {MODEL_OUT}" + (f" and {DEMO_OUT}" if demo.any() else ""))


if __name__ == "__main__":
    main()
