/**
 * Pushes enough distressed clips at one pen to trip the alert rule, so you can
 * rehearse the phone buzzing without waiting for the barn simulator.
 *
 *   npx tsx scripts/fire-alert.ts [pen] [count]
 *
 * The real demo uses held-out clips through the dashboard's simulator; this is
 * only for testing that the bot delivers.
 */

import * as api from "../src/api.ts";
import { config } from "../src/config.ts";

const pen = process.argv[2] ?? "3";
const count = Number(process.argv[3] ?? 3);

/** A short synthetic WAV. The mock reads the filename, so each one is distinct. */
function wav(seed: number): Buffer {
  const samples = 1600;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((i * (seed + 3)) / 20)), 44 + i * 2);
  }
  return buf;
}

const h = await api.health();
console.log(`API ${config.api} (mode=${h.mode}); firing ${count} distressed call(s) at pen ${pen}`);

for (let i = 1; i <= count; i++) {
  const pred = await api.predict(wav(i + Date.now() % 1000), `distress-${i}.wav`, { penId: pen });
  console.log(`  ${i}. ${pred.status} (${Math.round(pred.valence.confidence * 100)}%)`);
}

const status = await api.pen(pen);
console.log(`\n${status.summary}`);
const latest = await api.latestAlert(pen);
console.log(latest ? `alert fired: ${latest.message}` : "no alert (cooldown, or threshold not met)");
