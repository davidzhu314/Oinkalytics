import { test } from "node:test";
import assert from "node:assert/strict";
import { alertText, handle, parse, penOf, type BotState, type Source } from "../src/commands.ts";
import { alertPoller } from "../src/alerts.ts";
import { classify, onceEvery, rateLimiter } from "../src/guard.ts";
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
    async latestAlert(penId?: string) {
      check();
      return alerts.filter((a) => !penId || a.pen_id === penId).at(-1);
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

test("natural phrasing a judge might use", () => {
  const cases: [string, string | undefined][] = [
    ["How's the coop doing?", "status"],
    ["what's going on", "status"],
    ["Any problems?", "status"],
    ["Give me an update", "status"],
    ["What's wrong in pen 3?", "why"],
    ["what happened", "why"],
    ["Can I hear it?", "play"],
    ["what does it sound like", "play"],
    ["send me the audio", "play"],
    ["please stop the alerts", "mute"],
    ["turn alerts back on", "unmute"],
    ["Is the barn quiet?", "status"],
    ["Why is pen 3 on alert?", "why"],
    ["what can you do", "help"],
    ["", "help"],
    ["the weather is nice", undefined],
  ];
  for (const [text, want] of cases) assert.equal(parse(text), want, text);
});

test("pen-scoped why and play", async () => {
  const oink = fakeOink([alert("a1", "2"), alert("a2", "3")]);
  assert.equal(penOf("why pen 2?"), "2");
  assert.equal(penOf("What's wrong in Pen #4"), "4");
  assert.equal(penOf("why"), undefined);
  const [why2] = await handle("why pen 2", pigs(oink), { muted: false });
  assert.match((why2 as { text: string }).text, /^Pen 2:/);
  const [why1] = await handle("why pen 1", pigs(oink), { muted: false });
  assert.equal((why1 as { text: string }).text, "No alerts from Pen 1 yet.");
  const play = await handle("play pen 2", pigs(oink), { muted: false });
  assert.equal(play[1].kind === "audio" && play[1].name, "pen-2-call.wav");
});

test("only real inbound texts get answered; receipts, typing and our own messages never do", () => {
  assert.equal(classify("inbound", "text"), "text");
  assert.equal(classify("inbound", "attachment"), "media");
  assert.equal(classify("inbound", "voice"), "media");
  for (const t of ["read", "typing", "reaction", "edit", "unsend", "effect", "richlink"]) assert.equal(classify("inbound", t), "ignore", t);
  assert.equal(classify("outbound", "text"), "ignore");
});

test("rate limit caps replies per conversation, and the media notice is sent at most every 2 min", () => {
  let now = 0;
  const rl = rateLimiter(5, 10_000, () => now);
  const ok = Array.from({ length: 8 }, () => rl.allow("chat"));
  assert.deepEqual(ok, [true, true, true, true, true, false, false, false]);
  assert.equal(rl.allow("other chat"), true);
  now = 10_001;
  assert.equal(rl.allow("chat"), true);
  const notice = onceEvery(120_000, () => now);
  assert.equal(notice("chat"), true);
  now += 60_000;
  assert.equal(notice("chat"), false);
  now += 61_000;
  assert.equal(notice("chat"), true);
});

test("one alert message: verdict, how sure, the reason, one hint", () => {
  const pig: Source = { name: "Pigs", emoji: "🐷", bad: "stressed", match: /pig/, oink: fakeOink() };
  const hen: Source = { name: "Chickens", emoji: "🐔", bad: "sick", match: /chicken/, oink: fakeOink() };
  const withReason = { ...alert("a1", "3"), confidence: 0.78,
    explanation: { text: "This call sounds stressed (81% sure). It sounds most like pigs recorded when separated from their group.", source: "llm" as const } };
  assert.equal(alertText(pig, withReason),
    "🐷 Pen 3: the pigs sound stressed (78% sure). 3 of their last 5 calls sounded stressed, from one animal or several.\n" +
    "It sounds most like pigs recorded when separated from their group.\n" +
    'Reply "play it" to hear the call.');
  // a one-sentence explanation has no extra reason: two lines, no repeat of the verdict
  const short = { ...alert("c1", "2"), confidence: 1, explanation: { text: "This recording sounds unhealthy (100% confident).", source: "template" as const } };
  assert.equal(alertText(hen, short), "🐔 Pen 2: the chickens sound sick (100% sure). 3 of their last 5 calls sounded sick, from one animal or several.\n" +
    'Reply "play it" to hear the call.');
  assert.doesNotMatch(alertText(pig, withReason), /why pig|play pig|Reply "why"/);
});

test("replies tag the pen with its animal", async () => {
  const sources: Source[] = [
    { name: "Pigs", emoji: "🐷", match: /\bpigs?\b/, oink: fakeOink([alert("p1", "3")]) },
    { name: "Chickens", emoji: "🐔", match: /\bchickens?\b/, oink: fakeOink([]) },
  ];
  const [why] = await handle("why", sources, { muted: false });
  assert.match((why as { text: string }).text, /^🐷 Pen 3: /);
});
