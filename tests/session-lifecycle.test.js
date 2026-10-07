// Worker-side session lifecycle (herdr redesign, lane B14), built to D2's design doc:
// ~/workspace/goals/project-room-herdr-redesign/phase2/design-docs/session-lifecycle.md
//
// - 7-state room-session machine: spawning → active ⇄ detached ⇄ reattaching,
//   suspended, draining, destroyed (+ transition timeouts, room-configurable)
// - Domain ops: spawnSession / attachSession / heartbeatSession / detachSession /
//   reattachSession / suspendSession / resumeSession / destroySession (+ reads)
// - Idempotency via herdr_session_journal (key → stored response, 24h TTL,
//   duplicate returns the stored response with duplicate:true, no herdr call)
// - Claim coupling: claim done/failed/released → draining → destroyed with grace;
//   session death never touches the claim (boundary law: herdr state never
//   settles claims)
// - Domain-error → HTTP mapping per D2 §2.9 (routes module)
//
// Fail-first: written before the implementation existed.
// Run: TMPDIR=~/workspace/pr-herdr-b14/.tmp node --test tests/session-lifecycle.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const T0 = 1_750_000_000_000;
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Static guards (run before the implementation import so failures are loud)
// ---------------------------------------------------------------------------

test("worker-safe: no node:net usage in lifecycle modules", () => {
  for (const f of ["server/session-lifecycle.mjs", "server/session-lifecycle-routes.mjs"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!/from\s+["']node:net["']/.test(src), `${f} must not import node:net`);
    assert.ok(!/require\(["']node:net["']\)/.test(src), `${f} must not require node:net`);
  }
});

test("boundary law: lifecycle modules never touch the claims board", () => {
  for (const f of ["server/session-lifecycle.mjs", "server/session-lifecycle-routes.mjs"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.ok(!/from\s+["']\.\/(work-claim|claim-)/.test(src), `${f} must not import claim modules`);
    assert.ok(!/require\(["']\.\/(work-claim|claim-)/.test(src), `${f} must not require claim modules`);
    assert.ok(!/INSERT INTO work_claims|UPDATE work_claims|DELETE FROM work_claims/.test(src),
      `${f} must never write work_claims rows`);
  }
});

const lifecycle = await import("../server/session-lifecycle.mjs");
const routes = await import("../server/session-lifecycle-routes.mjs");

const {
  createSessionLifecycle,
  SessionLifecycleError,
  VersionMismatchError,
  OccupantChangedError,
  TransportError,
  TimeoutError,
  ServerError,
  herdrLifecycleSchema,
  SESSION_STATES,
  DEFAULT_TIMEOUTS,
} = lifecycle;
const { handleSessionLifecycle } = routes;

// ---- Schema: the four §3 tables, D2-constrained ----
test("schema: creates the four §3 tables", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(herdrLifecycleSchema);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  for (const t of ["herdr_sessions", "herdr_session_journal", "herdr_lane_optin", "herdr_backend_state"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  db.close();
});

test("schema: is additive and re-runnable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(herdrLifecycleSchema);
  db.exec(herdrLifecycleSchema);
  db.close();
});

test("schema: journal carries idempotency_key + response_json for the dedupe store", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(herdrLifecycleSchema);
  const cols = db.prepare("PRAGMA table_info(herdr_session_journal)").all().map(c => c.name);
  for (const c of ["idempotency_key", "response_json", "transition", "created_at"]) {
    assert.ok(cols.includes(c), `journal missing column ${c}`);
  }
  const scols = db.prepare("PRAGMA table_info(herdr_sessions)").all().map(c => c.name);
  for (const c of ["state", "occupant_id", "pin_stale", "drain_reason", "drain_at", "consecutive_failures"]) {
    assert.ok(scols.includes(c), `herdr_sessions missing column ${c}`);
  }
  db.close();
});

test("SESSION_STATES is the 7-state machine", () => {
  assert.deepEqual([...SESSION_STATES].sort(),
    ["active", "destroyed", "detached", "draining", "reattaching", "spawning", "suspended"]);
});

test("DEFAULT_TIMEOUTS carries the proposed values (tunable, flagged in PR)", () => {
  assert.equal(DEFAULT_TIMEOUTS.spawnTimeoutMs, 30_000);
  assert.equal(DEFAULT_TIMEOUTS.reattachTimeoutMs, 60_000);
  assert.equal(DEFAULT_TIMEOUTS.destroyTimeoutMs, 60_000);
  assert.equal(DEFAULT_TIMEOUTS.heartbeatFailureBudget, 3);
  assert.equal(DEFAULT_TIMEOUTS.graceMs.claim_done, 15 * MIN);
  assert.equal(DEFAULT_TIMEOUTS.graceMs.claim_failed, 5 * MIN);
  assert.equal(DEFAULT_TIMEOUTS.graceMs.claim_released, 30 * MIN);
});

// ---- Harness ----
function unit(t, opts = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(herdrLifecycleSchema);
  let at = T0;
  const lc = createSessionLifecycle({ db, now: () => at }, opts);
  t.after(() => db.close());
  return { db, lc, advance: ms => { at += ms; }, at: () => at };
}

// Fake SessionAdapter (duck-typed against seam-design §2.2).
function fakeAdapter(seed = {}) {
  const panes = new Map(); // paneId -> { agentId, occupantId, alive }
  let n = 0;
  const calls = [];
  const fail = { ...(seed.fail ?? {}) };
  const api = {
    calls, panes,
    setFail(name, err) { fail[name] = err; },
    clearFail(name) { delete fail[name]; },
    async spawnAgent(o) {
      calls.push(["spawnAgent", o]);
      if (fail.spawnAgent) throw fail.spawnAgent;
      n += 1;
      const agentId = `ag-${n}`;
      const paneId = `pane-${n}`;
      panes.set(paneId, { agentId, occupantId: `occ-${agentId}`, alive: true });
      return { agentId, paneId };
    },
    async snapshot() {
      calls.push(["snapshot"]);
      if (fail.snapshot) throw fail.snapshot;
      return {
        workspaces: [{
          name: "ws", tabs: [{
            name: "tab",
            panes: [...panes.entries()].filter(([, p]) => p.alive)
              .map(([paneId, p]) => ({ paneId, agentId: p.agentId })),
          }],
        }],
      };
    },
    async getAgent(agentId) {
      calls.push(["getAgent", agentId]);
      if (fail.getAgent) throw fail.getAgent;
      for (const p of panes.values()) {
        if (p.agentId === agentId && p.alive) return { agentId, occupantId: p.occupantId, state: "running" };
      }
      const e = new ServerError(`agent ${agentId} not found`);
      e.code = "agent_not_found";
      throw e;
    },
    async closePane(paneId) {
      calls.push(["closePane", paneId]);
      if (fail.closePane) throw fail.closePane;
      const p = panes.get(paneId);
      if (!p || !p.alive) {
        const e = new ServerError(`pane ${paneId} not found`);
        e.code = "pane_not_found";
        throw e;
      }
      p.alive = false;
    },
    async ping() {
      calls.push(["ping"]);
      if (fail.ping) throw fail.ping;
      return { ok: true, protocolVersion: 22, herdrVersion: "0.14.2" };
    },
    async reportState(paneId, state, detail) {
      calls.push(["reportState", paneId, state, detail]);
      if (fail.reportState) throw fail.reportState;
    },
    // test-only helpers
    _killPane(paneId) { panes.get(paneId).alive = false; },
    _swapOccupant(paneId, occupantId) { panes.get(paneId).occupantId = occupantId; },
  };
  return api;
}

const spawnReq = (over = {}) => ({
  idempotencyKey: "claim:clm-9:spawn:attempt-1",
  claimId: "clm-9",
  laneMemberId: "member-1",
  tenantId: "tenant-1",
  kind: "claude",
  cwd: "/tmp/work",
  workspace: "ws-1",
  title: "lane worker",
  metadata: { lane: "b14" },
  ...over,
});

const fastTimeouts = {
  spawnTimeoutMs: 500, reattachTimeoutMs: 500, destroyTimeoutMs: 500,
  confirmPollMs: 10, heartbeatFailureBudget: 3,
};

function journalEvents(db, sessionId) {
  return db.prepare(
    "SELECT event, idempotency_key, transition FROM herdr_session_journal WHERE session_id = ? ORDER BY journal_id"
  ).all(sessionId);
}

// ---- spawnSession ----
test("spawnSession: spawning → active when the pane confirms", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const res = await lc.spawnSession(spawnReq());
  assert.equal(res.state, "active");
  assert.equal(res.duplicate, false);
  assert.ok(res.sessionId.length >= 8);
  assert.equal(res.paneId, "pane-1");
  assert.equal(res.agentId, "ag-1");
  assert.equal(res.occupantId, "occ-ag-1");
  // adapter got the spec-shaped spawn (kind-driven, resume passthrough)
  const [, opts] = a.calls.find(c => c[0] === "spawnAgent");
  assert.equal(opts.kind, "claude");
  assert.equal(opts.workspace, "ws-1");
  const info = await lc.getSession(res.sessionId);
  assert.equal(info.state, "active");
  assert.equal(info.claimId, "clm-9");
  assert.equal(info.laneMemberId, "member-1");
  assert.equal(info.backend, "herdr");
  assert.deepEqual(journalEvents(db, res.sessionId).map(r => r.event), ["spawn"]);
});

test("spawnSession: requires idempotencyKey (422)", async t => {
  const { lc } = unit(t, { adapter: fakeAdapter(), timeouts: fastTimeouts });
  const bad = spawnReq(); delete bad.idempotencyKey;
  await assert.rejects(() => lc.spawnSession(bad),
    err => err instanceof SessionLifecycleError && err.status === 422 && err.code === "invalid_lifecycle_input");
});

test("spawnSession: duplicate key returns the stored response byte-for-byte, no herdr call", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const first = await lc.spawnSession(spawnReq());
  const spawnCalls = a.calls.filter(c => c[0] === "spawnAgent").length;
  const second = await lc.spawnSession(spawnReq());
  assert.equal(second.duplicate, true);
  assert.equal(a.calls.filter(c => c[0] === "spawnAgent").length, spawnCalls);
  const { duplicate: d1, ...rest1 } = first;
  const { duplicate: d2, ...rest2 } = second;
  assert.deepEqual(rest2, rest1); // byte-identical apart from the flag
  assert.equal(d1, false); assert.equal(d2, true);
});

test("spawnSession: key reuse across transitions is rejected (422)", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq());
  await assert.rejects(
    () => lc.detachSession({ idempotencyKey: "claim:clm-9:spawn:attempt-1", sessionId: s.sessionId, reason: "operator" }),
    err => err.status === 422 && err.code === "idempotency_key_transition_mismatch");
});

test("spawnSession: dedupe entries expire after the 24h TTL", async t => {
  const a = fakeAdapter();
  const { lc, advance } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const first = await lc.spawnSession(spawnReq());
  advance(24 * 3600_000 + 1);
  const second = await lc.spawnSession(spawnReq()); // same key, TTL expired → new spawn
  assert.equal(second.duplicate, false);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(a.calls.filter(c => c[0] === "spawnAgent").length, 2);
});

test("spawnSession: spawn-confirm timeout → destroyed, partial pane NOT speculatively killed", async t => {
  const a = fakeAdapter();
  a.setFail("snapshot", new TimeoutError("snapshot hung"));
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  await assert.rejects(() => lc.spawnSession(spawnReq({ idempotencyKey: "k-timeout" })),
    err => err instanceof TimeoutError);
  const sessionId = db.prepare("SELECT session_id FROM herdr_sessions WHERE claim_id = 'clm-9'").get().session_id;
  const row = db.prepare("SELECT state, pane_id FROM herdr_sessions WHERE session_id = ?").get(sessionId);
  assert.equal(row.state, "destroyed");
  // Deviation from D2 T1's "partial pane must be closed", flagged in the PR:
  // the pane may be perfectly healthy (only the confirm hung); killing it would
  // destroy a live agent. The pane is left alone, its ids journaled for the
  // operator, and a same-key retry re-attaches to it (next test).
  assert.equal(a.panes.get(row.pane_id).alive, true);
  assert.ok(journalEvents(db, sessionId).some(r => r.event === "spawn_failed"));
  const failed = db.prepare("SELECT detail_json FROM herdr_session_journal WHERE session_id = ? AND event = 'spawn_failed'").get(sessionId);
  assert.equal(JSON.parse(failed.detail_json).paneId, row.pane_id);
});

test("spawnSession: retry on the same key re-attaches to the partial pane, never spawns twice", async t => {
  const a = fakeAdapter();
  let failSnapshot = true;
  const origSnapshot = a.snapshot.bind(a);
  a.snapshot = async (...args) => {
    if (failSnapshot) throw new TimeoutError("confirm hangs — bridge blip");
    return origSnapshot(...args);
  };
  const { lc } = unit(t, { adapter: a, timeouts: { ...fastTimeouts, spawnTimeoutMs: 120 } });
  await assert.rejects(() => lc.spawnSession(spawnReq({ idempotencyKey: "k-retry" })), err => err instanceof TimeoutError);
  failSnapshot = false; // the blip is over; the partial pane is still alive
  const retry = await lc.spawnSession(spawnReq({ idempotencyKey: "k-retry" }));
  assert.equal(retry.state, "active");
  assert.equal(retry.duplicate, false);
  assert.equal(a.calls.filter(c => c[0] === "spawnAgent").length, 1); // still one pane
  assert.equal(retry.paneId, "pane-1");
});

test("spawnSession: adapter TransportError → 503 session_backend_unavailable + spawn_fallback_legacy journal", async t => {
  const a = fakeAdapter();
  a.setFail("spawnAgent", new TransportError("socket refused"));
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  await assert.rejects(() => lc.spawnSession(spawnReq()),
    err => err instanceof SessionLifecycleError && err.status === 503 && err.code === "session_backend_unavailable");
  const fb = db.prepare("SELECT * FROM herdr_session_journal WHERE event = 'spawn_fallback_legacy'").all();
  assert.equal(fb.length, 1);
  const health = await lc.getBackendState();
  assert.equal(health.reachable, 0);
});

test("spawnSession: allowlist deny (ServerError, non-retriable) is stored — replay re-raises", async t => {
  const a = fakeAdapter();
  const deny = new ServerError("kind not allowlisted"); deny.code = "allowlist_deny"; deny.retriable = false;
  a.setFail("spawnAgent", deny);
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  await assert.rejects(() => lc.spawnSession(spawnReq({ idempotencyKey: "k-deny" })), err => err instanceof ServerError);
  await assert.rejects(() => lc.spawnSession(spawnReq({ idempotencyKey: "k-deny" })), err => err instanceof ServerError);
  assert.equal(a.calls.filter(c => c[0] === "spawnAgent").length, 1);
});

test("spawnSession: no adapter configured → 503 (fail closed)", async t => {
  const { lc } = unit(t, { timeouts: fastTimeouts });
  await assert.rejects(() => lc.spawnSession(spawnReq()),
    err => err.status === 503 && err.code === "session_backend_unavailable");
});

// ---- attachSession ----
test("attachSession: adopts a detached session for a live claim → reattaching → active", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, {
    adapter: a, timeouts: fastTimeouts,
    claimReader: { isLiveClaim: id => id === "clm-10" },
  });
  const s = await lc.spawnSession(spawnReq({ claimId: "clm-9", idempotencyKey: "k1" }));
  await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "lane_request" });
  const res = await lc.attachSession({
    idempotencyKey: "session:x:attach:1", sessionId: s.sessionId,
    claimId: "clm-10", laneMemberId: "member-2", verifyOccupant: true,
  });
  assert.equal(res.state, "active");
  assert.equal(res.resumed, false);
  assert.equal(res.duplicate, false);
  assert.equal((await lc.getSession(s.sessionId)).claimId, "clm-10");
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "attach"));
});

test("attachSession: claim not live → 409 claim_not_live", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, {
    adapter: a, timeouts: fastTimeouts,
    claimReader: { isLiveClaim: () => false },
  });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "lane_request" });
  await assert.rejects(
    () => lc.attachSession({ idempotencyKey: "k-att", sessionId: s.sessionId, claimId: "dead-claim", laneMemberId: "m" }),
    err => err.status === 409 && err.code === "claim_not_live");
});

test("attachSession: occupant mismatch without re-pin → OccupantChangedError, stays detached", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "lane_request" });
  a._swapOccupant(s.paneId, "occ-impostor");
  await assert.rejects(
    () => lc.attachSession({ idempotencyKey: "k-att", sessionId: s.sessionId, claimId: "clm-9", laneMemberId: "m" }),
    err => err instanceof OccupantChangedError);
  assert.equal((await lc.getSession(s.sessionId)).state, "detached");
});

test("attachSession: raw paneId adoption (migration path)", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const handle = await a.spawnAgent({ kind: "codex" }); // pane exists outside any room session
  const res = await lc.attachSession({
    idempotencyKey: "k-mig", paneId: handle.paneId,
    claimId: "clm-9", laneMemberId: "member-1", verifyOccupant: true,
  });
  assert.equal(res.state, "active");
  assert.equal(res.paneId, handle.paneId);
  assert.equal((await lc.getSession(res.sessionId)).claimId, "clm-9");
});

test("attachSession: idempotent on the same key", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "lane_request" });
  const args = { idempotencyKey: "k-att", sessionId: s.sessionId, claimId: "clm-9", laneMemberId: "member-1" };
  const first = await lc.attachSession(args);
  const second = await lc.attachSession(args);
  assert.equal(second.duplicate, true);
  assert.equal(second.sessionId, first.sessionId);
});

// ---- heartbeatSession ----
test("heartbeatSession: ok beat updates lastHeartbeatAt, returns occupantOk:true", async t => {
  const a = fakeAdapter();
  const { lc, db, advance } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  advance(30_000);
  const res = await lc.heartbeatSession({ sessionId: s.sessionId, occupantId: s.occupantId, reportedAgentState: "working" });
  assert.equal(res.state, "active");
  assert.equal(res.occupantOk, true);
  assert.ok(res.serverTimeMs > 0);
  const info = await lc.getSession(s.sessionId);
  assert.equal(info.lastAgentState, "working");
  assert.ok(new Date(info.lastHeartbeatAt).getTime() > new Date(info.createdAt).getTime());
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "heartbeat"));
});

test("heartbeatSession: occupant mismatch → occupantOk:false, pin marked stale, session stays active", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  const res = await lc.heartbeatSession({ sessionId: s.sessionId, occupantId: "occ-impostor" });
  assert.equal(res.occupantOk, false);
  assert.equal(res.state, "active"); // pane fine; the pin is stale
  assert.equal((await lc.isDrivable(s.sessionId)).drivable, false);
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "heartbeat_occupant_mismatch"));
});

test("heartbeatSession: 3 consecutive adapter failures → detached (T2), claim untouched", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  a.setFail("ping", new TransportError("bridge down"));
  for (let i = 0; i < 2; i++) {
    const r = await lc.heartbeatSession({ sessionId: s.sessionId, occupantId: s.occupantId });
    assert.equal(r.state, "active");
  }
  const third = await lc.heartbeatSession({ sessionId: s.sessionId, occupantId: s.occupantId });
  assert.equal(third.state, "detached");
  assert.equal((await lc.getSession(s.sessionId)).state, "detached");
  assert.equal((await lc.getSession(s.sessionId)).claimId, "clm-9"); // claim untouched
  const events = journalEvents(db, s.sessionId).map(r => r.event);
  assert.ok(events.filter(e => e === "heartbeat_failed").length === 3);
  assert.ok(events.includes("detach"));
  // recovery resets the budget
  a.clearFail("ping");
  await lc.reattachSession({ idempotencyKey: "k-rea", sessionId: s.sessionId });
  const ok = await lc.heartbeatSession({ sessionId: s.sessionId, occupantId: s.occupantId });
  assert.equal(ok.state, "active");
});

test("heartbeatSession: unknown session → 404", async t => {
  const { lc } = unit(t, { adapter: fakeAdapter(), timeouts: fastTimeouts });
  await assert.rejects(() => lc.heartbeatSession({ sessionId: "nope", occupantId: "x" }),
    err => err.status === 404 && err.code === "session_not_found");
});

// ---- detachSession ----
test("detachSession: active → detached with reason, idempotent", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  const res = await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "operator" });
  assert.deepEqual({ sessionId: res.sessionId, state: res.state, duplicate: res.duplicate },
    { sessionId: s.sessionId, state: "detached", duplicate: false });
  const again = await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "operator" });
  assert.equal(again.duplicate, true);
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "detach"));
});

// ---- reattachSession ----
test("reattachSession: detached → reattaching → active when occupant re-verifies", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "bridge_health" });
  const res = await lc.reattachSession({ idempotencyKey: "k-rea", sessionId: s.sessionId });
  assert.equal(res.state, "active");
  assert.equal(res.occupantChanged, false);
  assert.equal(res.resumed, false);
  assert.equal(res.occupantId, s.occupantId);
});

test("reattachSession: pane gone + stored resume ref → new pane via native --resume, journal pane_replaced_after_restart", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({
    idempotencyKey: "k1", resumeSessionRef: "cli-sess-1", resumeCommand: ["claude", "--resume", "cli-sess-1"],
  }));
  await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "bridge_health" });
  a._killPane(s.paneId); // herdr restarted, pane did not come back
  const res = await lc.reattachSession({ idempotencyKey: "k-rea", sessionId: s.sessionId });
  assert.equal(res.state, "active");
  assert.equal(res.resumed, true);
  assert.notEqual(res.paneId, s.paneId);
  const [, spawnOpts] = a.calls.filter(c => c[0] === "spawnAgent").at(-1);
  assert.deepEqual(spawnOpts.resumeCommand, ["claude", "--resume", "cli-sess-1"]); // native resume, never transcript replay
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "pane_replaced_after_restart"));
});

test("reattachSession: occupant changed without forceRepin → OccupantChangedError, stays detached", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "bridge_health" });
  a._swapOccupant(s.paneId, "occ-stranger");
  await assert.rejects(() => lc.reattachSession({ idempotencyKey: "k-rea", sessionId: s.sessionId }),
    err => err instanceof OccupantChangedError);
  assert.equal((await lc.getSession(s.sessionId)).state, "detached");
  // operator-authorized re-pin succeeds
  const forced = await lc.reattachSession({ idempotencyKey: "k-rea2", sessionId: s.sessionId, forceRepin: true });
  assert.equal(forced.state, "active");
  assert.equal(forced.occupantChanged, true);
  assert.equal(forced.occupantId, "occ-stranger");
});

// ---- suspend / resume ----
test("suspendSession / resumeSession: active ⇄ suspended", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  const sus = await lc.suspendSession({ idempotencyKey: "k-sus", sessionId: s.sessionId, reason: "lane_request" });
  assert.equal(sus.state, "suspended");
  assert.equal(sus.duplicate, false);
  const re = await lc.resumeSession({ idempotencyKey: "k-res", sessionId: s.sessionId });
  assert.equal(re.state, "active"); // resume reuses the reattach shapes
  assert.equal(re.occupantChanged, false);
  const events = journalEvents(db, s.sessionId).map(r => r.event);
  assert.ok(events.includes("suspend"));
});

// ---- destroySession (two-phase) ----
test("destroySession: first call → draining with grace; pane kept until grace elapses", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  const res = await lc.destroySession({
    idempotencyKey: "session:x:destroy:claim_done-1", sessionId: s.sessionId, reason: "claim_done",
  });
  assert.equal(res.state, "draining");
  assert.equal(res.paneClosed, false);
  assert.equal(res.duplicate, false);
  assert.equal(a.panes.get(s.paneId).alive, true); // pane kept through grace
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "drain_start"));
});

test("destroySession: fresh key while draining converges (no double-schedule)", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.destroySession({ idempotencyKey: "k-d1", sessionId: s.sessionId, reason: "claim_done" });
  const again = await lc.destroySession({ idempotencyKey: "k-d2", sessionId: s.sessionId, reason: "claim_done" });
  assert.equal(again.state, "draining");
  assert.equal(again.duplicate, false);
});

test("destroySession: after grace, completeDestroy closes the pane → destroyed", async t => {
  const a = fakeAdapter();
  const { lc, db, advance } = unit(t, {
    adapter: a,
    timeouts: { ...fastTimeouts, graceMs: { ...DEFAULT_TIMEOUTS.graceMs, claim_done: 50 } },
  });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.destroySession({ idempotencyKey: "k-d1", sessionId: s.sessionId, reason: "claim_done" });
  advance(49);
  const early = await lc.completeDestroy(s.sessionId);
  assert.equal(early.state, "draining"); // grace not elapsed
  advance(2);
  const done = await lc.completeDestroy(s.sessionId);
  assert.equal(done.state, "destroyed");
  assert.equal(done.paneClosed, true);
  assert.equal(a.panes.get(s.paneId).alive, false);
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "destroyed"));
});

test("destroySession: pane already gone → destroyed immediately, paneClosed:false", async t => {
  const a = fakeAdapter();
  const { lc, advance } = unit(t, {
    adapter: a,
    timeouts: { ...fastTimeouts, graceMs: { ...DEFAULT_TIMEOUTS.graceMs, claim_failed: 50 } },
  });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.destroySession({ idempotencyKey: "k-d1", sessionId: s.sessionId, reason: "claim_failed" });
  a._killPane(s.paneId);
  advance(60);
  const done = await lc.completeDestroy(s.sessionId);
  assert.equal(done.state, "destroyed");
  assert.equal(done.paneClosed, false);
});

test("destroySession: close failure keeps draining + journals destroy_retry (never destroyed on timeout alone)", async t => {
  const a = fakeAdapter();
  const { lc, db, advance } = unit(t, {
    adapter: a,
    timeouts: { ...fastTimeouts, graceMs: { ...DEFAULT_TIMEOUTS.graceMs, claim_done: 50 } },
  });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.destroySession({ idempotencyKey: "k-d1", sessionId: s.sessionId, reason: "claim_done" });
  a.setFail("closePane", new TimeoutError("close hung"));
  advance(60);
  const still = await lc.completeDestroy(s.sessionId);
  assert.equal(still.state, "draining");
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "destroy_retry"));
});

// ---- claim coupling ----
test("onClaimEvent done: session → draining with the claim_done grace; claim row untouched by us", async t => {
  const a = fakeAdapter();
  const { lc, db, advance } = unit(t, {
    adapter: a,
    timeouts: { ...fastTimeouts, graceMs: { ...DEFAULT_TIMEOUTS.graceMs, claim_done: 50 } },
  });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  const affected = await lc.onClaimEvent({ claimId: "clm-9", event: "done" });
  assert.equal(affected.length, 1);
  assert.equal(affected[0].state, "draining");
  assert.equal((await lc.getSession(s.sessionId)).state, "draining");
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "drain_start"));
  advance(60);
  const done = await lc.completeDestroy(s.sessionId);
  assert.equal(done.state, "destroyed");
});

test("onClaimEvent released: 30min grace, pane kept alive for warm adoption", async t => {
  const a = fakeAdapter();
  const { lc, advance } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.onClaimEvent({ claimId: "clm-9", event: "released" });
  const row = (await lc.getSession(s.sessionId));
  assert.equal(row.state, "draining");
  advance(29 * MIN);
  assert.equal((await lc.completeDestroy(s.sessionId)).state, "draining");
  advance(2 * MIN);
  assert.equal((await lc.completeDestroy(s.sessionId)).state, "destroyed");
});

test("claim released then reclaimed: new live claim adopts the draining session, destroy cancelled", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, {
    adapter: a, timeouts: fastTimeouts,
    claimReader: { isLiveClaim: id => id === "clm-11" },
  });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.onClaimEvent({ claimId: "clm-9", event: "released" });
  assert.equal((await lc.getSession(s.sessionId)).state, "draining");
  // Warm adoption: the new claimer attaches the draining session directly.
  const adopted = await lc.attachSession({
    idempotencyKey: "k-adopt", sessionId: s.sessionId,
    claimId: "clm-11", laneMemberId: "member-9", verifyOccupant: true,
  });
  assert.equal(adopted.state, "active");
  const info = await lc.getSession(s.sessionId);
  assert.equal(info.claimId, "clm-11");
  assert.equal(a.panes.get(info.paneId).alive, true); // pane adopted, never closed
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "destroy_cancelled_adopted"));
});

test("onClaimEvent: claim terminal while detached → draining recorded, no speculative kill", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.detachSession({ idempotencyKey: "k-det", sessionId: s.sessionId, reason: "bridge_health" });
  await lc.onClaimEvent({ claimId: "clm-9", event: "failed" });
  const info = await lc.getSession(s.sessionId);
  assert.equal(info.state, "draining");
  // pane fate unknown → completeDestroy defers, never marks destroyed alone
  const res = await lc.completeDestroy(s.sessionId);
  assert.equal(res.state, "draining");
});

test("onSessionLost: journals only — claim and session state untouched (boundary law)", async t => {
  const a = fakeAdapter();
  const { lc, db } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.onSessionLost(s.sessionId, { reason: "pane_exited" });
  assert.equal((await lc.getSession(s.sessionId)).state, "active");
  assert.equal((await lc.getSession(s.sessionId)).claimId, "clm-9");
  assert.ok(journalEvents(db, s.sessionId).some(r => r.event === "session_lost"));
});

// ---- lane opt-in / backend health ----
test("lane opt-in: set/get round-trips the herdr marker", async t => {
  const { lc } = unit(t);
  const out = await lc.setLaneOptIn({ laneId: "lane-7", roomId: "room-1", setBy: "member-1", backend: "herdr" });
  assert.equal(out.sessionBackend, "herdr");
  assert.equal((await lc.getLaneOptIn("lane-7")).setBy, "member-1");
  assert.equal(await lc.getLaneOptIn("nope"), null);
});

test("recordBackendHealth: reachable/flap bookkeeping", async t => {
  const { lc } = unit(t);
  await lc.recordBackendHealth({ reachable: true });
  assert.equal((await lc.getBackendState()).reachable, 1);
  await lc.recordBackendHealth({ reachable: false, errorCode: "timeout", errorMessage: "hung" });
  const s = await lc.getBackendState();
  assert.equal(s.reachable, 0);
  assert.equal(s.lastErrorCode, "timeout");
});

// ---- reads ----
test("listSessions: filters + room-standard cursor pagination", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  await lc.spawnSession(spawnReq({ claimId: "c1", laneMemberId: "m1", idempotencyKey: "a" }));
  await lc.spawnSession(spawnReq({ claimId: "c2", laneMemberId: "m1", idempotencyKey: "b" }));
  const c = await lc.spawnSession(spawnReq({ claimId: "c3", laneMemberId: "m2", idempotencyKey: "c" }));
  await lc.detachSession({ idempotencyKey: "d", sessionId: c.sessionId, reason: "operator" });
  assert.equal((await lc.listSessions({ laneMemberId: "m1" })).sessions.length, 2);
  assert.equal((await lc.listSessions({ claimId: "c3" })).sessions.length, 1);
  assert.equal((await lc.listSessions({ state: "detached" })).sessions.length, 1);
  const p1 = await lc.listSessions({ limit: 2 });
  assert.equal(p1.sessions.length, 2);
  assert.equal(p1.hasMore, true);
  const p2 = await lc.listSessions({ limit: 2, after: p1.next });
  assert.equal(p2.sessions.length, 1);
  assert.equal(p2.hasMore, false);
});

test("sessionJournal: paginates with limit/after", async t => {
  const a = fakeAdapter();
  const { lc } = unit(t, { adapter: a, timeouts: fastTimeouts });
  const s = await lc.spawnSession(spawnReq({ idempotencyKey: "k1" }));
  await lc.heartbeatSession({ sessionId: s.sessionId, occupantId: s.occupantId });
  await lc.heartbeatSession({ sessionId: s.sessionId, occupantId: s.occupantId });
  const p1 = await lc.sessionJournal(s.sessionId, { limit: 2 });
  assert.equal(p1.entries.length, 2);
  const p2 = await lc.sessionJournal(s.sessionId, { after: p1.entries[1].journalId });
  assert.equal(p2.entries.length, 1);
  assert.equal(p2.entries[0].event, "heartbeat");
});

// ---------------------------------------------------------------------------
// Routes — REST shapes per D2, domain-error → HTTP mapping per D2 §2.9.
// Unmounted: http.mjs wiring is the integration step's job.
// ---------------------------------------------------------------------------

function routeHarness(t, opts = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(herdrLifecycleSchema);
  let at = T0;
  const adapter = opts.adapter === undefined ? fakeAdapter() : opts.adapter;
  const lifecycle = createSessionLifecycle({ db, now: () => at }, { adapter, timeouts: fastTimeouts, ...opts.lcOpts });
  const res = {};
  const helpers = {
    json: (_res, status, payload) => { res.status = status; res.payload = payload; return payload; },
    reject: (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; },
    body: async req => req.body,
  };
  t.after(() => db.close());
  const call = (route, { method = "GET", id = null, body: b = undefined, roomId = "room-1", member = "member-1", params = "" } = {}) =>
    handleSessionLifecycle({
      req: { method, body: b }, res,
      url: new URL(`https://x.test/api/rooms/${roomId}/herdr-sessions${params}`),
      store: { db, now: () => at }, roomId,
      auth: { member: { id: member } },
      lifecycleRoute: route, lifecycleId: id, helpers, lifecycle,
    }).then(() => ({ ...res }));
  return { call, lifecycle, adapter, advance: ms => { at += ms; } };
}

const createBody = (over = {}) => ({
  idempotencyKey: "rk1", claimId: "clm-9", laneMemberId: "member-1",
  tenantId: "tenant-1", kind: "claude", ...over,
});

test("routes: POST create → 201 (duplicate:false); replay → 200 (duplicate:true)", async t => {
  const { call } = routeHarness(t);
  const first = await call("create", { method: "POST", body: createBody() });
  assert.equal(first.status, 201);
  assert.equal(first.payload.session.duplicate, false);
  assert.equal(first.payload.session.state, "active");
  assert.equal(first.payload.roomId, "room-1");
  const second = await call("create", { method: "POST", body: createBody() });
  assert.equal(second.status, 200);
  assert.equal(second.payload.session.duplicate, true);
  assert.equal(second.payload.session.sessionId, first.payload.session.sessionId);
});

test("routes: POST create rejects laneMemberId != caller → 403", async t => {
  const { call } = routeHarness(t);
  await assert.rejects(
    call("create", { method: "POST", body: createBody({ laneMemberId: "someone-else" }) }),
    err => err.status === 403 && err.code === "session_not_owner");
});

test("routes: POST create with no adapter → 503 herdr_version_mismatch-free unavailable", async t => {
  const { call } = routeHarness(t, { adapter: null });
  await assert.rejects(
    call("create", { method: "POST", body: createBody() }),
    err => err.status === 503 && err.code === "session_backend_unavailable");
});

test("routes: VersionMismatchError → 503 herdr_version_mismatch", async t => {
  const a = fakeAdapter();
  a.setFail("spawnAgent", new VersionMismatchError("protocol 21 != pinned 22"));
  const { call } = routeHarness(t, { adapter: a });
  await assert.rejects(
    call("create", { method: "POST", body: createBody() }),
    err => err.status === 503 && err.code === "herdr_version_mismatch");
});

test("routes: adapter TransportError on spawn → 503 session_backend_unavailable (legacy fallback, not 502)", async t => {
  // Deliberate deviation from the D2 §2.9 table's generic TransportError →
  // 502/504 row, flagged in the PR: at spawn time no session exists, so the
  // honest signal is 503 + the compat-plan §3.4 legacy-fallback contract
  // (D2 §2.1: TransportError on spawn "falls back to legacy") — not a
  // retryable 502 inviting blind retries against a down bridge.
  const a = fakeAdapter();
  a.setFail("spawnAgent", new TransportError("socket refused"));
  const { call } = routeHarness(t, { adapter: a });
  await assert.rejects(
    call("create", { method: "POST", body: createBody() }),
    err => err.status === 503 && err.code === "session_backend_unavailable");
});

test("routes: GET list / GET item / GET journal round-trip", async t => {
  const { call } = routeHarness(t);
  const created = await call("create", { method: "POST", body: createBody() });
  const id = created.payload.session.sessionId;
  const list = await call("list", { params: "?state=active" });
  assert.equal(list.status, 200);
  assert.equal(list.payload.sessions.length, 1);
  assert.equal(list.payload.hasMore, false);
  const item = await call("item", { id });
  assert.equal(item.payload.session.sessionId, id);
  await assert.rejects(call("item", { id: "nope" }), err => err.status === 404 && err.code === "session_not_found");
  const journal = await call("journal", { id });
  assert.ok(journal.payload.entries.some(e => e.event === "spawn"));
});

test("routes: full transition lifecycle over HTTP", async t => {
  const { call, advance } = routeHarness(t);
  const created = await call("create", { method: "POST", body: createBody() });
  const id = created.payload.session.sessionId;
  const hb = await call("heartbeat", { method: "POST", id, body: { occupantId: created.payload.session.occupantId, reportedAgentState: "working" } });
  assert.equal(hb.payload.occupantOk, true);
  const det = await call("detach", { method: "POST", id, body: { idempotencyKey: "rd1", reason: "operator" } });
  assert.equal(det.payload.session.state, "detached");
  const rea = await call("reattach", { method: "POST", id, body: { idempotencyKey: "rr1" } });
  assert.equal(rea.payload.session.state, "active");
  const sus = await call("suspend", { method: "POST", id, body: { idempotencyKey: "rs1", reason: "lane_request" } });
  assert.equal(sus.payload.session.state, "suspended");
  const res = await call("resume", { method: "POST", id, body: { idempotencyKey: "rr2" } });
  assert.equal(res.payload.session.state, "active");
  const des = await call("destroy", { method: "POST", id, body: { idempotencyKey: "rx1", reason: "claim_done", graceMs: 1 } });
  assert.equal(des.payload.session.state, "draining");
  advance(5);
  // Same-key follow-up after grace elapses completes the two-phase close
  // (D2 §2.7); a fresh key would converge on the draining record instead.
  const fin = await call("destroy", { method: "POST", id, body: { idempotencyKey: "rx1", reason: "claim_done" } });
  assert.equal(fin.payload.session.state, "destroyed"); // follow-up completes the two-phase close
  assert.equal(fin.payload.session.paneClosed, true);
});

test("routes: attach to another member's session → 403", async t => {
  const { call } = routeHarness(t);
  const created = await call("create", { method: "POST", body: createBody() });
  const id = created.payload.session.sessionId;
  await call("detach", { method: "POST", id, body: { idempotencyKey: "rd1", reason: "operator" } });
  await assert.rejects(
    call("attach", { method: "POST", id, member: "member-2", body: { idempotencyKey: "ra1", claimId: "clm-9" } }),
    err => err.status === 403 && err.code === "session_not_owner");
});

test("routes: unknown route → 404 lifecycle_unknown_route", async t => {
  const { call } = routeHarness(t);
  await assert.rejects(call("bogus", {}), err => err.status === 404 && err.code === "lifecycle_unknown_route");
});

test("routes: strict body shapes — unknown keys rejected (422)", async t => {
  const { call } = routeHarness(t);
  await assert.rejects(
    call("create", { method: "POST", body: { ...createBody(), bogus: 1 } }),
    err => err.status === 422 && err.code === "invalid_lifecycle_input");
});
