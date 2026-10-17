/**
 * Polls GET /alerts and hands new ones to a callback.
 *
 * On startup it reads the existing alerts once and parks the cursor on the
 * newest, so restarting the bot mid-demo does not re-text the backlog
 * (docs/API.md spells this out).
 */

import { alertsAfter } from "./api.ts";
import { config } from "./config.ts";
import type { Alert } from "./types.ts";

export type AlertHandler = (alert: Alert) => Promise<void>;

export class AlertPoller {
  private cursor: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly onAlert: AlertHandler) {}

  /** Swallow the backlog so a restart starts quiet. Returns how many were skipped. */
  async catchUp(): Promise<number> {
    const existing = await alertsAfter();
    this.cursor = existing.at(-1)?.alert_id;
    return existing.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        const fresh = await alertsAfter(this.cursor);
        for (const alert of fresh) {
          // Advance the cursor first: a send that throws must not replay forever.
          this.cursor = alert.alert_id;
          await this.onAlert(alert);
        }
      } catch (err) {
        // The API or the tunnel may blink. Keep polling.
        console.warn("[alerts] poll failed:", (err as Error).message);
      } finally {
        if (this.running) this.timer = setTimeout(tick, config.alertPollMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
