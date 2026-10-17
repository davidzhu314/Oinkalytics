/**
 * A Spectrum-shaped app backed by stdin and stdout.
 *
 * Why this exists: Spectrum's `terminal` provider spawns a downloaded `tuichat`
 * binary, which Windows Application Control blocks outright, and which is a
 * full-screen TUI that cannot be scripted. This gives the same
 * `[space, message]` loop over plain lines, so the agent can be driven by hand
 * or piped from a test on any machine, with no Photon credentials.
 *
 * It implements only the surface `runAgent` touches, and is cast to
 * `SpectrumInstance` at the boundary. Nothing in the real build depends on it.
 */

import type { Content, ContentInput, Message, Space, SpectrumInstance } from "spectrum-ts";

const resolve = async (input: ContentInput): Promise<Content> =>
  typeof input === "string" ? { type: "text", text: input } : await input.build();

/** How a sent message is rendered. Tests swap this for a collector. */
export type Sink = (content: Content) => void;

export const printSink: Sink = (content) => {
  if (content.type === "text") process.stdout.write(`\n${content.text}\n\n> `);
  else if (content.type === "markdown") process.stdout.write(`\n${content.markdown}\n\n> `);
  else if (content.type === "attachment")
    process.stdout.write(`\n[attachment: ${content.name}, ${content.mimeType}]\n\n> `);
  else process.stdout.write(`\n[${content.type}]\n\n> `);
};

export interface StdinApp {
  app: SpectrumInstance;
  /** Feed one inbound line, as if the farmer texted it. */
  say(body: string): void;
  /** Feed an audio attachment, as if the farmer sent a recording. */
  sendAudio(name: string, mimeType: string, bytes: Buffer): void;
  /** Inbound lines not yet picked up by the agent loop. */
  readonly queued: number;
  /** Resolves once the queue is empty and replies have had `grace` ms to land. */
  drain(grace?: number): Promise<void>;
  close(): void;
}

export function createStdinApp(sink: Sink = printSink, spaceId = "local"): StdinApp {
  const queue: Array<[Space, Message]> = [];
  let wake: (() => void) | undefined;
  let closed = false;

  const push = (item: [Space, Message]) => {
    queue.push(item);
    wake?.();
  };

  const space = {
    __platform: "stdin",
    id: spaceId,
    async send(...content: ContentInput[]) {
      for (const c of content) sink(await resolve(c));
      return undefined;
    },
    async responding<T>(fn: () => T | Promise<T>) {
      return fn();
    },
  } as unknown as Space;

  const message = (content: Content): Message =>
    ({
      id: `stdin_${Date.now()}_${queue.length}`,
      __platform: "stdin",
      content,
      sender: { id: "farmer", __platform: "stdin" },
      space,
    }) as unknown as Message;

  const messages: AsyncIterable<[Space, Message]> = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = undefined;
      }
    },
  };

  const app = {
    messages,
    async stop() {
      closed = true;
      wake?.();
    },
  } as unknown as SpectrumInstance;

  return {
    app,
    get queued() {
      return queue.length;
    },
    async drain(grace = 500) {
      const deadline = Date.now() + 10_000;
      while (queue.length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, grace));
    },
    say(body) {
      push([space, message({ type: "text", text: body })]);
    },
    sendAudio(name, mimeType, bytes) {
      push([
        space,
        message({
          type: "attachment",
          id: `att_${name}`,
          name,
          mimeType,
          size: bytes.length,
          read: async () => bytes,
          stream: async () => new Blob([new Uint8Array(bytes)]).stream(),
        }),
      ]);
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}
