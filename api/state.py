"""Pen tracking, alert rules and clip storage. Real logic, shared by the mock and real servers."""

import os
import threading
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone

from .schemas import Alert, PenStatus, Prediction

WINDOW = int(os.getenv("ALERT_WINDOW", 5))
THRESHOLD = int(os.getenv("ALERT_THRESHOLD", 3))
COOLDOWN = timedelta(seconds=int(os.getenv("ALERT_COOLDOWN_S", 300)))
PENS = [p.strip() for p in os.getenv("PENS", "1,2,3,4").split(",") if p.strip()]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def now() -> datetime:
    return datetime.now(timezone.utc)


class Store:
    def __init__(self):
        self._lock = threading.Lock()
        self.names: dict[str, str] = {}  # pen_id -> display name; survives /reset (names aren't calls)
        self.reset()

    def label(self, pen_id: str) -> str:
        return self.names.get(pen_id) or f"Pen {pen_id}"

    def set_name(self, pen_id: str, name: str) -> None:
        """Name a pen (and list it in /pens even before its first call)."""
        with self._lock:
            self.names[pen_id] = name
            self.history.setdefault(pen_id, deque(maxlen=WINDOW))

    def remove_pen(self, pen_id: str) -> None:
        """Stop tracking a pen: it leaves /pens and can't alert. Alerts already sent stay listed."""
        with self._lock:
            self.history.pop(pen_id, None)
            self.last_alert_at.pop(pen_id, None)
            self.names.pop(pen_id, None)

    def reset(self):
        with self._lock:
            self.predictions: dict[str, Prediction] = {}
            self.clips: dict[str, tuple[bytes, str]] = {}
            self.history: dict[str, deque[Prediction]] = {p: deque(maxlen=WINDOW) for p in PENS}
            self.alerts: list[Alert] = []
            self.last_alert_at: dict[str, datetime] = {}

    def reset_pen(self, pen_id: str) -> None:
        """Forget one pen's recent calls and its alert cooldown (the hub calls this when a pen's scenario changes)."""
        with self._lock:
            if pen_id in self.history:
                self.history[pen_id].clear()
            self.last_alert_at.pop(pen_id, None)

    def put_clip(self, clip_id: str, data: bytes, media_type: str = "audio/wav"):
        with self._lock:
            self.clips[clip_id] = (data, media_type)

    def get_clip(self, clip_id: str):
        return self.clips.get(clip_id)

    def record(self, pred: Prediction) -> Alert | None:
        """Store a prediction; if it pushes its pen over the threshold (and not in cooldown), raise an alert."""
        with self._lock:
            self.predictions[pred.prediction_id] = pred
            if pred.pen_id is None or pred.status == "unsure":
                return None
            hist = self.history.setdefault(pred.pen_id, deque(maxlen=WINDOW))
            hist.append(pred)
            flagged = [p for p in hist if p.status == "distressed"]
            if pred.status != "distressed" or len(flagged) < THRESHOLD:
                return None
            last = self.last_alert_at.get(pred.pen_id)
            if last and pred.created_at - last < COOLDOWN:
                return None
            conf = sum(p.valence.p_distressed for p in flagged) / len(flagged)
            alert = Alert(
                alert_id=new_id("alrt"),
                pen_id=pred.pen_id,
                created_at=pred.created_at,
                pen_name=self.names.get(pred.pen_id),
                message=(
                    f"{self.label(pred.pen_id)}: distress calls rising, {len(flagged)} of the last "
                    f"{len(hist)} flagged ({conf:.0%} confidence)."
                ),
                distressed=len(flagged),
                window=len(hist),
                confidence=round(conf, 3),
                trigger_prediction_id=pred.prediction_id,
                explanation=pred.explanation,
                audio_url=pred.audio_url,
            )
            self.alerts.append(alert)
            self.last_alert_at[pred.pen_id] = pred.created_at
            return alert

    def pen_status(self, pen_id: str) -> PenStatus:
        hist = list(self.history.get(pen_id, ()))
        n_bad = sum(p.status == "distressed" for p in hist)
        level = "alert" if n_bad >= THRESHOLD else "watch" if n_bad else "calm"
        last = hist[-1] if hist else None
        summary = (
            f"{self.label(pen_id)}: {level.upper()}, {n_bad} of last {len(hist)} distressed"
            if hist else f"{self.label(pen_id)}: no calls yet"
        )
        return PenStatus(
            pen_id=pen_id,
            level=level,
            window=len(hist),
            distressed=n_bad,
            last_prediction_id=last.prediction_id if last else None,
            updated_at=last.created_at if last else None,
            summary=summary,
            name=self.names.get(pen_id),
        )

    def pens(self) -> list[PenStatus]:
        return [self.pen_status(p) for p in self.history]

    def alerts_after(self, after: str | None) -> list[Alert]:
        """Alerts newer than the given alert_id (all alerts if None or unknown)."""
        if after is None:
            return list(self.alerts)
        for i, a in enumerate(self.alerts):
            if a.alert_id == after:
                return self.alerts[i + 1:]
        return list(self.alerts)
