"""HTTP client for the Oinkalytics APIs (docs/API.md). The dashboard never imports ML code.

One API per species, same contract. The chicken server adds `species` and `status_label` fields.
"""

import os
import tempfile
from pathlib import Path

import httpx

API = os.environ.get("OINK_API", "http://localhost:8000").rstrip("/")
CHICKEN_API = os.environ.get("CHICKEN_API", "http://localhost:8002").rstrip("/")

# Display words per species. Statuses stay calm|distressed|unsure on the wire (frozen contract).
SPECIES = {
    "pig": {
        "api": API, "name": "Pig", "noun": "pig", "emoji": "🐷", "place": "Barn",
        "words": {"calm": "CALM", "distressed": "DISTRESSED"}, "risk": "distress",
    },
    "chicken": {
        "api": CHICKEN_API, "name": "Chicken", "noun": "chicken", "emoji": "🐔", "place": "Coop",
        "words": {"calm": "HEALTHY", "distressed": "SICK"}, "risk": "sickness",
    },
}

_AUDIO_CACHE = Path(tempfile.gettempdir()) / "oinkalytics-dashboard-audio"


def _client(base: str | None, timeout: float = 10.0) -> httpx.Client:
    return httpx.Client(base_url=base or API, timeout=timeout)


def health(base: str | None = None) -> dict | None:
    try:
        with _client(base, 3) as c:
            return c.get("/health").raise_for_status().json()
    except httpx.HTTPError:
        return None


def predict(path: str, pen_id: str | None = None, mock_label: str | None = None, base: str | None = None) -> dict:
    data = {}
    if pen_id:
        data["pen_id"] = pen_id
    if mock_label:  # only the mock reads this; the real server ignores it
        data["mock_label"] = mock_label
    with _client(base, 30) as c, open(path, "rb") as f:
        return c.post("/predict", files={"file": (Path(path).name, f)}, data=data).raise_for_status().json()


def pens(base: str | None = None) -> list[dict]:
    with _client(base, 5) as c:
        return c.get("/pens").raise_for_status().json()


def latest_alert(base: str | None = None) -> dict | None:
    with _client(base, 5) as c:
        r = c.get("/alerts/latest")
        return None if r.status_code == 404 else r.raise_for_status().json()


def reset(base: str | None = None) -> None:
    with _client(base, 5) as c:
        c.post("/reset").raise_for_status()


def audio_file(audio_url: str, base: str | None = None) -> str:
    """Download an `audio_url` ("/audio/clip_…") to a cached local WAV for gr.Audio."""
    _AUDIO_CACHE.mkdir(exist_ok=True)
    tag = "chicken-" if (base or API) == CHICKEN_API and CHICKEN_API != API else ""
    out = _AUDIO_CACHE / (tag + audio_url.rstrip("/").split("/")[-1] + ".wav")
    if not out.exists():
        with _client(base, 10) as c:
            out.write_bytes(c.get(audio_url).raise_for_status().content)
    return str(out)
