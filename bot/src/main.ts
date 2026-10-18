// Oinkalytics Photon bot. BOT_CHANNEL=terminal (default, no credentials) or imessage (Spectrum Cloud).

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Spectrum, attachment, voice, type PlatformProviderConfig, type Space } from "spectrum-ts";
import { oinkClient, type Alert } from "./oink.ts";
import { digestText, emergencySpeech, emergencyText, emergencyWatch, handle, penTitle, type BotState, type Reply, type Source, type Watched } from "./commands.ts";
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

// ---------- What the farmer gets ----------
// Kept deliberately quiet: warnings that arrive together are bundled into one message, each pen texts at
// most once per 30 minutes, there are no "getting worse" follow-ups, emergencies are rare (sustained and
// severe, see emergencyWatch) with at most one reminder, and everything shares a hard cap.
const PUSH_MAX = 4, PUSH_WINDOW_MS = 15 * 60_000;
const pushed: number[] = [];
function mayPush(what: string): boolean {
  const now = Date.now();
  while (pushed.length && now - pushed[0] > PUSH_WINDOW_MS) pushed.shift();
  if (pushed.length >= PUSH_MAX) { console.log(`[guard] ${PUSH_MAX} messages in 15 min already; not sending: ${what}`); return false; }
  pushed.push(now);
  return true;
}
// A pen with no new calls for 2 minutes (closed tab, stopped barn) keeps its last state forever on the
// server; it must not count toward an emergency.
const STALE_MS = 2 * 60_000;
const fresh = (pen: { updated_at: string | null }) => !!pen.updated_at && Date.now() - Date.parse(pen.updated_at) < STALE_MS;

const PEN_QUIET_MS = 30 * 60_000;            // after texting about a pen, leave it alone this long
const BUNDLE_MS = 15_000;                     // warnings within this window go out together
const penTexted = new Map<string, number>();  // pen_id -> last proactive message (any species)
const bundle: { src: Source; alert: Alert }[] = [];
let bundleTimer: ReturnType<typeof setTimeout> | undefined;

async function flushBundle() {
  bundleTimer = undefined;
  const items = bundle.splice(0);
  if (!items.length || state.muted) return;
  const names = items.map((x) => penTitle(x.alert.pen_id, x.alert.pen_name)).join(", ");
  const space = await resolveFarmerSpace();
  if (!space) { console.error("[alerts] no farmer conversation yet; dropped:", names); return; }
  if (!mayPush(`warning ${names}`)) return;
  await space.send(digestText(items)).catch((err) => console.error("[alerts] send failed:", err));
  const now = Date.now();
  for (const x of items) penTexted.set(x.alert.pen_id, now);
  console.log(`[alerts] sent ${items.length} warning(s): ${names}`);
}

const pollers = sources.map((src) =>
  alertPoller({
    oink: src.oink,
    state,
    async deliver(a: Alert) {
      const last = penTexted.get(a.pen_id);
      if (last && Date.now() - last < PEN_QUIET_MS) {
        console.log(`[alerts] ${penTitle(a.pen_id, a.pen_name)} already texted in the last 30 min; not sending again`);
        return;
      }
      if (bundle.some((x) => x.alert.pen_id === a.pen_id)) return; // pigs and hens in one pen: one line
      bundle.push({ src, alert: a });
      bundleTimer ??= setTimeout(flushBundle, BUNDLE_MS);
    },
  }),
);

console.log(`[bot] channel=${CHANNEL} api=${API} chicken_api=${CHICKEN_API ?? "off"} muted=${state.muted} farmer=${FARMER ? "set" : "unset"}`);
await restoreSpace();
await Promise.all(pollers.map((p) => p.start()));

// ---------- Emergencies (rare) ----------
// A 🚨 text plus a spoken voice note (macOS text-to-speech), then at most one reminder after 10 minutes
// if it's still going and nobody replied "OK". Photon's shared iMessage line can't place phone calls; a
// voice note is the loudest thing it can send. Emergencies don't count against the message cap above.
const run = promisify(execFile);
async function speech(text: string): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;
  const dir = await mkdtemp(join(tmpdir(), "oink-voice-"));
  const file = join(dir, "emergency.m4a");
  try {
    await run("say", ["-r", "170", "-o", file, "--file-format=m4af", text]);
    return await readFile(file);
  } catch (err) {
    console.error("[emergency] couldn't make the voice note:", err);
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const EMERGENCY_REMIND_MS = 10 * 60_000;
const EMERGENCY_QUIET_MS = 30 * 60_000; // an incident ends after 30 min without an emergency reading
const watch = emergencyWatch();
let incident: { since: number; lastAt: number; sent: number; seenAt: number } | null = null;
let emergencyBusy = false;
const emergencyLoop = setInterval(async () => {
  if (emergencyBusy) return;
  emergencyBusy = true;
  try {
    const watched: Watched[] = [];
    for (const src of sources) {
      try {
        for (const pen of (await src.oink.pens()).filter(fresh)) watched.push({ key: `${src.name}:${pen.pen_id}`, src, pen });
      } catch { /* that model is down */ }
    }
    const now = Date.now();
    const em = watch.update(watched, now);
    if (incident && now - incident.seenAt > EMERGENCY_QUIET_MS) incident = null;
    if (!em.length) return;
    if (!incident) incident = { since: now, lastAt: 0, sent: 0, seenAt: now };
    incident.seenAt = now;
    const acked = (state.emergencyAckAt ?? 0) >= incident.since;
    if (acked || incident.sent >= 2 || (incident.sent === 1 && now - incident.lastAt < EMERGENCY_REMIND_MS)) return;
    const what = em.map((w) => penTitle(w.pen.pen_id, w.pen.name)).join(", ");
    if (state.muted) { console.log(`[emergency] muted, not sending: ${what}`); return; }
    const space = await resolveFarmerSpace();
    if (!space) { console.error("[emergency] no farmer conversation yet"); return; }
    incident.sent += 1;
    incident.lastAt = now;
    const reminder = incident.sent > 1;
    await space.send((reminder ? "Reminder: " : "") + emergencyText(em)).catch((err) => console.error("[emergency] text failed:", err));
    const audio = reminder ? null : await speech(emergencySpeech(em));
    if (audio) await space.send(voice(audio, { mimeType: "audio/mp4", name: "emergency.m4a" }))
      .catch((err) => console.error("[emergency] voice note failed:", err));
    for (const w of em) penTexted.set(w.pen.pen_id, now);
    console.log(`[emergency] sent${reminder ? " reminder" : ""}: ${what}${audio ? " (with voice note)" : ""}`);
  } finally {
    emergencyBusy = false;
  }
}, 3000);

const shutdown = async () => {
  for (const p of pollers) p.stop();
  clearInterval(emergencyLoop);
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
