import assert from "node:assert/strict";
import { test } from "node:test";

import { parseIntent, parsePen } from "../src/intents.ts";

test("the three must-have commands, phrased the way a judge would", () => {
  for (const s of ["why", "Why?", "why??", "explain", "how come", "what's going on"]) {
    assert.equal(parseIntent(s).kind, "why", s);
  }
  for (const s of ["status", "Status", "pens", "summary", "how are the pens", "all good?"]) {
    assert.equal(parseIntent(s).kind, "status", s);
  }
  for (const s of ["play it", "play", "let me hear it", "send the clip", "audio"]) {
    assert.equal(parseIntent(s).kind, "play", s);
  }
});

test("pen numbers come through in every spelling", () => {
  assert.equal(parsePen("pen 3"), "3");
  assert.equal(parsePen("pen3"), "3");
  assert.equal(parsePen("PEN #3"), "3");
  assert.equal(parsePen("#3"), "3");
  assert.equal(parsePen("3"), "3");
  assert.equal(parsePen("why"), undefined);
});

test("a pen-scoped command keeps both the intent and the pen", () => {
  assert.deepEqual(parseIntent("why pen 3"), { kind: "why", penId: "3" });
  assert.deepEqual(parseIntent("status pen 2"), { kind: "status", penId: "2" });
  assert.deepEqual(parseIntent("play pen 4"), { kind: "play", penId: "4" });
});

test("mute exists because the plan calls alert spam a high risk", () => {
  assert.equal(parseIntent("mute").kind, "mute");
  assert.equal(parseIntent("stop alerts").kind, "mute");
  assert.equal(parseIntent("unmute").kind, "unmute");
});

test("an empty or unrecognised message is handled, not dropped", () => {
  assert.equal(parseIntent("").kind, "help");
  assert.equal(parseIntent("help").kind, "help");
  assert.deepEqual(parseIntent("tell me a joke"), { kind: "unknown", text: "tell me a joke" });
});
