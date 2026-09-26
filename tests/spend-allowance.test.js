import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, replay, spendAllowance } from "../src/events.js";
import { spendLedger, sessionRecord } from "../src/work-item-session.js";
import { spendAllowanceReport, enforceSpendAllowance } from "../server/spend-allowance.mjs";
import { classifyCommand } from "../server/action-classes.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

// Issue #6 C3: an owner-set room spend allowance. The reducer is owner-only,
// the ledger derives from the projection, and store.command() refuses any
// session start that would commit more than the allowance before writing.

async function serve(t, { start = Date.parse("2026-09-14T12:00:00Z") } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-allowance-"));
  const clock = { now: start };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest human", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // spend-allowance tests exercise it as a working agent.
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  keys.guest = store.issueAccessKey("commons", "guest"); keys.agent = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  const state = () => store.room("commons").state;
  const propose = title => { const workItemId = `w-${randomUUID()}`; send("owner", T.WORK_PROPOSED, { workItemId, title, definitionOfDone: "done", accountableMemberId: "agent", mode: "read" }); return workItemId; };
  const session = (workItemId, body, token = keys.agent) => request("/api/rooms/commons/work-sessions", { method: "POST", token,
    data: { requestId: randomUUID(), workItemId, expectedRevision: state().workItems[workItemId].revision, action: "set_status", ...body } });
  const report = () => spendAllowanceReport(state(), clock.now);
  return { store, keys, clock, send, request, state, propose, session, report };
}

test("reducer: owner-only, strict shape, revisioned, clearable and replayable", async t => {
  const f = await serve(t);
  assert.equal(spendAllowance(f.state()), null, "no allowance is the default");
  for (const actor of ["guest", "agent"]) {
    assert.throws(() => f.send(actor, T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 5000, periodDays: 30 }), { status: 422, code: "command_rejected", message: /Only the Room owner may set the spend allowance/ });
  }
  assert.equal(f.state().room.spendAllowance, undefined, "a refused allowance leaves no trace");
  for (const data of [{ allowanceCents: -1, periodDays: 30 }, { allowanceCents: 1.5, periodDays: 30 }, { allowanceCents: 100000001, periodDays: 30 },
    { allowanceCents: 5000, periodDays: 0 }, { allowanceCents: 5000, periodDays: 366 }, { allowanceCents: 5000 }, { allowanceCents: null, periodDays: 30 }]) {
    assert.throws(() => f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, data), { status: 422 }, JSON.stringify(data));
  }
  assert.throws(() => f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: "50", periodDays: 30 }), { status: 422, code: "invalid_command" });
  assert.throws(() => f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 5000, periodDays: 30, note: "x" }), { status: 422, code: "invalid_command" });
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 5000, periodDays: 30 });
  assert.deepEqual(spendAllowance(f.state()), { allowanceCents: 5000, periodDays: 30, revision: 1, setById: "owner", setAt: new Date(f.clock.now).toISOString() });
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 0, periodDays: 7 });
  assert.equal(spendAllowance(f.state()).allowanceCents, 0, "zero is a real allowance (nothing may start)");
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: null });
  assert.equal(spendAllowance(f.state()), null);
  assert.equal(f.state().room.spendAllowance.revision, 3);
  const events = f.store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all("commons").map(row => JSON.parse(row.body));
  assert.deepEqual(replay(events).room.spendAllowance, f.state().room.spendAllowance, "the allowance is event-sourced");
  assert.equal(classifyCommand(T.ROOM_SPEND_ALLOWANCE_SET), "act");
});

test("ledger and enforcement: reserve on start, refuse the start that would exceed, free on stop, hold unknown spend", async t => {
  const f = await serve(t);
  const a = f.propose("run A"), b = f.propose("run B"), c = f.propose("run C");
  // Without an allowance nothing changes: an undeclared session starts as before.
  assert.equal((await f.session(c, { status: "processing" })).status, 201);
  assert.equal((await f.session(c, { status: "done" })).status, 201);
  assert.equal(f.report().allowance, null); assert.equal(f.report().headroomCents, null);
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 5000, periodDays: 30 });
  // The closed, unreported, uncapped attempt of C is named but adds nothing.
  assert.deepEqual(f.report().sessions, { live: 0, unreserved: 0, attemptsCounted: 1, attemptsUnreported: 1, attemptsHeld: 0 });
  // Under an allowance a start must declare its spend cap.
  const undeclared = await f.session(a, { status: "processing" });
  assert.equal(undeclared.status, 422); assert.equal(undeclared.json.error.code, "spend_allowance_budget_required");
  assert.equal(sessionRecord(f.state().workItems[a]).status, "queued", "nothing was written");
  const before = f.store.room("commons").sequence;
  const startA = await f.session(a, { status: "processing", budget: { maxSpendCents: 2000 } });
  assert.equal(startA.status, 201, JSON.stringify(startA.json));
  assert.deepEqual([f.report().spentCents, f.report().reservedCents, f.report().committedCents, f.report().headroomCents], [0, 2000, 2000, 3000]);
  // The second claim cannot reserve past the remaining allowance; the refusal is exact and writes nothing.
  const tooMuch = await f.session(b, { status: "processing", budget: { maxSpendCents: 3500 } });
  assert.equal(tooMuch.status, 409); assert.equal(tooMuch.json.error.code, "spend_allowance_exceeded");
  assert.match(tooMuch.json.error.message, /\$30\.00 left/);
  assert.equal(f.store.room("commons").sequence, before + 1, "only the accepted start was written");
  assert.equal(sessionRecord(f.state().workItems[b]).status, "queued");
  const startB = await f.session(b, { status: "processing", budget: { maxSpendCents: 3000 } });
  assert.equal(startB.status, 201);
  assert.deepEqual([f.report().reservedCents, f.report().headroomCents, f.report().overCents], [5000, 0, 0]);
  // A report within the reservation moves spend from reserved to spent and changes nothing else.
  assert.equal((await f.session(a, { status: "active", spendCents: 500 })).status, 201);
  assert.deepEqual([f.report().spentCents, f.report().reservedCents, f.report().committedCents], [500, 4500, 5000]);
  // A report beyond the reservation that would carry the room past the allowance is refused on the command path...
  assert.throws(() => f.send("agent", T.SESSION_STATUS_CHANGED, { workItemId: b, expectedRevision: f.state().workItems[b].revision, status: "active", spendCents: 3600 }),
    { status: 409, code: "spend_allowance_exceeded" });
  // ...while on the session path the session's own budget trip-wire fires first: the run is
  // force-stopped without a spend report, so its reservation is held as unknown spend, not freed.
  const overCap = await f.session(b, { status: "failed", spendCents: 3100 });
  assert.equal(overCap.status, 409); assert.equal(overCap.json.error.code, "budget_exceeded");
  assert.equal(sessionRecord(f.state().workItems[b]).status, "failed");
  assert.deepEqual([f.report().heldCents, f.report().sessions.attemptsHeld], [3000, 1]);
  // Stopping A below its reservation frees the difference.
  assert.equal((await f.session(a, { status: "done", spendCents: 800 })).status, 201);
  assert.deepEqual([f.report().spentCents, f.report().reservedCents, f.report().heldCents, f.report().committedCents, f.report().headroomCents], [800, 0, 3000, 3800, 1200]);
  // A retry that declares no budget inherits its cap (2000) and 2000 > 1200.
  const retry = await f.session(a, { status: "processing" });
  assert.equal(retry.status, 409); assert.equal(retry.json.error.code, "spend_allowance_exceeded");
  const retryFit = await f.session(a, { status: "processing", budget: { maxSpendCents: 1200 } });
  assert.equal(retryFit.status, 201);
  assert.equal(f.report().headroomCents, 0);
  // A stop above the cap still lands on the command path so actual spend is recorded.
  f.send("agent", T.SESSION_STOPPED, { workItemId: a, expectedRevision: f.state().workItems[a].revision, status: "failed", spendCents: 1300 });
  assert.deepEqual([f.report().spentCents, f.report().overCents], [2100, 100]);
  // Unknown spend never frees allowance: a stop with no report holds the declared cap.
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 6000, periodDays: 30 });
  assert.equal((await f.session(a, { status: "processing", budget: { maxSpendCents: 900 } })).status, 201);
  assert.equal((await f.session(a, { status: "failed" })).status, 201);
  assert.deepEqual([f.report().heldCents, f.report().sessions.attemptsHeld, f.report().headroomCents], [3900, 2, 0]);
  const held = await f.session(c, { status: "processing", budget: { maxSpendCents: 1 } });
  assert.equal(held.status, 409, "held spend blocks the next start");
  // The ledger is the same function the card uses.
  assert.equal(spendLedger(f.state(), { nowMs: f.clock.now, periodDays: 30 }).committedCents, f.report().committedCents);
});

test("period: closed attempts roll out of the window, live sessions always count, zero freezes starts", async t => {
  const f = await serve(t);
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 5000, periodDays: 1 });
  const a = f.propose("old run"), b = f.propose("long run");
  assert.equal((await f.session(a, { status: "processing", budget: { maxSpendCents: 4000 } })).status, 201);
  assert.equal((await f.session(a, { status: "done", spendCents: 4000 })).status, 201);
  assert.equal((await f.session(b, { status: "processing", budget: { maxSpendCents: 1000 } })).status, 201);
  assert.deepEqual([f.report().spentCents, f.report().reservedCents, f.report().headroomCents], [4000, 1000, 0]);
  f.clock.now += 2 * 86400000;
  assert.deepEqual([f.report().spentCents, f.report().reservedCents, f.report().headroomCents], [0, 1000, 4000], "the closed attempt left the period; the live one still reserves");
  assert.equal(f.report().period.days, 1);
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 0, periodDays: 1 });
  const frozen = await f.session(f.propose("frozen"), { status: "processing", budget: { maxSpendCents: 1 } });
  assert.equal(frozen.status, 409); assert.equal(frozen.json.error.code, "spend_allowance_exceeded");
  assert.equal((await f.session(b, { status: "done", spendCents: 900 })).status, 201, "stops still land under a zero allowance");
  assert.deepEqual([f.report().spentCents, f.report().overCents], [900, 900], "spend is attributed to the period it was measured in");
  // Removing the allowance restores the pre-allowance behaviour.
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: null });
  assert.equal((await f.session(f.propose("free"), { status: "processing" })).status, 201);
  // enforceSpendAllowance is inert without an allowance and for non-session commands.
  assert.equal(enforceSpendAllowance(f.state(), { type: T.MESSAGE_POSTED, data: {} }, f.clock.now), undefined);
});

test("two concurrent claims cannot both reserve the last of the allowance", async t => {
  const f = await serve(t);
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 3000, periodDays: 30 });
  const items = [f.propose("first"), f.propose("second"), f.propose("third")];
  const results = await Promise.all(items.map(workItemId => f.session(workItemId, { status: "processing", budget: { maxSpendCents: 2000 } })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409, 409], JSON.stringify(results.map(r => r.json?.error?.code ?? r.status)));
  assert.ok(results.filter(r => r.status === 409).every(r => r.json.error.code === "spend_allowance_exceeded"));
  assert.deepEqual([f.report().reservedCents, f.report().headroomCents, f.report().sessions.live], [2000, 1000, 1]);
});

test("route: members read it, only the owner sets it, and the body is strict", async t => {
  const f = await serve(t);
  const path = "/api/rooms/commons/spend-allowance";
  assert.equal((await f.request(path)).status, 401);
  assert.ok([401, 403].includes((await f.request(path, { method: "POST", data: { allowanceCents: 1 } })).status));
  const read = await f.request(path, { token: f.keys.agent });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { roomId: "commons", evaluatedThrough: f.store.room("commons").sequence, allowance: null, period: read.json.period,
    spentCents: 0, reservedCents: 0, heldCents: 0, committedCents: 0, sessions: { live: 0, unreserved: 0, attemptsCounted: 0, attemptsUnreported: 0, attemptsHeld: 0 }, headroomCents: null, overCents: 0 });
  assert.equal(read.json.period.days, 30);
  assert.equal((await f.request(`${path}?days=3`, { token: f.keys.agent })).status, 422);
  for (const token of [f.keys.guest, f.keys.agent]) {
    const denied = await f.request(path, { method: "POST", token, data: { allowanceCents: 5000, periodDays: 30 } });
    assert.equal(denied.status, 403); assert.equal(denied.json.error.code, "owner_required");
  }
  assert.equal(spendAllowance(f.state()), null, "a refused set leaves no trace");
  for (const data of [{}, { allowanceCents: "50" }, { allowanceCents: -5 }, { allowanceCents: 5000, periodDays: 400 }, { allowanceCents: 5000, extra: 1 }, { allowanceCents: null, periodDays: 30 }, { allowanceCents: 5000, requestId: "" }]) {
    const invalid = await f.request(path, { method: "POST", token: f.keys.owner, data });
    assert.equal(invalid.status, 422, JSON.stringify(data)); assert.equal(invalid.json.error.code, "invalid_spend_allowance");
  }
  const requestId = randomUUID();
  const set = await f.request(path, { method: "POST", token: f.keys.owner, data: { allowanceCents: 5000, requestId } });
  assert.equal(set.status, 201); assert.equal(set.json.event.type, T.ROOM_SPEND_ALLOWANCE_SET);
  assert.deepEqual(set.json.event.data, { allowanceCents: 5000, periodDays: 30 }, "the period defaults to 30 days");
  const again = await f.request(path, { method: "POST", token: f.keys.owner, data: { allowanceCents: 5000, requestId } });
  assert.equal(again.status, 200); assert.equal(again.json.duplicate, true);
  const conflict = await f.request(path, { method: "POST", token: f.keys.owner, data: { allowanceCents: 6000, requestId } });
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, "idempotency_conflict");
  const shown = await f.request(path, { token: f.keys.guest });
  assert.equal(shown.json.allowance.allowanceCents, 5000); assert.equal(shown.json.headroomCents, 5000);
  const cleared = await f.request(path, { method: "POST", token: f.keys.owner, data: { allowanceCents: null } });
  assert.equal(cleared.status, 201); assert.equal((await f.request(path, { token: f.keys.owner })).json.allowance, null);
  // The generic command path stays owner-only too.
  const viaCommands = await f.request("/api/rooms/commons/commands", { method: "POST", token: f.keys.guest, data: { id: randomUUID(), type: T.ROOM_SPEND_ALLOWANCE_SET, data: { allowanceCents: 1, periodDays: 1 } } });
  assert.equal(viaCommands.status, 422); assert.equal(viaCommands.json.error.code, "command_rejected");
});

test("agent room owner can set the existing room-wide allowance and non-owner malformed writes reveal no schema", async t => {
  const f = await serve(t);
  const path = "/api/rooms/commons/spend-allowance";
  // A non-owner sees the same refusal even when the body has invalid fields.
  for (const body of [{}, { unknown: "field" }, { allowanceCents: "not cents" }, { allowanceCents: 5000, extra: true }]) {
    const res = await f.request(path, { method: "POST", token: f.keys.agent, data: body });
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(res.json.error.code, "owner_required");
  }
  // Create an agent-owned room with the same event shape as self-serve
  // creation. Keep the owner ID stable through write and replay.
  const agentRoomId = "agent-allowance-test";
  const events = initialRoom(agentRoomId, "ai_allowance_owner");
  events[1].data.kind = "agent";
  events[1].data.identityId = "ai_allowance_owner";
  f.store.initialize(events);
  const agentKey = f.store.issueAccessKey(agentRoomId, "ai_allowance_owner");
  const before = f.store.room(agentRoomId).state.room.spendAllowance;
  assert.equal(before, undefined);
  const peerIdentity = f.store.identities.create("Allowance peer");
  f.store.identities.link(agentKey, agentRoomId, { identityId: peerIdentity.identityId, permissions: [] });
  // A #761 membership-administration grant is deliberately not spend authority.
  f.store.delegation.grant(agentKey, agentRoomId, { identityId: peerIdentity.identityId });
  assert.equal(f.store.delegation.hasGrant(agentRoomId, peerIdentity.identityId), true);
  for (const body of [{}, { allowanceCents: 5000, unexpected: 1 }]) {
    const outsider = await f.request(`/api/rooms/${agentRoomId}/spend-allowance`, { method: "POST", token: peerIdentity.secret, data: body });
    assert.equal(outsider.status, 403, "a room member who is not owner never reaches body validation");
    assert.equal(outsider.json.error.code, "owner_required");
  }
  const set = await f.request(`/api/rooms/${agentRoomId}/spend-allowance`, { method: "POST", token: agentKey, data: { allowanceCents: 5000, periodDays: 30 } });
  assert.equal(set.status, 201, JSON.stringify(set.json));
  const saved = f.store.room(agentRoomId).state.room.spendAllowance;
  assert.equal(saved.allowanceCents, 5000);
  assert.equal(saved.periodDays, 30);
  const replayed = replay(f.store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all(agentRoomId).map(row => JSON.parse(row.body)));
  assert.deepEqual(replayed.room.spendAllowance, saved);
  const report = spendAllowanceReport(f.store.room(agentRoomId).state, f.clock.now);
  assert.equal(report.headroomCents, 5000);
  assert.equal(report.committedCents, 0);
  const retry = await f.request(`/api/rooms/${agentRoomId}/spend-allowance`, { method: "POST", token: agentKey,
    data: { allowanceCents: 5000, periodDays: 30, requestId: "agent-owner-retry" } });
  assert.equal(retry.status, 201);
  const duplicate = await f.request(`/api/rooms/${agentRoomId}/spend-allowance`, { method: "POST", token: agentKey,
    data: { allowanceCents: 5000, periodDays: 30, requestId: "agent-owner-retry" } });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.duplicate, true);
  const final = spendAllowanceReport(f.store.room(agentRoomId).state, f.clock.now);
  assert.deepEqual([final.allowance.allowanceCents, final.headroomCents, final.committedCents], [5000, 5000, 0]);
  const original = f.state().room.spendAllowance;
  f.send("owner", T.ROOM_SPEND_ALLOWANCE_SET, { allowanceCents: 5000, periodDays: 30 });
  const humanReport = f.report();
  assert.deepEqual([humanReport.allowance.allowanceCents, humanReport.headroomCents, humanReport.committedCents],
    [final.allowance.allowanceCents, final.headroomCents, final.committedCents]);
  assert.equal(original, undefined, "the existing human room was not mutated until its owner acted");
});
