/**
 * Building the text we text back. Pure functions over API shapes, so the demo
 * wording can be tested and tweaked without running Spectrum.
 *
 * Two rules from docs/API.md are enforced here:
 *  - Alert `message` and pen `summary` are sent as-is; we never re-word them.
 *  - `context_top3` must be labelled as a random-split result, because contexts
 *    are tied to recording sessions and we cannot claim honest accuracy.
 */

import type { Alert, PenStatus, Prediction } from "./types.ts";

const CONTEXT_CAVEAT = "likely situation (random-split accuracy)";

export const HELP = [
  "Oinkalytics, listening to your pens.",
  "",
  "  status      how every pen is doing",
  "  why         why the last alert fired",
  "  play it     hear the call that triggered it",
  "  mute        stop alerts (unmute to resume)",
  "",
  "You can also send me a recording and I'll tell you what I hear.",
].join("\n");

export const NO_ALERTS = "No alerts yet. All quiet.";

export function statusReply(pens: PenStatus[]): string {
  if (pens.length === 0) return "No pens are reporting yet.";
  // `summary` is pre-written by the API to be texted as-is.
  return pens.map((p) => p.summary).join("\n");
}

export function whyReply(alert: Alert): string {
  return [
    alert.message,
    "",
    alert.explanation.text,
  ].join("\n");
}

/** The caption that rides along with the audio file for "play it". */
export function playCaption(alert: Alert): string {
  return `Pen ${alert.pen_id}: this is the call that triggered the alert.`;
}

function formatFeatures(p: Prediction): string {
  const f = p.features;
  const bits = [`${f.duration_s}s long`];
  if (f.f0_mean_hz !== null) bits.push(`mean pitch ${f.f0_mean_hz} Hz`);
  bits.push(`${f.loudness_db} dB`);
  return bits.join(", ");
}

/**
 * Reply to a clip the farmer recorded. `explanation.text` comes from the API
 * (LLM or template, already claim-checked there) and is quoted, not rewritten.
 */
export function clipReply(p: Prediction): string {
  if (p.status === "unsure") {
    // Grey state: no verdict, no colour-coded language, just the API's words.
    return p.explanation.text;
  }

  const verdict = p.status === "distressed" ? "Distressed" : "Calm";
  const confidence = `${Math.round(p.valence.confidence * 100)}% confident`;
  const lines = [`${verdict} — ${confidence}.`, "", p.explanation.text];

  const top = p.context_top3[0];
  if (top) {
    lines.push("", `${CONTEXT_CAVEAT}: ${top.label} (${Math.round(top.p * 100)}%)`);
  }
  lines.push("", `Measured: ${formatFeatures(p)}`);
  return lines.join("\n");
}

export const MUTED = "Alerts muted. Text \"unmute\" when you want them back.";
export const UNMUTED = "Alerts back on.";

export function unknownReply(text: string): string {
  return `I didn't catch "${text.slice(0, 40)}". Text "help" for what I can do.`;
}
