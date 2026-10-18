"""HTTP routes. The server module supplies `predict_fn(audio_bytes, filename, hint) -> Prediction fields`."""

from typing import Callable, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .schemas import Alert, Health, PenStatus, Prediction
from .state import Store


def build_router(store: Store, predict_fn: Callable[..., Prediction], health: Health,
                 on_alert: Optional[Callable[[Alert, Prediction], None]] = None) -> APIRouter:
    r = APIRouter()

    @r.get("/health", response_model=Health)
    def get_health():
        return health

    @r.post("/predict", response_model=Prediction)
    async def predict(
        file: UploadFile = File(..., description="Any audio ffmpeg can read (wav, m4a, mp3, caf...)"),
        pen_id: Optional[str] = Form(None, description="Set by the simulator; omit for one-off uploads"),
        mock_label: Optional[str] = Form(None, description="Mock only: force calm|distressed|unsure"),
    ):
        data = await file.read()
        if not data:
            raise HTTPException(400, "empty file")
        pred = predict_fn(data, file.filename or "clip", pen_id=pen_id, hint=mock_label)
        alert = store.record(pred)
        if alert and on_alert:
            on_alert(alert, pred)
        return pred

    @r.get("/predictions/{prediction_id}", response_model=Prediction)
    def get_prediction(prediction_id: str):
        p = store.predictions.get(prediction_id)
        if not p:
            raise HTTPException(404, "unknown prediction")
        return p

    @r.get("/pens", response_model=list[PenStatus])
    def pens():
        return store.pens()

    @r.get("/pens/{pen_id}", response_model=PenStatus)
    def pen(pen_id: str):
        return store.pen_status(pen_id)

    @r.post("/pens/{pen_id}/reset", response_model=PenStatus)
    def reset_pen(pen_id: str):
        """Clear one pen's recent calls (alerts already sent stay in the alert list)."""
        if pen_id not in store.history:
            raise HTTPException(404, f"unknown pen {pen_id}")
        store.reset_pen(pen_id)
        return store.pen_status(pen_id)

    class PenName(BaseModel):
        name: str = Field(min_length=1, max_length=60)

    @r.post("/pens/{pen_id}/name", response_model=PenStatus)
    def name_pen(pen_id: str, body: PenName):
        """Give a pen a display name; alerts and status then use it ("North barn" instead of "Pen L1-x7k2")."""
        store.set_name(pen_id, body.name.strip())
        return store.pen_status(pen_id)

    @r.post("/pens/{pen_id}/remove")
    def remove_pen(pen_id: str):
        """Stop tracking a pen the user deleted (alerts already sent stay listed)."""
        store.remove_pen(pen_id)
        return {"ok": True}

    @r.get("/alerts", response_model=list[Alert])
    def alerts(after: Optional[str] = Query(None, description="Return only alerts newer than this alert_id")):
        return store.alerts_after(after)

    @r.get("/alerts/latest", response_model=Alert)
    def latest_alert(pen_id: Optional[str] = None):
        found = [a for a in store.alerts if pen_id is None or a.pen_id == pen_id]
        if not found:
            raise HTTPException(404, "no alerts yet")
        return found[-1]

    @r.get("/audio/{clip_id}")
    def audio(clip_id: str):
        clip = store.get_clip(clip_id)
        if not clip:
            raise HTTPException(404, "unknown clip")
        return Response(content=clip[0], media_type=clip[1])

    @r.post("/reset")
    def reset():
        """Dev only: clear pens, alerts and predictions."""
        store.reset()
        return {"ok": True}

    return r
