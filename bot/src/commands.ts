// Farmer commands. Pure apart from the API calls, so tests can drive it with a fake client.

import type { Alert, Oink, PenStatus } from "./oink.ts";

export type Reply =
  | { kind: "text"; text: string }
  | { kind: "audio"; bytes: Buffer; name: string };

export type BotState = { muted: boolean; emergencyAckAt?: number };

/** One monitored species: its API and how to name it ("Pigs", "Chickens"). The first is the main one. */
export type Source = {
  name: string;
  match: RegExp;
  oink: Oink;
  /** Shown in front of pens ("🐷 Pen 3"); falls back to the name. */
  emoji?: string;
  /** How a bad pen sounds, for alerts: "stressed" for pigs, "sick" for chickens. */
  bad?: string;
  /** One animal, for "could be one pig or several". */
  noun?: string;
};

/** The reason part of an explanation: everything after its first sentence (the verdict, already in the alert). */
export function reasonOf(explanation: string): string {
  const parts = explanation.trim().split(/(?<=[.!?])\s+/);
  return parts.slice(1).join(" ");
}

/** 3 of the last 5 calls sounding bad is the alert threshold (a warning); 4 or 5 of 5 is critical. */
export const CRITICAL_AT = 4;
export type Severity = "warning" | "critical";
export const severity = (distressed: number): Severity => (distressed >= CRITICAL_AT ? "critical" : "warning");
const TAG: Record<Severity, string> = { warning: "⚠️ Warning", critical: "🚨 Critical" };

/** One alert message: what, how sure, the reason, and one hint. The "why" is folded in, so the farmer
 *  doesn't have to ask (texting "why" still works). The microphone counts calls, not animals. */
/** "The last 4 calls from the pen all sounded stressed" / "3 of the last 5 calls from the pen sounded stressed".
 *  Counts calls, never animals: two pigs can make four calls. */
function callCount(n: number, of: number, bad: string, now = false): string {
  const verb = now ? `now sound ${bad}` : `sounded ${bad}`;
  return n === of ? `The last ${of} calls from the pen all ${verb}` : `${n} of the last ${of} calls from the pen ${verb}`;
}

/** "North barn" when the hub named the pen, else "Pen 3". */
export const penTitle = (id: string, name?: string | null): string => name || `Pen ${id}`;
const sureText = (confidence: number): string => (confidence >= 0.995 ? ">99%" : `${Math.round(confidence * 100)}%`);

export function alertText(src: Source, a: Alert): string {
  const bad = src.bad ?? "stressed";
  const noun = src.noun ?? "animal";
  const head = src.emoji ? `${src.emoji} ${penTitle(a.pen_id, a.pen_name)}` : penTitle(a.pen_id, a.pen_name);
  const sure = sureText(a.confidence);
  const reason = reasonOf(a.explanation.text);
  const sev = severity(a.distressed);
  return [
    `${TAG[sev]} · ${head} sounds ${bad} (${sure} sure). ${callCount(a.distressed, a.window, bad)}, could be one ${noun} or several.` +
      (sev === "critical" ? " Please check the pen now." : ""),
    reason,
    'Reply "play it" to hear the call.',
  ].filter(Boolean).join("\n");
}

const HELP =
  "I watch the barn microphones and text you when a pen sounds distressed.\n" +
  'Text "status" for every pen, "why" for the reason behind the latest alert (or "why pen 3"), ' +
  '"play it" to hear the call, or "mute" / "unmute" for alerts.';

const UNREACHABLE = "I can't reach the barn monitor right now. Try again in a minute.";

/** Lower-case, drop punctuation, collapse spaces: "Why?!" -> "why", "Play it." -> "play it". */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

type Command = "ack" | "status" | "why" | "play" | "mute" | "unmute" | "help";

// Checked in this order, anywhere in the message, so a judge's natural phrasing works:
// "how's the coop doing", "what's wrong in pen 3", "can I hear it", "please stop the alerts".
const INTENTS: [Command, RegExp][] = [
  // A short "OK" / "on it" acknowledges an emergency (checked first: "ok" alone means nothing else).
  ["ack", /^(ok(ay)?|k|on it|on my way|got it|ack(nowledged)?|coming|heading (there|over)|i m (on it|coming))( thanks?| thank you)?$/],
  ["unmute", /\b(unmute|unsilence|resume|turn (the )?alerts? (back )?on|alerts? (back )?on|start (the )?alerts?)\b/],
  ["mute", /\b(mute|silence|shh+|stop (the )?(alerts?|texts?|messages?)|turn (the )?alerts? off|alerts? off)\b/],
  ["play", /\b(play|listen|hear|sound(ed)? like|send (me )?(the )?(audio|clip|call|recording))\b/],
  ["why", /\b(why|explain|reason|what (happened|went wrong|s wrong|is wrong|caused)|what s going on with|details?)\b/],
  ["status", /\b(status|pens?|barn|coop|update|overview|summary|check|everything|how (s|is|are)|how (re|are) (they|the)|what s (up|going on|happening)|any(thing)? (news|wrong|problems?))\b/],
  ["help", /\b(help|hi|hello|hey|yo|start|commands?|what can you do|menu)\b/],
];

export function parse(text: string): Command | undefined {
  const t = normalize(text);
  if (t === "" || t === "?") return "help";
  for (const [cmd, re] of INTENTS) if (re.test(t)) return cmd;
  return undefined;
}

/** "why pen 3", "play pen2", "what's wrong in pen #4" -> "3" / "2" / "4". */
export function penOf(text: string): string | undefined {
  return normalize(text).match(/\bpen ?(\d+)\b/)?.[1];
}

/** "why chicken" -> only the chicken source; plain "why" -> all of them. */
function pick(text: string, sources: Source[]): Source[] {
  const t = normalize(text);
  const named = sources.filter((s) => s.match.test(t));
  return named.length ? named : sources;
}

/** Newest alert across the chosen sources. Only the main source being down is an error. */
async function latest(chosen: Source[], main: Source, pen?: string): Promise<{ hit?: { src: Source; alert: Alert }; down: Source[] }> {
  let hit: { src: Source; alert: Alert } | undefined;
  const down: Source[] = [];
  for (const src of chosen) {
    let a: Alert | undefined;
    try {
      a = await src.oink.latestAlert(pen);
    } catch (err) {
      if (src === main) throw err;
      down.push(src);
      continue;
    }
    if (a && (!hit || a.created_at > hit.alert.created_at)) hit = { src, alert: a };
  }
  return { hit, down };
}

export async function handle(text: string, sources: Source[], state: BotState): Promise<Reply[]> {
  const cmd = parse(text);
  const say = (t: string): Reply[] => [{ kind: "text", text: t }];
  const many = sources.length > 1;
  const label = (src: Source, pen: string, name?: string | null) =>
    src.emoji ? `${src.emoji} ${penTitle(pen, name)}` : many ? `${src.name}, ${penTitle(pen, name)}` : penTitle(pen, name);
  try {
    switch (cmd) {
      case "status": {
        const blocks: string[] = [];
        for (const src of pick(text, sources)) {
          try {
            // Named pens (the hub's) and pens with calls; skip unnamed defaults nobody is using.
            const pens = (await src.oink.pens()).filter((p) => p.name || p.window > 0);
            const lines = pens.length ? pens.map((p) => p.summary).join("\n") : "No pens are set up yet.";
            blocks.push(many ? `${src.name}:\n${lines}` : lines);
          } catch (err) {
            if (src === sources[0]) throw err;
            blocks.push(`${src.name}: monitor not connected.`);
          }
        }
        return say(blocks.join("\n\n"));
      }
      case "why": {
        const chosen = pick(text, sources);
        const { hit, down } = await latest(chosen, sources[0], penOf(text));
        if (!hit && down.length === chosen.length) return say(`${down.map((s) => s.name).join(", ")}: monitor not connected.`);
        if (!hit) return say(penOf(text) ? `No alerts from Pen ${penOf(text)} yet.` : "No alerts yet. Every pen has been calm so far.");
        return say(`${label(hit.src, hit.alert.pen_id, hit.alert.pen_name)}: ${hit.alert.explanation.text}`);
      }
      case "play": {
        const chosen = pick(text, sources);
        const { hit, down } = await latest(chosen, sources[0], penOf(text));
        if (!hit && down.length === chosen.length) return say(`${down.map((s) => s.name).join(", ")}: monitor not connected.`);
        if (!hit) return say(penOf(text) ? `No alerts from Pen ${penOf(text)} yet, so there's no call to play.` : "No alerts yet, so there's no call to play.");
        const bytes = await hit.src.oink.audio(hit.alert.audio_url);
        const who = many ? `${hit.src.name.toLowerCase()}-` : "";
        return [
          { kind: "text", text: `This is the call that triggered the ${label(hit.src, hit.alert.pen_id, hit.alert.pen_name)} alert.` },
          { kind: "audio", bytes, name: `${who}pen-${hit.alert.pen_id}-call.wav` },
        ];
      }
      case "ack":
        state.emergencyAckAt = Date.now();
        return say("Thanks, I'll stop the emergency alerts. I'm still listening and will text you if anything changes.");
      case "mute":
        state.muted = true;
        return say('Alerts muted. I\'ll still answer "status" and "why". Text "unmute" to turn them back on.');
      case "unmute":
        state.muted = false;
        return say("Alerts are on. I'll text you when a pen sounds distressed.");
      case "help":
        return say(many ? `${HELP}\nAdd "chicken" or "pig" (e.g. "why chicken") to ask about one species.` : HELP);
      default:
        return say(`Sorry, I didn't catch that. ${HELP}`);
    }
  } catch (err) {
    console.error(`[bot] command ${cmd ?? "?"} failed:`, err);
    return say(UNREACHABLE);
  }
}

/** A true emergency is sustained and severe, not just "the last 5 calls were bad" (an ordinary stressed
 *  pen does that). A pen is critical when 4+ of its last 5 confident calls are distress calls. Emergency:
 *   - one pen critical without a break for EMERGENCY.singleMs, with at least EMERGENCY.singleCalls new
 *     distress calls in that time, or
 *   - EMERGENCY.multiPens or more different pens critical at once, each for at least EMERGENCY.multiMs
 *     (a barn-wide incident: predator, fire, storm). Pigs and hens in the same pen count as one pen.
 *  Any non-critical reading resets that pen's clock. Stateful but clock-injected, so it's tested. */
export const EMERGENCY = { singleMs: 120_000, singleCalls: 15, multiPens: 2, multiMs: 45_000 };
export type Watched = { key: string; src: Source; pen: PenStatus };
export function emergencyWatch(cfg = EMERGENCY) {
  const st = new Map<string, { since: number; calls: number; last: string | null }>();
  return {
    /** Feed every (fresh) pen on every poll; returns the pens in a true emergency right now. */
    update(pens: Watched[], now: number): Watched[] {
      const seen = new Set<string>();
      const critical: (Watched & { since: number; calls: number })[] = [];
      for (const w of pens) {
        seen.add(w.key);
        const crit = w.pen.window >= 5 && w.pen.distressed >= CRITICAL_AT;
        if (!crit) { st.delete(w.key); continue; }
        let s = st.get(w.key);
        if (!s) st.set(w.key, (s = { since: now, calls: 0, last: w.pen.last_prediction_id }));
        else if (w.pen.last_prediction_id !== s.last) { s.calls += 1; s.last = w.pen.last_prediction_id; }
        critical.push({ ...w, since: s.since, calls: s.calls });
      }
      for (const k of [...st.keys()]) if (!seen.has(k)) st.delete(k); // pen gone or stale
      const wide = critical.filter((c) => now - c.since >= cfg.multiMs);
      if (new Set(wide.map((c) => c.pen.pen_id)).size >= cfg.multiPens) return wide.map(({ key, src, pen }) => ({ key, src, pen }));
      return critical.filter((c) => now - c.since >= cfg.singleMs && c.calls >= cfg.singleCalls).map(({ key, src, pen }) => ({ key, src, pen }));
    },
  };
}

const placeOf = (w: Watched) => `${w.src.emoji ? `${w.src.emoji} ` : ""}${penTitle(w.pen.pen_id, w.pen.name)}`;
const uniquePens = (ws: Watched[]) => [...new Map(ws.map((w) => [w.pen.pen_id, w])).values()];

export function emergencyText(ws: Watched[]): string {
  const pens = uniquePens(ws);
  const what = pens.length > 1
    ? `${pens.length} pens have been in severe distress at the same time: ${ws.map(placeOf).join(", ")}.`
    : `${placeOf(ws[0])} has been in severe, non-stop distress for over ${Math.round(EMERGENCY.singleMs / 60_000)} minutes.`;
  return `🚨 EMERGENCY · ${what} This could be a predator, fire or injury. Please check ${pens.length > 1 ? "the barn" : "the pen"} now.\n` +
    'Reply "OK" when you\'re on it.';
}

/** What the voice note says (no emoji, short sentences for text-to-speech). */
export function emergencySpeech(ws: Watched[]): string {
  const pens = uniquePens(ws);
  const names = pens.map((w) => penTitle(w.pen.pen_id, w.pen.name));
  return pens.length > 1
    ? `Emergency at the barn. ${pens.length} pens are in severe distress at the same time: ${names.join(", ")}. Please check the barn now.`
    : `Emergency at ${names[0]}. The animals have been in severe distress for over two minutes. Please check the pen now.`;
}

/** Several warnings that arrive together go out as one message. */
export function digestText(items: { src: Source; alert: Alert }[]): string {
  if (items.length === 1) return alertText(items[0].src, items[0].alert);
  const lines = items.map(({ src, alert: a }) =>
    `• ${src.emoji ? `${src.emoji} ` : ""}${penTitle(a.pen_id, a.pen_name)} sounds ${src.bad ?? "stressed"} (${a.distressed} of the last ${a.window} calls)`);
  const crit = items.some(({ alert: a }) => severity(a.distressed) === "critical");
  return `${crit ? TAG.critical : TAG.warning} · ${items.length} pens need a look:\n${lines.join("\n")}\n` +
    'Reply "why" for the reason or "play it" to hear the latest call.';
}

/** Follow-up when a pen that already got a warning gets worse (the server only alerts once per pen per 5 min). */
export function escalationText(src: Source, pen: PenStatus): string {
  const bad = src.bad ?? "stressed";
  const head = src.emoji ? `${src.emoji} ${penTitle(pen.pen_id, pen.name)}` : penTitle(pen.pen_id, pen.name);
  return `${TAG.critical} · ${head}: it's getting worse. ${callCount(pen.distressed, pen.window, bad, true)}. ` +
    `Please check the pen now.\nReply "play it" to hear the call.`;
}

/** Remembers the alerts we sent, and says when a warned pen has become critical: at most once per alert,
 *  and only within `forMs` of it. */
export function escalator(forMs = 10 * 60_000, now: () => number = Date.now) {
  const sent = new Map<string, { at: number; critical: boolean }>();
  return {
    noted(key: string, alert: Alert) {
      sent.set(key, { at: now(), critical: severity(alert.distressed) === "critical" });
    },
    shouldEscalate(key: string, pen: PenStatus): boolean {
      const s = sent.get(key);
      if (!s || s.critical || now() - s.at > forMs) return false;
      if (pen.level === "alert" && pen.distressed >= CRITICAL_AT) {
        s.critical = true;
        return true;
      }
      return false;
    },
  };
}
