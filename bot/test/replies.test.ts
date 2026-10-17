import assert from "node:assert/strict";
import { test } from "node:test";

import { clipReply, statusReply, whyReply } from "../src/replies.ts";
import type { Alert, PenStatus, Prediction } from "../src/types.ts";

const pen = (over: Partial<PenStatus> = {}): PenStatus => ({
  pen_id: "3",
  level: "alert",
  window: 5,
  distressed: 4,
  last_prediction_id: "pred_x",
  updated_at: "2026-10-17T10:00:00Z",
  summary: "Pen 3: ALERT, 4 of last 5 distressed",
  ...over,
});

const alert = (over: Partial<Alert> = {}): Alert => ({
  alert_id: "alrt_1",
  pen_id: "3",
  created_at: "2026-10-17T10:00:00Z",
  message: "Pen 3: distress calls rising, 4 of the last 5 flagged (82% confidence).",
  distressed: 4,
  window: 5,
  confidence: 0.82,
  trigger_prediction_id: "pred_x",
  explanation: { text: "The calls were long and high-pitched.", source: "llm" },
  audio_url: "/audio/clip_x",
  ...over,
});

const prediction = (over: Partial<Prediction> = {}): Prediction => ({
  prediction_id: "pred_x",
  clip_id: "clip_x",
  pen_id: "3",
  created_at: "2026-10-17T10:00:00Z",
  status: "distressed",
  abstain_reason: null,
  valence: { p_distressed: 0.86, confidence: 0.86 },
  context_top3: [{ label: "Isolation", p: 0.41 }],
  features: {
    duration_s: 0.92,
    f0_mean_hz: 612.3,
    loudness_db: -12.1,
    spectral_centroid_hz: 2410,
    am_rate_hz: 21.4,
  },
  similar_calls: [],
  explanation: { text: "Long, high-pitched and loud.", source: "llm" },
  audio_url: "/audio/clip_x",
  ...over,
});

test("pen summaries are sent exactly as the API wrote them", () => {
  assert.equal(statusReply([pen()]), "Pen 3: ALERT, 4 of last 5 distressed");
  assert.equal(statusReply([]), "No pens are reporting yet.");
});

test("why? quotes the alert message and the API's explanation, unchanged", () => {
  const a = alert();
  const out = whyReply(a);
  assert.ok(out.includes(a.message));
  assert.ok(out.includes(a.explanation.text));
});

test("a clip verdict carries confidence and the API's explanation", () => {
  const out = clipReply(prediction());
  assert.ok(out.startsWith("Distressed — 86% confident."));
  assert.ok(out.includes("Long, high-pitched and loud."));
});

test("context is always labelled as a random-split result", () => {
  // docs/API.md: contexts are tied to recording sessions, so we must not imply
  // the honest leave-session-out accuracy applies to them.
  const out = clipReply(prediction());
  assert.ok(out.includes("random-split accuracy"), out);
  assert.ok(out.includes("Isolation"));
});

test("an unsure call says only what the API said: no verdict, no context claim", () => {
  const out = clipReply(
    prediction({
      status: "unsure",
      abstain_reason: "not_pig",
      valence: { p_distressed: 0.51, confidence: 0.51 },
      explanation: { text: "I'm not sure this is a pig call.", source: "template" },
    }),
  );
  assert.equal(out, "I'm not sure this is a pig call.");
  assert.ok(!out.includes("Distressed"));
  assert.ok(!out.includes("Calm"));
  assert.ok(!out.includes("Isolation"));
});
