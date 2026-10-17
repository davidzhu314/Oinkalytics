"""Barn trends from animal sounds, texted to the farmer by the bot.

1. Distress vs normal:   each pen's recent share of distressed calls against its own earlier share
                         (or the rest of the barn's, until the pen has history). Added to every alert.
2. Most distress over time: the pen with the highest distress share for PERSIST_N periods in a row
                         (a day by default), plus neighbouring pens that are rising. Can point to
                         illness or another problem the farmer hasn't spotted.

Only confident calls count (calm or distressed); "unsure" calls are skipped, like the alert rule.
Shares, not counts, so a bigger pen or a closer microphone doesn't look worse. All windows are
environment variables so the demo can run "days" as minutes (TREND_PERIOD_S=60).
"""

from __future__ import annotations

import os
import statistics
import threading
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .schemas import Alert, Prediction
from .state import PENS, new_id, now


def _env(name: str, default: float) -> float:
    return float(os.getenv(name, default))


@dataclass
class TrendConfig:
    recent_s: float = _env("TREND_RECENT_S", 600)          # "right now" = last 10 min
    baseline_s: float = _env("TREND_BASELINE_S", 86400)    # "normal" = the 24 h before that
    min_calls: int = int(_env("TREND_MIN_CALLS", 8))        # fewer confident calls than this = not enough to say
    share_floor: float = _env("TREND_SHARE_FLOOR", 0.05)    # avoids "20x normal" when normal is ~0
    recent_min_calls: int = int(_env("TREND_RECENT_MIN_CALLS", 5))  # calls needed to judge "right now"
    period_s: float = _env("TREND_PERIOD_S", 86400)         # trend 2 compares pens per period (a day)
    persist_n: int = int(_env("TREND_PERSIST_N", 3))        # top pen this many periods in a row
    period_min_calls: int = int(_env("TREND_PERIOD_MIN_CALLS", 10))
    top_ratio: float = _env("TREND_TOP_RATIO", 1.5)         # top pen must be >= 1.5x the other pens' median
    top_margin: float = _env("TREND_TOP_MARGIN", 0.10)      # ...and at least 10 points above it


class PenTrend(BaseModel):
    pen_id: str
    recent_calls: int = Field(description="Confident calls in the recent window")
    recent_share: Optional[float] = Field(None, description="Share of those that were distressed, 0-1")
    normal_calls: int
    normal_share: Optional[float] = Field(None, description="Distress share in the baseline window, 0-1")
    normal_source: Optional[Literal["pen", "barn"]] = Field(
        None, description="pen: this pen's own history; barn: the other pens (pen has too little history)")
    ratio: Optional[float] = Field(None, description="recent_share / normal_share; null if not enough calls")
    summary: str = Field(description="One line, ready to append to an alert")


class TrendEvent(BaseModel):
    event_id: str
    kind: Literal["persistent"]
    pen_id: str
    created_at: datetime
    message: str = Field(description="Ready to text as-is")


class PenPeriodShare(BaseModel):
    pen_id: str
    calls: int
    share: Optional[float] = None


class Ranking(BaseModel):
    periods: int
    period_label: str
    pens: list[PenPeriodShare] = Field(description="Highest distress share first; pens with too few calls last")
    flagged: list[str] = Field(description="Pens currently flagged by the persistence rule")
    message: str = Field(description="Ready to text as-is")


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def _pct(x: float) -> str:
    return f"{round(100 * x)}%"


@dataclass
class Trends:
    cfg: TrendConfig = field(default_factory=TrendConfig)
    pens: list[str] = field(default_factory=lambda: list(PENS))

    def __post_init__(self):
        self._lock = threading.RLock()
        self.reset()

    def reset(self):
        with self._lock:
            self.calls: dict[str, list[tuple[datetime, bool]]] = defaultdict(list)  # pen -> (time, distressed)
            self.events: list[TrendEvent] = []
            self.streak_sent: dict[str, int] = {}          # pen -> last period index it was reported for
            self._checked_period: Optional[int] = None

    # ---------- recording ----------
    def record(self, pred: Prediction, alert: Optional[Alert] = None):
        """Call for every prediction. `alert` matches the route hook's signature; trends don't need it."""
        with self._lock:
            if pred.pen_id is not None and pred.status != "unsure":
                if pred.pen_id not in self.pens:
                    self.pens.append(pred.pen_id)
                self.calls[pred.pen_id].append((pred.created_at, pred.status == "distressed"))
                self._prune(pred.created_at)
            self.evaluate(pred.created_at)

    def _prune(self, at: datetime):
        keep = max(self.cfg.recent_s + self.cfg.baseline_s, self.cfg.period_s * (self.cfg.persist_n + 2))
        cutoff = at - timedelta(seconds=keep)
        for pen, xs in self.calls.items():
            if xs and xs[0][0] < cutoff:
                self.calls[pen] = [c for c in xs if c[0] >= cutoff]

    # ---------- helpers ----------
    def _window(self, pen: str, start: datetime, end: datetime) -> tuple[int, int]:
        xs = [d for t, d in self.calls.get(pen, ()) if start <= t < end]
        return len(xs), sum(xs)

    def _share(self, n: int, k: int, min_calls: int) -> Optional[float]:
        return k / n if n >= min_calls else None

    # ---------- trend 1: distress vs normal ----------
    def pen_trend(self, pen: str, at: Optional[datetime] = None) -> PenTrend:
        at = at or now()
        c = self.cfg
        with self._lock:
            r_start = at - timedelta(seconds=c.recent_s)
            b_start = r_start - timedelta(seconds=c.baseline_s)
            rn, rk = self._window(pen, r_start, at + timedelta(microseconds=1))
            bn, bk = self._window(pen, b_start, r_start)
            source: Optional[str] = "pen"
            if bn < c.min_calls:  # too little history: compare with the rest of the barn over the same span
                source = "barn"
                bn = bk = 0
                for other in self.pens:
                    if other != pen:
                        n, k = self._window(other, b_start, at + timedelta(microseconds=1))
                        bn, bk = bn + n, bk + k
            recent = self._share(rn, rk, min(c.min_calls, c.recent_min_calls))
            normal = self._share(bn, bk, c.min_calls)
            if normal is None:
                source = None
            ratio = round(recent / max(normal, c.share_floor), 2) if recent is not None and normal is not None else None
        whose = "this pen's normal" if source == "pen" else "the rest of the barn"
        if ratio is None:
            summary = "Not enough history yet to compare with normal."
        elif ratio >= 1.5:
            summary = f"That's about {ratio:.1f}× {whose} ({_pct(recent)} of calls distressed vs {_pct(normal)})."
        elif ratio <= 0.67:
            summary = f"That's below {whose} ({_pct(recent)} of calls distressed vs {_pct(normal)})."
        else:
            summary = f"That's close to {whose} ({_pct(recent)} of calls distressed vs {_pct(normal)}), so this pen is often this noisy."
        return PenTrend(pen_id=pen, recent_calls=rn, recent_share=None if recent is None else round(recent, 3),
                        normal_calls=bn, normal_share=None if normal is None else round(normal, 3),
                        normal_source=source, ratio=ratio, summary=summary)

    # ---------- trend 2: evaluated on every call and every poll ----------
    def evaluate(self, at: Optional[datetime] = None):
        at = at or now()
        with self._lock:
            self._persistence(at)

    def _emit(self, kind: str, pen: str, at: datetime, message: str):
        self.events.append(TrendEvent(event_id=new_id("trnd"), kind=kind, pen_id=pen, created_at=at, message=message))

    def _period_index(self, at: datetime) -> int:
        return int(at.timestamp() // self.cfg.period_s)

    def _period_shares(self, idx: int) -> dict[str, tuple[int, Optional[float]]]:
        start = datetime.fromtimestamp(idx * self.cfg.period_s, timezone.utc)
        end = start + timedelta(seconds=self.cfg.period_s)
        out = {}
        for pen in self.pens:
            n, k = self._window(pen, start, end)
            out[pen] = (n, self._share(n, k, self.cfg.period_min_calls))
        return out

    def _top_pen(self, shares: dict[str, tuple[int, Optional[float]]]) -> Optional[tuple[str, float, float]]:
        valid = {p: s for p, (_, s) in shares.items() if s is not None}
        if len(valid) < 2:
            return None
        pen = max(valid, key=valid.get)
        others = statistics.median(v for p, v in valid.items() if p != pen)
        if valid[pen] >= self.cfg.top_ratio * others and valid[pen] - others >= self.cfg.top_margin:
            return pen, valid[pen], others
        return None

    def period_label(self, n: int = 1) -> str:
        s = self.cfg.period_s
        word = "day" if s == 86400 else "hour" if s == 3600 else "minute" if s == 60 else f"{int(s)}-second period"
        return _plural(n, word)

    def _neighbours(self, pen: str) -> list[str]:
        if pen not in self.pens:
            return []
        i = self.pens.index(pen)
        return [self.pens[j] for j in (i - 1, i + 1) if 0 <= j < len(self.pens)]

    def _persistence(self, at: datetime):
        """Run once per completed period: flag a pen that topped the barn PERSIST_N periods in a row."""
        last_done = self._period_index(at) - 1
        if self._checked_period == last_done:
            return
        self._checked_period = last_done
        for pen, streak, share, others in self._streaks(last_done):
            if self.streak_sent.get(pen) is not None and self.streak_sent[pen] >= last_done - streak + 1:
                continue  # already reported this streak
            self.streak_sent[pen] = last_done
            msg = (f"Pen {pen} has had the most distress in the barn {self.period_label(streak)} in a row "
                   f"({_pct(share)} of calls vs {_pct(others)} for the other pens).")
            rising = self._rising_neighbours(pen, last_done)
            if rising:
                names = " and ".join(f"Pen {p}" for p in rising)
                msg += f" {names} next door {'is' if len(rising) == 1 else 'are'} rising too."
                msg += " Worth checking these pens for signs of illness or other problems."
            else:
                msg += " Worth checking the pen for signs of illness or other problems."
            self._emit("persistent", pen, at, msg)

    def _streaks(self, last_done: int):
        """(pen, streak length, latest share, others' median) for pens on a streak of >= PERSIST_N."""
        top = self._top_pen(self._period_shares(last_done))
        if not top:
            return []
        pen, share, others = top
        streak = 1
        while streak < self.cfg.persist_n + 30:
            t = self._top_pen(self._period_shares(last_done - streak))
            if not t or t[0] != pen:
                break
            streak += 1
        return [(pen, streak, share, others)] if streak >= self.cfg.persist_n else []

    def _rising_neighbours(self, pen: str, last_done: int) -> list[str]:
        """Neighbours whose share went up in each of the last two periods and now sit above the barn median."""
        cur, prev, prev2 = (self._period_shares(last_done - i) for i in range(3))
        valid_now = [s for _, s in cur.values() if s is not None]
        if not valid_now:
            return []
        median_now = statistics.median(valid_now)
        out = []
        for nb in self._neighbours(pen):
            a, b, c = prev2[nb][1], prev[nb][1], cur[nb][1]
            if None not in (a, b, c) and a < b < c and c > median_now:
                out.append(nb)
        return out

    # ---------- on-demand ranking ("trends" text) ----------
    def ranking(self, periods: int = 3, at: Optional[datetime] = None) -> Ranking:
        at = at or now()
        with self._lock:
            self.evaluate(at)
            last_done = self._period_index(at) - 1
            totals = {p: [0, 0] for p in self.pens}
            for idx in range(last_done - periods + 1, last_done + 2):  # completed periods + the current one
                start = datetime.fromtimestamp(idx * self.cfg.period_s, timezone.utc)
                for p in self.pens:
                    n, k = self._window(p, start, start + timedelta(seconds=self.cfg.period_s))
                    totals[p][0] += n
                    totals[p][1] += k
            rows = [PenPeriodShare(pen_id=p, calls=n, share=None if n < self.cfg.min_calls else round(k / n, 3))
                    for p, (n, k) in totals.items()]
            rows.sort(key=lambda r: (r.share is None, -(r.share or 0)))
            flagged = [p for p, *_ in self._streaks(last_done)]  # pens whose streak is still going
        label = self.period_label(periods)
        lines = [f"Distress by pen, last {label}:"]
        for r in rows:
            flag = " (flagged)" if r.pen_id in flagged else ""
            lines.append(f"Pen {r.pen_id}: {_pct(r.share)} of calls{flag}" if r.share is not None
                         else f"Pen {r.pen_id}: not enough calls yet")
        if not any(r.share is not None for r in rows):
            lines = [f"Not enough calls in the last {label} to compare pens yet."]
        return Ranking(periods=periods, period_label=label, pens=rows, flagged=flagged, message="\n".join(lines))

    def events_after(self, after: Optional[str]) -> list[TrendEvent]:
        self.evaluate()
        with self._lock:
            if after is None:
                return list(self.events)
            for i, e in enumerate(self.events):
                if e.event_id == after:
                    return self.events[i + 1:]
            return list(self.events)


def build_trends_router(trends: Trends) -> APIRouter:
    r = APIRouter(prefix="/trends")

    @r.get("/pens", response_model=list[PenTrend])
    def pen_trends():
        return [trends.pen_trend(p) for p in trends.pens]

    @r.get("/pens/{pen_id}", response_model=PenTrend)
    def pen_trend(pen_id: str):
        if pen_id not in trends.pens:
            raise HTTPException(404, "unknown pen")
        return trends.pen_trend(pen_id)

    @r.get("/events", response_model=list[TrendEvent])
    def events(after: Optional[str] = Query(None, description="Return only events newer than this event_id")):
        return trends.events_after(after)

    @r.get("/ranking", response_model=Ranking)
    def ranking(periods: int = Query(3, ge=1, le=30)):
        return trends.ranking(periods)

    return r
