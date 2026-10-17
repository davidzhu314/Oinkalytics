// Oinkalytics Photon bot. BOT_CHANNEL=terminal (default, no credentials) or imessage (Spectrum Cloud).

import { Spectrum, attachment, type PlatformProviderConfig, type Space } from "spectrum-ts";
import { oinkClient, type Alert } from "./oink.ts";
import { handle, type BotState, type Reply, type Source } from "./commands.ts";
import { alertPoller } from "./alerts.ts";

const API = process.env.OINK_API ?? "http://localhost:8000";
// Optional second species (the chicken workstream's server, local or a tunnel URL). Unset = pigs only.
const CHICKEN_API = process.env.CHICKEN_API;
const CHANNEL = process.env.BOT_CHANNEL ?? "terminal";
// The farmer's phone (E.164). During development this is the dev phone, so alerts never go to anyone else.
const FARMER = process.env.FARMER_PHONE;
// Optional allowlist of senders the bot answers; empty means answer anyone who reaches the line.
const ALLOWED = (process.env.ALLOWED_SENDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const state: BotState = { muted: ["1", "true", "yes"].includes((process.env.BOT_MUTE ?? "").toLowerCase()) };

const sources: Source[] = [{ name: "Pigs", match: /\b(pigs?|barn|sows?|hogs?)\b/, oink: oinkClient(API) }];
if (CHICKEN_API) sources.push({ name: "Chickens", match: /\b(chickens?|hens?|coop|birds?|poultry)\b/, oink: oinkClient(CHICKEN_API) });

async function loadProviders() {
  if (CHANNEL === "imessage") {
    if (!process.env.SPECTRUM_PROJECT_ID || !process.env.SPECTRUM_PROJECT_SECRET)
      throw new Error("BOT_CHANNEL=imessage needs SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env");
    const { imessage } = await import("spectrum-ts/providers/imessage");
    return { imessage, providers: [imessage.config()] as PlatformProviderConfig[] };
  }
  if (CHANNEL === "terminal") {
    const { terminal } = await import("spectrum-ts/providers/terminal");
    const commands = ["/status", "/why", "/play", "/mute", "/unmute"].map((name) => ({ name }));
    return { terminal, providers: [terminal.config({ commands })] as PlatformProviderConfig[] };
  }
  throw new Error(`Unknown BOT_CHANNEL "${CHANNEL}" (use terminal or imessage)`);
}

const { providers, imessage, terminal } = await loadProviders();
// Cloud iMessage authenticates through Spectrum() itself; the provider config doesn't take credentials.
const options = { logLevel: "warn" } as const;
// Spectrum() falls back to SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET from the environment and
// calls Spectrum Cloud with them even for the terminal provider. Drop them there, so terminal mode
// stays credential-free and offline-safe whatever is in .env.
if (!imessage) {
  delete process.env.SPECTRUM_PROJECT_ID;
  delete process.env.SPECTRUM_PROJECT_SECRET;
}
const app = imessage
  ? await Spectrum({
      projectId: process.env.SPECTRUM_PROJECT_ID!,
      projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
      providers,
      options,
    })
  : await Spectrum({ providers, options });

// Where proactive alerts go. Set from the farmer's first inbound message; a shared iMessage
// line can't start a conversation, so the farmer has to text the bot once first.
let farmerSpace: Space | undefined;

async function resolveFarmerSpace(): Promise<Space | undefined> {
  if (farmerSpace) return farmerSpace;
  try {
    if (terminal) farmerSpace = await terminal(app).space.get("chat-1");
    else if (imessage && FARMER) {
      const im = imessage(app);
      farmerSpace = await im.space.create(await im.user(FARMER));
    }
  } catch (err) {
    console.error('[bot] no conversation with the farmer yet; text the bot "status" once:', err);
  }
  return farmerSpace;
}

async function send(space: Space, replies: Reply[]) {
  for (const r of replies) {
    if (r.kind === "text") await space.send(r.text);
    else await space.send(attachment(r.bytes, { name: r.name, mimeType: "audio/wav" }));
  }
}

const pollers = sources.map((src) =>
  alertPoller({
    oink: src.oink,
    state,
    async deliver(a: Alert) {
      const space = await resolveFarmerSpace();
      if (!space) throw new Error("no farmer conversation yet");
      const tag = sources.length > 1 ? `${src.name}, ` : "";
      const one = src.name.toLowerCase().replace(/s$/, "");
      const hint = sources.length > 1 ? `"why ${one}" or "play ${one}"` : '"why" or "play it"';
      await space.send(`${tag}${a.message}\nReply ${hint}.`);
      console.log(`[alerts] sent ${src.name} ${a.alert_id}: ${a.message}`);
    },
  }),
);

console.log(`[bot] channel=${CHANNEL} api=${API} chicken_api=${CHICKEN_API ?? "off"} muted=${state.muted} farmer=${FARMER ? "set" : "unset"}`);
await Promise.all(pollers.map((p) => p.start()));

const shutdown = async () => {
  for (const p of pollers) p.stop();
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for await (const [space, message] of app.messages) {
  const sender = message.sender?.id ?? "unknown";
  if (ALLOWED.length && !ALLOWED.includes(sender)) {
    console.log(`[bot] ignoring sender not on ALLOWED_SENDERS`);
    continue;
  }
  if (message.content.type !== "text") {
    await space.send('I can only read text for now. Try "status", "why" or "play it".');
    continue;
  }
  // Remember the farmer's conversation for alerts (any sender in terminal mode).
  if (terminal || !FARMER || sender === FARMER) farmerSpace = space;
  const text = message.content.text.replace(/^\//, "");
  console.log(`[bot] received "${text.slice(0, 40)}"`);
  await space.responding(async () => send(space, await handle(text, sources, state)));
}
