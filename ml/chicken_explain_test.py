"""Tests for ml/chicken_explain.py, on hand-written evidence dicts.

    python -m pytest ml/chicken_explain_test.py -q
    python -m ml.chicken_explain_test              # no pytest needed

Named chicken_* to stay inside the add-on's file budget. The point of these is the
guardrails, not the wording: the template must never invent a number, and check()
must reject an LLM answer that names a disease, gives advice, or cites a figure
that is not in the evidence.
"""

import sys

from ml.chicken_explain import check, prepare, template

SICK = {
    "status": "sick",
    "p_sick": 0.86,
    "features": {"duration_s": 4.92, "f0_mean_hz": 612.3, "loudness_db": -12.1,
                 "spectral_centroid_hz": 2410.0, "am_rate_hz": 21.4},
    "typical": {"healthy": {"duration_s": 2.1, "f0_mean_hz": 430.0},
                "sick": {"duration_s": 4.8, "f0_mean_hz": 640.0}},
}
HEALTHY = {**SICK, "status": "healthy", "p_sick": 0.11}
UNSURE = {**SICK, "status": "unsure", "p_sick": 0.52, "abstain_reason": "low_confidence"}
NOT_CHICKEN = {**SICK, "status": "unsure", "p_sick": 0.5, "abstain_reason": "not_chicken"}


def check_cases():
    cases = []

    def case(name, ok):
        cases.append((name, ok))

    # --- the template is always clean by construction -----------------------
    for name, ev in [("sick", SICK), ("healthy", HEALTHY), ("unsure", UNSURE), ("not_chicken", NOT_CHICKEN)]:
        e = prepare(ev)
        t = template(e)
        case(f"template/{name} is non-empty", bool(t.strip()))
        case(f"template/{name} passes its own check", check(t, e) is None)

    e = prepare(SICK)
    case("sick template says unhealthy", "unhealthy" in template(e))
    case("template never mentions duration", "s (" not in template(e) and "lasted" not in template(e))
    case("healthy template says healthy", "healthy" in template(prepare(HEALTHY)))
    case("not_chicken template is the fixed line",
         template(prepare(NOT_CHICKEN)) == "I'm not sure this is a chicken recording.")
    case("unsure template gives no verdict",
         "unhealthy" not in template(prepare(UNSURE)).replace("unhealthy ", "x", 0)
         or "not confident" in template(prepare(UNSURE)))

    # --- check() must catch everything that strays --------------------------
    case("invented number rejected",
         check("This recording sounds unhealthy (86% confident). It lasted 9.99 s.", e) is not None)
    case("named disease rejected",
         check("This recording sounds unhealthy (86% confident). It suggests bronchitis.", e) is not None)
    case("diagnosis word rejected",
         check("The birds are infected (86% confident). It lasted 4.92 s.", e) is not None)
    case("advice rejected",
         check("This recording sounds unhealthy (86% confident). You should call a vet.", e) is not None)
    case("feelings rejected",
         check("This recording sounds unhealthy (86% confident). The birds are suffering.", e) is not None)
    case("rambling rejected",
         check("One. Two. Three. Four. Five.", e) is not None)

    # --- numbers that ARE in the evidence must pass --------------------------
    case("evidence numbers accepted",
         check("This recording sounds unhealthy (86% confident). It had a mean pitch of 612 Hz "
               "(typical unhealthy recording: 640 Hz).", e) is None)
    # Clip length is the file size, not a bird property, and is part of the confound.
    case("duration comparison rejected",
         check("This recording sounds unhealthy (86% confident). It lasted 4.92 s.", e) is not None)
    case("duration is not offered as a comparison", "duration_s" not in prepare(SICK)["typical"])
    case("duration is not measured into the evidence", "duration_s" not in prepare(SICK)["measured"])
    case("rounded percentage accepted",
         check("This recording sounds unhealthy (86% confident).", e) is None)

    # --- prepare() only keeps informative comparisons ------------------------
    flat = {**SICK, "typical": {"healthy": {"f0_mean_hz": 640.0},
                                "sick": {"f0_mean_hz": 641.0}}}
    case("uninformative typicals dropped", prepare(flat)["typical"] == {})
    case("informative typicals kept", set(prepare(SICK)["typical"]) == {"f0_mean_hz"})
    case("confidence flips for healthy", prepare(HEALTHY)["confidence"] == 0.89)
    case("confidence for sick", prepare(SICK)["confidence"] == 0.86)

    return cases


def main() -> int:
    cases = check_cases()
    failed = [n for n, ok in cases if not ok]
    for name, ok in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
    print(f"\n{len(cases) - len(failed)}/{len(cases)} passed")
    return 1 if failed else 0


# pytest entry points, so `pytest ml/chicken_explain_test.py` works too
def test_all():
    failed = [n for n, ok in check_cases() if not ok]
    assert not failed, f"failed: {failed}"


if __name__ == "__main__":
    sys.exit(main())
