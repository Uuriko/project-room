// CP-AGENTS-1 fleet read model over a real store and HTTP server
// (server/agent-fleet.mjs, server/routes/agents.mjs, the orient `you` field).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { claimWork, createWork, recordReview, updateWork } from "../server/work-claims.mjs";
import { fleetFor, fleetRows, primaryState, FLEET_STATES } from "../server/agent-fleet.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  const get = async (actor, path) => {
    const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${f.keys[actor]}` } });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, origin, send, get };
}

function seedFleet(f) {
  const now = f.store.now();
  const add = (memberId, displayName, extra = {}) => f.send("owner", T.MEMBER_ADDED, { memberId, displayName, kind: "agent", permissions: ["accept_work"], ...extra });
  add("agent-removed", "Removed bot");
  add("agent-readonly", "Readonly bot");
  add("agent-paused", "Paused bot");
  add("agent-idle", "Idle bot");
  add("guest-bot", "Guest bot", { accountableHumanId: "guest" });
  const removed = f.store.room("commons").state.members["agent-removed"];
  f.send("owner", T.MEMBER_ACCESS_CHANGED, { memberId: "agent-removed", expectedMemberRevision: removed.revision, permissions: [], active: false });
  setTier(f.store.db, "commons", "agent-readonly", "t1_readonly", { updatedBy: "owner" });
  f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: "pause-1", reason: "Owner paused" }, null, { memberId: "agent-paused" });
  // producer halts itself through a handoff with haltAll.
  const item = () => f.store.room("commons").state.workItems["test-handoff"];
  f.send("producer", T.WORK_ACCEPTED, { workItemId: "test-handoff", expectedRevision: item().revision });
  f.send("producer", T.WORK_HANDOFF_RECORDED, { workItemId: "test-handoff", expectedRevision: item().revision,
    doneSummary: "Stopped", nextAction: "Owner reviews", limitReason: "Out of scope", haltAll: true });
  // reviewer holds an active Board claim; it also closed one earlier claim that was approved.
  const at = offset => new Date(now - offset);
  let active = createWork({ id: "fleet-active", title: "Fix the flaky test" }, { now: at(3_600_000), agentId: "owner" });
  active = claimWork(active, "reviewer", { now: at(3_000_000) });
  f.store.workClaims.set("commons", active);
  let done = createWork({ id: "fleet-done", title: "Ship the docs" }, { now: at(86_400_000 * 2), agentId: "owner" });
  done = claimWork(done, "reviewer", { now: at(86_400_000 * 2 - 1000) });
  done = updateWork(done, "reviewer", { state: "in_progress", now: at(86_400_000 * 2 - 900) });
  done = recordReview(done, "owner", { verdict: "approve", summary: "Looks right", now: at(86_400_000 * 2 - 800) });
  done = updateWork(done, "reviewer", { state: "done", now: at(86_400_000 * 2 - 700), authority: true });
  f.store.workClaims.set("commons", done);
}

test("each agent gets exactly one primary state, and the claim and last action match the Board and events", async t => {
  const f = await setup(t);
  seedFleet(f);
  const before = auditRecovery(f.store).dataSha256;
  const { status, body } = await f.get("owner", "/api/rooms/commons/agents/overview");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(auditRecovery(f.store).dataSha256, before, "the overview writes nothing");
  assert.equal(body.scope, "room");
  const byId = Object.fromEntries(body.agents.map(row => [row.memberId, row]));
  assert.deepEqual(Object.fromEntries(Object.entries(byId).map(([id, row]) => [id, row.state])), {
    "agent-idle": "idle", "agent-paused": "paused", "agent-readonly": "read_only", "agent-removed": "removed",
    "guest-bot": "idle", producer: "halted", reviewer: "working"
  });
  for (const row of body.agents) assert.ok(FLEET_STATES.includes(row.state));
  const boardClaim = f.store.workClaims.get("commons", "fleet-active");
  assert.deepEqual(byId.reviewer.currentClaim, { claimId: "fleet-active", title: "Fix the flaky test", state: boardClaim.state, leaseExpiresAt: boardClaim.leaseExpiresAt, untrusted: true });
  assert.equal(byId.reviewer.outcomes.claimsDone, 1);
  assert.equal(byId.reviewer.outcomes.reviewsApproved, 1);
  assert.equal(byId["agent-paused"].wake.paused, true);
  assert.equal(byId["agent-paused"].wake.reason, "Owner paused");
  assert.equal(byId["agent-readonly"].tier, "t1_readonly");
  assert.deepEqual(byId["guest-bot"].sponsor, { memberId: "guest", displayName: f.store.room("commons").state.members.guest.displayName });
  const events = f.store.db.prepare("SELECT sequence, body FROM events WHERE room_id='commons' ORDER BY sequence").all().map(row => ({ seq: row.sequence, ...JSON.parse(row.body) }));
  const lastProducer = events.filter(event => event.actorId === "producer").at(-1);
  assert.deepEqual(byId.producer.lastAction, { seq: lastProducer.seq, type: lastProducer.type, at: lastProducer.at });
  assert.equal(byId["agent-idle"].lastAction, null, "an agent that never acted has no last action");
  for (const row of body.agents) {
    assert.equal(row.receiving, null);
    assert.equal(row.budget, null);
    assert.equal(row.spend.periodDays, 7);
  }
});

test("a non-owner agent gets 403 owner_required; a sponsor sees only their own agents", async t => {
  const f = await setup(t);
  seedFleet(f);
  const agent = await f.get("producer", "/api/rooms/commons/agents/overview");
  assert.equal(agent.status, 403);
  assert.equal(agent.body.error.code, "owner_required");
  const sponsor = await f.get("guest", "/api/rooms/commons/agents/overview");
  assert.equal(sponsor.status, 200, JSON.stringify(sponsor.body));
  assert.equal(sponsor.body.scope, "sponsored");
  assert.deepEqual(sponsor.body.agents.map(row => row.memberId), ["guest-bot"]);
});

test("room_orient carries the calling agent's own state, badges and budget", async t => {
  const f = await setup(t);
  seedFleet(f);
  const reviewer = await f.get("reviewer", "/api/rooms/commons/orient");
  assert.equal(reviewer.status, 200, JSON.stringify(reviewer.body));
  assert.equal(reviewer.body.you.state, "working");
  assert.deepEqual(reviewer.body.you.badges, []);
  assert.equal(reviewer.body.you.budget, null);
  const owner = await f.get("owner", "/api/rooms/commons/orient");
  assert.equal(owner.body.you.state, undefined, "humans get no fleet state");
});

test("primary state precedence is fixed", () => {
  assert.equal(primaryState({ removed: true, halted: true }), "removed");
  assert.equal(primaryState({ halted: true, read_only: true, paused: true }), "halted");
  assert.equal(primaryState({ read_only: true, paused: true, working: true }), "read_only");
  assert.equal(primaryState({ paused: true, working: true }), "paused");
  assert.equal(primaryState({ working: true }), "working");
  assert.equal(primaryState({}), "idle");
});

test("a 50-agent room reads in under 50 ms with one projection parse", async t => {
  const f = await setup(t);
  for (let i = 0; i < 50; i++) f.send("owner", T.MEMBER_ADDED, { memberId: `bulk-${String(i).padStart(2, "0")}`, displayName: `Bulk agent ${i}`, kind: "agent", permissions: ["accept_work"] });
  for (let i = 0; i < 25; i++) f.store.workClaims.set("commons", claimWork(createWork({ id: `bulk-claim-${i}`, title: `Bulk ${i}` }, { now: new Date(f.store.now() - 60_000), agentId: "owner" }), `bulk-${String(i).padStart(2, "0")}`, { now: new Date(f.store.now() - 30_000) }));
  const auth = { member: { id: "owner" } };
  fleetFor(f.store, auth, "commons"); // warm statements
  f.store._projectionCache = null;
  const projectionLength = f.store.db.prepare("SELECT length(projection) AS n FROM rooms WHERE id='commons'").get().n;
  const parse = JSON.parse;
  let projectionParses = 0;
  JSON.parse = function (text, ...rest) {
    if (typeof text === "string" && text.length === projectionLength) projectionParses++;
    return parse.call(this, text, ...rest);
  };
  let overview;
  const started = performance.now();
  try { overview = fleetFor(f.store, auth, "commons"); }
  finally { JSON.parse = parse; }
  const elapsed = performance.now() - started;
  assert.equal(overview.agents.length, 52);
  assert.equal(projectionParses, 1);
  assert.ok(elapsed < 50, `overview took ${elapsed.toFixed(1)} ms`);
  assert.equal(overview.agents.filter(row => row.state === "working").length, 25);
  assert.equal(fleetRows(f.store, "commons", f.store.room("commons"), { memberIds: ["bulk-00"] })[0].currentClaim.claimId, "bulk-claim-0");
});
