/**
 * End-to-end against a running Oinkalytics API. Walks the demo script: feed a
 * pen distress clips until it alerts, then answer "why?" and "play it".
 *
 * Skipped automatically when no API is reachable, so `npm test` works offline.
 *
 *   uvicorn api.mock_server:app --port 8000     # in the repo root
 *   ALERT_COOLDOWN_S=5 npm test                 # in bot/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as api from "../src/api.ts";
import { AlertPoller } from "../src/alerts.ts";
import { clipReply, statusReply, whyReply } from "../src/replies.ts";
import type { Alert } from "../src/types.ts";

const reachable = await api
  .health()
  .then((h) => h.ok)
  .catch(() => false);

const wavBytes = (seed: number) => {
  // A tiny valid WAV. The mock keys its verdict off the bytes and the filename,
  // so a varying sample keeps each clip distinct.
  const samples = 1600;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((i * (seed + 3)) / 20)), 44 + i * 2);
  }
  return buf;
};

test("the demo script, end to end", { skip: !reachable && "no API on OINK_API" }, async (t) => {
  await fetch(`${process.env.OINK_API ?? "http://localhost:8000"}/reset`, { method: "POST" });

  const seen: Alert[] = [];
  const poller = new AlertPoller(async (a) => void seen.push(a));
  assert.equal(await poller.catchUp(), 0, "reset should leave no alerts");
  poller.start();
  t.after(() => poller.stop());

  await t.test("a distressed clip comes back distressed, with an explanation", async () => {
    const pred = await api.predict(wavBytes(1), "distress-1.wav", { penId: "3" });
    assert.equal(pred.status, "distressed");
    assert.ok(pred.valence.confidence > 0.5);
    assert.ok(clipReply(pred).includes("Distressed"));
  });

  await t.test("a non-pig clip abstains instead of guessing", async () => {
    const pred = await api.predict(wavBytes(2), "clap-noise.wav");
    assert.equal(pred.status, "unsure");
    assert.equal(clipReply(pred), pred.explanation.text);
  });

  await t.test("three distressed calls push the pen to alert", async () => {
    for (const i of [2, 3]) {
      await api.predict(wavBytes(i + 10), `distress-${i}.wav`, { penId: "3" });
    }
    const pen3 = await api.pen("3");
    assert.equal(pen3.level, "alert");
    assert.ok(pen3.distressed >= 3);
    assert.ok(statusReply(await api.pens()).includes("Pen 3: ALERT"));
  });

  await t.test("the poller picks the alert up and 'why?' explains it", async () => {
    const deadline = Date.now() + 8000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(seen.length > 0, "no alert arrived within 8s");

    const latest = await api.latestAlert("3");
    assert.ok(latest, "latestAlert should find the alert");
    assert.equal(latest.pen_id, "3");
    assert.ok(whyReply(latest).includes(latest.explanation.text));
  });

  await t.test("'play it' returns real WAV bytes", async () => {
    const latest = await api.latestAlert("3");
    assert.ok(latest);
    const wav = await api.audio(latest.audio_url);
    assert.ok(wav.length > 44);
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  });

  await t.test("a restart does not re-text the backlog", async () => {
    const fresh = new AlertPoller(async () => {});
    assert.ok((await fresh.catchUp()) > 0, "catchUp should swallow existing alerts");
  });
});

test("latestAlert answers null, not a throw, before anything has fired", {
  skip: !reachable && "no API on OINK_API",
}, async () => {
  await fetch(`${process.env.OINK_API ?? "http://localhost:8000"}/reset`, { method: "POST" });
  assert.equal(await api.latestAlert(), null);
});
