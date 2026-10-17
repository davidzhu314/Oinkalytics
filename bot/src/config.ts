/** Everything the bot reads from the environment, in one place. */

import { existsSync } from "node:fs";

// Load a .env before anything below reads process.env. Node has done this
// natively since 20.12, so there is no dotenv dependency to install.
//
// bot/.env wins, then the repo root, so the team can keep one shared file
// (the root .env already holds OPENROUTER_API_KEY for the ML side).
// Earlier files win: loadEnvFile does not overwrite what is already set.
for (const envFile of process.env.BOT_ENV_FILE ? [process.env.BOT_ENV_FILE] : [".env", "../.env"]) {
  if (!existsSync(envFile)) continue;
  process.loadEnvFile(envFile);
  console.log(`[config] loaded ${envFile}`);
}


const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase());

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * OINK_API must be a URL. Guarding it here because a credential pasted into
 * this variable by mistake would otherwise be sent to fetch() and echoed in
 * the stack trace. The value is never printed.
 */
function apiBase(): string {
  const raw = process.env.OINK_API?.trim();
  if (!raw) return "http://localhost:8000";
  if (!/^https?:\/\//.test(raw)) {
    throw new Error(
      "OINK_API must start with http:// or https:// — it is the address of the " +
        "Oinkalytics API, not a credential. Its current value is not printed here " +
        "on purpose; if you pasted a key into it, rotate that key and set " +
        "OINK_API=http://localhost:8000",
    );
  }
  return raw.replace(/\/+$/, "");
}

export const config = {
  /** Oinkalytics API base. Use http://<teammate-ip>:8000 to hit someone else's machine. */
  api: apiBase(),
  /** How often to poll /alerts. docs/API.md says 2s. */
  alertPollMs: Number(process.env.ALERT_POLL_MS ?? 2000),
  /**
   * Dev safety valve for the plan's "alert spam" risk: alerts are fetched and
   * logged but never sent to a phone. Turn it off for the demo.
   */
  mute: bool(process.env.BOT_MUTE, false),
  /**
   * Phone numbers / handles that get alerts even if they never texted the bot.
   * Use the demo phone here, e.g. ALERT_TO=+15551234567
   */
  alertTo: list(process.env.ALERT_TO),
  /** Where the subscriber list is kept, so a restart keeps texting the same people. */
  subscribersFile: process.env.SUBSCRIBERS_FILE ?? ".subscribers.json",
  /** Photon Spectrum Cloud credentials. Absent => terminal-only dev mode. */
  projectId: process.env.SPECTRUM_PROJECT_ID,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET,
  /** Which Spectrum providers to bring up. */
  /** Opt in to Spectrum's terminal TUI alongside iMessage. Blocked on some machines. */
  terminal: bool(process.env.BOT_TERMINAL, false),
} as const;

export const hasCloudCreds = () => Boolean(config.projectId && config.projectSecret);
