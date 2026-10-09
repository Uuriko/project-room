import test from "node:test";
import assert from "node:assert/strict";
import { isPauseMinutes } from "../relay/src/protocol.mjs";
import { pauseUntilFromMinutes } from "../machine/lib/protocol.mjs";

// The relay answers {paused:true} and forwards the pause; the daemon ignores a
// pause with no real duration (#2121). If the relay accepts a value the daemon
// ignores, an owner is told the machine is paused while guests keep running.
test("every pause the relay accepts is one the daemon honors, and the reverse", () => {
  const now = 1_700_000_000_000;
  for (const minutes of [-5, 0, 1, 30, 10_080]) {
    const honored = pauseUntilFromMinutes(minutes, now) === now + minutes * 60_000;
    assert.equal(isPauseMinutes(minutes), honored, `relay and daemon disagree on ${minutes} minutes`);
  }
});
