"""The Oinkalytics hub: a single-page site (web/) served by the API, plus the audio clips it plays.

Served at http://localhost:8000/ . Clips come only from an allow-list built at startup
(held-out demo calls + a few ESC-50 clips the "not a pig" detector never trained on),
so /hub-api/clip/{name} can't be used to read arbitrary files.
"""

import csv
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SOUNDWEL = ROOT / "data/raw/soundwel/Soundwel Dataset - Audio and Spectrograms"
ESC = ROOT / "data/raw/esc50/ESC-50-master/audio"
DEMO_TEAMS = ("ETHZ", "NMBU")  # FBN's held-out calm calls mostly read as distressed (DECISIONS.md)

# Picked in advance from recordings the model never trained on (demo hold-out sessions / ESC-50 fold 5).
SHOWCASE = [
    {"key": "calm", "title": "A calm pig", "file": "ETHZETHZPositivePositivepig283.wav",
     "note": "Recorded with a pen mate, food and toys", "truth": "calm"},
    {"key": "distressed", "title": "A distressed pig", "file": "ETHZETHZIsolationIsolationpig2612.wav",
     "note": "Recorded during short isolation", "truth": "distressed"},
    {"key": "notpig", "title": "Not a pig", "file": "5-209989-A-22.wav",
     "note": "Someone clapping", "truth": "not a pig"},
]
NOT_PIG_EXTRA = ["5-218494-A-22.wav", "5-221567-A-22.wav"]


def _clips() -> tuple[dict[str, Path], dict[str, list[dict]]]:
    allowed: dict[str, Path] = {}
    pool: dict[str, list[dict]] = {"calm": [], "distressed": []}
    demo = ROOT / "data/demo_clips.csv"
    if demo.exists():
        with open(demo, newline="") as f:
            for row in csv.DictReader(f):
                path = SOUNDWEL / row["file"]
                if row["session"].split("_")[0] in DEMO_TEAMS and path.exists():
                    allowed[row["file"]] = path
                    pool[row["truth"]].append({"name": row["file"], "context": row["context"]})
    for name in [s["file"] for s in SHOWCASE] + NOT_PIG_EXTRA:
        path = SOUNDWEL / name if (SOUNDWEL / name).exists() else ESC / name
        if path.exists():
            allowed[name] = path
    return allowed, pool


def install(app: FastAPI) -> None:
    allowed, pool = _clips()

    @app.get("/", include_in_schema=False)
    def home():
        return RedirectResponse("/hub/")

    @app.get("/hub-api/clips")
    def clips():
        return {
            "showcase": [{**s, "url": f"/hub-api/clip/{s['file']}"} for s in SHOWCASE if s["file"] in allowed],
            "pool": {k: [{**c, "url": f"/hub-api/clip/{c['name']}"} for c in v] for k, v in pool.items()},
            "not_pig": [f"/hub-api/clip/{n}" for n in NOT_PIG_EXTRA if n in allowed],
        }

    @app.get("/hub-api/clip/{name}")
    def clip(name: str):
        path = allowed.get(name)
        if not path:
            raise HTTPException(404, "unknown clip")
        return FileResponse(path, media_type="audio/wav")

    app.mount("/hub/slides", StaticFiles(directory=ROOT / "docs/slides"), name="slides")
    app.mount("/hub", StaticFiles(directory=WEB, html=True), name="hub")
