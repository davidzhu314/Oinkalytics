"""Plain-English explanation of a prediction, built only from the evidence JSON.

    explain(evidence) -> {"text": str, "source": "llm" | "template"}

The LLM (OpenRouter) gets only the evidence and a strict prompt. Its answer is then checked: every
number must appear in the evidence (allowing rounding), it must not name a situation that isn't in
the evidence, and it must not anthropomorphise. Anything off, a failure, or a call slower than
EXPLAIN_TIMEOUT_S falls back to the template. Results are cached by evidence hash.

Env: OPENROUTER_API_KEY, OPENROUTER_MODEL, EXPLAIN_LLM (0 disables the LLM), EXPLAIN_TIMEOUT_S (8).
"""

import hashlib
import json
import os
import re
import time

import httpx
from dotenv import load_dotenv

from ml.evidence import load_typical

load_dotenv()

URL = "https://openrouter.ai/api/v1/chat/completions"
TIMEOUT_S = float(os.environ.get("EXPLAIN_TIMEOUT_S", "8"))
# A "typical" comparison is only cited when calm and distressed medians differ by at least this much.
INFORMATIVE = 0.15
# Features worth comparing to typical values. AM rate is too noisy on short calls to cite.
COMPARABLE = {"duration_s": ("lasted", "s"), "f0_mean_hz": ("had a mean pitch of", "Hz")}

# SoundWel's 17 recording contexts. Naming one that isn't in the evidence is a new claim.
CONTEXTS = [
    "AfterNursing", "Barren", "BeforeNursing", "Castration", "Crushing", "Enriched", "Fighting", "Huddling",
    "Isolation", "MissedNursing", "NegativeConditioning", "NovelObject", "PositiveConditioning", "Restrain",
    "Reunion", "Run", "Surprise",
]


def _context_re(name: str) -> re.Pattern:
    """'NovelObject' matches 'novel object', 'novel-object' and 'NovelObject'."""
    words = re.findall(r"[A-Z][a-z]*", name)
    return re.compile(r"\b" + r"[\s-]*".join(words) + r"\b", re.I)


BANNED = re.compile(
    r"\b(scared|afraid|fear\w*|frighten\w*|terrif\w*|pain\w*|hurt\w*|suffer\w*|happy|sad|angry|anxious|"
    r"panic\w*|lonely|feel\w*|wants?|thinks?|means?|saying|says|tells?|sick|ill|disease\w*|injur\w*|"
    r"emotion\w*|mood)\b",
    re.I,
)

SYSTEM = """You explain one pig-call prediction to a farmer in plain English.

Rules:
- Use ONLY the facts in the JSON. Never add numbers, causes, health claims or advice that are not in it.
- Exactly 2 short sentences. No lists, no headings, no quotes.
- Sentence 1: the verdict and its confidence (use "confidence" as a percentage).
- Sentence 2: the evidence: the measured values that have a typical value to compare with, and/or the closest similar call and the situation it was recorded in.
- Describe sounds, not feelings. Say "sounds like calls recorded during isolation", never "the pig is scared", "in pain", "wants", "feels" or "means".
- Round numbers the way the JSON gives them; don't compute new ones.
- If status is "unsure", say it is not confident either way and why, using only the JSON."""

_cache: dict[str, dict] = {}


def _confidence(ev: dict) -> float:
    p = ev["p_distressed"]
    return round(p if ev["status"] == "distressed" else 1 - p if ev["status"] == "calm" else max(p, 1 - p), 2)


def prepare(ev: dict) -> dict:
    """The evidence actually used: own-method typical values when built, only informative comparisons."""
    typical = load_typical() or ev.get("typical") or {}
    keep = {}
    for k in COMPARABLE:
        c, d = typical.get("calm", {}).get(k), typical.get("distressed", {}).get(k)
        if c and d and abs(c - d) / ((c + d) / 2) >= INFORMATIVE:
            keep[k] = {"calm": c, "distressed": d}
    f = ev["features"]
    measured = {k: f.get(k) for k in COMPARABLE if f.get(k) is not None}
    return {
        "status": ev["status"],
        "abstain_reason": ev.get("abstain_reason"),
        "p_distressed": round(ev["p_distressed"], 2),
        "confidence": _confidence(ev),
        "measured": {k: round(v, 2) if k == "duration_s" else round(v) for k, v in measured.items()},
        "typical": keep,
        "similar_calls": [
            {"status": s["status"], "context": s["context"], "similarity": round(s["similarity"], 2)}
            for s in ev.get("similar_calls", [])[:3]
        ],
    }


def template(e: dict) -> str:
    if e["status"] == "unsure":
        if e.get("abstain_reason") == "not_pig":
            return "I'm not sure this is a pig call."
        text = f"I'm not confident either way about this call (chance of distress {e['p_distressed']:.0%})."
        if e["similar_calls"]:
            s = e["similar_calls"][0]
            text += f" Its closest match is a {s['status']} call recorded during {s['context']}."
        return text
    text = f"This call sounds {e['status']} ({e['confidence']:.0%} confident)."
    parts = []
    for k, t in e["typical"].items():
        if k in e["measured"]:
            verb, unit = COMPARABLE[k]
            parts.append(f"{verb} {e['measured'][k]:g} {unit} (typical {e['status']} call: {t[e['status']]:g} {unit})")
    if parts:
        text += " It " + " and ".join(parts) + "."
    if e["similar_calls"]:
        s = e["similar_calls"][0]
        text += f" It sounds most like a {s['status']} call recorded during {s['context']}."
    return text


def _numbers(obj) -> list[float]:
    if isinstance(obj, bool) or obj is None:
        return []
    if isinstance(obj, (int, float)):
        return [float(obj)]
    if isinstance(obj, dict):
        return [n for v in obj.values() for n in _numbers(v)]
    if isinstance(obj, (list, tuple)):
        return [n for v in obj for n in _numbers(v)]
    return []


def check(text: str, e: dict) -> str | None:
    """Why `text` strays from the evidence, or None if it's clean."""
    allowed = _numbers(e)
    allowed += [n * 100 for n in allowed if 0 <= n <= 1]  # 0.86 may appear as 86%
    allowed += [float(len(e["similar_calls"]))]
    for m in re.finditer(r"-?\d+(?:\.(\d+))?", text.replace(",", "")):
        n = float(m.group(0))
        tol = 0.5 * 10 ** -len(m.group(1) or "") + 1e-9  # what rounding to the written precision allows
        if not any(abs(n - a) <= tol for a in allowed):
            return f"number {m.group(0)} not in evidence"
    known = {s["context"] for s in e["similar_calls"]}
    stray = [c for c in CONTEXTS if c not in known and _context_re(c).search(text)]
    if stray:
        return f"situation {stray[0]} not in evidence"
    if (w := BANNED.search(text)):
        return f"anthropomorphising word '{w.group(0)}'"
    if len(re.findall(r"[.!?](\s|$)", text.strip())) > 3:
        return "too long"
    return None


def _llm(e: dict) -> str:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("no OPENROUTER_API_KEY")
    r = httpx.post(
        URL,
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": os.environ.get("OPENROUTER_MODEL", "anthropic/claude-sonnet-5.5"),
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(e)}],
            "temperature": 0,
            "max_tokens": 160,
        },
        timeout=TIMEOUT_S,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def explain(evidence: dict) -> dict:
    e = prepare(evidence)
    h = hashlib.sha256(json.dumps(e, sort_keys=True).encode()).hexdigest()
    if h in _cache:
        return _cache[h]
    out = {"text": template(e), "source": "template"}
    # "not a pig" always uses the fixed line the demo relies on.
    if os.environ.get("EXPLAIN_LLM", "1") != "0" and e.get("abstain_reason") != "not_pig":
        t0 = time.monotonic()
        try:
            text = _llm(e)
            problem = check(text, e) or ("too slow" if time.monotonic() - t0 > TIMEOUT_S else None)
            if problem:
                print(f"[explain] LLM output rejected ({problem}): {text!r}")
            else:
                out = {"text": text, "source": "llm"}
        except Exception as err:  # noqa: BLE001 - any failure means the template
            print(f"[explain] LLM failed, using template: {err.__class__.__name__}: {err}")
    _cache[h] = out
    return out
