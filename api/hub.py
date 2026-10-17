"""The Oinkalytics hub: a single-page site (web/) served by the API, plus the audio clips it plays.

Served at http://localhost:8000/ . Clips come only from an allow-list built at startup
(held-out demo calls + a few ESC-50 clips the "not a pig" detector never trained on),
so /hub-api/clip/{name} can't be used to read arbitrary files.

Chickens: pens can hold pigs, chickens or both (PEN_LAYOUT). The page reaches the chicken
workstream's API (CHICKEN_API, same contract) through /hub-api/chicken/*, so the browser never
needs cross-origin access to a teammate's server or tunnel. Chicken demo clips come from
data/chicken_demo_clips.csv (path,truth), also allow-listed.
"""

import csv
import os
from pathlib import Path

import httpx

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SOUNDWEL = ROOT / "data/raw/soundwel/Soundwel Dataset - Audio and Spectrograms"
ESC = ROOT / "data/raw/esc50/ESC-50-master/audio"
DEMO_TEAMS = ("ETHZ", "NMBU")  # FBN's held-out calm calls mostly read as distressed (DECISIONS.md)
CHICKEN_API = os.environ.get("CHICKEN_API", "http://localhost:8002").rstrip("/")
CHICKEN_CLIPS = Path(os.environ.get("CHICKEN_CLIPS", ROOT / "data/chicken_demo_clips.csv"))
PEN_LAYOUT = os.environ.get("PEN_LAYOUT", "1:pig,2:pig+chicken,3:chicken,4:pig+chicken")
TRUTH = {"calm": "calm", "healthy": "calm", "distressed": "distressed", "unhealthy": "distressed", "sick": "distressed"}

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


def _chicken_clips(allowed: dict[str, Path]) -> dict[str, list[dict]]:
    pool: dict[str, list[dict]] = {"calm": [], "distressed": []}
    if not CHICKEN_CLIPS.exists():
        return pool
    with open(CHICKEN_CLIPS, newline="") as f:
        for i, row in enumerate(csv.DictReader(f)):
            p = Path(row.get("path") or row.get("file") or "")
            path = p if p.is_absolute() else ROOT / p
            kind = TRUTH.get((row.get("truth") or "").strip().lower())
            if kind and path.exists():
                name = f"chicken-{i}-{path.name}"
                allowed[name] = path
                pool[kind].append({"name": name})
    return pool


def _layout() -> dict[str, list[str]]:
    pens = {}
    for part in PEN_LAYOUT.split(","):
        pen, _, animals = part.strip().partition(":")
        pens[pen.strip()] = [a for a in animals.split("+") if a in ("pig", "chicken")]
    return pens


def install(app: FastAPI) -> None:
    allowed, pool = _clips()
    chicken_pool = _chicken_clips(allowed)

    @app.get("/", include_in_schema=False)
    def home():
        return RedirectResponse("/hub/")

    @app.get("/hub-api/clips")
    def clips():
        return {
            "showcase": [{**s, "url": f"/hub-api/clip/{s['file']}"} for s in SHOWCASE if s["file"] in allowed],
            "pool": {k: [{**c, "url": f"/hub-api/clip/{c['name']}"} for c in v] for k, v in pool.items()},
            "not_pig": [f"/hub-api/clip/{n}" for n in NOT_PIG_EXTRA if n in allowed],
            "chicken_pool": {k: [{**c, "url": f"/hub-api/clip/{c['name']}"} for c in v] for k, v in chicken_pool.items()},
            "layout": _layout(),
        }

    # Only the chicken API's own endpoints are forwarded, nothing else.
    CHICKEN_PATHS = {"health", "pens", "alerts", "alerts/latest", "predict", "reset"}

    @app.api_route("/hub-api/chicken/{path:path}", methods=["GET", "POST"], include_in_schema=False)
    async def chicken(path: str, request: Request):
        if path not in CHICKEN_PATHS and not path.startswith("audio/"):
            raise HTTPException(404, "unknown chicken endpoint")
        async with httpx.AsyncClient(base_url=CHICKEN_API, timeout=30) as c:
            try:
                r = await c.request(request.method, f"/{path}", params=request.query_params,
                                    content=await request.body(),
                                    headers={k: v for k, v in request.headers.items() if k.lower() == "content-type"})
            except httpx.HTTPError:
                raise HTTPException(503, "chicken model not connected")
        return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))

    @app.get("/hub-api/clip/{name}")
    def clip(name: str):
        path = allowed.get(name)
        if not path:
            raise HTTPException(404, "unknown clip")
        return FileResponse(path, media_type="audio/wav")

    app.mount("/hub/slides", StaticFiles(directory=ROOT / "docs/slides"), name="slides")
    app.mount("/hub", StaticFiles(directory=WEB, html=True), name="hub")
