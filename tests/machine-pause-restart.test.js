import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineDaemon } from "../machine/lib/daemon.mjs";
import { loadConfig } from "../machine/lib/config.mjs";

// A halt survives a daemon restart (config.halted). A pause must too: launchd
// restarts the daemon after a crash or reboot, and a pause that lives only in
// memory ends early with the owner still believing the machine is paused.
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "room-machine-pause-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a relay pause survives a daemon restart", async t => {
  const dir = home(t);
  const first = new MachineDaemon({ home: dir });
  first.state.running = {};
  await first.handleRaw(JSON.stringify({ type: "pause", minutes: 15 }));
  const until = first.state.pausedUntil;
  assert.equal(typeof until, "number");
  assert.equal(loadConfig(dir).pausedUntil, until, "the pause is written to config");
  const restarted = new MachineDaemon({ home: dir });
  assert.equal(restarted.state.pausedUntil, until, "a restarted daemon is still paused");
  assert.equal(restarted.status().pausedUntil, until);
});

test("a local pause survives a restart and resume clears it for good", async t => {
  const dir = home(t);
  const first = new MachineDaemon({ home: dir });
  first.state.running = {};
  const { pausedUntil } = await first.pause(30);
  assert.equal(new MachineDaemon({ home: dir }).state.pausedUntil, pausedUntil);
  await first.handleRaw(JSON.stringify({ type: "resume" }));
  assert.equal(loadConfig(dir).pausedUntil, null);
  assert.equal(new MachineDaemon({ home: dir }).state.pausedUntil, null, "a resumed machine stays resumed after restart");
});

test("a pause with no real duration writes nothing", async t => {
  const dir = home(t);
  const daemon = new MachineDaemon({ home: dir });
  daemon.state.running = {};
  await daemon.handleRaw(JSON.stringify({ type: "pause", minutes: 0 }));
  await daemon.pause(-1);
  assert.equal(loadConfig(dir).pausedUntil, null);
});
