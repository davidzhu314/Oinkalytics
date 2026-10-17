// Proactive texts: poll /alerts and /trends/events and forward new items to the farmer.

import type { Alert, Oink, TrendEvent } from "./oink.ts";
import type { BotState } from "./commands.ts";

export type AlertPoller = { tick(): Promise<void>; start(): Promise<void>; stop(): void };

export function alertPoller(opts: {
  oink: Oink;
  state: BotState;
  deliver: (alert: Alert) => Promise<void>;
  intervalMs?: number;
}): AlertPoller {
  return cursorPoller({ ...opts, name: "alerts", list: (after) => opts.oink.alerts(after), idOf: (a) => a.alert_id });
}

/** Trend events ("Pen 5 has had the most distress in the barn 3 days in a row"). */
export function trendPoller(opts: {
  oink: Oink;
  state: BotState;
  deliver: (event: TrendEvent) => Promise<void>;
  intervalMs?: number;
}): AlertPoller {
  return cursorPoller({ ...opts, name: "trends", list: (after) => opts.oink.trendEvents(after), idOf: (e) => e.event_id });
}

function cursorPoller<T extends { message: string }>(opts: {
  name: string;
  list: (after?: string) => Promise<T[]>;
  idOf: (item: T) => string;
  state: BotState;
  deliver: (item: T) => Promise<void>;
  intervalMs?: number;
}): AlertPoller {
  const { name, list, idOf, state, deliver, intervalMs = 2000 } = opts;
  let cursor: string | undefined;
  let ready = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  // Skip every alert that already exists, so a restart doesn't re-send old ones.
  async function init() {
    const existing = await list();
    const last = existing.at(-1);
    cursor = last ? idOf(last) : undefined;
    ready = true;
    console.log(`[${name}] starting after ${cursor ?? "(none)"}; ${existing.length} old item(s) skipped`);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!ready) await init();
      for (const item of await list(cursor)) {
        if (state.muted) console.log(`[${name}] muted, not sending: ${item.message}`);
        else await deliver(item);
        cursor = idOf(item); // advance only after delivery, so a failed send is retried
      }
    } catch (err) {
      console.error(`[${name}] poll failed:`, err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    async start() {
      await tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
