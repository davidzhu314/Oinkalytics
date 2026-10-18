import { test } from "node:test";
import assert from "node:assert/strict";
import { alertText, digestText, emergencySpeech, emergencyText, emergencyWatch, escalationText, escalator, handle, parse, penOf, severity, type BotState, type Source } from "../src/commands.ts";
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
  const pig: Source = { name: "Pigs", emoji: "🐷", bad: "stressed", noun: "pig", match: /pig/, oink: fakeOink() };
  const hen: Source = { name: "Chickens", emoji: "🐔", bad: "sick", noun: "hen", match: /chicken/, oink: fakeOink() };
  const withReason = { ...alert("a1", "3"), confidence: 0.78,
    explanation: { text: "This call sounds stressed (81% sure). It sounds most like pigs recorded when separated from their group.", source: "llm" as const } };
  assert.equal(alertText(pig, withReason),
    "⚠️ Warning · 🐷 Pen 3 sounds stressed (78% sure). 3 of the last 5 calls from the pen sounded stressed, could be one pig or several.\n" +
    "It sounds most like pigs recorded when separated from their group.\n" +
    'Reply "play it" to hear the call.');
  // a one-sentence explanation has no extra reason: two lines, no repeat of the verdict
  const short = { ...alert("c1", "2"), confidence: 1, explanation: { text: "This recording sounds unhealthy (100% confident).", source: "template" as const } };
  assert.equal(alertText(hen, short), "⚠️ Warning · 🐔 Pen 2 sounds sick (>99% sure). 3 of the last 5 calls from the pen sounded sick, could be one hen or several.\n" +
    'Reply "play it" to hear the call.');
  assert.doesNotMatch(alertText(pig, withReason), /why pig|play pig|Reply "why"/);
});

test("alerts and escalations use the pen's name when the hub set one", () => {
  const pig: Source = { name: "Pigs", emoji: "🐷", bad: "stressed", noun: "pig", match: /pig/, oink: fakeOink() };
  const named = { ...alert("n1", "L1-x7k2"), pen_name: "North barn", confidence: 0.82 };
  assert.match(alertText(pig, named), /^⚠️ Warning · 🐷 North barn sounds stressed \(82% sure\)/);
  assert.match(alertText(pig, { ...named, pen_name: null }), /🐷 Pen L1-x7k2 sounds/);
  const status = { pen_id: "L1-x7k2", name: "North barn", level: "alert" as const, window: 5, distressed: 4,
    last_prediction_id: null, updated_at: null, summary: "" };
  assert.match(escalationText(pig, status), /🐷 North barn: it's getting worse/);
});

test("replies tag the pen with its animal", async () => {
  const sources: Source[] = [
    { name: "Pigs", emoji: "🐷", match: /\bpigs?\b/, oink: fakeOink([alert("p1", "3")]) },
    { name: "Chickens", emoji: "🐔", match: /\bchickens?\b/, oink: fakeOink([]) },
  ];
  const [why] = await handle("why", sources, { muted: false });
  assert.match((why as { text: string }).text, /^🐷 Pen 3: /);
});

test("3 of 5 is a warning, 4 or 5 of 5 is critical", () => {
  const pig: Source = { name: "Pigs", emoji: "🐷", bad: "stressed", noun: "pig", match: /pig/, oink: fakeOink() };
  assert.equal(severity(3), "warning");
  assert.equal(severity(4), "critical");
  const five = { ...alert("a5", "3"), distressed: 5, window: 5, confidence: 0.9 };
  assert.match(alertText(pig, five), /^🚨 Critical · 🐷 Pen 3 sounds stressed \(90% sure\)\. The last 5 calls from the pen all sounded stressed, could be one pig or several\. Please check the pen now\./);
  // 2 pigs can make 4 calls: the text says calls, never "4 pigs"
  assert.doesNotMatch(alertText(pig, { ...five, distressed: 4, window: 4 }), /4 pigs|of their/);
});

test("a warned pen that gets worse gets one critical follow-up, within 10 minutes", () => {
  let now = 0;
  const w = escalator(600_000, () => now);
  const pen = (distressed: number) => ({ pen_id: "3", level: (distressed >= 3 ? "alert" : "watch") as "alert" | "watch",
    window: 5, distressed, last_prediction_id: null, updated_at: null, summary: "" });
  assert.equal(w.shouldEscalate("Pigs:3", pen(5)), false); // no warning sent yet
  w.noted("Pigs:3", alert("a1", "3")); // a 3-of-5 warning
  assert.equal(w.shouldEscalate("Pigs:3", pen(3)), false);
  assert.equal(w.shouldEscalate("Pigs:3", pen(4)), true);
  assert.equal(w.shouldEscalate("Pigs:3", pen(5)), false); // only once
  w.noted("Pigs:3", { ...alert("a2", "3"), distressed: 5 }); // an alert that was already critical
  assert.equal(w.shouldEscalate("Pigs:3", pen(5)), false);
  w.noted("Pigs:3", alert("a3", "3"));
  now = 700_000;
  assert.equal(w.shouldEscalate("Pigs:3", pen(5)), false); // too long after the warning
  const pig: Source = { name: "Pigs", emoji: "🐷", bad: "stressed", noun: "pig", match: /pig/, oink: fakeOink() };
  assert.equal(escalationText(pig, pen(4)), "🚨 Critical · 🐷 Pen 3: it's getting worse. 4 of the last 5 calls from the pen now sound stressed. " +
    'Please check the pen now.\nReply "play it" to hear the call.');
});


test("emergency only for sustained, severe distress, not an ordinary stressed pen", () => {
  const pig: Source = { name: "Pigs", emoji: "🐷", bad: "stressed", noun: "pig", match: /pig/, oink: fakeOink() };
  const hen: Source = { name: "Chickens", emoji: "🐔", bad: "sick", noun: "hen", match: /chicken/, oink: fakeOink() };
  const pen = (id: string, distressed: number, last: string, name: string | null = null) =>
    ({ pen_id: id, name, level: "alert" as const, window: 5, distressed, last_prediction_id: last, updated_at: null, summary: "" });
  const w = (src: Source, p: ReturnType<typeof pen>) => ({ key: `${src.name}:${p.pen_id}`, src, pen: p });
  // one pen, 5 of 5 distressed: an ordinary stressed pen, not an emergency yet
  let watch = emergencyWatch();
  assert.deepEqual(watch.update([w(pig, pen("1", 5, "p0"))], 0), []);
  // still critical after 2 minutes but only a few new calls: not enough evidence
  for (let t = 1; t <= 5; t++) watch.update([w(pig, pen("1", 5, `p${t}`))], t * 1000);
  assert.deepEqual(watch.update([w(pig, pen("1", 5, "p5"))], 121_000), []);
  // 2+ minutes of non-stop severe distress with 15+ new distress calls: emergency
  watch = emergencyWatch();
  for (let t = 0; t <= 20; t++) watch.update([w(pig, pen("1", 5, `q${t}`))], t * 6000);
  assert.deepEqual(watch.update([w(pig, pen("1", 5, "q21"))], 126_000).map((x) => x.pen.pen_id), ["1"]);
  // one calm reading resets the clock
  watch = emergencyWatch();
  for (let t = 0; t <= 20; t++) watch.update([w(pig, pen("1", t === 10 ? 2 : 5, `r${t}`))], t * 6000);
  assert.deepEqual(watch.update([w(pig, pen("1", 5, "r21"))], 126_000), []);
  // two different pens critical together for 45 s: barn-wide emergency
  watch = emergencyWatch();
  watch.update([w(pig, pen("1", 4, "a")), w(pig, pen("2", 4, "b"))], 0);
  assert.deepEqual(watch.update([w(pig, pen("1", 4, "a")), w(pig, pen("2", 4, "b"))], 30_000), []);
  assert.deepEqual(watch.update([w(pig, pen("1", 4, "a")), w(pig, pen("2", 4, "b"))], 46_000).map((x) => x.pen.pen_id), ["1", "2"]);
  // pigs and hens in the SAME pen are one pen, not a barn-wide incident
  watch = emergencyWatch();
  watch.update([w(pig, pen("1", 4, "a")), w(hen, pen("1", 4, "b"))], 0);
  assert.deepEqual(watch.update([w(pig, pen("1", 4, "a")), w(hen, pen("1", 4, "b"))], 60_000), []);
  // wording
  const one = [w(pig, pen("L1-a", 5, "x", "North barn"))];
  assert.match(emergencyText(one), /^🚨 EMERGENCY · 🐷 North barn has been in severe, non-stop distress for over 2 minutes\./);
  assert.match(emergencyText(one), /Reply "OK" when you're on it\.$/);
  assert.match(emergencyText([w(pig, pen("1", 4, "a")), w(hen, pen("2", 4, "b", "Hen house"))]), /2 pens have been in severe distress at the same time: 🐷 Pen 1, 🐔 Hen house\./);
  assert.equal(emergencySpeech(one), "Emergency at North barn. The animals have been in severe distress for over two minutes. Please check the pen now.");
});

test("warnings that arrive together go out as one message", () => {
  const pig: Source = { name: "Pigs", emoji: "🐷", bad: "stressed", noun: "pig", match: /pig/, oink: fakeOink() };
  const hen: Source = { name: "Chickens", emoji: "🐔", bad: "sick", noun: "hen", match: /chicken/, oink: fakeOink() };
  const a1 = { ...alert("a1", "L1-x"), pen_name: "North barn" }, a2 = { ...alert("a2", "L2-y"), pen_name: "Hen house" };
  const text = digestText([{ src: pig, alert: a1 }, { src: hen, alert: a2 }]);
  assert.match(text, /^⚠️ Warning · 2 pens need a look:\n• 🐷 North barn sounds stressed \(3 of the last 5 calls\)\n• 🐔 Hen house sounds sick/);
  assert.equal(digestText([{ src: pig, alert: a1 }]), alertText(pig, a1)); // a single warning reads as before
});

test("'OK' acknowledges an emergency; longer messages keep their meaning", async () => {
  assert.equal(parse("OK"), "ack");
  assert.equal(parse("on it!"), "ack");
  assert.equal(parse("ok thanks"), "ack");
  assert.equal(parse("ok what's the status"), "status");
  const state: BotState = { muted: false };
  const pig: Source = { name: "Pigs", emoji: "🐷", match: /pig/, oink: fakeOink() };
  const r = await handle("okay", [pig], state);
  assert.ok(state.emergencyAckAt && state.emergencyAckAt <= Date.now());
  assert.match(r[0].kind === "text" ? r[0].text : "", /stop the emergency alerts/);
});
