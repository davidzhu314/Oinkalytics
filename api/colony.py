"""Bat colony "Who's calling?" for the hub (web/colony.html). Its own environment, separate from the barn.

The identity model (models/bats.joblib, ml/bat_train.py) was trained on 22 recording days; every clip
served here comes from the 6 held-out days. Guesses use the clip's stored Perch embedding
(data/emb/bats.npz, same pipeline as the server), so no audio model runs per request.
"""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parents[1]


def install(app: FastAPI) -> None:
    try:
        B = joblib.load(ROOT / "models/bats.joblib")
        demo = pd.read_csv(ROOT / "data/bat_demo.csv")
        E = np.load(ROOT / "data/emb/bats.npz")["emb_call"]
    except (OSError, ValueError):
        return  # bat data not built on this machine: the colony page says so
    lab = pd.read_csv(ROOT / "data/bat_labels.csv")
    clips = {r.clip: r for r in demo.itertuples()}
    test = lab.day.isin(B["held_days"]).to_numpy()
    pred = B["model"].predict(E[test])
    per_bat = pd.Series(pred == lab.bat.to_numpy()[test]).groupby(lab.bat.to_numpy()[test]).agg(["size", "mean"])

    @app.get("/hub-api/bats")
    def bats():
        return {
            "bats": [{"id": b, "heldout_calls": int(per_bat.loc[b, "size"]) if b in per_bat.index else 0,
                      "heldout_accuracy": float(per_bat.loc[b, "mean"]) if b in per_bat.index else None}
                     for b in B["classes"]],
            "clips": [{"clip": r.clip, "bat": int(r.bat), "day": r.day, "context": r.context, "dur_s": r.dur_s,
                       "url": f"/hub-api/bats/audio/{r.clip}"} for r in demo.itertuples()],
            "heldout": {"accuracy": B["heldout_accuracy"], "balanced": B["heldout_balanced"],
                        "top3": B["heldout_top3"], "days": B["held_days"], "n_test": B["n_test"], "n_train": B["n_train"]},
        }

    @app.get("/hub-api/bats/guess/{clip}")
    def guess(clip: str):
        r = clips.get(clip)
        if r is None:
            raise HTTPException(404, "unknown clip")
        p = B["model"].predict_proba(E[[r.row]])[0]
        order = np.argsort(p)[::-1]
        return {"clip": clip, "guesses": [{"bat": B["classes"][i], "p": round(float(p[i]), 3)} for i in order]}

    @app.get("/hub-api/bats/audio/{clip}")
    def audio(clip: str):
        if clip not in clips:
            raise HTTPException(404, "unknown clip")
        return FileResponse(ROOT / "data/bat_demo" / clip, media_type="audio/wav")
