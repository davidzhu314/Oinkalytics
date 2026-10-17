/**
 * Dev entrypoint: the same agent, driven from your keyboard, with no Photon
 * credentials and no phone.
 *
 *   npm run dev
 *
 * Type "status", "why", "play it" at the prompt. Alerts from the API arrive
 * here too, so the whole demo flow is testable against the mock server alone.
 * Also accepts `/send <path-to-audio>` to exercise send-a-clip.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline";

import { runAgent } from "./agent.ts";
import { createStdinApp } from "./stdin-app.ts";

const MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".caf": "audio/x-caf",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

const dev = createStdinApp();
const agent = await runAgent(dev.app);

const rl = createInterface({ input: process.stdin, output: process.stdout });
process.stdout.write("> ");

rl.on("line", (line) => {
  const body = line.trim();
  if (body === "/quit" || body === "/exit") return rl.close();

  if (body.startsWith("/send ")) {
    const path = body.slice(6).trim().replace(/^["']|["']$/g, "");
    void readFile(path)
      .then((bytes) => {
        const mime = MIME[extname(path).toLowerCase()] ?? "audio/wav";
        dev.sendAudio(basename(path), mime, bytes);
      })
      .catch((err: Error) => process.stdout.write(`\ncannot read ${path}: ${err.message}\n\n> `));
    return;
  }

  dev.say(body);
});

rl.on("close", () => {
  // Piped input closes the moment the lines are read, so let the replies land
  // before tearing the agent down. Makes the bot smoke-testable from a script.
  void dev
    .drain()
    .then(() => {
      dev.close();
      return agent.stop();
    })
    .finally(() => process.exit(0));
});
