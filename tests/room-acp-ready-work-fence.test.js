// PR #6384 follow-up (Codex HOLD): a dependency-triggered ready_work wake is
// fenced on current Board prerequisite truth right before the model turn.
// The wake id carries the prerequisite basis; the bridge re-reads every
// prerequisite from the Room and starts zero turns when one reopened or the
// basis no longer matches. Assigned wakes keep their old behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Bridge, CLAIM_KEY, readyWorkBasisOf, readyWorkWakeOf, prerequisiteBasis } from "../room-acp/src/bridge.mjs";
import { claimReadyWorkBasis } from "../server/work-claim-events.mjs";
import { join } from "../room-acp/src/join.mjs";
import { startRoom, FAKE_AGENT } from "./room-acp-fixture.mjs";

const waitFor = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("timed out waiting");
};

async function queuedReadyWork(t) {
  const room = await startRoom(t);
  const connection = await join({ link: room.invite().link, displayName: "Coder", env: room.env });
  const identityHeaders = { authorization: `Bearer ${connection.identitySecret}`, "content-type": "application/json" };
  const beat = await fetch(`${room.origin}/api/agent-heartbeats`, {
    method: "POST", headers: identityHeaders, body: JSON.stringify({ hostId: connection.hostId, mode: "pull-only" })
  });
  assert.equal(beat.status, 200, await beat.text());
  const asOwner = (path, body, method = "POST") => fetch(room.origin + path, {
    method, headers: { authorization: `Bearer ${room.ownerKey}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  }).then(async res => ({ status: res.status, json: await res.json() }));
  const poll = () => fetch(`${room.origin}/api/agent-wakes/poll?hostId=${encodeURIComponent(connection.hostId)}&waitMs=0`, {
    headers: { authorization: `Bearer ${connection.identitySecret}` }
  }).then(res => res.json());
  for (const [path, body, status] of [
    ["/api/rooms/commons/work-claims", { id: "prereq", title: "Prerequisite", reviewPolicy: "self_attested" }, 201],
    ["/api/rooms/commons/work-claims/prereq/claim", {}, 200],
    ["/api/rooms/commons/work-claims/prereq/update", { state: "in_progress" }, 200],
    ["/api/rooms/commons/work-claims", { id: "follow-on", title: "Follow-on work", reviewPolicy: "self_attested", dependsOn: ["prereq"], assignee: connection.memberId }, 201],
  ]) {
    const out = await asOwner(path, body);
    assert.equal(out.status, status, JSON.stringify(out.json));
  }
  const assigned = ((await poll()).pendingWakes ?? []).filter(wake => wake.reason === "assigned");
  assert.ok(assigned.length >= 1);
  const acked = await fetch(`${room.origin}/api/agent-heartbeats/ack`, {
    method: "POST", headers: identityHeaders, body: JSON.stringify({ signalIds: assigned.map(wake => wake.signalId) })
  });
  assert.equal(acked.status, 200, await acked.text());
  const done = await asOwner("/api/rooms/commons/work-claims/prereq/update", { state: "done", note: "prerequisite complete" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const readyWakes = ((await poll()).pendingWakes ?? []).filter(wake => wake.reason === "ready_work");
  assert.equal(readyWakes.length, 1, "exactly one queued ready_work wake");
  assert.equal(readyWakes[0].workClaim, "follow-on");
  const bridge = new Bridge({
    connection,
    candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE_AGENT] },
    env: { ...room.env, FAKE_ACP_MODE: "echo" }, respondTo: "owner", waitMs: 500, cadenceSeconds: 30,
    log: process.env.RA_DEBUG ? (...a) => console.error("[bridge]", ...a) : () => {}
  });
  const echoNotes = async () => ((await asOwner("/api/rooms/commons/work-claims/follow-on", undefined, "GET")).json.history ?? [])
    .filter(entry => entry.agentId === connection.memberId && /^echo: /.test(entry.note ?? ""));
  const start = () => { const running = bridge.run(); t.after(async () => { bridge.stop(); await running; }); };
  const redeliver = async () => {
    const claim = (await asOwner("/api/rooms/commons/work-claims/follow-on", undefined, "GET")).json;
    await bridge.claimSignalTurn(CLAIM_KEY + "follow-on", {
      signalId: readyWakes[0].signalId, reason: "ready_work", messageId: readyWakes[0].messageId, claim, author: "owner" });
  };
  return { room, asOwner, poll, wake: readyWakes[0], bridge, echoNotes, start, redeliver };
}

test("ready_work basis: the bridge mirrors the server basis and parses only well-formed wake ids", () => {
  const deps = [{ id: "b", state: "done", revision: null }, { id: "a", state: "done", revision: "r1", premiseFlag: null }];
  assert.equal(prerequisiteBasis(deps), claimReadyWorkBasis(deps));
  const basis = createHash("sha256").update("x").digest("hex");
  assert.equal(readyWorkBasisOf(`work-claim:dep:ready_work:none:${basis}`, "dep"), basis);
  assert.equal(readyWorkBasisOf(`work-claim:dep:ready_work:none:${basis}`, "other"), null);
  assert.equal(readyWorkBasisOf(`work-claim:dep:assigned:none:${basis}`, "dep"), null);
  assert.equal(readyWorkBasisOf("work-claim:dep:ready_work:none:not-a-basis", "dep"), null);
  assert.deepEqual(readyWorkWakeOf(`work-claim:dep:ready_work:r:1:${basis}`, "dep"), { revision: "r:1", basis });
  assert.equal(readyWorkWakeOf(`work-claim:dep:ready_work:${basis}`, "dep"), null, "a wake id without a revision is stale");
});

test("bridge: a queued ready_work wake whose prerequisite reopened starts zero model turns", async t => {
  const { asOwner, bridge, echoNotes, start, redeliver } = await queuedReadyWork(t);
  // Reopen: retract the done prerequisite's premise after the wake queued.
  const flagged = await asOwner("/api/rooms/commons/work-claims/prereq/premise-invalid", { reason: "prerequisite reopened: wrong premise" });
  assert.equal(flagged.status, 200, JSON.stringify(flagged.json));
  start();
  await waitFor(() => bridge.stats.stale >= 1 && bridge.stats.acked >= 1);
  assert.equal(bridge.stats.turns, 0, "no model turn for a stale ready_work wake");
  assert.equal((await echoNotes()).length, 0);
  // A redelivery of the same signal replays the discarded receipt: still zero.
  await redeliver();
  assert.equal(bridge.stats.turns, 0);
  assert.equal((await echoNotes()).length, 0);
});

test("bridge: a ready_work wake whose prerequisite is still done runs one turn and no duplicate on redelivery", async t => {
  const { bridge, echoNotes, start, redeliver, poll } = await queuedReadyWork(t);
  start();
  await waitFor(async () => (await echoNotes()).length >= 1);
  await waitFor(() => bridge.stats.acked >= 1);
  assert.equal(bridge.stats.turns, 1);
  assert.equal(bridge.stats.stale, 0);
  await redeliver();
  assert.equal(bridge.stats.turns, 1, "redelivery replays the posted receipt, no second turn");
  assert.equal((await echoNotes()).length, 1, "exactly one claim note");
  assert.equal(((await poll()).pendingWakes ?? []).filter(wake => wake.reason === "ready_work").length, 0);
});

test("bridge: a reassignment after the final authority check and before the prompt starts zero model turns", async t => {
  const { asOwner, bridge, echoNotes, start } = await queuedReadyWork(t);
  // Land the reassignment in the race window: right after the last
  // authorized({requireRunnable}) check passes and before readyWorkCurrent.
  const authorized = bridge.authorized.bind(bridge);
  let reassigned = null;
  bridge.authorized = async options => {
    const allowed = await authorized(options);
    if (options?.requireRunnable && !reassigned) {
      const current = (await asOwner("/api/rooms/commons/work-claims/follow-on", undefined, "GET")).json;
      reassigned = await asOwner("/api/rooms/commons/work-claims/follow-on/reassign", {
        newOwner: "owner", expectedClaimedAt: current.claimedAt, expectedHistoryLength: current.history.length,
        note: "reassigned inside the pre-prompt window" });
    }
    return allowed;
  };
  start();
  await waitFor(() => bridge.stats.stale >= 1 && bridge.stats.acked >= 1);
  assert.equal(reassigned?.status, 200, JSON.stringify(reassigned?.json));
  assert.equal(bridge.stats.turns, 0, "the old runner must not start a turn for a dependent it no longer owns");
  assert.equal((await echoNotes()).length, 0);
});
