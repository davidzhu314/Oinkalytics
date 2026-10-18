"""The API contract. Frozen at hour 12: add fields if you must, never rename or remove.

The mock server and the real server both return exactly these shapes, so the dashboard
and the Photon bot can build against the mock and switch to the real one without changes.
"""

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

Status = Literal["calm", "distressed", "unsure"]
AbstainReason = Literal["low_confidence", "not_pig"]
PenLevel = Literal["calm", "watch", "alert"]


class Valence(BaseModel):
    p_distressed: float = Field(description="Calibrated probability the call is negative valence, 0-1")
    confidence: float = Field(description="Probability of the predicted class, max(p, 1-p)")


class ContextGuess(BaseModel):
    label: str = Field(description="SoundWel context, e.g. Isolation, Restrain, Reunion")
    p: float


class Features(BaseModel):
    """Measured from the audio itself. The explanation may only cite these numbers."""
    duration_s: float
    f0_mean_hz: Optional[float] = Field(None, description="Mean pitch; null if unvoiced")
    loudness_db: float = Field(description="RMS level, dBFS")
    spectral_centroid_hz: float
    am_rate_hz: Optional[float] = Field(None, description="Amplitude modulation rate")


class SimilarCall(BaseModel):
    clip_id: str
    status: Literal["calm", "distressed"]
    context: str
    similarity: float = Field(description="Cosine similarity, 0-1")
    audio_url: str


class Explanation(BaseModel):
    text: str
    source: Literal["llm", "template"]


class Prediction(BaseModel):
    prediction_id: str
    clip_id: str
    pen_id: Optional[str] = None
    created_at: datetime
    status: Status
    abstain_reason: Optional[AbstainReason] = Field(None, description="Set only when status is 'unsure'")
    valence: Valence
    context_top3: list[ContextGuess] = Field(
        description="Random-split accuracy only (contexts are tied to sessions); label it that way in the UI"
    )
    features: Features
    similar_calls: list[SimilarCall] = Field(description="Up to 3 nearest calls, never from the same session")
    explanation: Explanation
    audio_url: str = Field(description="This clip, as WAV. Relative to the API base URL")


class PenStatus(BaseModel):
    pen_id: str
    level: PenLevel = Field(description="alert: >= threshold distressed in window; watch: >= 1; else calm")
    window: int = Field(description="Number of confident predictions considered (unsure ones are skipped)")
    distressed: int
    last_prediction_id: Optional[str] = None
    updated_at: Optional[datetime] = None
    summary: str = Field(description="One line, ready to text: 'Pen 3: ALERT, 4 of last 5 distressed'")
    name: Optional[str] = Field(None, description="Display name set with POST /pens/{pen_id}/name (e.g. 'North barn')")


class Alert(BaseModel):
    alert_id: str
    pen_id: str
    created_at: datetime
    message: str = Field(description="Ready to send as-is")
    pen_name: Optional[str] = Field(None, description="The pen's display name, if one was set")
    distressed: int
    window: int
    confidence: float = Field(description="Mean p_distressed of the flagged calls")
    trigger_prediction_id: str
    explanation: Explanation
    audio_url: str = Field(description="The clip that triggered the alert ('play it')")


class Health(BaseModel):
    ok: bool
    mode: Literal["mock", "real"]
    model: str
