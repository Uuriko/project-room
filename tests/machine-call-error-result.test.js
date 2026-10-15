import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnContext } from "../machine/lib/spawn.mjs";
import { defaultConfig, saveConfig } from "../machine/lib/config.mjs";
import { MachineDaemon } from "../machine/lib/daemon.mjs";

// Regression for #2873: an exception inside call() used to be swallowed by
// receive()'s .catch(() => {}), so no result frame was ever sent and the
// relay caller hung until its own timeout. Every call must answer with a
// result frame — including calls rejected before dispatch and calls whose
// post-dispatch bookkeeping throws after the tool already ran.
const fakes = fileURLToPath(new URL("../machine/fakes/", import.meta.url));

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), "room-machine-call-error-"));
  writeFileSync(join(home, "argv-log"), "");
  writeFileSync(join(home, "env-log"), "");
  saveConfig({ ...defaultConfig(), enabled: true, machineId: "mac-1", label: "spare" }, home);
  const env = {
    PATH: `${fakes}:${process.env.PATH}`, HOME: home, TMPDIR: home, LANG: "C", LC_ALL: "C",
    USER: "room", LOGNAME: "room", TERM: "dumb", ROOM_MACHINE_ENABLED: "1", ROOM_MACHINE_HOME: home,
    ROOM_MACHINE_DEADMAN_SECONDS: "30",
  };
  const daemon = new MachineDaemon({ home, env });
  const sent = [];
  daemon.socket = { send: text => sent.push(JSON.parse(text)), close: () => {} };
  t.after(async () => {
    await spawnContext.run({ env }, () => daemon.stop());
    rmSync(home, { recursive: true, force: true });
  });
  const receive = message => spawnContext.run({ env }, () => daemon.receive(JSON.stringify(message)));
  return { home, daemon, sent, receive };
}

const caller = (claimId, slot = "desk") => ({ identityId: "ai_caller", claimId, slot, verified: true });

test("a claimId outside [A-Za-z0-9_-] is refused before the tool runs, with a result frame", async t => {
  const { home, daemon, sent, receive } = setup(t);
  await receive({ type: "call", id: "bad-claim", tool: "desktop.click", args: { x: 1, y: 2 }, caller: caller("bad/id") });
  assert.equal(sent.length, 1, "the caller gets a result frame instead of hanging");
  assert.equal(sent[0].id, "bad-claim");
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error.code, "lease_required");
  assert.equal(readFileSync(join(home, "argv-log"), "utf8").includes("tools/call"), false, "the tool never executed");
  assert.equal(daemon.state.slots.desk, null, "the slot was not taken by the malformed lease");
});

test("a call id outside CALL_ID_PATTERN is refused with a result frame", async t => {
  const { sent, receive } = setup(t);
  await receive({ type: "call", id: "bad id!", tool: "machine.status", args: {}, caller: caller("lease-1") });
  assert.equal(sent.length, 1, "the caller gets a result frame instead of hanging");
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error.code, "invalid_message");
});

test("an exception after the tool executed still sends an error result", async t => {
  const { home, sent, receive } = setup(t);
  // A regular file where claimDir() needs a directory: captureConsoleFrame /
  // appendManifest throw after dispatchTool has already run the click.
  mkdirSync(join(home, "recordings"), { recursive: true });
  writeFileSync(join(home, "recordings", "rec-err"), "not a directory");
  await receive({ type: "call", id: "boom", tool: "desktop.click", args: { x: 1, y: 2 }, caller: caller("rec-err") });
  assert.equal(readFileSync(join(home, "argv-log"), "utf8").includes("tools/call"), true, "the tool did execute");
  assert.equal(sent.length, 1, "the caller gets a result frame instead of hanging");
  assert.equal(sent[0].id, "boom");
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error.code, "unavailable");
});
