// herdr redesign — Phase-A gate: legacy ↔ herdr parity suite (lane B9).
//
// The scripted scenario (claim → session → heartbeat → blocked → done) runs
// TWICE — once against the legacy session backend, once against the
// SessionAdapter contract (B2's real `server/session-adapter.mjs`
// `InMemorySessionAdapter`). The suite asserts IDENTICAL room-observable
// outcomes: claim states, journal entries, API response shapes (session
// card, claim card, heartbeat presence record), and event sequences.
// Any divergence is a test failure with a diff.
//
// Pure test lane: no production code is touched. Deterministic virtual
// clock shared by both runs — timestamps must match exactly, no
// normalization.
import test from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "./herdr-parity/parity-scenario.mjs";
import { compareTraces } from "./herdr-parity/parity-compare.mjs";
import { createLegacyDriver } from "./herdr-parity/legacy-driver.mjs";
import { createHerdrDriver } from "./herdr-parity/herdr-driver.mjs";
import {
  createSessionAdapter,
  VersionMismatchError,
  OccupantChangedError,
  AGENT_STATES,
  INMEMORY_PROTOCOL_VERSION,
} from "../server/session-adapter.mjs";

test("parity: claim → session → heartbeat → blocked → done is identical across backends", async () => {
  const legacy = await runScenario(createLegacyDriver);
  const herdr = await runScenario(createHerdrDriver);
  assert.equal(legacy.backend, "legacy");
  assert.equal(herdr.backend, "herdr");
  const diffs = compareTraces(legacy, herdr);
  assert.deepEqual(diffs, [], `parity divergences:\n${diffs.join("\n")}`);
});

test("parity: the scenario emits the expected room-observable event sequence", async () => {
  const trace = await runScenario(createLegacyDriver);
  assert.deepEqual(trace.eventSequence, [
    "work.claimed",
    "work.state_changed",
    "session.started",
    "session.status_changed",
    "heartbeat.recorded",
    "session.heartbeat",
    "work.state_changed",
    "session.status_changed",
    "work.state_changed",
    "session.status_changed",
    "work.done",
    "session.stopped",
  ]);
  const last = trace.steps[trace.steps.length - 1];
  assert.equal(last.claim.state, "done");
  assert.equal(last.sessionCard.status, "done");
});

test("parity: error paths match — double claim and illegal transition", async () => {
  const errors = {};
  for (const [name, create] of [["legacy", createLegacyDriver], ["herdr", createHerdrDriver]]) {
    const driver = await create();
    await driver.claim("parity-task-1", "ai_paritylane");
    const doubleClaim = await driver.tryOp(() => driver.claim("parity-task-1", "ai_paritylane"));
    const illegal = await driver.tryOp(() => driver.illegalFinish("parity-task-1", "ai_paritylane"));
    errors[name] = { doubleClaim, illegal };
    await driver.close();
  }
  for (const kind of ["doubleClaim", "illegal"]) {
    assert.equal(errors.herdr[kind].code, errors.legacy[kind].code, `${kind} error code`);
    assert.equal(errors.herdr[kind].message, errors.legacy[kind].message, `${kind} error message`);
  }
});

test("comparator: detects a dropped journal entry (negative control)", async () => {
  const a = await runScenario(createLegacyDriver);
  const b = await runScenario(createLegacyDriver);
  b.journal.pop();
  const diffs = compareTraces(a, b);
  assert.ok(diffs.length > 0, "expected the comparator to report a divergence");
  assert.ok(diffs.some(d => d.includes("journal")), `diff should name the journal:\n${diffs.join("\n")}`);
});

test("comparator: detects a claim-state divergence (negative control)", async () => {
  const a = await runScenario(createLegacyDriver);
  const b = await runScenario(createLegacyDriver);
  b.steps[3].claim = { ...b.steps[3].claim, state: "in_progress" };
  const diffs = compareTraces(a, b);
  assert.ok(diffs.length > 0, "expected the comparator to report a divergence");
  assert.ok(diffs.some(d => d.includes("steps[3].claim.state")), `diff should name the field:\n${diffs.join("\n")}`);
});

test("real adapter (B2): honors the §2.2 contract surface used by the parity run", async () => {
  const adapter = await createSessionAdapter({ pinnedProtocolVersion: INMEMORY_PROTOCOL_VERSION });
  await adapter.connect();
  const ping = await adapter.ping();
  assert.equal(ping.ok, true);
  assert.equal(ping.protocolVersion, INMEMORY_PROTOCOL_VERSION);

  const events = [];
  const sub = await adapter.subscribe(["pane.agent_status_changed"], ev => events.push(ev));
  assert.equal(sub.active, true);

  const handle = await adapter.spawnAgent({
    kind: "claude",
    command: "parity-worker",
    metadata: { taskId: "parity-task-1", memberId: "ai_paritylane" },
  });
  // AgentHandle shape: { id, paneId, occupantId }.
  assert.match(handle.id, /^agent-/);
  assert.match(handle.paneId, /^pane-/);
  assert.match(handle.occupantId, /^occ-/);

  await adapter.reportState(handle.paneId, "working", "starting");
  await adapter.reportState(handle.paneId, "blocked", "waiting on review");
  assert.deepEqual(events.map(e => e.state), ["working", "blocked"]);
  assert.ok(events.every(e => e.type === "pane.agent_status_changed"));

  const agent = await adapter.getAgent(handle.id);
  assert.equal(agent.state, "blocked");
  assert.equal(agent.occupantId, handle.occupantId);

  const snap = await adapter.snapshot();
  const panes = snap.workspaces.flatMap(ws => ws.tabs.flatMap(tab => tab.panes));
  assert.equal(panes.length, 1);
  assert.equal(panes[0].id, handle.paneId);

  assert.equal(adapter.supports("spawnAgent"), true);
  assert.equal(adapter.supports("worktree.create"), false);

  await sub.close();
  assert.equal(sub.active, false);
  await adapter.disconnect();
});

test("real adapter (B2): version mismatch fails closed at connect", async () => {
  const adapter = await createSessionAdapter({ pinnedProtocolVersion: INMEMORY_PROTOCOL_VERSION + 1 });
  await assert.rejects(
    () => adapter.connect(),
    err => err instanceof VersionMismatchError && err.code === "version_mismatch",
  );
});

test("real adapter (B2): occupant pinning rejects sends to a changed occupant", async () => {
  const adapter = await createSessionAdapter({ pinnedProtocolVersion: INMEMORY_PROTOCOL_VERSION });
  await adapter.connect();
  const handle = await adapter.spawnAgent({ kind: "claude", command: "parity-worker" });
  // A stale occupant handle is rejected — the send is NOT delivered.
  await assert.rejects(
    () => adapter.sendText({ id: handle.id, occupantId: "occ-stale" }, "hello"),
    err => err instanceof OccupantChangedError && err.code === "occupant_changed",
  );
  // The pinned occupant from the handle works.
  const res = await adapter.sendText(handle, "hello");
  assert.equal(res.ok, true);
  await adapter.disconnect();
});

test("real adapter (B2): reportState rejects unknown agent states", async () => {
  const adapter = await createSessionAdapter({ pinnedProtocolVersion: INMEMORY_PROTOCOL_VERSION });
  await adapter.connect();
  const handle = await adapter.spawnAgent({ kind: "claude", command: "parity-worker" });
  assert.ok(AGENT_STATES.includes("working") && AGENT_STATES.includes("blocked"));
  await assert.rejects(() => adapter.reportState(handle.paneId, "napping"), /unknown state/);
  await adapter.disconnect();
});
