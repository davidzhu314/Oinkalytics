"""The shipped decision rule, shared by the API (api/server.py) and offline tests (ml/noise_test.py).

Given Perch `emb_call` embeddings and the trained bundle (models/oink.joblib), returns per call:
calibrated p_distressed, the pig-detector probability, the best cosine match to the training index,
and the verdict: "not a pig" first, then distressed / calm / unsure by the calibrated thresholds.
"""

import numpy as np


def verdict(E: np.ndarray, M: dict) -> dict:
    E = np.atleast_2d(E)
    p = 1 / (1 + np.exp(-M["valence"].decision_function(E) / M["temperature"]))
    pig_p = M["pig"].predict_proba(E)[:, 1]
    U = E / np.linalg.norm(E, axis=1, keepdims=True)
    sims = U @ M["index"]["emb"].T
    best = sims.max(axis=1)

    not_pig = (pig_p < 0.5) | (best < M["ood_sim"])
    status = np.where(not_pig, "unsure",
                      np.where(p >= M["alarm_at"], "distressed",
                               np.where(p < M["calm_below"], "calm", "unsure")))
    abstain = np.where(not_pig, "not_pig", np.where(status == "unsure", "low_confidence", None))
    return {"p": p, "pig_p": pig_p, "sims": sims, "best": best, "status": status, "abstain": abstain}
