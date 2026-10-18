// Farmer commands. Pure apart from the API calls, so tests can drive it with a fake client.

import type { Alert, Oink, PenStatus } from "./oink.ts";

export type Reply =
  | { kind: "text"; text: string }
  | { kind: "audio"; bytes: Buffer; name: string };

export type BotState = { muted: boolean };

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

type Command = "status" | "why" | "play" | "mute" | "unmute" | "help";

// Checked in this order, anywhere in the message, so a judge's natural phrasing works:
// "how's the coop doing", "what's wrong in pen 3", "can I hear it", "please stop the alerts".
const INTENTS: [Command, RegExp][] = [
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
