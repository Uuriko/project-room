// Audit wave LOW-D regression tests (RC-2026-09-30-3634).
// Each test encodes the contract one fixed finding restored. Every test was
// verified to fail on the pre-fix code for the intended reason (checkout the
// pre-fix source, run, re-apply the fix) before being committed here.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const runScript = (rel, args, { env = {}, input = "" } = {}) => new Promise((resolvePromise) => {
  const child = execFile(process.execPath, [resolve(repoRoot, rel), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    timeout: 30000,
  }, (error, stdout, stderr) => resolvePromise({ error, stdout, stderr, code: error?.code ?? 0 }));
  if (input) child.stdin.end(input); else child.stdin.end();
});

// ---- L-31: semver card-version tie-break in agent-discovery ----
import { createAgentDiscovery } from "../src/agent-discovery.mjs";

test("L-31: card version 1.2.10 outranks 1.2.9 at equal coverage (numeric segments)", () => {
  const discovery = createAgentDiscovery({
    cardRegistry: {
      list: () => [
        { agentId: "a-agent", version: "1.2.9", capabilities: ["chat"] },
        { agentId: "b-agent", version: "1.2.10", capabilities: ["chat"] },
      ],
    },
  });
  const ranked = discovery.discover({ capabilities: ["chat"] });
  assert.equal(ranked[0].agentId, "b-agent"); // "1.2.10" > "1.2.9" (was NaN → agentId order)
  assert.equal(ranked[1].agentId, "a-agent");
});

test("L-31: higher coverage still beats a higher version", () => {
  const discovery = createAgentDiscovery({
    cardRegistry: {
      list: () => [
        { agentId: "a-agent", version: "2.0.0", capabilities: ["chat"] },
        { agentId: "b-agent", version: "1.0.0", capabilities: ["chat", "files"] },
      ],
    },
  });
  const ranked = discovery.discover({ capabilities: ["chat", "files"] });
  assert.equal(ranked[0].agentId, "b-agent");
});

// ---- L-32: case-insensitive channel-key normalization in contact-merge ----
import { createContactMerge } from "../src/contact-merge.mjs";

test("L-32: channels differing only by key case still conflict on divergent handles", () => {
  const merge = createContactMerge();
  const a = merge.addContact({ emails: ["alice@example.com"], channels: { X: "@alice" } });
  const b = merge.addContact({ emails: ["alice@example.com"], channels: { x: "@mallory" } });
  const proposal = merge.proposeMerge(a.id, b.id);
  assert.equal(proposal.state, "conflict");
  assert.ok(proposal.conflicts.some(c => c.field === "channels.X"),
    `expected a conflict on the shared channel, got ${JSON.stringify(proposal.conflicts)}`);
});

test("L-32: channels differing only by key case do not conflict on the same handle", () => {
  const merge = createContactMerge();
  const a = merge.addContact({ emails: ["alice@example.com"], channels: { X: "@alice" } });
  const b = merge.addContact({ emails: ["alice@example.com"], channels: { x: "@alice" } });
  const proposal = merge.proposeMerge(a.id, b.id);
  assert.ok(!proposal.conflicts.some(c => c.field === "channels.X"),
    `unexpected channel conflict: ${JSON.stringify(proposal.conflicts)}`);
});

// ---- L-33: NaN failureThreshold fails closed to the default breaker ----
import { createFailover, DEFAULT_FAILURE_THRESHOLD } from "../src/failover-provider-wireup.mjs";

test("L-33: NaN failureThreshold falls back to the default so the circuit still opens", async () => {
  const fo = createFailover({
    failureThreshold: NaN,
    cooldownMs: Number.POSITIVE_INFINITY,
    providers: [{ name: "p0", sender: async () => { throw new Error("down"); } }],
  });
  for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i += 1) {
    await assert.rejects(fo.send({ body: "x" }));
  }
  assert.equal(fo.stats("p0").circuitState, "open");
});

// ---- L-34: reactions on deleted messages are refused ----
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("L-34: setMessageReaction on a deleted message throws 'Message was deleted'", () => {
  const dir = mkdtempSync(join(tmpdir(), "lowd-l34-"));
  try {
    const store = new RoomStore(join(dir, "room.sqlite"));
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    let n = 0;
    const send = (type, data) =>
      store.command(owner, "commons", { id: `e${(n += 1)}`, type, data });
    send(T.MESSAGE_POSTED, { messageId: "m1", body: "hello" });
    send(T.MESSAGE_DELETED, { messageId: "m1", expectedMessageRevision: 0 });
    assert.throws(
      () => send(T.MESSAGE_REACTION_SET, { messageId: "m1", reaction: "👍", active: true }),
      /Message was deleted/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- L-35: snapshot() must be a read, persist() the only writer ----
import { createHandoffStore } from "../src/handoff-store.mjs";

test("L-35: snapshot() never calls storage.save (only mutating ops persist)", () => {
  let saves = 0;
  const store = createHandoffStore({
    storage: { save: () => { saves += 1; }, load: () => null },
  });
  store.snapshot();
  assert.equal(saves, 0);
  store.propose({ fromAgent: "a", toAgent: "b", taskId: "t", summary: "work" }, "a");
  assert.equal(saves, 1);
});

// ---- L-36: overnight quiet windows wrap midnight ----
import { createDigestScheduler } from "../src/digest-scheduler.mjs";

test("L-36: quiet-window boundaries are wall-clock on DST transition days", () => {
  const scheduler = createDigestScheduler();
  const sub = scheduler.subscribe({
    userId: "u1", channels: ["email"], cadence: "immediate",
    quietHours: { start: "22:00", end: "07:00", tz: "America/New_York" },
  });
  // 2026-03-08 is the US spring-forward day (02:00 -> 03:00). 23:30 EDT is
  // 2026-03-09T03:30Z; the window ends at local 07:00 = 2026-03-09T11:00Z.
  // Absolute-ms arithmetic on the pre-fix code returned 12:00Z instead.
  const now = Date.UTC(2026, 2, 9, 3, 30);
  assert.equal(scheduler.nextDue(sub, now), Date.UTC(2026, 2, 9, 11, 0));
});

test("L-36: overnight quiet windows wrap midnight (guard, UTC has no DST)", () => {
  const scheduler = createDigestScheduler();
  const sub = scheduler.subscribe({
    userId: "u1", channels: ["email"], cadence: "immediate",
    quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
  });
  // 2026-09-30 23:30 UTC is inside the quiet window; next due is 2026-10-01 07:00 UTC.
  const now = Date.UTC(2026, 8, 30, 23, 30);
  assert.equal(scheduler.nextDue(sub, now), Date.UTC(2026, 9, 1, 7, 0));
});

test("L-36: nextDue outside the quiet window returns now", () => {
  const scheduler = createDigestScheduler();
  const sub = scheduler.subscribe({
    userId: "u1", channels: ["email"], cadence: "immediate",
    quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
  });
  const now = Date.UTC(2026, 8, 30, 12, 0);
  assert.equal(scheduler.nextDue(sub, now), now);
});

// ---- L-37: inbound sentAt is coerced to a number, never garbage ----
import { createMessaging } from "../src/cross-agent-messaging.mjs";

test("L-37: inbound messages with a non-numeric sentAt get a numeric fallback", () => {
  let captured;
  const transport = { receive: (handler) => { captured = handler; }, send: async () => {} };
  const bus = createMessaging({ transport, clock: () => 1727731200000 });
  bus.onInbound(() => {});
  captured({ from: "a", to: "b", body: "hello", threadId: "t1", sentAt: "bogus" });
  const stored = bus.thread("t1");
  assert.equal(stored.length, 1);
  assert.equal(typeof stored[0].sentAt, "number");
  assert.ok(Number.isFinite(stored[0].sentAt));
});

// ---- L-38: totp verifyCode never throws on bad clock/step inputs ----
import { generateSecret, generateCode, verifyCode } from "../src/totp-2fa.mjs";

test("L-38: verifyCode returns false (not throw) on non-numeric time and bad stepSeconds", () => {
  const secret = generateSecret();
  const code = generateCode(secret, { time: 1727731200000 });
  assert.doesNotThrow(() => {
    assert.equal(verifyCode(code, secret, { time: "x" }), false);
    assert.equal(verifyCode(code, secret, { time: Number.NaN }), false);
    assert.equal(verifyCode(code, secret, { time: -1 }), false);
    assert.equal(verifyCode(code, secret, { stepSeconds: 0 }), false);
    assert.equal(verifyCode(code, secret, { stepSeconds: "30" }), false);
  });
});

// ---- L-39: retry button wired before the invite preview fetch (source-contract) ----
// join.js only boots when `document` exists (no DOM lib in the repo), so the
// retention-bar guard here is the file-level contract itself: the retry
// listener must be registered before the preview fetch that can fail. Verified
// against the pre-fix source: wiring used to sit after the fetch.
test("L-39: retryWired registration precedes the /agent-invites/preview fetch in boot()", () => {
  const src = readFileSync(join(repoRoot, "src/join.js"), "utf8");
  const bootSrc = src.slice(src.indexOf("function boot()"));
  const wireAt = bootSrc.indexOf("retryWired");
  const fetchAt = bootSrc.indexOf("/agent-invites/preview");
  assert.ok(wireAt !== -1 && fetchAt !== -1, "expected retryWired guard and the preview fetch in boot()");
  assert.ok(wireAt < fetchAt, "the retry button must be wired before the preview fetch that can fail");
});

// ---- L-40: pairing-code attempt numbering is the post-increment count ----
import { createWhatsAppConnect } from "../src/whatsapp-connect.mjs";

test("L-40: WA_CODE_MISMATCH message and detail agree on the attempt count", () => {
  const wa = createWhatsAppConnect({ code: () => "1234-5678" });
  const { id } = wa.createConnection();
  wa.stageCode(id, "+14155550123");
  let err = null;
  try { wa.confirmCode(id, "0000-0000"); } catch (e) { err = e; }
  assert.ok(err, "expected confirmCode to throw on a wrong pairing code");
  assert.equal(err.code, "WA_CODE_MISMATCH");
  assert.equal(err.detail.codeAttempts, 1);
  assert.ok(err.message.includes("(attempt 1/5)"),
    `message/detail disagree: ${err.message} vs detail ${JSON.stringify(err.detail)}`);
});

// ---- L-41: aliased messages are visible under their channel ----
import { createUnifiedContactThread } from "../src/unified-contact-thread.mjs";

test("L-41: query({channel}) and markRead({channel}) surface channel-aliased messages", () => {
  const thread = createUnifiedContactThread();
  thread.addMessage({ channel: "email", channelMessageId: "e1", ts: 1000,
    direction: "inbound", from: "alice", body: "same-body" });
  thread.addMessage({ channel: "telegram", channelMessageId: "tg1", ts: 1001,
    direction: "inbound", from: "alice", body: "same-body" });
  assert.equal(thread.query({ channel: "telegram" }).length, 1);
  assert.equal(thread.markRead({ channel: "telegram" }), 1);
});

// ---- L-42: link-before-introduce is buffered, not dropped ----
import { assembleOutsideAgents, outsideAgentBody } from "../src/outside-agents.mjs";

test("L-42: a link arriving before its introduce is applied once the agent exists", () => {
  const linkMsg = {
    id: "m-link", authorId: "alice", at: Date.now(),
    body: outsideAgentBody({ v: 1, kind: "link", externalRef: "agent-1", memberId: "alice" }),
  };
  const introMsg = {
    id: "m-intro", authorId: "alice", at: Date.now(),
    body: outsideAgentBody({ v: 1, kind: "introduce", externalRef: "agent-1",
      displayName: "Agent One", origin: "room" }),
  };
  const agents = assembleOutsideAgents([linkMsg, introMsg], { alice: { active: true } });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].linkedMemberId, "alice");
});

// ---- L-43: concurrent same-token room.post calls share one backend post ----
import { createMcpPostWiring } from "../src/mcp-post-wiring.mjs";

test("L-43: concurrent posts with the same clientToken share one in-flight post", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const wiring = createMcpPostWiring({
    transport: {
      connect: async () => {}, disconnect: async () => {}, registerTool: () => {},
    },
    postBackend: async () => { calls += 1; await gate; return { messageId: "posted-1" }; },
  });
  await wiring.connect();
  try {
    const args = ["room.post", { channel: "c", text: "t" }, { agentId: "a", clientToken: "tok" }];
    const p1 = wiring.handleRequest(...args);
    const p2 = wiring.handleRequest(...args);
    // Both callers must attach to the in-flight slot before the backend settles.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(calls, 1);
    assert.deepEqual(r1, r2);
  } finally { await wiring.disconnect(); }
});

// ---- L-45: --print-cron line is shell-quoted (injection-safe) ----
// (dynamic import: shQuote was unexported pre-fix, so a static import would
// fail the whole file at load instead of this test alone)
test("L-45: shQuote makes hostile values inert inside single quotes", async () => {
  const { shQuote } = await import("../scripts/backup-verify.mjs");
  assert.equal(shQuote("a'b"), "'a'\\''b'");
  assert.equal(shQuote("plain"), "'plain'");
  assert.equal(shQuote("a$b`c\"d"), "'a$b`c\"d'");
});

test("L-45: --print-cron emits no unquoted hostile characters", async () => {
  const { stdout, code } = await runScript("scripts/backup-verify.mjs",
    ["--print-cron", "--db", "a'b", "--to", 'x";touch /tmp/lowd-pwned', "--schedule", "hourly"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("'a'\\''b'"), `db not quoted as expected:\n${stdout}`);
  assert.ok(!stdout.includes('"a\'b"'), `db appears double-quoted:\n${stdout}`);
});

// ---- L-46: room-templates is a recognized action again ----
test("L-46: 'room-templates' is accepted as a documented action (not usage_error)", async () => {
  const { stderr } = await runScript("scripts/agent-inbox.mjs", ["room-templates"],
    { env: { ROOM_AGENT_ORIGIN: "", ROOM_AGENT_ROOM: "", ROOM_AGENT_MEMBER: "", ROOM_AGENT_TOKEN: "" } });
  let diagnostic;
  try { diagnostic = JSON.parse(stderr.trim().split("\n").pop()); } catch { diagnostic = null; }
  assert.ok(diagnostic && diagnostic.code !== "usage_error",
    `room-templates must be a recognized action, got: ${stderr}`);
});

// ---- L-47: read-only commands must not write the onboarding state file ----
import { onboardMain } from "../scripts/agent-onboard.mjs";

test("L-47: checklist/status never rewrite the state file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lowd-l47-"));
  const statePath = join(dir, "state.json");
  try {
    const env = { ROOM_ONBOARD_STATE: statePath };
    const realEnv = process.env.ROOM_ONBOARD_STATE;
    process.env.ROOM_ONBOARD_STATE = statePath;
    try {
      await onboardMain(["start", "agent-9", "--name", "Nine"]);
    } finally {
      if (realEnv === undefined) delete process.env.ROOM_ONBOARD_STATE;
      else process.env.ROOM_ONBOARD_STATE = realEnv;
    }
    const fixed = new Date("2026-01-02T03:04:05.000Z");
    utimesSync(statePath, fixed, fixed);
    const before = statSync(statePath);
    process.env.ROOM_ONBOARD_STATE = statePath;
    try {
      await onboardMain(["checklist", "agent-9"]);
      await onboardMain(["status"]);
    } finally {
      if (realEnv === undefined) delete process.env.ROOM_ONBOARD_STATE;
      else process.env.ROOM_ONBOARD_STATE = realEnv;
    }
    const after = statSync(statePath);
    assert.equal(after.mtimeMs, before.mtimeMs, "read-only commands must not rewrite the state file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- L-48: a dead live host yields structured fetch_failed notes, not a throw ----
import { liveAudit } from "../scripts/live-audit.mjs";

test("L-48: liveAudit degrades to fetch_failed notes when every fetch throws", async () => {
  const result = await liveAudit({
    origin: "https://unreachable.invalid",
    fetchImpl: async () => { throw new Error("boom"); },
  });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.failures) && result.failures.length > 0);
  assert.ok(result.failures.some(f => f.code === "fetch_failed"),
    `expected fetch_failed notes, got ${JSON.stringify(result.failures)}`);
});

// ---- L-49: manifest fields are validated; hash walk is symlink-safe ----
import { readManifest, computeAssetHashes, buildManifest, writeManifest, sha256Hex } from "../scripts/deploy-checks.mjs";

test("L-49: readManifest rejects version/assetCount/hash-shape drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "lowd-l49-"));
  try {
    const manifestPath = join(dir, ".asset-hashes.json");
    writeManifest(manifestPath, buildManifest({ "a.js": sha256Hex("x") }));
    assert.doesNotThrow(() => readManifest(manifestPath));

    const tamper = (fn) => {
      const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      fn(raw);
      writeFileSync(manifestPath, JSON.stringify(raw));
    };
    tamper(raw => { raw.version = 2; });
    assert.throws(() => readManifest(manifestPath), /version/);
    tamper(raw => { raw.version = 1; raw.assetCount = 99; });
    assert.throws(() => readManifest(manifestPath), /assetCount/);
    tamper(raw => { raw.assetCount = 1; raw.assets["a.js"] = "not-a-hash"; });
    assert.throws(() => readManifest(manifestPath), /hash/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L-49: computeAssetHashes skips symlinks and paths escaping the root", () => {
  const dir = mkdtempSync(join(tmpdir(), "lowd-l49b-"));
  try {
    writeFileSync(join(dir, "real.js"), "content");
    symlinkSync(join(dir, "real.js"), join(dir, "link.js"));
    const { hashes, skipped } = computeAssetHashes(["real.js", "link.js", "../escape.js"], { root: dir });
    assert.ok(Object.hasOwn(hashes, "real.js"));
    assert.ok(!Object.hasOwn(hashes, "link.js"), "symlinks must not be followed");
    assert.ok(!Object.hasOwn(hashes, "../escape.js"), "root-escaping paths must be skipped");
    assert.ok(skipped.includes("link.js") && skipped.includes("../escape.js"),
      `expected link.js and ../escape.js in skipped, got ${JSON.stringify(skipped)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- L-50/L-51: legacy statuses union + paginated PR list (gh-stub integration) ----
test("L-50/L-51: a required check reported only as a legacy status counts as green; PR list uses --paginate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lowd-l5051-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = `#!/bin/bash
echo "$@" >> "$GH_STUB_LOG"
path="$2"
case "$path" in
  repos/Uuriko/project-room) echo '{"default_branch":"main"}' ;;
  repos/Uuriko/project-room/branches/main/protection) echo '{"required_status_checks":{"checks":[{"context":"legacy-check"}],"strict":false}}' ;;
  repos/Uuriko/project-room/rulesets) echo '[]' ;;
  "repos/Uuriko/project-room/pulls?state=open&base=main&per_page=100") echo '[{"number":7,"title":"legacy only","draft":false,"mergeable":true,"mergeable_state":"clean","head":{"sha":"abc123"}}]' ;;
  repos/Uuriko/project-room/pulls/7) echo '{"mergeable_state":"clean","mergeable":true,"draft":false,"head_sha":"abc123"}' ;;
  repos/Uuriko/project-room/commits/abc123/check-runs) echo '[]' ;;
  repos/Uuriko/project-room/commits/abc123/status) echo '[{"name":"legacy-check","state":"success"}]' ;;
  *) echo 'null' ;;
esac
`;
  writeFileSync(join(bin, "gh"), stub, { mode: 0o755 });
  try {
    const { stdout, code } = await runScript("scripts/merge-queue-dryrun.mjs", [], {
      env: { PATH: `${bin}:${process.env.PATH}`, GH_STUB_LOG: join(dir, "gh-argv.log") },
    });
    assert.equal(code, 0, `dry-run failed:\n${stdout}`);
    assert.ok(/\[READY\s*\]/.test(stdout),
      `PR green only via legacy status must be READY:\n${stdout}`);
    const argv = readFileSync(join(dir, "gh-argv.log"), "utf8");
    const pullsLine = argv.split("\n").find((line) => line.includes("pulls?state=open"));
    assert.ok(pullsLine && pullsLine.includes("--paginate"),
      `open-PR listing must use --paginate:\n${argv}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- L-52: ciPanel normalizes legacy StatusContext rows ----
// (dynamic import: ciPanel was module-private pre-fix)
test("L-52: ciPanel classifies legacy StatusContext rows via state, not CheckRun status/conclusion", async () => {
  const { ciPanel } = await import("../scripts/room-health.mjs");
  const prs = [
    { number: 1, title: "legacy green", statusCheckRollup: [
      { __typename: "StatusContext", state: "SUCCESS", context: "ci/legacy" },
    ] },
    { number: 2, title: "legacy red", statusCheckRollup: [
      { __typename: "StatusContext", state: "FAILURE", context: "ci/legacy" },
    ] },
    { number: 3, title: "legacy pending", statusCheckRollup: [
      { __typename: "StatusContext", state: "PENDING", context: "ci/legacy" },
    ] },
    { number: 4, title: "checkrun green", statusCheckRollup: [
      { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
    ] },
  ];
  const panel = ciPanel(prs);
  assert.equal(panel.pass, 2);
  assert.equal(panel.fail, 1);
  assert.equal(panel.pending, 1);
});

// ---- L-53: heartbeat/ack fetch is bounded by a 15s abort ----
import { pullOnce } from "../scripts/room-key-pull.mjs";

test("L-53: pullOnce aborts a stalled heartbeat fetch within ~15s", async () => {
  const realFetch = globalThis.fetch;
  let sawSignal = null;
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    sawSignal = opts?.signal ?? null;
    sawSignal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")));
  });
  try {
    await assert.rejects(
      Promise.race([
        pullOnce({ origin: "https://keys.invalid", token: "t", hostId: "h" }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("hang: no abort within 20s")), 20000)),
      ]),
      /abort/i,
    );
    assert.ok(sawSignal instanceof AbortSignal, "the fetch must receive an AbortSignal");
  } finally { globalThis.fetch = realFetch; }
});

// ---- G-L1: broadcast ack requests do not land in every inbox ----
import { projectActivity } from "../activity-inbox/src/project.js";

test("G-L1: an ack request without toMemberId is not an ack_needed row for an arbitrary viewer", () => {
  const { rows } = projectActivity({
    viewer: { memberId: "bob" },
    events: [{ id: "e1", type: "note.recorded", at: "2026-09-30T00:00:00Z",
      data: { ackNeeded: true, workItemId: "w1" } }],
  });
  assert.equal(rows.filter((r) => r.kind === "ack_needed").length, 0);
});

test("G-L1: an ack request addressed to the viewer still lands in their inbox", () => {
  const { rows } = projectActivity({
    viewer: { memberId: "bob" },
    events: [{ id: "e1", type: "note.recorded", at: "2026-09-30T00:00:00Z",
      data: { ackNeeded: true, toMemberId: "bob", workItemId: "w1" } }],
  });
  assert.equal(rows.filter((r) => r.kind === "ack_needed").length, 1);
});

// ---- G-L2: the retry disjunct requires the request to be open ----
// (dynamic import: isRequestEligible was extracted from the inline loop by the fix)
test("G-L2: closed requests are never eligible, even with a pending local delivery", async () => {
  const { isRequestEligible } = await import("../client/request-runner.mjs");
  assert.equal(isRequestEligible(
    { id: "r1", status: "closed" },
    { owned: true, runState: "result_ready", hasPendingDelivery: true }), false);
});

test("G-L2: open requests keep the old ownership/retry semantics", async () => {
  const { isRequestEligible } = await import("../client/request-runner.mjs");
  assert.equal(isRequestEligible(
    { id: "r1", status: "open" },
    { owned: false, runState: undefined, hasPendingDelivery: false }), true);
  assert.equal(isRequestEligible(
    { id: "r1", status: "open" },
    { owned: true, runState: "result_ready", hasPendingDelivery: true }), true);
  assert.equal(isRequestEligible(
    { id: "r1", status: "open" },
    { owned: true, runState: "needs_attention", hasPendingDelivery: true }), false);
});
