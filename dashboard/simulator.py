"""Barn simulator: streams held-out clips to POST /predict, one pen at a time. One per species.

Pigs: the ML session's list, data/demo_clips.csv (override with DEMO_CLIPS): columns file, session,
context, p_distressed, status, truth. Only DEMO_TEAMS sessions are used (default ETHZ,NMBU: FBN calm
clips mostly read as distressed, see docs/SESSION_HANDOFF.md).

Chickens: data/chicken_demo_clips.csv (override with CHICKEN_CLIPS), written by the chicken
workstream: columns path (relative to the repo root) and truth (healthy|unhealthy). Clips must come
from recordings the chicken model never trained on.

Pools are split by the **true** label, not the model's verdict, so the demo shows the model as it is.
"""

import csv
import itertools
import os
import random
import threading
from pathlib import Path

import client

REPO = Path(__file__).resolve().parent.parent
RAMP_PEN = os.environ.get("RAMP_PEN", "3")

# The chicken list may say healthy/unhealthy; the simulator's pools are calm/distressed.
TRUTH = {"calm": "calm", "distressed": "distressed", "healthy": "calm", "unhealthy": "distressed", "sick": "distressed"}

SOURCES = {
    "pig": {
        "clips": Path(os.environ.get("DEMO_CLIPS", REPO / "data" / "demo_clips.csv")),
        "audio_dir": REPO / "data" / "raw" / "soundwel" / "Soundwel Dataset - Audio and Spectrograms",
        "teams": [t.strip() for t in os.environ.get("DEMO_TEAMS", "ETHZ,NMBU").split(",") if t.strip()],
    },
    "chicken": {
        "clips": Path(os.environ.get("CHICKEN_CLIPS", REPO / "data" / "chicken_demo_clips.csv")),
        "audio_dir": REPO,
        "teams": [],
    },
}


def load_clips(path: Path, audio_dir: Path, teams: list[str]) -> dict[str, list[dict]]:
    pools: dict[str, list[dict]] = {"calm": [], "distressed": []}
    if not path.exists():
        return pools
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            name = row.get("file") or row.get("path") or ""
            p = Path(name)
            row["path"] = str(p if p.is_absolute() else audio_dir / p)
            team = (row.get("session") or "").split("_")[0]
            pool = TRUTH.get((row.get("truth") or "").strip().lower())
            if pool and (not teams or team in teams) and Path(row["path"]).exists():
                row["pool"] = pool
                pools[pool].append(row)
    return pools


class Simulator:
    def __init__(self, species: str = "pig"):
        self.species = species
        self.meta = client.SPECIES[species]
        self.source = SOURCES[species]
        self.reload()
        self.interval_s = 2.0
        self.ramp = False
        self.sent = 0
        self.last = ""
        self.error = ""
        self._ramp_calls = 0
        self._rng = random.Random(0)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def reload(self):
        """Re-read the clip list (the chicken list may appear after the dashboard starts)."""
        self.clips = load_clips(self.source["clips"], self.source["audio_dir"], self.source["teams"])
        self._cycles = {v: itertools.cycle(rows) for v, rows in self.clips.items() if rows}

    @property
    def api(self) -> str:
        return self.meta["api"]

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.running:
            return
        if not all(self.clips.values()):
            self.reload()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def set_ramp(self, on: bool):
        if on and not self.ramp:
            self._ramp_calls = 0
        self.ramp = on

    def _pick(self, pen: str) -> dict:
        pool = "calm"
        if self.ramp and pen == RAMP_PEN:
            # Trouble builds: each call to the ramp pen is more likely to be distressed/sick than the last.
            self._ramp_calls += 1
            if self._rng.random() < min(1.0, 0.2 + 0.2 * self._ramp_calls):
                pool = "distressed"
        return next(self._cycles[pool])

    def _run(self):
        try:
            mock = (client.health(self.api) or {}).get("mode") == "mock"
            pen_ids = [p["pen_id"] for p in client.pens(self.api)]
        except Exception as e:  # API down: report it and stop
            self.error = f"Can't reach the {self.meta['noun']} API at {self.api}: {e}"
            return
        for pen in itertools.cycle(pen_ids):
            if self._stop.is_set():
                return
            if not all(self._cycles.get(v) for v in ("calm", "distressed")):
                self.error = f"No usable clips in {self.source['clips']}"
                return
            clip = self._pick(pen)
            try:
                pred = client.predict(clip["path"], pen_id=pen, mock_label=clip["pool"] if mock else None, base=self.api)
                self.sent += 1
                self.error = ""
                word = pred.get("status_label") or pred["status"]
                self.last = f"Pen {pen}: {Path(clip['path']).name} → {word}"
            except Exception as e:
                self.error = f"Last call failed: {e}"
            self._stop.wait(self.interval_s)

    def describe(self) -> str:
        c, d = len(self.clips["calm"]), len(self.clips["distressed"])
        words = self.meta["words"]
        if not (c and d):
            return f"**Simulator not ready** · no usable clips yet in `{self.source['clips'].relative_to(REPO) if self.source['clips'].is_relative_to(REPO) else self.source['clips']}`"
        src = f"{self.source['clips'].name} ({c} {words['calm'].lower()}, {d} {words['distressed'].lower()} held-out recordings)"
        state = "running" if self.running else "stopped"
        ramp = f" · ramping {self.meta['risk']} in Pen {RAMP_PEN}" if self.ramp else ""
        lines = [f"**Simulator {state}**{ramp} · {self.sent} calls sent · clips: {src}"]
        if self.last:
            lines.append(f"Last: {self.last}")
        if self.error:
            lines.append(f"⚠️ {self.error}")
        return "  \n".join(lines)
