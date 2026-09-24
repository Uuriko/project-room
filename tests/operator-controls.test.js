import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { sessionRecord } from "../src/work-item-session.js";
import {
  getControls, setControls, killAgent, reviveAgent, setSpendCap, setTier,
  agentSpendLedger, enforceOperatorControls, operatorControlsReport,
  AUTONOMY_TIERS, DEFAULT_AUTONOMY_TIER, OPERATOR_CONTROLS_DEFAULT_PERIOD_DAYS,
} from "../server/operator-controls.mjs";

// Slice 1/3: per-agent operator controls — spend caps, kill switch, autonomy
// tiers. Migration-safe defaults: no controls row means no behavior change
// until the operator acts.

async function serve(t, { start = Date.parse("2026-09-14T12:00:00Z") } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-operator-controls-"));
  const clock = { now: start };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest human", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  send("owner", T.MEMBER_ADDED, { memberId: "agent2", displayName: "Second agent", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  keys.guest = store.issueAccessKey("commons", "guest");
  keys.agent = store.issueAccessKey("commons", "agent");
  keys.agent2 = store.issueAccessKey("commons", "agent2");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  const state = () => store.room("commons").state;
  const db = () => store.db;
  const propose = (title, accountableMemberId = "agent") => { const workItemId = `w-${randomUUID()}`; send("owner", T.WORK_PROPOSED, { workItemId, title, definitionOfDone: "done", accountableMemberId, mode: "read" }); return workItemId; };
  const startSession = (actor, workItemId, budget) => send(actor, T.SESSION_STARTED,
    { workItemId, expectedRevision: state().workItems[workItemId].revision, ...(budget ? { budget } : {}) });
  return { store, keys, clock, send, request, state, db, propose, startSession };
}

// assert.throws returns undefined on this Node; capture the error instead.
const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };

test("validation: bad caps, periods, tiers and shapes are 422 invalid_operator_controls", async t => {
  const f = await serve(t);
  const db = f.db();
  for (const spendCapCents of [0, -1, 1.5, "5000", 100000001]) {
    assert.throws(() => setControls(db, "commons", "agent", { spendCapCents }), { status: 422, code: "invalid_operator_controls" }, JSON.stringify(spendCapCents));
  }
  for (const spendPeriodDays of [0, 366, 1.5, "30"]) {
    assert.throws(() => setControls(db, "commons", "agent", { spendPeriodDays }), { status: 422, code: "invalid_operator_controls" }, JSON.stringify(spendPeriodDays));
  }
  assert.throws(() => setControls(db, "commons", "agent", { autonomyTier: "t3_admin" }), { status: 422, code: "invalid_operator_controls" });
  assert.throws(() => setControls(db, "commons", "agent", { sandboxed: "yes" }), { status: 422, code: "invalid_operator_controls" });
  assert.throws(() => setControls(db, "commons", "agent", {}), { status: 422, code: "invalid_operator_controls" }, "empty patch");
  assert.throws(() => setControls(db, "commons", "agent", { spendCapCents: 100, note: "x" }), { status: 422, code: "invalid_operator_controls" }, "unknown key");
  assert.throws(() => setControls(db, "commons", "agent", null), { status: 422, code: "invalid_operator_controls" });
  assert.throws(() => setControls(db, "commons", "not a member!!", { spendCapCents: 100 }), { status: 422, code: "invalid_operator_controls" });
  assert.equal(getControls(db, "commons", "agent"), null, "rejected writes leave no row");
});

test("setControls: partial updates, frozen rows, tier helpers", async t => {
  const f = await serve(t);
  const db = f.db();
  assert.deepEqual(AUTONOMY_TIERS, ["t1_readonly", "t2_standard"]);
  assert.equal(DEFAULT_AUTONOMY_TIER, "t2_standard");
  const one = setSpendCap(db, "commons", "agent", 5000, { updatedBy: "owner", nowMs: f.clock.now });
  assert.deepEqual({ ...one },
    { roomId: "commons", memberId: "agent", spendCapCents: 5000, spendPeriodDays: OPERATOR_CONTROLS_DEFAULT_PERIOD_DAYS,
      killedAt: null, autonomyTier: "t2_standard", sandboxed: false, updatedAt: f.clock.now, updatedBy: "owner" });
  assert.ok(Object.isFrozen(one), "controls rows are frozen");
  const two = setTier(db, "commons", "agent", "t1_readonly", { updatedBy: "owner", nowMs: f.clock.now + 1 });
  assert.equal(two.autonomyTier, "t1_readonly");
  assert.equal(two.spendCapCents, 5000, "partial update keeps the cap");
  const three = setControls(db, "commons", "agent", { spendCapCents: null, sandboxed: true }, { updatedBy: "owner", nowMs: f.clock.now + 2 });
  assert.equal(three.spendCapCents, null, "null clears the cap");
  assert.equal(three.sandboxed, true, "sandboxed flag stores for slice 3");
});

test("kill switch: kill stops writes, revive restores, kill is idempotent", async t => {
  const f = await serve(t);
  const db = f.db();
  assert.equal(reviveAgent(db, "commons", "agent"), null, "reviving a never-killed agent is a no-op");
  const killed = killAgent(db, "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now });
  assert.equal(killed.killedAt, f.clock.now);
  const again = killAgent(db, "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now + 5 });
  assert.equal(again.killedAt, f.clock.now + 5, "re-kill refreshes the timestamp");
  const revived = reviveAgent(db, "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now + 6 });
  assert.equal(revived.killedAt, null);
  assert.equal(getControls(db, "commons", "agent").spendCapCents, null, "kill/revive do not disturb other fields");
});

test("agentSpendLedger: per-agent attribution, measured only", async t => {
  const f = await serve(t);
  const now = f.clock.now;
  const empty = agentSpendLedger(f.state(), "agent", { nowMs: now });
  assert.deepEqual([empty.spentCents, empty.reservedCents, empty.heldCents, empty.committedCents], [0, 0, 0, 0]);
  // agent runs a session: reports 500 mid-run, closes at 800.
  const a = f.propose("agent run");
  f.startSession("agent", a, { maxSpendCents: 2000 });
  assert.equal(agentSpendLedger(f.state(), "agent", { nowMs: now }).reservedCents, 2000, "live session reserves its declared cap");
  f.send("agent", T.SESSION_STATUS_CHANGED, { workItemId: a, expectedRevision: f.state().workItems[a].revision, status: "active", spendCents: 500 });
  let ledger = agentSpendLedger(f.state(), "agent", { nowMs: now });
  assert.deepEqual([ledger.spentCents, ledger.reservedCents, ledger.committedCents], [500, 1500, 2000], "reported spend moves from reserved to spent");
  f.send("agent", T.SESSION_STOPPED, { workItemId: a, expectedRevision: f.state().workItems[a].revision, status: "done", spendCents: 800 });
  ledger = agentSpendLedger(f.state(), "agent", { nowMs: now });
  assert.deepEqual([ledger.spentCents, ledger.reservedCents, ledger.heldCents, ledger.committedCents], [800, 0, 0, 800]);
  // agent2's spend never leaks into agent's ledger.
  const b = f.propose("agent2 run", "agent2");
  f.startSession("agent2", b, { maxSpendCents: 3000 });
  assert.equal(agentSpendLedger(f.state(), "agent", { nowMs: now }).committedCents, 800, "agent2's reservation is invisible to agent");
  assert.equal(agentSpendLedger(f.state(), "agent2", { nowMs: now }).reservedCents, 3000);
  // A closed, unreported, capped attempt is held at its cap; an unreported
  // uncapped one is only counted, never assumed zero.
  f.send("agent2", T.SESSION_STOPPED, { workItemId: b, expectedRevision: f.state().workItems[b].revision, status: "failed" });
  ledger = agentSpendLedger(f.state(), "agent2", { nowMs: now });
  assert.deepEqual([ledger.heldCents, ledger.sessions.attemptsHeld, ledger.sessions.attemptsUnreported], [3000, 1, 0]);
  const c = f.propose("agent2 run 2", "agent2");
  f.startSession("agent2", c);
  f.send("agent2", T.SESSION_STOPPED, { workItemId: c, expectedRevision: f.state().workItems[c].revision, status: "failed" });
  ledger = agentSpendLedger(f.state(), "agent2", { nowMs: now });
  assert.equal(ledger.sessions.attemptsUnreported, 1, "uncapped unreported attempts are named, not zeroed");
  assert.equal(ledger.heldCents, 3000, "the held attempt still holds its cap");
});

test("enforcement through store.command: killed agent writes refused, revive restores", async t => {
  const f = await serve(t);
  // No controls row: migration-safe default, everything works.
  f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "hello" });
  killAgent(f.db(), "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now });
  const refused = capture(() => f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "still here" }));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_killed");
  assert.match(refused.message, /Test agent/, "the refusal names the agent");
  assert.match(refused.message, /operator/, "the refusal says who stopped it");
  // Even a session stop from the killed agent is refused: killed always wins.
  const w = f.propose("killed run");
  assert.throws(() => f.startSession("agent", w, { maxSpendCents: 100 }), { status: 403, code: "agent_killed" });
  reviveAgent(f.db(), "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now });
  f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "back" });
});

test("enforcement: t1_readonly refuses writes but heartbeats and stops land", async t => {
  const f = await serve(t);
  setTier(f.db(), "commons", "agent", "t1_readonly", { updatedBy: "owner", nowMs: f.clock.now });
  const refused = capture(() => f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "chat" }));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
  assert.match(refused.message, /read-only autonomy tier/);
  const w = f.propose("readonly run");
  assert.throws(() => f.startSession("agent", w, { maxSpendCents: 100 }), { status: 403, code: "agent_readonly" }, "t1 cannot start sessions");
  assert.throws(() => f.send("agent", T.WORK_PROPOSED, { workItemId: `w-${randomUUID()}`, title: "x", definitionOfDone: "d", accountableMemberId: "agent", mode: "read" }),
    { status: 403, code: "agent_readonly" }, "t1 cannot propose work");
  // Downgrade path: a session started as t2 keeps reporting under t1.
  setTier(f.db(), "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: f.clock.now });
  f.startSession("agent", w, { maxSpendCents: 2000 });
  setTier(f.db(), "commons", "agent", "t1_readonly", { updatedBy: "owner", nowMs: f.clock.now });
  f.send("agent", T.SESSION_STATUS_CHANGED, { workItemId: w, expectedRevision: f.state().workItems[w].revision, status: "active", spendCents: 100 });
  assert.equal(sessionRecord(f.state().workItems[w]).spend_cents, 100, "heartbeat with spend report lands under t1");
  f.send("agent", T.SESSION_STOPPED, { workItemId: w, expectedRevision: f.state().workItems[w].revision, status: "done", spendCents: 150 });
  assert.equal(sessionRecord(f.state().workItems[w]).status, "done", "stop lands under t1");
  // Killed beats tier: a killed t1 agent is refused with agent_killed.
  killAgent(f.db(), "commons", "agent", { updatedBy: "owner", nowMs: f.clock.now });
  assert.throws(() => f.send("agent", T.SESSION_STATUS_CHANGED, { workItemId: w, expectedRevision: f.state().workItems[w].revision, status: "active" }),
    { status: 403, code: "agent_killed" });
});

test("enforcement: spend cap — budget required, exact cap, parked message", async t => {
  const f = await serve(t);
  setSpendCap(f.db(), "commons", "agent", 5000, { updatedBy: "owner", nowMs: f.clock.now });
  const a = f.propose("cap run A"), b = f.propose("cap run B"), c = f.propose("cap run C");
  // Under a cap a start must declare its reservation (mirrors the room allowance).
  const undeclared = capture(() => f.startSession("agent", a));
  assert.equal(undeclared.status, 422);
  assert.equal(undeclared.code, "agent_spend_cap_budget_required");
  assert.match(undeclared.message, /\$50\.00/);
  assert.equal(sessionRecord(f.state().workItems[a]).status, "queued", "nothing was written");
  f.startSession("agent", a, { maxSpendCents: 2000 });
  // The second start fits exactly: 2000 committed + 3000 == 5000.
  f.startSession("agent", b, { maxSpendCents: 3000 });
  // The third start is one cent over: parked at the cap.
  const parked = capture(() => f.startSession("agent", c, { maxSpendCents: 1 }));
  assert.equal(parked.status, 409);
  assert.equal(parked.code, "agent_spend_cap_exceeded");
  assert.match(parked.message, /parked at its cap/);
  assert.match(parked.message, /\$0\.00 spent, \$50\.00 reserved/);
  assert.match(parked.message, /\$0\.00 left/);
  assert.equal(sessionRecord(f.state().workItems[c]).status, "queued", "the refused start wrote nothing");
  // A spend report beyond the reservation that would carry the agent past
  // the cap is refused; the session must stop instead.
  assert.throws(() => f.send("agent", T.SESSION_STATUS_CHANGED,
    { workItemId: a, expectedRevision: f.state().workItems[a].revision, status: "active", spendCents: 2100 }),
    { status: 409, code: "agent_spend_cap_exceeded" });
  // A report within the reservation changes nothing and always lands.
  f.send("agent", T.SESSION_STATUS_CHANGED, { workItemId: a, expectedRevision: f.state().workItems[a].revision, status: "active", spendCents: 1500 });
  assert.equal(sessionRecord(f.state().workItems[a]).spend_cents, 1500);
  // A stop above the reservation still lands so actual spend is recorded.
  f.send("agent", T.SESSION_STOPPED, { workItemId: a, expectedRevision: f.state().workItems[a].revision, status: "done", spendCents: 2200 });
  assert.equal(sessionRecord(f.state().workItems[a]).status, "done");
});

test("enforceOperatorControls is a no-op without a row and ignores malformed input", async t => {
  const f = await serve(t);
  const noop = () => enforceOperatorControls({ db: f.db(), roomId: "commons", state: f.state(),
    command: { type: T.MESSAGE_POSTED, data: {} }, actorId: "agent", nowMs: f.clock.now, fail: () => { throw new Error("must not fail"); } });
  assert.doesNotThrow(noop, "no controls row: no behavior change");
  assert.doesNotThrow(() => enforceOperatorControls({}), "missing everything is a no-op");
});

test("API: owner can set and read; non-owner gets 403; shape is complete", async t => {
  const f = await serve(t);
  const path = "/api/rooms/commons/operator/agents/agent";
  for (const token of [f.keys.guest, f.keys.agent]) {
    const put = await f.request(path, { method: "PUT", token, data: { spendCapCents: 1000 } });
    assert.equal(put.status, 403, "non-owner PUT refused");
    assert.equal(put.json.error.code, "owner_required");
    const get = await f.request(path, { method: "GET", token });
    assert.equal(get.status, 403, "non-owner GET refused");
    assert.equal(get.json.error.code, "owner_required");
  }
  const missing = await f.request("/api/rooms/commons/operator/agents/nobody", { method: "GET", token: f.keys.owner });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "member_not_found");
  const bad = await f.request(path, { method: "PUT", token: f.keys.owner, data: { spendCapCents: 1000, autonomyTier: "t9" } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "invalid_operator_controls");
  const contra = await f.request(path, { method: "PUT", token: f.keys.owner, data: { killed: true, revived: true } });
  assert.equal(contra.status, 422);
  const empty = await f.request(path, { method: "PUT", token: f.keys.owner, data: {} });
  assert.equal(empty.status, 422);
  // Defaults read before the operator ever acts.
  const fresh = await f.request(path, { method: "GET", token: f.keys.owner });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.controls, null);
  assert.deepEqual(fresh.json.status, { killed: false, autonomyTier: "t2_standard", spendCapCents: null, parkedAtCap: false });
  assert.equal(fresh.json.headroomCents, null);
  assert.equal(typeof fresh.json.evaluatedThrough, "number");
  // Set a cap and a tier, then kill and revive through the aliases.
  const set = await f.request(path, { method: "PUT", token: f.keys.owner, data: { spendCapCents: 5000, spendPeriodDays: 7, autonomyTier: "t1_readonly", sandboxed: true } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json.controls, { spendCapCents: 5000, spendPeriodDays: 7, killedAt: null,
    autonomyTier: "t1_readonly", sandboxed: true, updatedAt: f.clock.now, updatedBy: "owner" });
  assert.equal(set.json.status.parkedAtCap, false);
  assert.equal(set.json.headroomCents, 5000);
  const killed = await f.request(path, { method: "PUT", token: f.keys.owner, data: { killed: true } });
  assert.equal(killed.status, 200);
  assert.equal(killed.json.status.killed, true);
  assert.equal(typeof killed.json.controls.killedAt, "number");
  const revived = await f.request(path, { method: "PUT", token: f.keys.owner, data: { revived: true } });
  assert.equal(revived.status, 200);
  assert.equal(revived.json.status.killed, false);
  assert.equal(revived.json.controls.killedAt, null);
  // Clearing the cap with null keeps the other fields.
  const cleared = await f.request(path, { method: "PUT", token: f.keys.owner, data: { spendCapCents: null } });
  assert.equal(cleared.json.controls.spendCapCents, null);
  assert.equal(cleared.json.controls.autonomyTier, "t1_readonly");
});

test("API-driven kill propagates to the command path immediately", async t => {
  const f = await serve(t);
  const path = "/api/rooms/commons/operator/agents/agent";
  await f.request(path, { method: "PUT", token: f.keys.owner, data: { killed: true } });
  assert.throws(() => f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "x" }), { status: 403, code: "agent_killed" });
  await f.request(path, { method: "PUT", token: f.keys.owner, data: { killed: false } });
  f.send("agent", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "x" });
});

test("operatorControlsReport: parkedAtCap derives from measured spend", async t => {
  const f = await serve(t);
  setSpendCap(f.db(), "commons", "agent", 800, { updatedBy: "owner", nowMs: f.clock.now });
  const w = f.propose("park run");
  f.startSession("agent", w, { maxSpendCents: 800 });
  f.send("agent", T.SESSION_STOPPED, { workItemId: w, expectedRevision: f.state().workItems[w].revision, status: "done", spendCents: 800 });
  const report = operatorControlsReport(f.db(), "commons", f.state(), "agent", f.clock.now);
  assert.equal(report.status.parkedAtCap, true);
  assert.equal(report.headroomCents, 0);
  assert.equal(report.ledger.spentCents, 800);
});
