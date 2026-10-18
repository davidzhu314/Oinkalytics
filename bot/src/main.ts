// Oinkalytics Photon bot. BOT_CHANNEL=terminal (default, no credentials) or imessage (Spectrum Cloud).

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Spectrum, attachment, voice, type PlatformProviderConfig, type Space } from "spectrum-ts";
import { oinkClient, type Alert } from "./oink.ts";
import { alertText, emergencyPens, emergencySpeech, emergencyText, escalationText, escalator, handle, type BotState, type Reply, type Source } from "./commands.ts";
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

// Safety net against spam: proactive messages (alerts, follow-ups, emergencies) share one budget.
// Replies to the farmer's own texts don't count.
const PUSH_MAX = 6, PUSH_WINDOW_MS = 10 * 60_000;
const pushed: number[] = [];
function mayPush(what: string): boolean {
  const now = Date.now();
  while (pushed.length && now - pushed[0] > PUSH_WINDOW_MS) pushed.shift();
  if (pushed.length >= PUSH_MAX) { console.log(`[guard] ${PUSH_MAX} messages in 10 min already; not sending: ${what}`); return false; }
  pushed.push(now);
  return true;
}
// A pen with no new calls for 2 minutes (closed tab, stopped barn) keeps its last state forever on the
// server; it must not trigger follow-ups or emergencies.
const STALE_MS = 2 * 60_000;
const fresh = (pen: { updated_at: string | null }) => !!pen.updated_at && Date.now() - Date.parse(pen.updated_at) < STALE_MS;

const pollers = sources.map((src) =>
  alertPoller({
    oink: src.oink,
    state,
    async deliver(a: Alert) {
      const space = await resolveFarmerSpace();
      if (!space) throw new Error("no farmer conversation yet");
      if (!mayPush(`alert ${a.alert_id}`)) return;
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
      // Emergencies supersede the "getting worse" follow-up; stale pens get nothing.
      if (!fresh(pen) || emergencyRecent.has(`${src.name}:${pen.pen_id}`)) continue;
      if (!worse.shouldEscalate(`${src.name}:${pen.pen_id}`, pen)) continue;
      if (state.muted) {
        console.log(`[alerts] muted, not sending: ${src.name} Pen ${pen.pen_id} critical`);
        continue;
      }
      const space = await resolveFarmerSpace();
      if (space && mayPush(`escalation ${pen.pen_id}`)) await space.send(escalationText(src, pen)).catch((err) => console.error("[alerts] escalation failed:", err));
      console.log(`[alerts] sent ${src.name} Pen ${pen.pen_id} escalation to critical`);
    }
  }
}, 3000);

// ---------- Emergencies ----------
// A pen whose last 5 calls are all distress calls, or 2+ pens critical at once: a 🚨 text plus a spoken
// voice note (macOS text-to-speech), repeated every minute up to 3 times until the farmer replies "OK".
// Photon's shared iMessage line can't place phone calls; a voice note is the loudest thing it can send.
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

const EMERGENCY_REPEAT_MS = 60_000;
const EMERGENCY_MAX = 3;
const EMERGENCY_QUIET_MS = 10 * 60_000; // after the last emergency message, a pen stays quiet this long
// Per pen ("Pigs:L1-ab12"): when its emergency began, when we last messaged, how many times.
const incidents = new Map<string, { since: number; lastAt: number; sent: number }>();
const emergencyRecent = new Set<string>(); // pens in, or recently messaged about, an emergency
let emergencyBusy = false;
const emergencyLoop = setInterval(async () => {
  if (emergencyBusy) return;
  emergencyBusy = true;
  try {
    const now = Date.now();
    // forget pens whose last emergency message is old enough
    for (const [key, inc] of incidents) if (inc.lastAt && now - inc.lastAt > EMERGENCY_QUIET_MS) incidents.delete(key);
    emergencyRecent.clear();
    for (const key of incidents.keys()) emergencyRecent.add(key);
    for (const src of sources) {
      let pens;
      try { pens = await src.oink.pens(); } catch { continue; }
      const em = emergencyPens(pens.filter(fresh));
      const due = [];
      for (const pen of em) {
        const key = `${src.name}:${pen.pen_id}`;
        emergencyRecent.add(key);
        let inc = incidents.get(key);
        if (!inc) incidents.set(key, (inc = { since: now, lastAt: 0, sent: 0 }));
        const acked = (state.emergencyAckAt ?? 0) >= inc.since;
        if (acked || inc.sent >= EMERGENCY_MAX || now - inc.lastAt < EMERGENCY_REPEAT_MS) continue;
        due.push(pen);
      }
      if (!due.length) continue;
      const what = due.map((p) => p.name || `Pen ${p.pen_id}`).join(", ");
      if (state.muted) { console.log(`[emergency] muted, not sending: ${src.name} ${what}`); continue; }
      const space = await resolveFarmerSpace();
      if (!space) { console.error("[emergency] no farmer conversation yet"); continue; }
      if (!mayPush(`emergency ${what}`)) continue;
      const counts = due.map((p) => {
        const inc = incidents.get(`${src.name}:${p.pen_id}`)!;
        inc.lastAt = now;
        inc.sent += 1;
        return inc.sent;
      });
      await space.send(emergencyText(src, due)).catch((err) => console.error("[emergency] text failed:", err));
      const audio = await speech(emergencySpeech(src, due));
      if (audio) await space.send(voice(audio, { mimeType: "audio/mp4", name: "emergency.m4a" }))
        .catch((err) => console.error("[emergency] voice note failed:", err));
      console.log(`[emergency] sent ${src.name} ${what} (${Math.max(...counts)}/${EMERGENCY_MAX}${audio ? ", with voice note" : ""})`);
    }
  } finally {
    emergencyBusy = false;
  }
}, 3000);

const shutdown = async () => {
  for (const p of pollers) p.stop();
  clearInterval(escalation);
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
