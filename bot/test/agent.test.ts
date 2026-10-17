/**
 * Drives runAgent end to end through the stdin app: real handlers, real API
 * calls, real alert poller, with sends collected instead of texted.
 *
 * Needs a running Oinkalytics API (the mock is fine); skipped without one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";

import * as api from "../src/api.ts";
import { runAgent } from "../src/agent.ts";
import { createStdinApp } from "../src/stdin-app.ts";
import type { Content } from "spectrum-ts";

const API = process.env.OINK_API ?? "http://localhost:8000";
const reachable = await api.health().then((h) => h.ok).catch(() => false);

const SUBS = ".subscribers.test.json";

const texts = (sent: Content[]) =>
  sent.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);

/** Harness: a collected-output agent plus a helper that waits for new sends. */
async function harness() {
  await fetch(`${API}/reset`, { method: "POST" });
  const sent: Content[] = [];
  rmSync(SUBS, { force: true });
  const dev = createStdinApp((c) => sent.push(c));
  const agent = await runAgent(dev.app, { subscribersFile: SUBS });

  const settle = async (minimum: number) => {
    const deadline = Date.now() + 5000;
    while (sent.length < minimum && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(sent.length >= minimum, `expected >=${minimum} sends, got ${sent.length}`);
  };

  return {
    sent,
    settle,
    async say(body: string) {
      const before = sent.length;
      dev.say(body);
      await settle(before + 1);
      return texts(sent.slice(before));
    },
    audio: dev.sendAudio,
    async stop() {
      dev.close();
      await agent.stop();
      rmSync(SUBS, { force: true });
    },
  };
}

const wav = (seed: number) => {
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

test("the agent, driven like a judge would", { skip: !reachable && "no API on OINK_API" }, async (t) => {
  const h = await harness();
  t.after(() => h.stop());

  await t.test("a first-time chat gets the help text before its answer", async () => {
    const out = await h.say("status");
    assert.ok(out.some((s) => s.includes("Oinkalytics, listening to your pens")), out.join("|"));
    assert.ok(out.some((s) => s.includes("Pen 1") || s.includes("No pens")), out.join("|"));
  });

  await t.test("'why' before any alert says so instead of erroring", async () => {
    const out = await h.say("why?");
    assert.deepEqual(out, ["No alerts yet. All quiet."]);
  });

  await t.test("'play it' before any alert says so too", async () => {
    const out = await h.say("play it");
    assert.deepEqual(out, ["No alerts yet. All quiet."]);
  });

  await t.test("a sent recording comes back with a verdict", async () => {
    const before = h.sent.length;
    h.audio("distress-memo.wav", "audio/wav", wav(7));
    await h.settle(before + 1);
    const out = texts(h.sent.slice(before));
    assert.ok(out[0]?.includes("Distressed"), out.join("|"));
  });

  await t.test("a non-audio attachment is declined politely", async () => {
    const before = h.sent.length;
    h.audio("barn.png", "image/png", Buffer.from("not audio"));
    await h.settle(before + 1);
    assert.ok(texts(h.sent.slice(before))[0]?.includes("only listen to audio"));
  });

  await t.test("an alert fires on its own and gets texted", async () => {
    const before = h.sent.length;
    for (const i of [1, 2, 3]) {
      await api.predict(wav(i + 20), `distress-${i}.wav`, { penId: "3" });
    }
    await h.settle(before + 1);
    const out = texts(h.sent.slice(before));
    assert.ok(out.some((s) => s.includes("Pen 3: distress calls rising")), out.join("|"));
  });

  await t.test("now 'why' explains the alert that fired", async () => {
    const out = (await h.say("why")).join("\n");
    assert.ok(out.includes("Pen 3"), out);
    const latest = await api.latestAlert("3");
    assert.ok(latest && out.includes(latest.explanation.text), out);
  });

  await t.test("'play it' attaches the triggering WAV", async () => {
    const before = h.sent.length;
    await h.say("play it");
    const att = h.sent.slice(before).find((c) => c.type === "attachment");
    assert.ok(att, "expected an attachment");
    assert.equal((att as { mimeType: string }).mimeType, "audio/wav");
    const bytes = await (att as { read(): Promise<Buffer> }).read();
    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  });

  await t.test("mute stops alerts, unmute brings them back", async () => {
    assert.ok((await h.say("mute"))[0]?.includes("muted"));
    const before = h.sent.length;
    for (const i of [1, 2, 3]) {
      await api.predict(wav(i + 40), `distress-m${i}.wav`, { penId: "2" });
    }
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(
      !texts(h.sent.slice(before)).some((s) => s.includes("Pen 2: distress")),
      "muted agent must not text alerts",
    );
    assert.ok((await h.say("unmute"))[0]?.includes("back on"));
  });

  await t.test("gibberish gets the help nudge, not a crash", async () => {
    assert.ok((await h.say("tell me a joke"))[0]?.includes("help"));
  });
});
