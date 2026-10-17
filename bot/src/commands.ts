// Farmer commands. Pure apart from the API calls, so tests can drive it with a fake client.

import type { Oink } from "./oink.ts";

export type Reply =
  | { kind: "text"; text: string }
  | { kind: "audio"; bytes: Buffer; name: string };

export type BotState = { muted: boolean };

const HELP =
  "I watch the barn microphones and text you when a pen sounds distressed.\n" +
  'Text "status" for every pen, "why" for the reason behind the latest alert, ' +
  '"play it" to hear the call, or "mute" / "unmute" for alerts.';

const UNREACHABLE = "I can't reach the barn monitor right now. Try again in a minute.";

/** Lower-case, drop punctuation, collapse spaces: "Why?!" -> "why", "Play it." -> "play it". */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

type Command = "status" | "why" | "play" | "mute" | "unmute" | "help";

export function parse(text: string): Command | undefined {
  const t = normalize(text);
  if (/^(status|pens?|how are (they|the pigs))\b/.test(t)) return "status";
  if (/^(why|explain|reason)\b/.test(t)) return "why";
  if (/^(play|listen|hear)\b/.test(t)) return "play";
  if (/^unmute\b/.test(t)) return "unmute";
  if (/^mute\b/.test(t)) return "mute";
  if (/^(help|hi|hello|hey|start|\?)\b/.test(t) || t === "") return "help";
  return undefined;
}

export async function handle(text: string, oink: Oink, state: BotState): Promise<Reply[]> {
  const cmd = parse(text);
  const say = (t: string): Reply[] => [{ kind: "text", text: t }];
  try {
    switch (cmd) {
      case "status": {
        const pens = await oink.pens();
        return say(pens.length ? pens.map((p) => p.summary).join("\n") : "No pens are set up yet.");
      }
      case "why": {
        const a = await oink.latestAlert();
        if (!a) return say("No alerts yet. Every pen has been calm so far.");
        return say(`Pen ${a.pen_id}: ${a.explanation.text}`);
      }
      case "play": {
        const a = await oink.latestAlert();
        if (!a) return say("No alerts yet, so there's no call to play.");
        const bytes = await oink.audio(a.audio_url);
        return [
          { kind: "text", text: `This is the call that triggered the Pen ${a.pen_id} alert.` },
          { kind: "audio", bytes, name: `pen-${a.pen_id}-call.wav` },
        ];
      }
      case "mute":
        state.muted = true;
        return say('Alerts muted. I\'ll still answer "status" and "why". Text "unmute" to turn them back on.');
      case "unmute":
        state.muted = false;
        return say("Alerts are on. I'll text you when a pen sounds distressed.");
      case "help":
        return say(HELP);
      default:
        return say(`Sorry, I didn't catch that. ${HELP}`);
    }
  } catch (err) {
    console.error(`[bot] command ${cmd ?? "?"} failed:`, err);
    return say(UNREACHABLE);
  }
}
