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


load_dotenv()

URL = "https://openrouter.ai/api/v1/chat/completions"
TIMEOUT_S = float(os.environ.get("EXPLAIN_TIMEOUT_S", "8"))

# SoundWel's 17 recording contexts. Naming one that isn't in the evidence is a new claim.
CONTEXTS = [
    "AfterNursing", "Barren", "BeforeNursing", "Castration", "Crushing", "Enriched", "Fighting", "Huddling",
    "Isolation", "MissedNursing", "NegativeConditioning", "NovelObject", "PositiveConditioning", "Restrain",
    "Reunion", "Run", "Surprise",
]


# How each recording situation reads to a farmer ("It sounds most like pigs recorded ...").
PLAIN = {
    "AfterNursing": "just after nursing", "Barren": "in a bare pen", "BeforeNursing": "just before nursing",
    "Castration": "during castration", "Crushing": "when being lain on by the sow", "Enriched": "in a pen with toys and straw",
    "Fighting": "during a fight", "Huddling": "while huddling together", "Isolation": "when separated from their group",
    "MissedNursing": "after missing a feed", "NegativeConditioning": "while waiting for something unpleasant",
    "NovelObject": "near something new", "PositiveConditioning": "while waiting for a treat", "Restrain": "while being held still",
    "Reunion": "when reunited with their group", "Run": "while running", "Surprise": "when startled",
}
WORD = {"calm": "calm", "distressed": "stressed"}
MAX_WORDS = 40


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

SYSTEM = """You write one short text message to a pig farmer about one call from their barn.

Rules:
- Use ONLY the facts in the JSON. Never add numbers, causes, health claims, diagnoses or advice.
- At most 2 short sentences and 30 words in total. Everyday words a farmer uses; no jargon (never say
  "confidence", "records", "typical", "data", "model", "valence" or "similarity").
- The only number you may write is how sure it is, as "(72% sure)", from "sure_pct".
- Sentence 1: whether it sounds calm or stressed ("word"), and how sure.
- Sentence 2 (optional): one reason. Use "situation" exactly as written (e.g. "It sounds most like pigs recorded
  when separated from their group"), and/or "matches_agree" (e.g. "all 3 of the closest recorded calls sound
  stressed too").
- Describe sounds, not feelings: "sounds stressed", never "the pig is scared", "in pain", "wants" or "feels".
- If status is "unsure": one sentence saying you are not sure yet whether it sounds calm or stressed."""

_cache: dict[str, dict] = {}


def _confidence(ev: dict) -> float:
    p = ev["p_distressed"]
    return round(p if ev["status"] == "distressed" else 1 - p if ev["status"] == "calm" else max(p, 1 - p), 2)


def prepare(ev: dict) -> dict:
    """The evidence the farmer's message may use: verdict, how sure, and the closest matches' situation in plain
    words. Measured values stay out: in pigs only call length separates calm from distressed, and a farmer can't
    act on "0.31 s vs 0.33 s"."""
    similar = [{"status": s["status"], "context": s["context"]} for s in ev.get("similar_calls", [])[:3]]
    status = ev["status"]
    # The situation of the closest match that sounds like the verdict (else the closest one), in plain words.
    same = [c for c in similar if c["status"] == status] or similar
    situation = PLAIN.get(same[0]["context"]) if same else None
    conf = _confidence(ev)
    return {
        "status": status,
        "abstain_reason": ev.get("abstain_reason"),
        "word": WORD.get(status),
        "confidence": conf,
        "sure_pct": round(conf * 100),
        "situation": situation,
        "matches_agree": _agree(similar, status),
        "matches_same": sum(c["status"] == status for c in similar),
        "similar_calls": similar,
    }


def _agree(similar: list[dict], status: str) -> str | None:
    """'all 3' / '2 of 3' of the closest recorded calls sound like the verdict."""
    if not similar or status == "unsure":
        return None
    n = sum(c["status"] == status for c in similar)
    return f"all {n}" if n == len(similar) and n > 1 else f"{n} of {len(similar)}"


def template(e: dict) -> str:
    if e["status"] == "unsure":
        if e.get("abstain_reason") == "not_pig":
            return "I'm not sure this is a pig call."
        return "I'm not sure yet whether this call sounds calm or stressed."
    text = f"Sounds {e['word']} ({e['sure_pct']}% sure)."
    if e["situation"]:
        text += f" It sounds most like pigs recorded {e['situation']}."
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
    low = text.lower()
    stray = [c for c in CONTEXTS if c not in known and (_context_re(c).search(text) or PLAIN[c].lower() in low)]
    if stray:
        return f"situation {stray[0]} not in evidence"
    if (w := BANNED.search(text)):
        return f"anthropomorphising word '{w.group(0)}'"
    if len(re.findall(r"[.!?](\s|$)", text.strip())) > 3 or len(text.split()) > MAX_WORDS:
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
            "max_tokens": 800,  # the model reasons first (~150-400 tokens); its thinking counts against this limit
        },
        timeout=TIMEOUT_S,
    )
    r.raise_for_status()
    text = r.json()["choices"][0]["message"].get("content")
    if not text:
        raise RuntimeError("empty reply")
    return text.strip()


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
