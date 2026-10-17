"""Barn simulator: streams held-out clips to POST /predict, one pen at a time.

Clips come from the ML session's list, data/demo_clips.csv (override with DEMO_CLIPS): columns
file, session, context, p_distressed, status, truth. Pools are split by the **true** label, not the
model's verdict, so the demo shows the model as it is. Only DEMO_TEAMS sessions are used (default
ETHZ,NMBU: FBN calm clips mostly read as distressed, see docs/SESSION_HANDOFF.md).
"""

import csv
import itertools
import os
import random
import threading
from pathlib import Path

import client

REPO = Path(__file__).resolve().parent.parent
CLIPS = Path(os.environ.get("DEMO_CLIPS", REPO / "data" / "demo_clips.csv"))
AUDIO_DIR = REPO / "data" / "raw" / "soundwel" / "Soundwel Dataset - Audio and Spectrograms"
TEAMS = [t.strip() for t in os.environ.get("DEMO_TEAMS", "ETHZ,NMBU").split(",") if t.strip()]
RAMP_PEN = os.environ.get("RAMP_PEN", "3")


def load_clips(path: Path = CLIPS) -> dict[str, list[dict]]:
    by_truth: dict[str, list[dict]] = {"calm": [], "distressed": []}
    if not path.exists():
        return by_truth
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            row["path"] = str(AUDIO_DIR / row["file"])
            team = row["session"].split("_")[0]
            if row["truth"] in by_truth and (not TEAMS or team in TEAMS) and Path(row["path"]).exists():
                by_truth[row["truth"]].append(row)
    return by_truth


class Simulator:
    def __init__(self):
        self.clips = load_clips()
        self.interval_s = 2.0
        self.ramp = False
        self.sent = 0
        self.last = ""
        self.error = ""
        self._ramp_calls = 0
        self._rng = random.Random(0)
        self._cycles = {v: itertools.cycle(rows) for v, rows in self.clips.items() if rows}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.running:
            return
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
        valence = "calm"
        if self.ramp and pen == RAMP_PEN:
            # Distress builds: each call to the ramp pen is more likely to be distressed than the last.
            self._ramp_calls += 1
            if self._rng.random() < min(1.0, 0.2 + 0.2 * self._ramp_calls):
                valence = "distressed"
        return next(self._cycles[valence])

    def _run(self):
        try:
            mock = (client.health() or {}).get("mode") == "mock"
            pen_ids = [p["pen_id"] for p in client.pens()]
        except Exception as e:  # API down: report it and stop
            self.error = f"Can't reach the API: {e}"
            return
        for pen in itertools.cycle(pen_ids):
            if self._stop.is_set():
                return
            if not all(self._cycles.get(v) for v in ("calm", "distressed")):
                self.error = f"No usable clips in {CLIPS}"
                return
            clip = self._pick(pen)
            try:
                pred = client.predict(clip["path"], pen_id=pen, mock_label=clip["truth"] if mock else None)
                self.sent += 1
                self.error = ""
                self.last = f"Pen {pen}: {Path(clip['path']).name} → {pred['status']}"
            except Exception as e:
                self.error = f"Last call failed: {e}"
            self._stop.wait(self.interval_s)

    def describe(self) -> str:
        c, d = len(self.clips["calm"]), len(self.clips["distressed"])
        src = f"{CLIPS.name} ({c} calm, {d} distressed held-out recordings)"
        state = "running" if self.running else "stopped"
        ramp = f" · ramping distress in Pen {RAMP_PEN}" if self.ramp else ""
        lines = [f"**Simulator {state}**{ramp} · {self.sent} calls sent · clips: {src}"]
        if self.last:
            lines.append(f"Last: {self.last}")
        if self.error:
            lines.append(f"⚠️ {self.error}")
        return "  \n".join(lines)
