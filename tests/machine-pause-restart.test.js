import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineDaemon } from "../machine/lib/daemon.mjs";
import { loadConfig, saveConfig } from "../machine/lib/config.mjs";

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

// Regression for #3030: the daemon is long-lived and other writers (CLI
// `provider set` / `bot enable`, `enroll`) update config.json while it runs.
// A halt, pause or resume must persist only the fields the daemon owns and
// must not revert those concurrent changes with its stale snapshot.
test("halt, pause and resume do not revert config changes made while the daemon runs", async t => {
  const dir = home(t);
  const daemon = new MachineDaemon({ home: dir });
  daemon.state.running = {};

  // CLI `provider set` lands after the daemon was constructed.
  const afterProvider = loadConfig(dir);
  afterProvider.provider = "anthropic";
  afterProvider.enabled = true;
  saveConfig(afterProvider, dir);
  await daemon.handleRaw(JSON.stringify({ type: "halt", epoch: 7 }));
  let saved = loadConfig(dir);
  assert.equal(saved.halted, true);
  assert.equal(saved.haltEpoch, 7);
  assert.equal(saved.provider, "anthropic", "halt must not revert a provider set made while the daemon runs");
  assert.equal(saved.enabled, true, "halt must not revert enabled");

  // An enroll-style rewrite lands while the daemon is halted.
  const afterEnroll = loadConfig(dir);
  afterEnroll.machineId = "mac-2";
  afterEnroll.relayUrl = "wss://relay.example";
  afterEnroll.roomId = "commons";
  saveConfig(afterEnroll, dir);
  await daemon.pause(15);
  saved = loadConfig(dir);
  assert.equal(saved.pausedUntil, daemon.state.pausedUntil, "the pause is still written to config");
  assert.equal(saved.machineId, "mac-2", "pause must not revert enrolment fields");
  assert.equal(saved.relayUrl, "wss://relay.example", "pause must not revert the relay URL");
  assert.equal(saved.roomId, "commons", "pause must not revert the room id");

  // CLI `bot enable` lands while the daemon is paused.
  const afterBot = loadConfig(dir);
  afterBot.bot = { enabled: true, rooms: ["commons"], tier: "t1" };
  saveConfig(afterBot, dir);
  await daemon.resume();
  saved = loadConfig(dir);
  assert.equal(saved.halted, false);
  assert.equal(saved.pausedUntil, null);
  assert.deepEqual(saved.bot, { enabled: true, rooms: ["commons"], tier: "t1" }, "resume must not revert a bot enable made while the daemon runs");
  assert.equal(saved.provider, "anthropic", "resume must not revert the provider either");
  assert.equal(daemon.config.machineId, "mac-2", "the daemon adopts the fresh config it reloaded");
});

test("a pause with no real duration writes nothing", async t => {
  const dir = home(t);
  const daemon = new MachineDaemon({ home: dir });
  daemon.state.running = {};
  await daemon.handleRaw(JSON.stringify({ type: "pause", minutes: 0 }));
  await daemon.pause(-1);
  assert.equal(loadConfig(dir).pausedUntil, null);
});
