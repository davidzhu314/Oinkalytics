"""Plain-English explanation of a chicken prediction, built only from the evidence.

    explain(evidence) -> {"text": str, "source": "llm" | "template"}

Same contract and same guardrails as ml/explain.py, as a sibling rather than an
edit, because that module is pig-specific in three ways that matter: its prompt
says "pig-call prediction", its fields are `p_distressed` / calm / distressed,
and its stray-claim check looks for SoundWel recording contexts, which this
dataset does not have.

Two things are stricter here:

  * No disease may be named. The dataset labels recordings "unhealthy", not
    "has Newcastle disease", so naming one would be inventing a diagnosis. The
    banned list covers the obvious poultry diseases and diagnosis verbs.
  * No advice. "Call a vet" or "cull the flock" is not in the evidence.

The number check, which requires every number in the output to appear in the
evidence, is reused from ml.explain unchanged.
"""

import hashlib
import json
import os
import re
import time

import httpx
from dotenv import load_dotenv

from ml.explain import URL, _numbers

load_dotenv()

TIMEOUT_S = float(os.environ.get("EXPLAIN_TIMEOUT_S", "8"))
# Only cite a typical comparison when the two classes actually differ by this much.
INFORMATIVE = 0.15

# Deliberately NOT including duration_s, unlike ml/explain.py.
#
# For a pig, duration is the length of one call and genuinely distinguishes calm
# from distressed. For a chicken here it is the length of the audio file somebody
# happened to save, which tells a farmer nothing, and clip length is part of the
# confound documented in docs/CHICKEN.md. Citing it would dress up an artefact as
# evidence.
#
# Loudness and spectral centroid are left out for the same reason, and more
# strongly: they are the confound (healthy files are ~9 dB quieter, and mid-band
# energy alone separates the classes at 0.82). So pitch is the only comparison
# left, and the INFORMATIVE filter usually drops that too, which means most
# explanations are just the verdict and its confidence. That is the honest
# outcome: this model has no uncontaminated measured evidence to point at.
COMPARABLE = {"f0_mean_hz": ("had a mean pitch of", "Hz")}

# Feelings, diagnoses and advice are all out of bounds: none of them are in the evidence.
BANNED = re.compile(
    r"\b("
    r"feel\w*|want\w*|suffer\w*|happy|sad|scared|afraid|distress\w*|pain\w*|miserab\w*|"
    r"newcastle|avian\s+influenza|bird\s+flu|coccidiosis|bronchitis|mycoplasm\w*|"
    r"salmonell\w*|coryza|gumboro|marek\w*|infect\w*|diagnos\w*|disease|virus|bacteri\w*|"
    r"treat\w*|medicat\w*|antibiotic\w*|vaccin\w*|cull\w*|vet\b|veterinar\w*|should|must|"
    # Clip length is the size of the saved file, not a property of the birds, and
    # it is part of the confound. The LLM must not reach for it as evidence.
    r"lasted|lasting|seconds?|minutes?|durations?|lengths?"
    r")\b",
    re.I,
)

SYSTEM = """You explain one chicken-flock audio prediction to a farmer in plain English.

Rules:
- Use ONLY the facts in the JSON. Never add numbers, causes, diagnoses or advice that are not in it.
- Exactly 2 short sentences. No lists, no headings, no quotes.
- Sentence 1: the verdict and its confidence (use "confidence" as a percentage).
- Sentence 2: the evidence, i.e. the measured values that have a typical value to compare with.
  If "measured" or "typical" is empty, say instead that the verdict comes from how the recording
  compares with the training recordings overall, and cite no numbers beyond the confidence.
- Never mention how long the recording is. That is the length of the file, not a property of the birds.
- Describe sounds, not diagnoses. Say "sounds like recordings labelled unhealthy", never name a
  disease, never say "infected", "sick bird", "diagnose", and never recommend any action.
- Describe sounds, not feelings. Never say the birds feel, want or suffer anything.
- Round numbers the way the JSON gives them; don't compute new ones.
- If status is "unsure", say it is not confident either way and why, using only the JSON."""

_cache: dict[str, dict] = {}


def _confidence(ev: dict) -> float:
    p = ev["p_sick"]
    return round(p if ev["status"] == "sick" else 1 - p if ev["status"] == "healthy" else max(p, 1 - p), 2)


def prepare(ev: dict) -> dict:
    """The evidence actually cited: measured values plus only the informative comparisons."""
    typical = ev.get("typical") or {}
    keep = {}
    for k in COMPARABLE:
        h, s = typical.get("healthy", {}).get(k), typical.get("sick", {}).get(k)
        if h and s and abs(h - s) / ((h + s) / 2) >= INFORMATIVE:
            keep[k] = {"healthy": h, "sick": s}
    f = ev.get("features") or {}
    measured = {k: f.get(k) for k in COMPARABLE if f.get(k) is not None}
    return {
        "status": ev["status"],
        "abstain_reason": ev.get("abstain_reason"),
        "p_sick": round(ev["p_sick"], 2),
        "confidence": _confidence(ev),
        "measured": {k: round(v, 2) if k == "duration_s" else round(v) for k, v in measured.items()},
        "typical": keep,
    }


def template(e: dict) -> str:
    if e["status"] == "unsure":
        if e.get("abstain_reason") == "not_chicken":
            return "I'm not sure this is a chicken recording."
        return (f"I'm not confident either way about this recording "
                f"(chance it sounds unhealthy {e['p_sick']:.0%}).")
    word = "unhealthy" if e["status"] == "sick" else "healthy"
    text = f"This recording sounds {word} ({e['confidence']:.0%} confident)."
    parts = []
    for k, t in e["typical"].items():
        if k in e["measured"]:
            verb, unit = COMPARABLE[k]
            parts.append(f"{verb} {e['measured'][k]:g} {unit} "
                         f"(typical {word} recording: {t[e['status']]:g} {unit})")
    if parts:
        text += " It " + " and ".join(parts) + "."
    return text


def check(text: str, e: dict) -> str | None:
    """Why `text` strays from the evidence, or None if it's clean."""
    allowed = _numbers(e)
    allowed += [n * 100 for n in allowed if 0 <= n <= 1]   # 0.86 may be written 86%
    for m in re.finditer(r"-?\d+(?:\.(\d+))?", text.replace(",", "")):
        n = float(m.group(0))
        tol = 0.5 * 10 ** -len(m.group(1) or "") + 1e-9    # what the written precision allows
        if not any(abs(n - a) <= tol for a in allowed):
            return f"number {m.group(0)} not in evidence"
    if (w := BANNED.search(text)):
        return f"claim or advice beyond the evidence: {w.group(0)!r}"
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
    # "not a chicken" always uses the fixed line, like the pig demo does.
    if os.environ.get("EXPLAIN_LLM", "1") != "0" and e.get("abstain_reason") != "not_chicken":
        t0 = time.monotonic()
        try:
            text = _llm(e)
            problem = check(text, e) or ("too slow" if time.monotonic() - t0 > TIMEOUT_S else None)
            if problem:
                print(f"[chicken_explain] LLM output rejected ({problem}): {text!r}")
            else:
                out = {"text": text, "source": "llm"}
        except Exception as err:  # noqa: BLE001 - any failure means the template
            print(f"[chicken_explain] LLM failed, using template: {err.__class__.__name__}: {err}")
    _cache[h] = out
    return out
