"""Barn simulator: a microphone in each pen hears a mix of that pen's animals, calm and distressed.

Pens hold pigs, chickens or both (client.PEN_LAYOUT). Each call goes to every model through
client.route(): the model that recognises its own animal judges it and counts it in that pen.
Every pen hears mostly calm calls with DISTRESS_MIX (default 1 in 6) distressed ones mixed in;
"ramp" makes the chosen pen's calls more and more likely to be distressed.

Pigs: the ML session's list, data/demo_clips.csv (override with DEMO_CLIPS): columns file, session,
context, p_distressed, status, truth. Only DEMO_TEAMS sessions are used (default ETHZ,NMBU: FBN calm
clips mostly read as distressed, see docs/SESSION_HANDOFF.md).

Chickens: data/chicken_demo_clips.csv (override with CHICKEN_CLIPS), written by ml/chicken_train.py
from recordings held out of everything: columns id, p_sick, truth (healthy|sick), status. Each id is
looked up in data/chicken_labels.csv for its file. A `path` column works too.

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
RAMP_PEN = os.environ.get("RAMP_PEN", "2")
DISTRESS_MIX = float(os.environ.get("DISTRESS_MIX", str(1 / 6)))

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


def _chicken_paths() -> dict[str, str]:
    """Recording id -> file, from ml/chicken_labels.py's table."""
    labels = REPO / "data" / "chicken_labels.csv"
    if not labels.exists():
        return {}
    with open(labels, newline="") as f:
        return {r["id"]: r["path"] for r in csv.DictReader(f)}


def load_clips(path: Path, audio_dir: Path, teams: list[str]) -> dict[str, list[dict]]:
    pools: dict[str, list[dict]] = {"calm": [], "distressed": []}
    if not path.exists():
        return pools
    ids = None
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            name = row.get("file") or row.get("path") or ""
            if not name and row.get("id"):
                ids = _chicken_paths() if ids is None else ids
                name = ids.get(row["id"], "")
            p = Path(name)
            row["path"] = str(p if p.is_absolute() else audio_dir / p)
            team = (row.get("session") or "").split("_")[0]
            pool = TRUTH.get((row.get("truth") or "").strip().lower())
            if pool and (not teams or team in teams) and Path(row["path"]).exists():
                row["pool"] = pool
                pools[pool].append(row)
    return pools


class BarnSimulator:
    def __init__(self):
        self.reload()
        self.interval_s = 2.0
        self.ramp = False
        self.ramp_pen = RAMP_PEN if RAMP_PEN in client.PEN_LAYOUT else next(iter(client.PEN_LAYOUT))
        self.sent = 0
        self.unclaimed = 0
        self.last = ""
        self.error = ""
        self.ready: list[str] = []
        self._ramp_calls = 0
        self._rng = random.Random(0)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def reload(self):
        """Re-read the clip lists (the chicken list may appear after the dashboard starts)."""
        self.clips = {sp: load_clips(src["clips"], src["audio_dir"], src["teams"]) for sp, src in SOURCES.items()}
        self._cycles = {sp: {v: itertools.cycle(rows) for v, rows in pools.items() if rows}
                        for sp, pools in self.clips.items()}

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.running:
            return
        self.reload()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def set_ramp(self, on: bool, pen: str | None = None):
        if pen and pen != self.ramp_pen:
            self.ramp_pen, self._ramp_calls = pen, 0
        if on and not self.ramp:
            self._ramp_calls = 0
        self.ramp = on

    def _check_ready(self) -> dict[str, bool]:
        """Species we can play: clips on disk and an API answering. Returns {species: is_mock}."""
        out = {}
        for sp, meta in client.SPECIES.items():
            if not all(self.clips[sp].values()):
                continue
            h = client.health(meta["api"])
            if h:
                out[sp] = h.get("mode") == "mock"
        self.ready = list(out)
        return out

    def _pick(self, pen: str) -> tuple[str, str, dict] | None:
        residents = [sp for sp in client.PEN_LAYOUT.get(pen, []) if sp in self.ready]
        if not residents:
            return None
        sp = self._rng.choice(residents)
        p_distress = DISTRESS_MIX
        if self.ramp and pen == self.ramp_pen:
            self._ramp_calls += 1
            p_distress = max(p_distress, min(1.0, 0.2 + 0.2 * self._ramp_calls))
        pool = "distressed" if self._rng.random() < p_distress else "calm"
        return sp, pool, next(self._cycles[sp][pool])

    def _run(self):
        ready = self._check_ready()
        if "pig" not in ready:
            self.error = f"Can't reach the pig API at {client.API}"
            return
        for i, pen in enumerate(itertools.cycle(client.PEN_LAYOUT)):
            if self._stop.is_set():
                return
            if i and i % (4 * len(client.PEN_LAYOUT)) == 0:  # every few rounds, notice a model coming online
                ready = self._check_ready() or ready
            picked = self._pick(pen)
            if not picked:
                continue
            sp, pool, clip = picked
            try:
                r = client.route(clip["path"], pen_id=pen, mock_truth=(sp, pool) if any(ready.values()) else None)
                self.sent += 1
                self.error = ""
                heard = f"Pen {pen} heard a {client.SPECIES[sp]['noun']} call ({client.SPECIES[sp]['words'][pool].lower()})"
                if r["winner"]:
                    c = r["counted"] or r["preds"][r["winner"]]
                    word = c.get("status_label") or client.SPECIES[r["winner"]]["words"].get(c["status"], "not sure").lower()
                    self.last = f"{heard} → {client.SPECIES[r['winner']]['noun']} model: {word.lower()}"
                else:
                    self.unclaimed += 1
                    self.last = f"{heard} → not sure which animal; not counted"
            except Exception as e:
                self.error = f"Last call failed: {e}"
            self._stop.wait(self.interval_s)

    def describe(self) -> str:
        parts = []
        for sp, meta in client.SPECIES.items():
            c, d = len(self.clips[sp]["calm"]), len(self.clips[sp]["distressed"])
            words = meta["words"]
            if not (c and d):
                parts.append(f"{meta['name'].lower()}s: no clips yet")
            elif self.running and sp not in self.ready:
                parts.append(f"{meta['name'].lower()}s: waiting for the model")
            else:
                parts.append(f"{meta['name'].lower()}s: {c} {words['calm'].lower()} + {d} {words['distressed'].lower()} held-out clips")
        state = "running" if self.running else "stopped"
        ramp = f" · ramping distress in Pen {self.ramp_pen}" if self.ramp else ""
        mix = f" · background mix: 1 in {round(1 / DISTRESS_MIX)} distressed" if DISTRESS_MIX > 0 else ""
        lines = [f"**Simulator {state}**{ramp}{mix} · {self.sent} calls · {self.unclaimed} not claimed by either model",
                 " · ".join(parts)]
        if self.last:
            lines.append(f"Last: {self.last}")
        if self.error:
            lines.append(f"⚠️ {self.error}")
        return "  \n".join(lines)
