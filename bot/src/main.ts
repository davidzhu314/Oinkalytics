// Oinkalytics Photon bot. BOT_CHANNEL=terminal (default, no credentials) or imessage (Spectrum Cloud).

import { readFileSync, writeFileSync } from "node:fs";
import { Spectrum, attachment, type PlatformProviderConfig, type Space } from "spectrum-ts";
import { oinkClient, type Alert } from "./oink.ts";
import { alertText, escalationText, escalator, handle, type BotState, type Reply, type Source } from "./commands.ts";
import { alertPoller } from "./alerts.ts";
import { classify, onceEvery, rateLimiter } from "./guard.ts";

const API = process.env.OINK_API ?? "http://localhost:8000";
// Optional second species (the chicken workstream's server, local or a tunnel URL). Unset = pigs only.
const CHICKEN_API = process.env.CHICKEN_API;
const CHANNEL = process.env.BOT_CHANNEL ?? "terminal";
// The farmer's phone (E.164). During development this is the dev phone, so alerts never go to anyone else.
const FARMER = process.env.FARMER_PHONE;
// Optional allowlist of senders the bot answers; empty means answer anyone who reaches the line.
const ALLOWED = (process.env.ALLOWED_SENDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const state: BotState = { muted: ["1", "true", "yes"].includes((process.env.BOT_MUTE ?? "").toLowerCase()) };

const sources: Source[] = [{ name: "Pigs", emoji: "🐷", bad: "stressed", noun: "pig", match: /\b(pigs?|barn|sows?|hogs?)\b/, oink: oinkClient(API) }];
if (CHICKEN_API)
  sources.push({ name: "Chickens", emoji: "🐔", bad: "sick", noun: "hen", match: /\b(chickens?|hens?|coop|birds?|poultry)\b/, oink: oinkClient(CHICKEN_API) });

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
// line can't start a conversation, so the farmer has to text the bot once first. The conversation
// id is saved to bot/.farmer-space.json (gitignored), so a restart mid-demo still reaches them.
let farmerSpace: Space | undefined;
const SPACE_FILE = new URL("../.farmer-space.json", import.meta.url);

function rememberSpace(space: Space) {
  if (farmerSpace?.id === space.id) return;
  farmerSpace = space;
  try {
    writeFileSync(SPACE_FILE, JSON.stringify({ channel: CHANNEL, id: space.id, saved_at: new Date().toISOString() }) + "\n");
  } catch (err) {
    console.error("[bot] couldn't save the farmer's conversation:", err);
  }
}

async function restoreSpace() {
  let saved: { channel?: string; id?: string };
  try {
    saved = JSON.parse(readFileSync(SPACE_FILE, "utf8"));
  } catch {
    return; // nothing saved yet
  }
  if (saved.channel !== CHANNEL || !saved.id) return;
  try {
    if (imessage) farmerSpace = await imessage(app).space.get(saved.id);
    else if (terminal) farmerSpace = await terminal(app).space.get(saved.id);
    if (farmerSpace) console.log("[bot] restored the farmer's conversation from the last run");
  } catch (err) {
    console.error("[bot] couldn't reopen the saved conversation; the farmer needs to text once:", err);
  }
}

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

const worse = escalator();

const pollers = sources.map((src) =>
  alertPoller({
    oink: src.oink,
    state,
    async deliver(a: Alert) {
      const space = await resolveFarmerSpace();
      if (!space) throw new Error("no farmer conversation yet");
      await space.send(alertText(src, a));
      worse.noted(`${src.name}:${a.pen_id}`, a);
      console.log(`[alerts] sent ${src.name} ${a.alert_id}: ${a.message}`);
    },
  }),
);

console.log(`[bot] channel=${CHANNEL} api=${API} chicken_api=${CHICKEN_API ?? "off"} muted=${state.muted} farmer=${FARMER ? "set" : "unset"}`);
await restoreSpace();
await Promise.all(pollers.map((p) => p.start()));

// A warned pen that gets worse within 10 minutes gets one "critical" follow-up.
const escalation = setInterval(async () => {
  for (const src of sources) {
    let pens;
    try {
      pens = await src.oink.pens();
    } catch {
      continue;
    }
    for (const pen of pens) {
      if (!worse.shouldEscalate(`${src.name}:${pen.pen_id}`, pen)) continue;
      if (state.muted) {
        console.log(`[alerts] muted, not sending: ${src.name} Pen ${pen.pen_id} critical`);
        continue;
      }
      const space = await resolveFarmerSpace();
      if (space) await space.send(escalationText(src, pen)).catch((err) => console.error("[alerts] escalation failed:", err));
      console.log(`[alerts] sent ${src.name} Pen ${pen.pen_id} escalation to critical`);
    }
  }
}, 3000);

const shutdown = async () => {
  for (const p of pollers) p.stop();
  clearInterval(escalation);
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const replies = rateLimiter(5, 10_000); // hard cap per conversation, whatever triggers a reply
const mediaNotice = onceEvery(120_000);
const ignoredTypes = new Set<string>();

for await (const [space, message] of app.messages) {
  const sender = message.sender?.id ?? "unknown";
  const kind = classify(message.direction, message.content.type);
  if (kind === "ignore") {
    // Read receipts, typing, reactions, our own outbound messages: never answer these.
    if (!ignoredTypes.has(message.content.type)) {
      ignoredTypes.add(message.content.type);
      console.log(`[bot] ignoring ${message.direction} "${message.content.type}" messages`);
    }
    continue;
  }
  if (ALLOWED.length && !ALLOWED.includes(sender)) {
    console.log(`[bot] ignoring sender not on ALLOWED_SENDERS`);
    continue;
  }
  if (!replies.allow(space.id)) {
    console.log("[bot] reply rate limit hit; not answering");
    continue;
  }
  if (kind === "media") {
    if (mediaNotice(space.id)) await space.send('I can only read text for now. Try "status", "why" or "play it".');
    continue;
  }
  if (message.content.type !== "text") continue;
  // Remember the farmer's conversation for alerts (any sender in terminal mode).
  if (terminal || !FARMER || sender === FARMER) rememberSpace(space);
  const text = message.content.text.replace(/^\//, "");
  console.log(`[bot] received "${text.slice(0, 40)}"`);
  await space.responding(async () => send(space, await handle(text, sources, state)));
}
