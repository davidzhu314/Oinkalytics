/** Everything the bot reads from the environment, in one place. */

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase());

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  /** Oinkalytics API base. Use http://<teammate-ip>:8000 to hit someone else's machine. */
  api: process.env.OINK_API ?? "http://localhost:8000",
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
