// tests/shed-loop-attention.test.js — the shed loop actually polls attention.
//
// Authoring gate answers:
// 1. Protects: the loop's poll path end to end — with a real room server and a
//    saved agent connection, the first tick must succeed (heartbeat "ok" with
//    an item count), not fail closed on every tick.
// 2. Credible regression: the 2026-10-04 bug this guards — the loop passed
//    `directory: config.directory` to currentAttention, but the connection
//    config carries no directory field, so every tick threw
//    "private_state_required" and the shed journaled nothing while reporting
//    "degraded". This test fails on that code (heartbeat stays "degraded")
//    and passes with the loop's own state dir.
// 3. Existing coverage: shed-loop.test.js only covers fail-closed startup.
//    Nothing exercises a successful tick.
// 4. Production seams: none. Real loop process, real room server, real client
//    modules; the only fixture is the repo's own acceptance fixture.
//
// Second test (issue #2878):
// 1. Protects: a FAILED agent handoff (SHED_AGENT_CMD exits non-zero) is
//    retried on a later tick instead of being recorded as handed and
//    suppressed until the 30-day prune; once a retry succeeds, the item is
//    deduped again and not handed repeatedly.
// 2. Credible regression: tick() stored handed[key] unconditionally and the
//    next tick skipped any key with an entry, ignoring ok:false — one
//    transient agent failure silently lost the item. On that code this test
//    times out waiting for a second attempt that never comes.
// 3. Existing coverage: the first test never sets SHED_AGENT_CMD, so no
//    handoff (successful or failed) was ever exercised.
// 4. Production seams: none. The agent command is a real shell script the
//    operator could have configured; it fails until a flag file appears,
//    then succeeds, and counts its own invocations.
//
// Third test (issue #2879):
// 1. Protects: dedup-state durability — each completed handoff is persisted
//    before the next item is attempted, so a crash mid-tick never re-hands
//    already-completed items after restart, and handed.json is never a
//    truncated half-write (atomic replace).
// 2. Credible regression: tick() persisted handed.json only once, at end of
//    tick, with an in-place writeFileSync. A kill during a later item's
//    (up to 600s) handoff lost every earlier handoff in that tick. On that
//    code this test observes no durable ok record mid-tick, and after a
//    SIGKILL + restart the first item is handed a second time.
// 3. Existing coverage: the tests above never kill the loop mid-tick.
// 4. Production seams: none. The agent command is a real shell script; the
//    kill is a real SIGKILL — the crash the issue describes.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loop = join(root, "shed", "shed-loop.mjs");

test("shed loop polls attention against a real room (regression: watch directory)", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const dir = mkdtempSync(join(tmpdir(), "shed-loop-attn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDirectory = join(dir, "config");
  const stateDir = join(dir, "state");
  saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer });

  const child = spawn(process.execPath, [loop], {
    env: { ...process.env, ROOM_AGENT_CONFIG: configDirectory, SHED_STATE_DIR: stateDir, SHED_POLL_SECS: "15" },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));

  // Wait for a post-tick heartbeat: the startup write has detail.note, the
  // tick write has detail.items. A broken poll path writes "degraded" here.
  const heartbeatPath = join(stateDir, "heartbeat.json");
  const start = Date.now();
  let heartbeat = null;
  while (Date.now() - start < 45000) {
    if (existsSync(heartbeatPath)) {
      // The loop rewrites this file in place, so a read can land mid-write: retry on a partial file.
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(heartbeatPath, "utf8")); } catch { /* partial write, poll again */ }
      if (parsed?.detail && (typeof parsed.detail.items === "number" || parsed.status !== "ok")) { heartbeat = parsed; break; }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(heartbeat, "loop wrote a post-tick heartbeat within 45s");
  assert.equal(heartbeat.status, "ok", `first tick succeeded (got ${heartbeat.status}: ${JSON.stringify(heartbeat.detail)})`);
  assert.equal(typeof heartbeat.detail.items, "number", "heartbeat reports the polled item count");
});

test("shed loop retries a failed handoff on a later tick, then dedups the success (regression #2878)", { timeout: 120000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Guarantee at least one pending attention item for the producer member.
  f.store.command(f.keys.owner, "commons", { id: "instructions-0", type: "room.charter_updated",
    data: { expectedRevision: 0, purpose: "Retry failed handoffs", outputs: null, boundaries: null, escalation: null } });

  const dir = mkdtempSync(join(tmpdir(), "shed-loop-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDirectory = join(dir, "config");
  const stateDir = join(dir, "state");
  saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer });

  // Operator agent command: counts every invocation, fails until the test
  // drops the flag file, then succeeds.
  const countPath = join(dir, "attempts.txt");
  const flagPath = join(dir, "succeed.flag");
  const agentPath = join(dir, "agent.sh");
  writeFileSync(agentPath, `#!/bin/sh\necho attempt >> '${countPath}'\nif [ -f '${flagPath}' ]; then exit 0; fi\nexit 1\n`);
  chmodSync(agentPath, 0o755);

  const child = spawn(process.execPath, [loop], {
    env: { ...process.env, ROOM_AGENT_CONFIG: configDirectory, SHED_STATE_DIR: stateDir, SHED_POLL_SECS: "15", SHED_AGENT_CMD: agentPath },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));

  const attempts = () => existsSync(countPath) ? readFileSync(countPath, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const handedPath = join(stateDir, "handed.json");
  const handedOk = () => {
    try { return Object.values(JSON.parse(readFileSync(handedPath, "utf8"))).some(e => e && e.ok === true); } catch { return false; }
  };
  async function waitFor(fn, timeoutMs, what) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.fail(`timed out waiting for ${what}`);
  }

  // First tick: the agent command runs and fails for every pending item.
  await waitFor(() => attempts() >= 1, 45000, "the first (failing) handoff attempt");
  // Wait for the tick to finish (post-tick heartbeat carries an item count)
  // so the attempt count below is the complete first-tick count.
  const heartbeatPath = join(stateDir, "heartbeat.json");
  await waitFor(() => {
    try { const h = JSON.parse(readFileSync(heartbeatPath, "utf8")); return typeof h?.detail?.items === "number"; } catch { return false; }
  }, 45000, "the first tick to complete");
  const failedAttempts = attempts();
  assert.ok(failedAttempts >= 1, "first tick attempted at least one handoff");
  assert.equal(handedOk(), false, "no handoff has succeeded yet");

  // The agent recovers. A later tick must retry the failed item(s): on the
  // old code the ok:false entry suppressed them and this wait timed out.
  writeFileSync(flagPath, "ok\n");
  await waitFor(() => attempts() > failedAttempts, 45000, "a retry of the failed handoff on a later tick");
  await waitFor(handedOk, 45000, "the retried handoff to be recorded as successful");

  // Once a retry succeeds, the item is deduped again: no further attempts
  // across another full poll interval.
  const successAttempts = attempts();
  await new Promise(r => setTimeout(r, 20000));
  assert.equal(attempts(), successAttempts, "successful handoff is not repeated on later ticks");
});

test("shed loop persists each handoff before the next: a mid-tick SIGKILL never re-hands completed items (regression #2879)", { timeout: 120000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // One charter update yields two pending attention items for the producer
  // (the fixture's seeded notice + the charter notice; see
  // current-attention-integration.test.js, first pull after one charter).
  f.store.command(f.keys.owner, "commons", { id: "instructions-0", type: "room.charter_updated",
    data: { expectedRevision: 0, purpose: "Crash-safe dedup", outputs: null, boundaries: null, escalation: null } });

  const dir = mkdtempSync(join(tmpdir(), "shed-loop-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDirectory = join(dir, "config");
  const stateDir = join(dir, "state");
  saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer });

  // Operator agent command: logs every invocation's packet; the first
  // distinct packet succeeds at once, the second distinct packet hangs
  // (the test SIGKILLs the loop mid-handoff — the crash window), and any
  // already-seen packet succeeds (so a restarted loop can finish the tick).
  const invocationsPath = join(dir, "invocations.log");
  const seenPath = join(dir, "seen.log");
  const hangPath = join(dir, "hanging.flag");
  const agentPath = join(dir, "agent.sh");
  writeFileSync(agentPath, [
    "#!/bin/sh",
    "packet=$(cat)",
    `echo "$packet" >> '${invocationsPath}'`,
    `if grep -Fqx "$packet" '${seenPath}' 2>/dev/null; then exit 0; fi`,
    `echo "$packet" >> '${seenPath}'`,
    `count=$(wc -l < '${seenPath}')`,
    `if [ "$count" -ge 2 ]; then touch '${hangPath}'; sleep 45; fi`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(agentPath, 0o755);

  const env = { ...process.env, ROOM_AGENT_CONFIG: configDirectory, SHED_STATE_DIR: stateDir, SHED_POLL_SECS: "15", SHED_AGENT_CMD: agentPath };
  const handedPath = join(stateDir, "handed.json");
  const handedOk = () => {
    try { return Object.values(JSON.parse(readFileSync(handedPath, "utf8"))).some(e => e && e.ok === true); } catch { return false; }
  };
  const invocations = () => existsSync(invocationsPath) ? readFileSync(invocationsPath, "utf8").split("\n").filter(Boolean) : [];
  async function waitFor(fn, timeoutMs, what) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await new Promise(r => setTimeout(r, 250));
    }
    assert.fail(`timed out waiting for ${what}`);
  }

  let child = spawn(process.execPath, [loop], { env, stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });

  // First tick: item 1's handoff completes, item 2's handoff begins and
  // hangs inside the agent command. The tick is now mid-flight.
  await waitFor(() => existsSync(hangPath), 45000, "the second item's handoff to begin (tick mid-flight)");
  const firstPacket = invocations()[0];
  assert.ok(firstPacket, "at least one handoff was attempted");
  // The completed first handoff must ALREADY be durable on disk — the tick
  // has not ended, so an end-of-tick-only persist has written nothing.
  const durableMidTick = handedOk();

  // The crash: SIGKILL, uncatchable, exactly the issue's failure scenario.
  child.kill("SIGKILL");
  await Promise.race([new Promise(r => child.once("close", r)), new Promise(r => setTimeout(r, 10000))]);

  // Restart against the same state dir.
  const restartTs = new Date().toISOString();
  child = spawn(process.execPath, [loop], { env, stdio: "ignore" });
  const heartbeatPath = join(stateDir, "heartbeat.json");
  await waitFor(() => {
    try { const h = JSON.parse(readFileSync(heartbeatPath, "utf8")); return h.ts >= restartTs && typeof h?.detail?.items === "number"; } catch { return false; }
  }, 45000, "the restarted loop's first tick to complete");
  // One more full poll interval: any wrongful re-hand would have happened.
  await new Promise(r => setTimeout(r, 20000));
  try { child.kill("SIGKILL"); } catch { /* already gone */ }

  assert.equal(durableMidTick, true, "a completed handoff is persisted before the next item is attempted");
  const reHands = invocations().filter(p => p === firstPacket).length;
  assert.equal(reHands, 1, "the completed item is never re-handed after a mid-tick crash + restart");
  assert.equal(handedOk(), true, "handed.json survives the crash as valid JSON with the successful record");
});
