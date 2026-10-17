"""HTTP client for the Oinkalytics API (docs/API.md). The dashboard never imports ML code."""

import os
import tempfile
from pathlib import Path

import httpx

API = os.environ.get("OINK_API", "http://localhost:8000").rstrip("/")
_AUDIO_CACHE = Path(tempfile.gettempdir()) / "oinkalytics-dashboard-audio"


def _client(timeout: float = 10.0) -> httpx.Client:
    return httpx.Client(base_url=API, timeout=timeout)


def health() -> dict | None:
    try:
        with _client(3) as c:
            return c.get("/health").raise_for_status().json()
    except httpx.HTTPError:
        return None


def predict(path: str, pen_id: str | None = None, mock_label: str | None = None) -> dict:
    data = {}
    if pen_id:
        data["pen_id"] = pen_id
    if mock_label:  # only the mock reads this; the real server ignores it
        data["mock_label"] = mock_label
    with _client(30) as c, open(path, "rb") as f:
        return c.post("/predict", files={"file": (Path(path).name, f)}, data=data).raise_for_status().json()


def pens() -> list[dict]:
    with _client(5) as c:
        return c.get("/pens").raise_for_status().json()


def latest_alert() -> dict | None:
    with _client(5) as c:
        r = c.get("/alerts/latest")
        return None if r.status_code == 404 else r.raise_for_status().json()


def reset() -> None:
    with _client(5) as c:
        c.post("/reset").raise_for_status()


def audio_file(audio_url: str) -> str:
    """Download an `audio_url` ("/audio/clip_…") to a cached local WAV for gr.Audio."""
    _AUDIO_CACHE.mkdir(exist_ok=True)
    out = _AUDIO_CACHE / (audio_url.rstrip("/").split("/")[-1] + ".wav")
    if not out.exists():
        with _client(10) as c:
            out.write_bytes(c.get(audio_url).raise_for_status().content)
    return str(out)
