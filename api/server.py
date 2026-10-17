"""Real API: same contract and routes as the mock, backed by Perch + the trained models.

Run:  uvicorn api.server:app --port 8000
Needs models/oink.joblib (python -m ml.train_final).
"""

import io
import os
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

from ml.embed import SR, embed_waveforms
from .routes import build_router
from .schemas import ContextGuess, Explanation, Features, Health, Prediction, SimilarCall, Valence
from .state import Store, new_id, now
from .trends import Trends, build_trends_router

load_dotenv()
ROOT = Path(__file__).resolve().parents[1]
M = joblib.load(ROOT / "models/oink.joblib")
store = Store()
trends = Trends()

# The evidence/explanation workstream provides these; fall back to minimal versions until it lands.
try:
    from ml.evidence import load_typical, measure
except ImportError:
    def load_typical():
        return None

    def measure(y: np.ndarray, sr: int) -> dict:
        f0 = None
        try:
            f, voiced, _ = librosa.pyin(y, fmin=50, fmax=2000, sr=sr)
            if np.any(voiced):
                f0 = round(float(np.nanmean(f[voiced])), 1)
        except Exception:  # noqa: BLE001 - pitch is optional evidence
            pass
        rms = float(np.sqrt(np.mean(y ** 2)) + 1e-9)
        return {"duration_s": round(len(y) / sr, 3), "f0_mean_hz": f0,
                "loudness_db": round(20 * np.log10(rms), 1),
                "spectral_centroid_hz": round(float(librosa.feature.spectral_centroid(y=y, sr=sr).mean()), 1),
                "am_rate_hz": None}

try:
    from ml.explain import explain, prepare, template

    def quick_explain(ev: dict) -> dict:
        return {"text": template(prepare(ev)), "source": "template"}
except ImportError:
    def explain(ev: dict) -> dict:
        if ev["status"] == "unsure":
            text = ("I'm not sure this is a pig call." if ev.get("abstain_reason") == "not_pig"
                    else "I'm not confident either way about this call.")
            return {"text": text, "source": "template"}
        f, typ = ev["features"], ev["typical"][ev["status"]]
        sim = ev["similar_calls"][0] if ev["similar_calls"] else None
        conf = ev["p_distressed"] if ev["status"] == "distressed" else 1 - ev["p_distressed"]
        text = (f"This call sounds {ev['status']} ({conf:.0%} confident). It lasted {f['duration_s']} s "
                f"(typical {ev['status']} call: {typ['duration_s']} s)")
        if f.get("f0_mean_hz"):
            text += f" with a mean pitch of {f['f0_mean_hz']} Hz (typical: {typ['f0_mean_hz']} Hz)"
        text += "."
        if sim:
            text += f" Its closest match is a {sim['status']} call recorded during {sim['context']}."
        return {"text": text, "source": "template"}


    quick_explain = explain  # the fallback above is template-only already

EVIDENCE: dict[str, dict] = {}  # prediction_id -> evidence, so an alert can get the full explanation later


def upgrade_explanation(alert, pred):
    """Barn-stream calls get the instant template; when one triggers an alert, fetch the LLM
    explanation in the background so "why?" gets it, without slowing the stream down."""
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
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(data); f.flush()
        out = subprocess.run(["ffmpeg", "-v", "error", "-i", f.name, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                             capture_output=True)
    if out.returncode != 0 or not out.stdout:
        raise HTTPException(400, f"could not decode audio: {out.stderr.decode()[:200]}")
    return np.frombuffer(out.stdout, np.float32).copy()


def to_wav(y: np.ndarray, sr: int = SR) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def reference_clip(i: int) -> str:
    cid = str(M["index"]["id"][i])
    if not store.get_clip(cid):
        store.put_clip(cid, Path(ROOT / M["index"]["path"][i]).read_bytes())
    return cid


def real_predict(data: bytes, filename: str, pen_id=None, hint=None) -> Prediction:
    y = decode(data, filename)
    if len(y) < SR // 50:
        raise HTTPException(400, "clip too short")
    r = embed_waveforms([y])
    e = r["emb_call"]

    p = float(1 / (1 + np.exp(-M["valence"].decision_function(e)[0] / M["temperature"])))
    pig_p = float(M["pig"].predict_proba(e)[0, 1])
    u = e[0] / np.linalg.norm(e[0])
    sims = M["index"]["emb"] @ u
    best = float(sims.max())

    abstain = None
    if pig_p < 0.5 or best < M["ood_sim"]:
        status, abstain = "unsure", "not_pig"
    elif p >= M["alarm_at"]:
        status = "distressed"
    elif p < M["calm_below"]:
        status = "calm"
    else:
        status, abstain = "unsure", "low_confidence"

    ctx_p = M["context"].predict_proba(e)[0]
    top = np.argsort(ctx_p)[::-1][:3]
    context_top3 = [ContextGuess(label=str(M["context"].classes_[i]), p=round(float(ctx_p[i]), 3)) for i in top]

    similar, seen = [], set()
    for i in np.argsort(sims)[::-1]:
        s = M["index"]["session"][i]
        if s in seen:
            continue  # one neighbour per session, so matches come from different recordings
        seen.add(s)
        cid = reference_clip(i)
        similar.append(SimilarCall(clip_id=cid, status="distressed" if M["index"]["valence"][i] else "calm",
                                   context=str(M["index"]["context"][i]), similarity=round(float(sims[i]), 3),
                                   audio_url=f"/audio/{cid}"))
        if len(similar) == 3:
            break

    features = Features(**measure(y, SR))
    evidence = {"status": status, "abstain_reason": abstain, "p_distressed": round(p, 3),
                "features": features.model_dump(),
                # same measurement on both sides once ml/typical.json exists; key medians until then
                "typical": load_typical() or M["typical"],
                "similar_calls": [s.model_dump(include={"status", "context", "similarity"}) for s in similar]}
    # One-off uploads (a person is waiting to read it) get the LLM; the barn stream gets the template.
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
        context_top3=context_top3, features=features, similar_calls=similar,
        explanation=Explanation(**expl), audio_url=f"/audio/{clip_id}",
    )


embed_waveforms([np.zeros(SR, np.float32)])  # warm up Perch so the first request is fast

app = FastAPI(title="Oinkalytics API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(build_router(store, real_predict,
                                Health(ok=True, mode="real", model="perch_v2 emb_call + logreg (leave-session-out 0.675)"),
                                on_alert=upgrade_explanation,
                                on_prediction=trends.record, on_reset=trends.reset))
app.include_router(build_trends_router(trends))
