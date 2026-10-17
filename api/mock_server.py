"""Mock API: real contract, real pen/alert logic, fake model.

Run:  uvicorn api.mock_server:app --port 8000 --reload
Docs: http://localhost:8000/docs

The verdict is deterministic per file (same clip -> same answer). Force it with the
`mock_label` form field, or put calm / distress / noise in the filename.
"""

import hashlib
import io
import random

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes import build_router
from .schemas import ContextGuess, Explanation, Features, Health, Prediction, SimilarCall, Valence
from .state import Store, new_id, now
from .trends import Trends, build_trends_router

NEG_CONTEXTS = ["Isolation", "Restrain", "Barren", "Castration", "NovelObject"]
POS_CONTEXTS = ["Reunion", "Run", "Enriched", "PositiveConditioning", "Huddling"]

store = Store()
trends = Trends()


def tone_wav(freq: float, seconds: float = 0.6, sr: int = 16000) -> bytes:
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    y = 0.3 * np.sin(2 * np.pi * freq * t) * np.hanning(t.size)
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV")
    return buf.getvalue()


def pick_status(data: bytes, filename: str, hint: str | None, rng: random.Random) -> str:
    name = filename.lower()
    if hint in ("calm", "distressed", "unsure"):
        return hint
    if any(k in name for k in ("noise", "clap", "cough", "notpig")):
        return "unsure"
    if any(k in name for k in ("distress", "neg")):
        return "distressed"
    if any(k in name for k in ("calm", "pos")):
        return "calm"
    return rng.choices(["calm", "distressed", "unsure"], [0.55, 0.35, 0.10])[0]


def mock_predict(data: bytes, filename: str, pen_id=None, hint=None) -> Prediction:
    rng = random.Random(hashlib.sha256(data).hexdigest())
    status = pick_status(data, filename, hint, rng)

    if status == "distressed":
        p = rng.uniform(0.72, 0.95)
    elif status == "calm":
        p = rng.uniform(0.05, 0.28)
    else:
        p = rng.uniform(0.42, 0.58)
    abstain = None
    if status == "unsure":
        abstain = "not_pig" if any(k in filename.lower() for k in ("noise", "clap", "cough", "notpig")) else "low_confidence"

    feats = Features(
        duration_s=round(rng.uniform(0.6, 1.4) if status == "distressed" else rng.uniform(0.15, 0.45), 3),
        f0_mean_hz=round(rng.uniform(300, 900) if status == "distressed" else rng.uniform(40, 150), 1),
        loudness_db=round(rng.uniform(-18, -8) if status == "distressed" else rng.uniform(-32, -20), 1),
        spectral_centroid_hz=round(rng.uniform(1500, 3500) if status == "distressed" else rng.uniform(500, 1200), 1),
        am_rate_hz=round(rng.uniform(15, 30), 1),
    )

    pool = NEG_CONTEXTS if p >= 0.5 else POS_CONTEXTS
    ctx = rng.sample(pool, 3)
    weights = sorted([rng.random() for _ in range(3)], reverse=True)
    total = sum(weights) * 1.3
    context_top3 = [ContextGuess(label=c, p=round(w / total, 3)) for c, w in zip(ctx, weights)]

    similar = []
    for i in range(3):
        cid = new_id("ref")
        store.put_clip(cid, tone_wav(rng.uniform(200, 800)))
        similar.append(SimilarCall(
            clip_id=cid,
            status="distressed" if p >= 0.5 else "calm",
            context=ctx[i],
            similarity=round(rng.uniform(0.75, 0.95), 3),
            audio_url=f"/audio/{cid}",
        ))

    if status == "unsure":
        text = ("I'm not sure this is a pig call." if abstain == "not_pig"
                else "I'm not confident either way about this call.")
    else:
        word = "distressed" if status == "distressed" else "calm"
        text = (f"[MOCK] This call sounds {word} ({max(p, 1 - p):.0%} confident). It lasted "
                f"{feats.duration_s}s with a mean pitch of {feats.f0_mean_hz} Hz; it is most similar "
                f"to {ctx[0]} calls from other recording sessions.")

    clip_id = new_id("clip")
    store.put_clip(clip_id, data)
    return Prediction(
        prediction_id=new_id("pred"),
        clip_id=clip_id,
        pen_id=pen_id,
        created_at=now(),
        status=status,
        abstain_reason=abstain,
        valence=Valence(p_distressed=round(p, 3), confidence=round(max(p, 1 - p), 3)),
        context_top3=context_top3,
        features=feats,
        similar_calls=similar,
        explanation=Explanation(text=text, source="template"),
        audio_url=f"/audio/{clip_id}",
    )


app = FastAPI(title="Oinkalytics API (mock)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(build_router(store, mock_predict, Health(ok=True, mode="mock", model="mock"),
                                on_prediction=trends.record, on_reset=trends.reset))
app.include_router(build_trends_router(trends))
