import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, parse, type BotState, type Source } from "../src/commands.ts";
import { alertPoller } from "../src/alerts.ts";
import type { Alert, Oink } from "../src/oink.ts";

const alert = (id: string, pen = "3"): Alert => ({
  alert_id: id,
  pen_id: pen,
  created_at: "2026-10-17T14:00:00Z",
  message: `Pen ${pen}: distress calls rising, 3 of the last 5 flagged`,
  distressed: 3,
  window: 5,
  confidence: 0.82,
  trigger_prediction_id: "pred_1",
  explanation: { text: "It sounds like calls recorded during isolation.", source: "template" },
  audio_url: "/audio/clip_1",
});

function fakeOink(alerts: Alert[] = [], opts: { down?: boolean; summary?: string } = {}): Oink {
  const check = () => {
    if (opts.down) throw new Error("ECONNREFUSED");
  };
  return {
    async pens() {
      check();
      return [
        { pen_id: "1", level: "calm", window: 5, distressed: 0, last_prediction_id: null, updated_at: null, summary: opts.summary ?? "Pen 1: calm" },
        { pen_id: "3", level: "alert", window: 5, distressed: 4, last_prediction_id: null, updated_at: null, summary: "Pen 3: ALERT, 4 of last 5 distressed" },
      ];
    },
    async alerts(after?: string) {
      check();
      const i = after ? alerts.findIndex((a) => a.alert_id === after) : -1;
      return alerts.slice(i + 1);
    },
    async latestAlert() {
      check();
      return alerts.at(-1);
    },
    async audio() {
      check();
      return Buffer.from("RIFF");
    },
    async predict() {
      throw new Error("not used");
    },
  };
}

const pigs = (oink: Oink): Source[] => [{ name: "Pigs", match: /\bpigs?\b/, oink }];

test("parse understands the farmer's phrasings", () => {
  assert.equal(parse("Status"), "status");
  assert.equal(parse("why?"), "why");
  assert.equal(parse("Why did pen 3 go off"), "why");
  assert.equal(parse("Play it."), "play");
  assert.equal(parse("unmute"), "unmute");
  assert.equal(parse("mute"), "mute");
  assert.equal(parse("hi"), "help");
  assert.equal(parse("what's the weather"), undefined);
});

test("status lists every pen summary", async () => {
  const [r] = await handle("status", pigs(fakeOink()), { muted: false });
  assert.deepEqual(r, { kind: "text", text: "Pen 1: calm\nPen 3: ALERT, 4 of last 5 distressed" });
});

test("why and play it handle no alerts yet", async () => {
  const why = await handle("why?", pigs(fakeOink()), { muted: false });
  assert.match((why[0] as { text: string }).text, /No alerts yet/);
  const play = await handle("play it", pigs(fakeOink()), { muted: false });
  assert.equal(play.length, 1);
});

test("why quotes the latest alert's explanation; play it attaches the WAV", async () => {
  const oink = fakeOink([alert("a1", "2"), alert("a2", "3")]);
  const [why] = await handle("why", pigs(oink), { muted: false });
  assert.deepEqual(why, { kind: "text", text: "Pen 3: It sounds like calls recorded during isolation." });
  const play = await handle("play it", pigs(oink), { muted: false });
  assert.equal(play[1].kind, "audio");
  assert.equal(play[1].kind === "audio" && play[1].name, "pen-3-call.wav");
});

test("mute and unmute flip state", async () => {
  const state: BotState = { muted: false };
  await handle("mute", pigs(fakeOink()), state);
  assert.equal(state.muted, true);
  await handle("unmute", pigs(fakeOink()), state);
  assert.equal(state.muted, false);
});

test("API down gives a friendly reply, not a crash", async () => {
  const [r] = await handle("status", pigs(fakeOink([], { down: true })), { muted: false });
  assert.match((r as { text: string }).text, /can't reach the barn monitor/);
});

test("poller skips alerts that existed at startup and sends new ones once", async () => {
  const alerts = [alert("a1"), alert("a2")];
  const sent: string[] = [];
  const p = alertPoller({ oink: fakeOink(alerts), state: { muted: false }, deliver: async (a) => void sent.push(a.alert_id) });
  await p.tick();
  assert.deepEqual(sent, []);
  alerts.push(alert("a3"), alert("a4"));
  await p.tick();
  await p.tick();
  assert.deepEqual(sent, ["a3", "a4"]);
});

test("poller drops alerts while muted and retries after a failed send", async () => {
  const alerts: Alert[] = [];
  const state: BotState = { muted: true };
  const sent: string[] = [];
  let fail = false;
  const p = alertPoller({
    oink: fakeOink(alerts),
    state,
    deliver: async (a) => {
      if (fail) throw new Error("send failed");
      sent.push(a.alert_id);
    },
  });
  await p.tick();
  alerts.push(alert("a1"));
  await p.tick(); // muted: logged, not sent
  state.muted = false;
  fail = true;
  alerts.push(alert("a2"));
  await p.tick(); // send fails, cursor stays on a1
  fail = false;
  await p.tick();
  assert.deepEqual(sent, ["a2"]);
});

test("two species: status lists both, why picks the newest alert or the named species", async () => {
  const pigAlert = { ...alert("p1", "3"), created_at: "2026-10-17T14:00:00Z" };
  const henAlert = { ...alert("c1", "2"), created_at: "2026-10-17T15:00:00Z",
    explanation: { text: "It sounds like the sick-group recordings.", source: "template" as const } };
  const sources: Source[] = [
    { name: "Pigs", match: /\bpigs?\b/, oink: fakeOink([pigAlert]) },
    { name: "Chickens", match: /\bchickens?\b/, oink: fakeOink([henAlert], { summary: "Pen 1: healthy" }) },
  ];
  const state = { muted: false };
  const [status] = await handle("status", sources, state);
  assert.match((status as { text: string }).text, /^Pigs:\nPen 1: calm[\s\S]*\n\nChickens:\nPen 1: healthy/);
  const [why] = await handle("why", sources, state);
  assert.deepEqual(why, { kind: "text", text: "Chickens, Pen 2: It sounds like the sick-group recordings." });
  const [whyPig] = await handle("why pig", sources, state);
  assert.match((whyPig as { text: string }).text, /^Pigs, Pen 3:/);
  const play = await handle("play it chicken", sources, state);
  assert.equal(play[1].kind === "audio" && play[1].name, "chickens-pen-2-call.wav");
});

test("chicken monitor down: pigs still answer, chickens say not connected", async () => {
  const sources: Source[] = [
    { name: "Pigs", match: /\bpigs?\b/, oink: fakeOink([alert("p1")]) },
    { name: "Chickens", match: /\bchickens?\b/, oink: fakeOink([], { down: true }) },
  ];
  const [status] = await handle("status", sources, { muted: false });
  assert.match((status as { text: string }).text, /Chickens: monitor not connected\./);
  const [why] = await handle("why", sources, { muted: false });
  assert.match((why as { text: string }).text, /^Pigs, Pen 3:/);
  const [whyHen] = await handle("why chicken", sources, { muted: false });
  assert.equal((whyHen as { text: string }).text, "Chickens: monitor not connected.");
});
