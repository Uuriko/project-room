import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseUntilFromMinutes } from "../machine/lib/protocol.mjs";
import { MachineDaemon } from "../machine/lib/daemon.mjs";

test("pauseUntilFromMinutes ignores a duration that would not hold", () => {
  const now = 1_700_000_000_000;
  assert.equal(pauseUntilFromMinutes(undefined, now), null);
  assert.equal(pauseUntilFromMinutes(0, now), null);
  assert.equal(pauseUntilFromMinutes(-5, now), null);
  assert.equal(pauseUntilFromMinutes("nope", now), null);
  assert.equal(pauseUntilFromMinutes(Number.POSITIVE_INFINITY, now), null);
  assert.equal(pauseUntilFromMinutes(15, now), now + 15 * 60 * 1000);
});

test("a relay pause with a bad duration does not suspend or start a pause", async () => {
  const home = mkdtempSync(join(tmpdir(), "room-machine-pause-"));
  const daemon = new MachineDaemon({ home });
  daemon.state.running = {};
  const before = daemon.state.pausedUntil;
  for (const minutes of [undefined, 0, -5, "nope"]) {
    await daemon.handleRaw(JSON.stringify({ type: "pause", minutes }));
    assert.equal(daemon.state.pausedUntil, before);
  }
  await daemon.handleRaw(JSON.stringify({ type: "pause", minutes: 15 }));
  assert.equal(typeof daemon.state.pausedUntil, "number");
  assert.ok(daemon.state.pausedUntil > Date.now());
});
