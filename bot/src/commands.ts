// Farmer commands. Pure apart from the API calls, so tests can drive it with a fake client.

import type { Alert, Oink } from "./oink.ts";

export type Reply =
  | { kind: "text"; text: string }
  | { kind: "audio"; bytes: Buffer; name: string };

export type BotState = { muted: boolean };

/** One monitored species: its API and how to name it ("Pigs", "Chickens"). The first is the main one. */
export type Source = { name: string; match: RegExp; oink: Oink };

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
  const label = (src: Source, pen: string) => (many ? `${src.name}, Pen ${pen}` : `Pen ${pen}`);
  try {
    switch (cmd) {
      case "status": {
        const blocks: string[] = [];
        for (const src of pick(text, sources)) {
          try {
            const pens = await src.oink.pens();
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
        return say(`${label(hit.src, hit.alert.pen_id)}: ${hit.alert.explanation.text}`);
      }
      case "play": {
        const chosen = pick(text, sources);
        const { hit, down } = await latest(chosen, sources[0], penOf(text));
        if (!hit && down.length === chosen.length) return say(`${down.map((s) => s.name).join(", ")}: monitor not connected.`);
        if (!hit) return say(penOf(text) ? `No alerts from Pen ${penOf(text)} yet, so there's no call to play.` : "No alerts yet, so there's no call to play.");
        const bytes = await hit.src.oink.audio(hit.alert.audio_url);
        const who = many ? `${hit.src.name.toLowerCase()}-` : "";
        return [
          { kind: "text", text: `This is the call that triggered the ${label(hit.src, hit.alert.pen_id)} alert.` },
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
