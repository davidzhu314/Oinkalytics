/**
 * Production entrypoint: the Photon channel the judges text.
 *
 *   SPECTRUM_PROJECT_ID=… SPECTRUM_PROJECT_SECRET=… ALERT_TO=+1555… npm start
 *
 * Spectrum's terminal provider is opt-in (BOT_TERMINAL=1) because it spawns a
 * downloaded `tuichat` binary that some machines block, and a crash there would
 * take the whole bot down mid-demo. Use `npm run dev` for a local prompt.
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";

import { runAgent, type SpaceResolver } from "./agent.ts";
import { config, hasCloudCreds } from "./config.ts";

if (!hasCloudCreds()) {
  console.error(
    "SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET are required (Photon dashboard > Settings).\n" +
      "For credential-free local testing run `npm run dev` instead.",
  );
  process.exit(1);
}

const credentials = { projectId: config.projectId!, projectSecret: config.projectSecret! };

/**
 * Both branches are spelled out so Spectrum can infer its provider tuple; a
 * ternary over the two arrays widens it and loses `imessage(app)`.
 */
async function boot() {
  if (config.terminal) {
    const app = await Spectrum({ ...credentials, providers: [imessage.config(), terminal.config()] });
    return { app, im: imessage(app) };
  }
  const app = await Spectrum({ ...credentials, providers: [imessage.config()] });
  return { app, im: imessage(app) };
}

const { app, im } = await boot();

/** iMessage can turn a stored chat id, or a raw phone number, back into a space. */
const resolver: SpaceResolver = {
  async fromId(ref) {
    return ref.platform === "imessage" && ref.spaceId ? im.space.get(ref.spaceId) : undefined;
  },
  async fromHandle(handle) {
    return im.space.create(handle);
  },
};

const agent = await runAgent(app, { resolver });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`\n[bot] ${signal}, shutting down`);
    void agent.stop().finally(() => process.exit(0));
  });
}
