// What the bot answers, and how often. Spectrum's message stream also carries read receipts, typing
// indicators, reactions, edits and the bot's own outbound messages. Answering those made a loop: the
// farmer's phone sent a read receipt for each reply, which the bot answered, and so on.

export type Kind = "text" | "media" | "ignore";

/** "text": a farmer's message to act on. "media": a photo/voice note/file (one polite "text only"). */
export function classify(direction: string, type: string): Kind {
  if (direction !== "inbound") return "ignore";
  if (type === "text") return "text";
  if (type === "attachment" || type === "voice") return "media";
  return "ignore"; // read, typing, reaction, edit, unsend, effect, richlink, ...
}

/** At most `max` replies per conversation in any `windowMs`, whatever triggers them. */
export function rateLimiter(max = 5, windowMs = 10_000, now: () => number = Date.now) {
  const sent = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
      const t = now();
      const recent = (sent.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= max) {
        sent.set(key, recent);
        return false;
      }
      recent.push(t);
      sent.set(key, recent);
      return true;
    },
  };
}

/** True at most once per `everyMs` per key (for the "text only" notice). */
export function onceEvery(everyMs = 120_000, now: () => number = Date.now) {
  const last = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    if (t - (last.get(key) ?? -Infinity) < everyMs) return false;
    last.set(key, t);
    return true;
  };
}
