"""Tests for api/trends.py. Run: python -m pytest api/test_trends.py"""

import random
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.schemas import Explanation, Features, Prediction, Valence
from api.state import Store, new_id
from api.trends import TrendConfig, Trends, build_trends_router

T0 = datetime(2026, 10, 18, 0, 0, tzinfo=timezone.utc)  # a period boundary for 60 s and 1 day periods


def pred(pen, distressed, at, status=None):
    p = 0.9 if distressed else 0.1
    return Prediction(
        prediction_id=new_id("pred"), clip_id="c", pen_id=pen, created_at=at,
        status=status or ("distressed" if distressed else "calm"),
        valence=Valence(p_distressed=p, confidence=max(p, 1 - p)), context_top3=[],
        features=Features(duration_s=0.5, loudness_db=-20, spectral_centroid_hz=1000),
        similar_calls=[], explanation=Explanation(text="x", source="template"), audio_url="/audio/c")


def feed(trends, store, pen, pattern, start, step_s=1.0):
    """Record a list of booleans (True = distressed) for one pen; returns the last alert raised, if any."""
    alert = None
    for i, d in enumerate(pattern):
        p = pred(pen, d, start + timedelta(seconds=i * step_s))
        a = store.record(p) if store else None
        trends.record(p, a)
        alert = a or alert
    return alert


def demo_cfg(**kw):
    base = dict(recent_s=30, baseline_s=600, min_calls=8, still_s=120, period_s=60, persist_n=3,
                period_min_calls=10, settle_calls=5, settle_max_distressed=1)
    base.update(kw)
    return TrendConfig(**base)


def test_distress_vs_own_normal():
    t = Trends(cfg=demo_cfg(), pens=["1", "2"])
    rng = random.Random(0)
    feed(t, None, "3", [rng.random() < 0.2 for _ in range(100)], T0)        # 100 s of a calm-ish pen (~20%)
    feed(t, None, "3", [True, True, True, True, False], T0 + timedelta(seconds=200))  # then 4 of 5 distressed
    tr = t.pen_trend("3", T0 + timedelta(seconds=205))
    assert tr.normal_source == "pen" and tr.recent_share == 0.8
    assert tr.ratio and tr.ratio > 2.5
    assert tr.summary.startswith("That's about") and "this pen's normal" in tr.summary


def test_falls_back_to_barn_then_says_not_enough():
    t = Trends(cfg=demo_cfg(), pens=["1", "2", "3"])
    assert "Not enough history" in t.pen_trend("3", T0).summary
    feed(t, None, "1", [False] * 20, T0)
    feed(t, None, "3", [True] * 5, T0 + timedelta(seconds=25))
    tr = t.pen_trend("3", T0 + timedelta(seconds=30))
    assert tr.normal_source == "barn" and "the rest of the barn" in tr.summary


def test_noisy_pen_is_called_close_to_normal():
    t = Trends(cfg=demo_cfg(), pens=["1"])
    feed(t, None, "1", [i % 2 == 0 for i in range(60)], T0)  # always ~50% distressed
    tr = t.pen_trend("1", T0 + timedelta(seconds=60))
    assert "close to this pen's normal" in tr.summary


def test_settled_after_alert():
    store, t = Store(), Trends(cfg=demo_cfg(), pens=["1", "2", "3", "4"])
    alert = feed(t, store, "3", [True] * 3, T0)
    assert alert is not None
    feed(t, store, "3", [False] * 5, T0 + timedelta(seconds=60))
    kinds = [(e.kind, e.alert_id) for e in t.events]
    assert kinds == [("settled", alert.alert_id)]
    assert t.events[0].message == "Pen 3 back to normal, 1 min after the alert."


def test_still_distressed_once_then_settled():
    store, t = Store(), Trends(cfg=demo_cfg(still_s=120), pens=["3"])
    alert = feed(t, store, "3", [True] * 3, T0)
    feed(t, store, "3", [True, False] * 4, T0 + timedelta(seconds=10))
    t.evaluate(T0 + timedelta(seconds=130))
    t.evaluate(T0 + timedelta(seconds=140))   # no duplicate
    assert [e.kind for e in t.events] == ["still_distressed"]
    assert "still sounds distressed 2 mins after the alert" in t.events[0].message
    feed(t, store, "3", [False] * 5, T0 + timedelta(seconds=150))
    assert [e.kind for e in t.events] == ["still_distressed", "settled"]


def _barn_periods(t, n_periods, hot="5", rates=None, start=T0, neighbour_ramp=None):
    """Simulate n 60 s periods; pen `hot` ~50% distressed, others ~15%."""
    rates = rates or {}
    for k in range(n_periods):
        for pen in t.pens:
            r = rates.get(pen, 0.5 if pen == hot else 0.15)
            if neighbour_ramp and pen in neighbour_ramp:
                r = neighbour_ramp[pen][k]
            n = 20
            bad = round(r * n)  # exact shares, so the test is deterministic
            for i in range(n):
                at = start + timedelta(seconds=60 * k + i * 2.5 + int(pen) * 0.1)
                t.record(pred(pen, i < bad, at))
    t.evaluate(start + timedelta(seconds=60 * n_periods + 1))


def test_persistent_top_pen_reported_once_with_rising_neighbour():
    t = Trends(cfg=demo_cfg(), pens=["3", "4", "5", "6", "7"])
    ramp = {"6": [0.05, 0.20, 0.35, 0.40, 0.45]}
    _barn_periods(t, 3, neighbour_ramp=None)
    persistent = [e for e in t.events if e.kind == "persistent"]
    assert len(persistent) == 1 and persistent[0].pen_id == "5"
    assert "3 minutes in a row" in persistent[0].message
    t2 = Trends(cfg=demo_cfg(), pens=["3", "4", "5", "6", "7"])
    _barn_periods(t2, 5, neighbour_ramp=ramp)
    ev = [e for e in t2.events if e.kind == "persistent"]
    assert len(ev) == 1                       # same streak isn't reported again
    assert "Pen 6 next door is rising too" in ev[0].message
    assert "Pen 4" not in ev[0].message       # flat neighbour isn't named
    assert ev[0].message.endswith("Worth checking these pens for signs of illness or other problems.")


def test_no_flag_when_all_pens_similar():
    t = Trends(cfg=demo_cfg(), pens=["1", "2", "3"])
    _barn_periods(t, 4, hot="none", rates={"1": 0.2, "2": 0.25, "3": 0.2})
    assert not [e for e in t.events if e.kind == "persistent"]


def test_ranking_and_router():
    t = Trends(cfg=demo_cfg(), pens=["3", "4", "5", "6"])
    _barn_periods(t, 3)
    r = t.ranking(3, T0 + timedelta(seconds=181))
    assert r.pens[0].pen_id == "5" and "5" in r.flagged
    assert r.message.splitlines()[0] == "Distress by pen, last 3 minutes:"
    assert r.message.splitlines()[1] == "Pen 5: 50% of calls (flagged)"
    later = t.ranking(3, T0 + timedelta(seconds=400))   # no calls in the latest periods: the streak has ended
    assert later.flagged == []
    app = FastAPI(); app.include_router(build_trends_router(t))
    c = TestClient(app)
    assert c.get("/trends/pens").status_code == 200
    assert c.get("/trends/pens/nope").status_code == 404
    assert isinstance(c.get("/trends/events").json(), list)
    assert c.get("/trends/ranking?periods=2").json()["periods"] == 2


def test_unsure_calls_are_ignored():
    t = Trends(cfg=demo_cfg(), pens=["1"])
    t.record(pred("1", True, T0, status="unsure"))
    assert t.pen_trend("1", T0).recent_calls == 0
