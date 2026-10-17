"""Tests for ml.explain. Run: .venv/bin/python -m unittest ml.test_explain -v
Set EXPLAIN_LIVE=1 to also make one real OpenRouter call.
"""

import os
import unittest
from unittest import mock

import numpy as np

from ml import evidence, explain as ex

TYPICAL = {
    "calm": {"duration_s": 0.25, "f0_mean_hz": 69.0},
    "distressed": {"duration_s": 0.33, "f0_mean_hz": 70.0},  # pitch barely differs: not cited
}

DISTRESSED = {
    "status": "distressed", "abstain_reason": None, "p_distressed": 0.86,
    "features": {"duration_s": 0.92, "f0_mean_hz": 612.3, "loudness_db": -12.1,
                 "spectral_centroid_hz": 2410.0, "am_rate_hz": 21.4},
    "typical": TYPICAL,
    "similar_calls": [{"status": "distressed", "context": "Restrain", "similarity": 0.91},
                      {"status": "distressed", "context": "Isolation", "similarity": 0.88}],
}
CALM = {**DISTRESSED, "status": "calm", "p_distressed": 0.12,
        "features": {**DISTRESSED["features"], "duration_s": 0.21, "f0_mean_hz": None},
        "similar_calls": [{"status": "calm", "context": "Enriched", "similarity": 0.83}]}
UNSURE = {**DISTRESSED, "status": "unsure", "abstain_reason": "low_confidence", "p_distressed": 0.52}
NOT_PIG = {**DISTRESSED, "status": "unsure", "abstain_reason": "not_pig", "p_distressed": 0.7}


class Base(unittest.TestCase):
    def setUp(self):
        ex._cache.clear()
        patches = [mock.patch.dict(os.environ, {"EXPLAIN_LLM": "1", "OPENROUTER_API_KEY": "test"})]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


class TemplateTests(Base):
    def test_distressed_is_plain_farmer_language(self):
        t = ex.template(ex.prepare(DISTRESSED))
        self.assertEqual(t, "Sounds stressed (86% sure). It sounds most like pigs recorded while being held still.")
        for jargon in ("confident", "typical", "0.92", "Hz", "Restrain"):
            self.assertNotIn(jargon, t)

    def test_calm(self):
        t = ex.template(ex.prepare(CALM))
        self.assertEqual(t, "Sounds calm (88% sure). It sounds most like pigs recorded in a pen with toys and straw.")

    def test_unsure_low_confidence(self):
        t = ex.template(ex.prepare(UNSURE))
        self.assertEqual(t, "I'm not sure yet whether this call sounds calm or stressed.")

    def test_not_pig_is_the_fixed_line(self):
        self.assertEqual(ex.template(ex.prepare(NOT_PIG)), "I'm not sure this is a pig call.")

    def test_templates_pass_their_own_check(self):
        for ev in (DISTRESSED, CALM, UNSURE, NOT_PIG):
            e = ex.prepare(ev)
            self.assertIsNone(ex.check(ex.template(e), e), ev["status"])


class CheckTests(Base):
    def setUp(self):
        super().setUp()
        self.e = ex.prepare(DISTRESSED)

    def test_accepts_plain_messages(self):
        for ok in ("Sounds stressed (86% sure). It sounds most like pigs recorded while being held still.",
                   "This pig sounds stressed (86% sure): 2 of 2 of the closest calls sound the same.",
                   "Sounds stressed, 86% sure. It sounds like calls recorded during restrain."):
            self.assertIsNone(ex.check(ok, self.e), ok)

    def test_rejects_measurements_now_left_out(self):
        self.assertIn("number", ex.check("Sounds stressed (86% sure). It lasted 0.92 s.", self.e))

    def test_rejects_plain_words_situation_not_in_evidence(self):
        self.assertIn("Fighting", ex.check("Sounds stressed (86% sure), like pigs recorded during a fight.", self.e))

    def test_rejects_invented_number(self):
        self.assertIn("number", ex.check("This call sounds distressed (86% confident) at 95 dB.", self.e))

    def test_rejects_situation_not_in_evidence(self):
        self.assertIn("Castration", ex.check("It sounds like calls recorded during castration.", self.e))
        self.assertIn("NovelObject", ex.check("It sounds like calls recorded near a novel object.", self.e))

    def test_rejects_anthropomorphising(self):
        self.assertIn("scared", ex.check("The pig is scared.", self.e))
        self.assertIn("pain", ex.check("This sounds like a pig in pain.", self.e))

    def test_rejects_long_output(self):
        self.assertEqual(ex.check("One. Two. Three. Four.", self.e), "too long")
        self.assertEqual(ex.check("Sounds stressed " + "and very " * 20 + "loud.", self.e), "too long")


class ExplainTests(Base):
    def test_clean_llm_output_is_used(self):
        text = "Sounds stressed (86% sure). It sounds most like pigs recorded while being held still."
        with mock.patch.object(ex, "_llm", return_value=text) as llm:
            self.assertEqual(ex.explain(DISTRESSED), {"text": text, "source": "llm"})
            ex.explain(DISTRESSED)  # cached
            self.assertEqual(llm.call_count, 1)

    def test_straying_llm_output_falls_back(self):
        with mock.patch.object(ex, "_llm", return_value="The pig is scared, 99% sure."):
            self.assertEqual(ex.explain(DISTRESSED)["source"], "template")

    def test_llm_failure_or_timeout_falls_back(self):
        import httpx

        for err in (httpx.ReadTimeout("slow"), RuntimeError("boom")):
            ex._cache.clear()
            with mock.patch.object(ex, "_llm", side_effect=err):
                self.assertEqual(ex.explain(DISTRESSED)["source"], "template")

    def test_not_pig_never_calls_llm(self):
        with mock.patch.object(ex, "_llm") as llm:
            self.assertEqual(ex.explain(NOT_PIG), {"text": "I'm not sure this is a pig call.", "source": "template"})
            llm.assert_not_called()

    def test_llm_disabled(self):
        with mock.patch.dict(os.environ, {"EXPLAIN_LLM": "0"}), mock.patch.object(ex, "_llm") as llm:
            self.assertEqual(ex.explain(UNSURE)["source"], "template")
            llm.assert_not_called()


class MeasureTests(unittest.TestCase):
    def test_keys_match_schema_and_values_are_sane(self):
        from api.schemas import Features

        sr = 32000
        t = np.arange(int(0.5 * sr)) / sr
        tone = 0.5 * np.sin(2 * np.pi * 300 * t) * (1 + 0.8 * np.sin(2 * np.pi * 20 * t)) / 1.8
        y = np.concatenate([np.zeros(sr // 4), tone, np.zeros(sr // 4)])
        f = evidence.measure(y, sr)
        Features(**f)
        self.assertEqual(set(f), set(Features.model_fields))
        self.assertAlmostEqual(f["f0_mean_hz"], 300, delta=5)
        self.assertAlmostEqual(f["am_rate_hz"], 20, delta=2)
        self.assertAlmostEqual(f["duration_s"], 0.5, delta=0.1)

    def test_silence_does_not_crash(self):
        f = evidence.measure(np.zeros(16000), 32000)
        self.assertIsNone(f["f0_mean_hz"])


@unittest.skipUnless(os.environ.get("EXPLAIN_LIVE") == "1", "set EXPLAIN_LIVE=1 for a real OpenRouter call")
class LiveTest(unittest.TestCase):
    def test_real_call(self):
        ex._cache.clear()
        for ev in (DISTRESSED, CALM, UNSURE):
            out = ex.explain(ev)
            print(f"\n[{ev['status']}] {out['source']}: {out['text']}")


if __name__ == "__main__":
    unittest.main()
