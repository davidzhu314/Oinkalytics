/**
 * The agent itself: one inbound message loop, one outbound alert fan-out.
 *
 * Deliberately generic over the Spectrum instance so index.ts (iMessage, needs
 * Photon credentials) and dev.ts (terminal, needs nothing) share every line of
 * behaviour. Nothing here knows which channel it is talking to.
 */

import { attachment, text, type Message, type Space, type SpectrumInstance } from "spectrum-ts";

import * as api from "./api.ts";
import { AlertPoller } from "./alerts.ts";
import { config } from "./config.ts";
import * as reply from "./replies.ts";
import { parseIntent } from "./intents.ts";
import { Subscribers, type SpaceRef } from "./subscribers.ts";
import type { Alert } from "./types.ts";

/** Lets index.ts rehydrate a persisted subscriber, or an ALERT_TO phone number. */
export interface SpaceResolver {
  /** A space we stored the id of on a previous run. */
  fromId?(ref: SpaceRef): Promise<Space | undefined>;
  /** A raw handle from ALERT_TO, e.g. "+15551234567". */
  fromHandle?(handle: string): Promise<Space | undefined>;
}

export interface AgentHandle {
  stop(): Promise<void>;
}

export interface AgentOptions {
  /** How to rehydrate a space we only know the id or phone number of. */
  resolver?: SpaceResolver;
  /** Override where subscribers are persisted. Tests use this for isolation. */
  subscribersFile?: string;
}

export async function runAgent(
  app: SpectrumInstance,
  options: AgentOptions = {},
): Promise<AgentHandle> {
  const resolver = options.resolver ?? {};
  const subscribers = new Subscribers(options.subscribersFile);
  /** Spaces we can send to right now, by subscriber key. */
  const live = new Map<string, Space>();
  /** Runtime mute, flipped by texting "mute". Starts from BOT_MUTE. */
  let muted = config.mute;

  const refOf = (space: Space & { id?: string }): SpaceRef => ({
    platform: space.__platform,
    spaceId: String(space.id ?? ""),
  });
  const keyOf = (ref: SpaceRef) => `${ref.platform}:${ref.spaceId}`;

  const track = (space: Space) => {
    const ref = refOf(space as Space & { id?: string });
    live.set(keyOf(ref), space);
    return subscribers.remember(ref);
  };

  // --- startup: who can we reach, and don't replay old alerts -------------

  const h = await api.health();
  console.log(`[agent] API ${config.api} is up (mode=${h.mode}, model=${h.model})`);

  for (const ref of subscribers.all()) {
    if (live.has(keyOf(ref)) || !resolver.fromId) continue;
    try {
      const space = await resolver.fromId(ref);
      if (space) live.set(keyOf(ref), space);
    } catch (err) {
      console.warn(`[agent] could not restore ${keyOf(ref)}:`, (err as Error).message);
    }
  }

  for (const handle of config.alertTo) {
    if (!resolver.fromHandle) continue;
    try {
      const space = await resolver.fromHandle(handle);
      if (space) {
        track(space);
        console.log(`[agent] alerts will also go to ${handle}`);
      }
    } catch (err) {
      console.warn(`[agent] could not reach ${handle}:`, (err as Error).message);
    }
  }

  // --- outbound: proactive alerts -----------------------------------------

  const sendAlert = async (alert: Alert) => {
    if (muted) {
      console.log(`[agent] muted, not sending: ${alert.message}`);
      return;
    }
    if (live.size === 0) {
      console.log(`[agent] nobody to text yet, dropping: ${alert.message}`);
      return;
    }
    // `message` is written by the API to be sent verbatim.
    const content = text(alert.message);
    await Promise.all(
      [...live.entries()].map(async ([key, space]) => {
        try {
          await space.send(content);
        } catch (err) {
          console.warn(`[agent] alert to ${key} failed:`, (err as Error).message);
        }
      }),
    );
    console.log(`[agent] alerted ${live.size} chat(s): ${alert.message}`);
  };

  const poller = new AlertPoller(sendAlert);
  const skipped = await poller.catchUp();
  if (skipped > 0) console.log(`[agent] skipping ${skipped} alert(s) from before startup`);
  poller.start();

  // --- inbound: commands and clips ----------------------------------------

  /** "play it": fetch the WAV from the API and attach it to the reply. */
  const sendClip = async (space: Space, alert: Alert) => {
    const wav = await api.audio(alert.audio_url);
    await space.send(
      text(reply.playCaption(alert)),
      attachment(wav, { mimeType: "audio/wav", name: `pen${alert.pen_id}.wav` }),
    );
  };

  /** The farmer recorded something: run it through /predict and report back. */
  const handleAttachment = async (space: Space, content: Extract<Message["content"], { type: "attachment" }>) => {
    if (!content.mimeType.startsWith("audio/")) {
      await space.send(text("I can only listen to audio. Send me a voice memo or a recording."));
      return;
    }
    const bytes = await content.read();
    const pred = await api.predict(bytes, content.name || "farmer-clip");
    await space.send(text(reply.clipReply(pred)));
  };

  const handleText = async (space: Space, body: string) => {
    const intent = parseIntent(body);
    switch (intent.kind) {
      case "help":
        return space.send(text(reply.HELP));
      case "mute":
        muted = true;
        return space.send(text(reply.MUTED));
      case "unmute":
        muted = false;
        return space.send(text(reply.UNMUTED));
      case "status": {
        const all = await api.pens();
        const shown = intent.penId ? all.filter((p) => p.pen_id === intent.penId) : all;
        return space.send(text(reply.statusReply(shown)));
      }
      case "why": {
        const alert = await api.latestAlert(intent.penId);
        return space.send(text(alert ? reply.whyReply(alert) : reply.NO_ALERTS));
      }
      case "play": {
        const alert = await api.latestAlert(intent.penId);
        if (!alert) return space.send(text(reply.NO_ALERTS));
        return sendClip(space, alert);
      }
      case "unknown":
        return space.send(text(reply.unknownReply(intent.text)));
    }
  };

  const loop = (async () => {
    for await (const [space, message] of app.messages) {
      const first = track(space);
      try {
        await space.responding(async () => {
          if (first) await space.send(text(reply.HELP));
          const content = message.content;
          if (content.type === "attachment") {
            await handleAttachment(space, content);
          } else if (content.type === "text") {
            await handleText(space, content.text);
          } else if (content.type === "markdown") {
            await handleText(space, content.markdown);
          }
          // Reactions, reads and the rest need no reply.
        });
      } catch (err) {
        // One bad message must never kill the loop mid-demo.
        console.error("[agent] handler failed:", (err as Error).message);
        await space
          .send(text("Something broke on my end. Try again, or text \"status\"."))
          .catch(() => {});
      }
    }
  })();

  console.log(`[agent] listening. ${subscribers.size} chat(s) known, muted=${muted}`);

  return {
    async stop() {
      poller.stop();
      await app.stop();
      await loop.catch(() => {});
    },
  };
}
