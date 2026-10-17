/**
 * Turning whatever the farmer typed into one of the behaviours in docs/PLAN.md.
 * Pure and dependency-free so it can be tested without a network or a phone.
 *
 * A judge will type "why?", "Why??", "why pen 3" or "what's going on" — all of
 * those have to land on the same intent.
 */

export type Intent =
  | { kind: "why"; penId?: string }
  | { kind: "status"; penId?: string }
  | { kind: "play"; penId?: string }
  | { kind: "mute" }
  | { kind: "unmute" }
  | { kind: "help" }
  | { kind: "unknown"; text: string };

/** "pen 3", "pen3", "#3" or a bare "3" => "3" */
export function parsePen(text: string): string | undefined {
  const m = /(?:\bpen\s*#?|#)(\d+)\b/i.exec(text) ?? /^\s*(\d+)\s*$/.exec(text);
  return m?.[1];
}

const matches = (text: string, patterns: RegExp[]) => patterns.some((p) => p.test(text));

export function parseIntent(raw: string): Intent {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const penId = parsePen(lower);

  if (matches(lower, [/^\s*$/])) return { kind: "help" };
  if (matches(lower, [/\bmute\b/, /\bquiet\b/, /\bstop alert/, /\bshut up\b/])) return { kind: "mute" };
  if (matches(lower, [/\bunmute\b/, /\bresume\b/, /\bstart alert/])) return { kind: "unmute" };
  if (matches(lower, [/\bhelp\b/, /\bcommands?\b/, /^\s*\?\s*$/, /what can you do/])) return { kind: "help" };
  if (matches(lower, [/\bplay\b/, /\blisten\b/, /\bhear\b/, /\bsend .*(clip|audio|recording)\b/, /\baudio\b/]))
    return { kind: "play", penId };
  if (matches(lower, [/\bwhy\b/, /\bexplain\b/, /\breason\b/, /\bhow come\b/, /what.s (going on|wrong|happening)/]))
    return { kind: "why", penId };
  if (matches(lower, [/\bstatus\b/, /\bpens?\b/, /\bsummary\b/, /\bupdate\b/, /\bhow (are|is)\b/, /\ball good\b/]))
    return { kind: "status", penId };

  return { kind: "unknown", text };
}
