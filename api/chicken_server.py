"""Chicken health API: the same contract and routes as the pig server, different model.

Run:  uvicorn api.chicken_server:app --port 8001
Needs models/chicken.joblib (python -m ml.chicken_train).

The dashboard and the Photon bot need no changes at all - point OINK_API at this
port and every endpoint behaves the same. Two places where the shared contract in
api/schemas.py is stretched rather than changed, because that file is frozen:

  * `status` reuses the pig words. "calm" means a healthy-sounding recording and
    "distressed" means an unhealthy-sounding one, so the dashboard's green/red
    and the bot's alert rule keep working untouched.
  * `abstain_reason` reuses "not_pig" as "not the target species". The text the
    user actually reads comes from `explanation.text`, which says "I'm not sure
    this is a chicken recording".

`context_top3` is always empty: this dataset has no recording-context labels, and
inventing them would be the dishonest kind of shortcut this project exists to avoid.
"""

import io
import subprocess
import tempfile
import threading
from pathlib import Path

import joblib
import librosa
import numpy as np
import soundfile as sf
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from ml.chicken_explain import explain, prepare, template
from ml.embed import SR, WIN, embed_waveforms
from ml.evidence import measure

from .routes import build_router
from .schemas import Explanation, Features, Health, Prediction, SimilarCall, Valence
from .state import Store, new_id, now

load_dotenv()
ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models/chicken.joblib"
if not MODEL.exists():
    raise SystemExit(f"{MODEL} missing; run python -m ml.chicken_train first")
M = joblib.load(MODEL)
store = Store()

EVIDENCE: dict[str, dict] = {}   # prediction_id -> evidence, so an alert can be upgraded later


def quick_explain(ev: dict) -> dict:
    """Instant template, for the barn stream where nobody is waiting to read it."""
    return {"text": template(prepare(ev)), "source": "template"}


def upgrade_explanation(alert, pred):
    """A streamed clip gets the template; if it triggers an alert, fetch the LLM wording
    in the background so "why?" has it, without slowing the stream down."""
    ev = EVIDENCE.get(pred.prediction_id)
    if not ev:
        return

    def run():
        e = Explanation(**explain(ev))
        pred.explanation = e
        alert.explanation = e

    threading.Thread(target=run, daemon=True).start()


def decode(data: bytes, filename: str) -> np.ndarray:
    """Any audio ffmpeg can read -> mono float32 at Perch's 32 kHz."""
    suffix = Path(filename).suffix or ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        f.flush()
        name = f.name
    try:
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", name, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
            capture_output=True,
        )
    finally:
        Path(name).unlink(missing_ok=True)
    if out.returncode != 0 or not out.stdout:
        raise HTTPException(400, f"could not decode audio: {out.stderr.decode()[:200]}")
    return np.frombuffer(out.stdout, np.float32).copy()


def to_wav(y: np.ndarray, sr: int = SR) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def windows(y: np.ndarray) -> list[np.ndarray]:
    """The same 5 s windowing ml/chicken_embed.py trains on, so inference matches training."""
    if len(y) <= WIN:
        w = np.zeros(WIN, np.float32)
        w[:len(y)] = y
        return [w]
    out = []
    for s in range(0, len(y), WIN):
        seg = y[s:s + WIN]
        if len(seg) < SR and out:      # drop a tail under 1 s rather than pad it
            break
        w = np.zeros(WIN, np.float32)
        w[:len(seg)] = seg
        out.append(w)
    return out


def reference_clip(i: int) -> str:
    """Cache and serve the neighbour's own 5 s window, sliced out of its recording."""
    cid = f"ref_{i}"
    if not store.get_clip(cid):
        path = ROOT / str(M["index"]["path"][i])
        k = int(M["index"]["window"][i])
        y, _ = librosa.load(path, sr=SR, mono=True, offset=k * WIN / SR, duration=WIN / SR)
        store.put_clip(cid, to_wav(y))
    return cid


def chicken_predict(data: bytes, filename: str, pen_id=None, hint=None) -> Prediction:
    y = decode(data, filename)
    if len(y) < SR // 50:
        raise HTTPException(400, "clip too short")

    # Average the windows of the recording, which is how ml/chicken_train.py scores a file.
    wins = windows(y)
    e = embed_waveforms(wins)[M["embedding"]]
    logit = float(np.mean(M["clf"].decision_function(e)))
    p = float(1 / (1 + np.exp(-logit / M["temperature"])))

    chicken_p = float(np.mean(M["detector"].predict_proba(e)[:, 1])) if M.get("detector") is not None else 1.0
    u = e.mean(axis=0)
    u = u / max(np.linalg.norm(u), 1e-12)
    sims = M["index"]["emb"] @ u
    best = float(sims.max())

    abstain = None
    if chicken_p < 0.5 or best < M["ood_sim"]:
        status, abstain = "unsure", "not_pig"        # contract value; the text says "chicken"
    elif p >= M["alarm_at"]:
        status = "distressed"                        # contract value for "sounds unhealthy"
    elif p < M["healthy_below"]:
        status = "calm"                              # contract value for "sounds healthy"
    else:
        status, abstain = "unsure", "low_confidence"

    similar, seen = [], set()
    for i in np.argsort(sims)[::-1]:
        rec = str(M["index"]["id"][i])
        if rec in seen:
            continue      # one neighbour per recording, so matches come from different recordings
        seen.add(rec)
        cid = reference_clip(i)
        similar.append(SimilarCall(
            clip_id=cid,
            status="distressed" if M["index"]["sick"][i] else "calm",
            context="unhealthy" if M["index"]["sick"][i] else "healthy",
            similarity=round(float(sims[i]), 3),
            audio_url=f"/audio/{cid}",
        ))
        if len(similar) == 3:
            break

    features = Features(**measure(y, SR))
    # chicken_explain speaks healthy/sick/unsure, so translate the contract words back.
    ev_status = {"calm": "healthy", "distressed": "sick", "unsure": "unsure"}[status]
    evidence = {
        "status": ev_status,
        "abstain_reason": "not_chicken" if abstain == "not_pig" else abstain,
        "p_sick": round(p, 3),
        "features": features.model_dump(),
        "typical": M["typical"],
    }
    expl = quick_explain(evidence) if pen_id else explain(evidence)

    clip_id = new_id("clip")
    store.put_clip(clip_id, to_wav(y))
    pred_id = new_id("pred")
    if pen_id:
        EVIDENCE[pred_id] = evidence
    return Prediction(
        prediction_id=pred_id, clip_id=clip_id, pen_id=pen_id, created_at=now(),
        status=status, abstain_reason=abstain,
        valence=Valence(p_distressed=round(p, 3), confidence=round(max(p, 1 - p), 3)),
        context_top3=[],        # no context labels in this dataset; see the module docstring
        features=features, similar_calls=similar,
        explanation=Explanation(**expl), audio_url=f"/audio/{clip_id}",
    )


embed_waveforms([np.zeros(WIN, np.float32)])   # warm up Perch so the first request is fast

_s = M.get("scores", {})
_model_name = (f"perch_v2 {M['embedding']} + logreg "
               f"(leave-recording-out {_s.get('honest_ba', float('nan')):.3f})")

app = FastAPI(title="Oinkalytics Chicken API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(build_router(store, chicken_predict,
                                Health(ok=True, mode="real", model=_model_name),
                                on_alert=upgrade_explanation))
