// Proactive alerts: poll /alerts and forward new ones to the farmer.

import type { Alert, Oink } from "./oink.ts";
import type { BotState } from "./commands.ts";

export type AlertPoller = { tick(): Promise<void>; start(): Promise<void>; stop(): void };

export function alertPoller(opts: {
  oink: Oink;
  state: BotState;
  deliver: (alert: Alert) => Promise<void>;
  intervalMs?: number;
}): AlertPoller {
  const { oink, state, deliver, intervalMs = 2000 } = opts;
  let cursor: string | undefined;
  let ready = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  // Skip every alert that already exists, so a restart doesn't re-send old ones.
  async function init() {
    const existing = await oink.alerts();
    cursor = existing.at(-1)?.alert_id;
    ready = true;
    console.log(`[alerts] starting after ${cursor ?? "(none)"}; ${existing.length} old alert(s) skipped`);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!ready) await init();
      for (const a of await oink.alerts(cursor)) {
        if (state.muted) console.log(`[alerts] muted, not sending: ${a.message}`);
        else await deliver(a);
        cursor = a.alert_id; // advance only after delivery, so a failed send is retried
      }
    } catch (err) {
      console.error("[alerts] poll failed:", err instanceof Error ? err.message : err);
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
