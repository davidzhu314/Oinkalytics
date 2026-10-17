/**
 * Who gets proactive alerts.
 *
 * An alert arrives with no conversation attached, so we need somewhere to send
 * it. Anyone who has texted the bot is remembered, and ALERT_TO can name the
 * demo phone up front so the first alert lands even if nobody texted first.
 *
 * Persisted to a small JSON file: restarting the bot during the demo must not
 * lose the judge's phone.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { config } from "./config.ts";

export interface SpaceRef {
  platform: string;
  spaceId: string;
}

const key = (ref: SpaceRef) => `${ref.platform}:${ref.spaceId}`;

export class Subscribers {
  private readonly known = new Map<string, SpaceRef>();

  constructor(private readonly file = config.subscribersFile) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as SpaceRef[];
      for (const ref of raw) this.known.set(key(ref), ref);
    } catch {
      // No file yet, or it is unreadable. Starting empty is correct.
    }
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify([...this.known.values()], null, 2));
    } catch (err) {
      console.warn("[subscribers] could not save:", (err as Error).message);
    }
  }

  /** Returns true the first time we see this space, so the caller can greet it. */
  remember(ref: SpaceRef): boolean {
    if (this.known.has(key(ref))) return false;
    this.known.set(key(ref), ref);
    this.save();
    return true;
  }

  all(): SpaceRef[] {
    return [...this.known.values()];
  }

  get size(): number {
    return this.known.size;
  }
}
