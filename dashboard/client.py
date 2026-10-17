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


# ---------- the barn: which animals live in which pen ----------

def _layout(spec: str) -> dict[str, list[str]]:
    """"1:pig,2:pig+chicken" -> {"1": ["pig"], "2": ["pig", "chicken"]}"""
    pens = {}
    for part in spec.split(","):
        pen, _, animals = part.strip().partition(":")
        pens[pen.strip()] = [a.strip() for a in animals.split("+") if a.strip() in SPECIES]
    return pens


PEN_LAYOUT = _layout(os.environ.get("PEN_LAYOUT", "1:pig,2:pig+chicken,3:chicken,4:pig+chicken"))


def claims(pred: dict | None) -> bool:
    """A model claims a call unless it says it isn't its animal (or it couldn't answer)."""
    return pred is not None and pred.get("abstain_reason") != "not_pig"


def route(path: str, pen_id: str | None = None, mock_truth: tuple[str, str] | None = None) -> dict:
    """Both models listen to one call; the one that recognises its own animal gets the verdict.

    Asks every reachable species API (without a pen, so nothing is counted yet). If exactly one
    claims the call, it is posted again to that API with `pen_id`, so it counts in that pen.
    Both or neither claiming = "not sure which animal", counted nowhere.
    `mock_truth` = (species, calm|distressed) lets mock servers fake the right answers; real
    servers ignore it.
    Returns {"winner": species | None, "preds": {species: pred | None}, "counted": pred | None}.
    """
    preds: dict[str, dict | None] = {}
    for sp, meta in SPECIES.items():
        mock = None
        if mock_truth:
            mock = mock_truth[1] if mock_truth[0] == sp else None
        try:
            name = path if not mock_truth or mock_truth[0] == sp else "noise.wav"  # mock: not my animal
            preds[sp] = _predict_named(path, name, mock_label=mock, base=meta["api"])
        except Exception:
            preds[sp] = None
    claimed = [sp for sp, p in preds.items() if claims(p)]
    winner = claimed[0] if len(claimed) == 1 else None
    counted = None
    if winner and pen_id:
        m = mock_truth[1] if mock_truth else None
        counted = _predict_named(path, path, pen_id=pen_id, mock_label=m, base=SPECIES[winner]["api"])
    return {"winner": winner, "preds": preds, "counted": counted}


def _predict_named(path: str, name: str, pen_id: str | None = None, mock_label: str | None = None,
                   base: str | None = None) -> dict:
    """predict(), but with the filename the server sees (the mocks read hints from it)."""
    data = {}
    if pen_id:
        data["pen_id"] = pen_id
    if mock_label:
        data["mock_label"] = mock_label
    with _client(base, 30) as c, open(path, "rb") as f:
        return c.post("/predict", files={"file": (Path(name).name, f)}, data=data).raise_for_status().json()
