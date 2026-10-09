// Guild-06 worker-17 (shard 17) hardening regressions.
//
//  - check-version-doors: a non-numeric/negative --wait-ms or --poll-ms made
//    waitDoors loop forever on a NaN deadline (tight setTimeout(NaN) poll
//    loop hammering the origin). Now a usage error, exit 2.
//  - real-agent-fixture: `publish` with missing/unreadable/malformed args
//    crashed with an uncaught stack trace (exit 1). Now a clean error +
//    usage on stderr, exit 2.
//  - soak-run: request timeouts double-counted stats.errors (the setTimeout
//    handler incremented AND the 'error' fired by req.destroy() incremented);
//    graceful shutdown could wait forever on an "exit" event that already
//    fired; importing the module must not boot the harness.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Agent } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHARDS = {
  doors: `${root}/scripts/check-version-doors.mjs`,
  fixture: `${root}/scripts/real-agent-fixture.mjs`,
  soak: `${root}/scripts/soak-run.mjs`,
};
const run = (script, args, timeout = 20000) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout, cwd: root });
const assertCleanUsageError = (r, what) => {
  assert.equal(r.status, 2, `${what}: expected exit 2, got ${r.status}: ${(r.stderr || "").slice(0, 300)}`);
  assert.match(r.stderr, /Usage:/i, `${what}: usage goes to stderr`);
  assert.doesNotMatch(r.stderr, /^\s*at\s/m, `${what}: no stack trace`);
};

// --- scripts/check-version-doors.mjs ----------------------------------------
test("check-version-doors: non-numeric --wait-ms exits 2 instead of hanging", () => {
  const r = run(SHARDS.doors, ["--origin", "http://127.0.0.1:1", "--sha", "b".repeat(40), "--wait-ms", "abc"], 15000);
  assertCleanUsageError(r, "check-version-doors --wait-ms abc");
});

test("check-version-doors: non-numeric --poll-ms exits 2", () => {
  const r = run(SHARDS.doors, ["--origin", "http://127.0.0.1:1", "--sha", "b".repeat(40), "--poll-ms", "soon"]);
  assertCleanUsageError(r, "check-version-doors --poll-ms soon");
});

test("check-version-doors: negative --wait-ms exits 2", () => {
  const r = run(SHARDS.doors, ["--origin", "http://127.0.0.1:1", "--sha", "b".repeat(40), "--wait-ms", "-5"]);
  assertCleanUsageError(r, "check-version-doors --wait-ms -5");
});

test("check-version-doors: waitDoors rejects a NaN waitMs instead of looping", { timeout: 8000 }, async () => {
  const { waitDoors } = await import("../scripts/check-version-doors.mjs");
  await assert.rejects(
    () => waitDoors({ origin: "http://127.0.0.1:1", sha: "b".repeat(40), waitMs: Number("abc"), pollMs: 10, fetchImpl: async () => { throw new Error("must not fetch"); } }),
    /waitMs/,
  );
});

// --- scripts/real-agent-fixture.mjs ------------------------------------------
test("real-agent-fixture: publish with no args exits 2 with usage, no stack", () => {
  assertCleanUsageError(run(SHARDS.fixture, ["publish"]), "real-agent-fixture publish");
});

test("real-agent-fixture: publish with a missing config exits 2, no stack", () => {
  assertCleanUsageError(
    run(SHARDS.fixture, ["publish", "/nonexistent/producer.json", "/nonexistent/note.md"]),
    "real-agent-fixture publish missing config",
  );
});

test("real-agent-fixture: publish with malformed config exits 2, no stack", () => {
  const dir = mkdtempSync(join(tmpdir(), "w17-fixture-"));
  const bad = join(dir, "producer.json");
  writeFileSync(bad, "{ not json");
  assertCleanUsageError(run(SHARDS.fixture, ["publish", bad, bad]), "real-agent-fixture publish malformed config");
});

test("real-agent-fixture: publish happy path writes the hashed artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "w17-fixture-"));
  const artDir = join(dir, "artifacts");
  mkdirSync(artDir);
  const configPath = join(dir, "producer.json");
  writeFileSync(configPath, JSON.stringify({
    fixture: "project-room-real-agent-v1", memberId: "producer",
    artifactOrigin: "https://127.0.0.1:8443", artifactDirectory: artDir,
  }));
  const mdPath = join(dir, "note.md");
  writeFileSync(mdPath, "# hello\n");
  const r = run(SHARDS.fixture, ["publish", configPath, mdPath]);
  assert.equal(r.status, 0, `publish happy path: expected exit 0, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  const out = JSON.parse(r.stdout);
  assert.match(out.evidenceUrl, /^https:\/\/127\.0\.0\.1:8443\/[a-f0-9]{64}\.md$/);
  assert.equal(out.evidenceVersion, `sha256:${out.evidenceUrl.split("/").pop().replace(".md", "")}`);
});

// --- scripts/soak-run.mjs ------------------------------------------------------
test("soak-run: importing the module does not boot the harness", async () => {
  const mod = await import("../scripts/soak-run.mjs");
  assert.equal(typeof mod.requestOnce, "function");
  assert.equal(typeof mod.waitForExit, "function");
});

test("soak-run requestOnce: one failed request counts exactly one error", async () => {
  const { requestOnce } = await import("../scripts/soak-run.mjs");
  const agent = new Agent({ keepAlive: true });
  const fresh = () => ({ requests: 0, ok2xx: 0, byStatus: {}, errors: 0 });
  try {
    // (a) the server accepts but never responds: the client-side timeout fires.
    const server = createServer(() => { /* never responds */ });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const timeoutStats = fresh();
    await requestOnce(`http://127.0.0.1:${server.address().port}`, "/api/health", agent, timeoutStats, 50);
    server.close();
    assert.equal(timeoutStats.errors, 1, `one timed-out request counted ${timeoutStats.errors} errors`);
    // (b) nothing is listening: 'error' fires first, then the timeout callback
    // runs against the dead request and must not count a second error.
    const refusedStats = fresh();
    await requestOnce("http://127.0.0.1:1", "/api/health", agent, refusedStats, 50);
    assert.equal(refusedStats.errors, 1, `one refused request counted ${refusedStats.errors} errors`);
  } finally {
    agent.destroy();
  }
});

test("soak-run waitForExit: an already-exited child resolves instead of hanging", async () => {
  const { waitForExit } = await import("../scripts/soak-run.mjs");
  const child = spawn(process.execPath, ["-e", "process.exit(3)"]);
  await new Promise((r) => child.once("exit", r)); // now "exit" has already fired
  const outcome = await Promise.race([
    waitForExit(child, 60_000).then((s) => ({ settled: true, ...s })),
    new Promise((r) => setTimeout(() => r({ settled: false }), 3000)),
  ]);
  assert.equal(outcome.settled, true, "waitForExit hung on an already-exited child");
  assert.equal(outcome.code, 3);
});
