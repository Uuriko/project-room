// Pure pause-duration checks: no Durable Object. A pause holds for a real
// duration only, so the relay refuses 0 instead of answering paused:true for a
// pause the daemon ignores (tests/relay-pause-minutes.test.js pins the two
// sides to each other).
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PAUSE_MINUTES, isPauseMinutes } from "../src/protocol.mjs";

test("the relay accepts only whole pause durations from 1 to the cap", () => {
  assert.equal(MAX_PAUSE_MINUTES, 10_080);
  for (const minutes of [1, 30, 10_080]) assert.equal(isPauseMinutes(minutes), true, String(minutes));
  for (const minutes of [0, -1, 1.5, 10_081, "30", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isPauseMinutes(minutes), false, String(minutes));
  }
});
