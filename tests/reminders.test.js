import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomClient } from "../src/client.js";
import { EVENT_TYPES as T } from "../src/events.js";
import { reminderLimits } from "../server/reminders.mjs";
import { localReminderTime, reminderTime, formatReminderTime } from "../src/reminder-time.js";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now(); f.store.now = () => at; f.advance = ms => { at += ms; };
  f.request = (extra = {}) => ({ requestId: randomUUID(), workItemId: "test-handoff", expectedRevision: 0, action: "schedule", dueAt: at + 3600000, ...extra });
  f.read = (actor = "owner") => f.store.reminders.list(f.keys[actor], "commons");
  f.save = (request, actor = "owner") => f.store.reminders.mutate(f.keys[actor], "commons", request);
  f.send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  f.work = () => f.store.room("commons").state.workItems["test-handoff"];
  f.mutate = (type, data = {}, actor = "producer") => f.send(type, { workItemId: "test-handoff", expectedRevision: f.work().revision, ...data }, actor);
  f.cancel = revision => f.save({ requestId: randomUUID(), workItemId: "test-handoff", expectedRevision: revision, action: "cancel" });
  return f;
}

test("private reminders persist per member without changing shared state, events or cursors", t => {
  const f = fixture(t), snapshot = f.store.snapshot(f.keys.owner, "commons");
  const request = f.request({ requestId: "same-member-local-id" });
  f.save(request); f.save(request, "guest"); f.save(request, "producer");
  assert.equal(f.read().reminders.length, 1); assert.equal(f.read("reviewer").reminders.length, 0);
  assert.equal(f.read("guest").viewerId, "guest"); assert.equal(f.read("producer").viewerId, "producer");
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), snapshot);
  const before = f.read().reminders;
  f.store.markCaughtUp(f.keys.owner, "commons", snapshot.sequence);
  assert.deepEqual(f.read().reminders, before, "acknowledging shared history never dismisses a private reminder");
  f.store.close(); f.store = new RoomStore(join(f.directory, "room.sqlite"));
  assert.deepEqual(f.read().reminders, before);
});

test("exact retries return historical receipts plus current state, never reactivate cancellation", t => {
  const f = fixture(t), request = f.request(), first = f.save(request);
  f.advance(7200000); f.cancel(1);
  const retry = f.save(request);
  assert.equal(retry.duplicate, true); assert.deepEqual(retry.receipt, first.receipt);
  assert.equal(retry.reminders[0].state, "cancelled"); assert.equal(retry.reminders[0].revision, 2);
  assert.throws(() => f.save({ ...request, dueAt: request.dueAt + 1 }), { code: "idempotency_conflict" });
  assert.throws(() => f.save(f.request()), { code: "stale_reminder" });
  assert.equal(f.save(f.request({ expectedRevision: 2 })).reminders[0].revision, 3);
});

test("validation is exact, bounded and atomic; stale writes cannot replace newer reminders", t => {
  const f = fixture(t), initial = f.request();
  for (const change of [{ memberId: "guest" }, { action: "delete" }, { expectedRevision: -1 }, { dueAt: 0 }, { dueAt: 1.5 }, { dueAt: f.store.now() + reminderLimits.horizon + 1 }, { workItemId: "missing" }, { workItemId: "__proto__" }]) {
    assert.throws(() => f.save({ ...initial, ...change }));
    assert.equal(f.read().reminders.length, 0);
  }
  const missing = { ...initial }; delete missing.requestId; assert.throws(() => f.save(missing));
  f.save(initial);
  assert.throws(() => f.save(f.request()), { code: "stale_reminder" });
  assert.equal(f.read().reminders[0].dueAt, initial.dueAt);
});

test("receipt storage failure rolls back the reminder; immutable receipts fail closed on reopen", t => {
  const f = fixture(t), request = f.request();
  f.store.db.exec("CREATE TRIGGER test_receipt_failure BEFORE INSERT ON private_reminder_commands BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  assert.throws(() => f.save(request), /synthetic receipt failure/);
  assert.equal(f.read().reminders.length, 0);
  f.store.db.exec("DROP TRIGGER test_receipt_failure"); f.save(request);
  assert.throws(() => f.store.db.exec("UPDATE private_reminder_commands SET response=response"), /immutable/);
  assert.throws(() => f.store.db.exec("DELETE FROM private_reminder_commands"), /retained/);
  f.store.db.exec("DROP TRIGGER private_reminder_commands_no_update");
  for (const readOnly of [false, true]) assert.throws(() => new RoomStore(join(f.directory, "room.sqlite"), { readOnly }), /reminder schema requires operator reconciliation/);
});

test("review and owner approval retire reminders only on genuine resolution; reopening never resurrects them", t => {
  const f = fixture(t), request = f.request(); f.save(request); f.save(request, "guest");
  f.mutate(T.WORK_ACCEPTED);
  f.mutate(T.WORK_COMPLETED, { summary: "Agenda", evidenceUrl: "https://example.invalid/agenda", evidenceVersion: "v1", producerId: "producer", nextAction: "Review" });
  assert.equal(f.read().reminders[0].state, "active");
  const evidence = { completionEventId: f.work().receipt.eventId, evidenceVersion: "v1" };
  f.mutate(T.VERIFICATION_RECORDED, { ...evidence, result: "pass", summary: "Checked" }, "reviewer");
  assert.equal(f.read().reminders[0].state, "active");
  const beforeApproval = f.store.snapshot(f.keys.owner, "commons");
  f.store.db.exec("CREATE TRIGGER test_retirement_failure BEFORE UPDATE ON private_reminders BEGIN SELECT RAISE(ABORT,'synthetic retirement failure'); END");
  assert.throws(() => f.mutate(T.OWNER_DECISION_RECORDED, { ...evidence, decision: "approved", reason: "Accepted" }, "owner"), /synthetic retirement failure/);
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), beforeApproval);
  f.store.db.exec("DROP TRIGGER test_retirement_failure");
  f.mutate(T.OWNER_DECISION_RECORDED, { ...evidence, decision: "approved", reason: "Accepted" }, "owner");
  for (const actor of ["owner", "guest"]) assert.equal(f.read(actor).reminders[0].state, "resolved");
  assert.equal(f.save(request).reminders[0].state, "resolved", "historical retry cannot reactivate");
  assert.throws(() => f.save(f.request({ expectedRevision: 2 })), { code: "work_resolved" });
  f.mutate(T.VERIFICATION_RECORDED, { ...evidence, result: "fail", summary: "Correction needed", nextAction: "Revise" }, "reviewer");
  assert.equal(f.read().reminders[0].state, "resolved");
  assert.equal(f.save(f.request({ expectedRevision: 2 })).reminders[0].state, "active", "explicit new reminder is allowed on reopened work");
});

test("superseding work retires reminders without copying them to replacement work", t => {
  const f = fixture(t); f.save(f.request());
  f.send(T.WORK_PROPOSED, { workItemId: "replacement", title: "Replacement", definitionOfDone: "New outcome", accountableMemberId: "owner", mode: "read" });
  f.mutate(T.WORK_SUPERSEDED, { supersededByWorkItemId: "replacement", reason: "Replanned" }, "owner");
  assert.equal(f.read().reminders.length, 1); assert.equal(f.read().reminders[0].state, "resolved");
});

test("logout and key rotation preserve preferences; revoked membership retires them permanently", t => {
  const f = fixture(t), session = f.store.createSession(f.keys.guest);
  f.save(f.request(), "guest"); f.store.revoke(session.token);
  assert.equal(f.read("guest").reminders[0].state, "active");
  f.keys.guest = f.store.issueAccessKey("commons", "guest");
  assert.equal(f.read("guest").reminders[0].state, "active");
  f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false });
  assert.throws(() => f.read("guest"), { status: 401 });
  f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "guest", expectedMemberRevision: 1, permissions: [], active: true });
  f.keys.guest = f.store.issueAccessKey("commons", "guest");
  assert.equal(f.read("guest").reminders[0].state, "resolved");
});

test("account suspension retires account reminders atomically", t => {
  const f = fixture(t); f.save(f.request(), "guest");
  const account = f.store.accountForMember("commons", "guest");
  f.store.changeAccountAccess(account.id, { expectedRevision: 0, active: false, reason: "Synthetic suspension" });
  assert.throws(() => f.read("guest"), { status: 401 });
  f.store.changeAccountAccess(account.id, { expectedRevision: 1, active: true, reason: "Synthetic restoration" });
  f.keys.guest = f.store.issueAccessKey("commons", "guest");
  assert.equal(f.read("guest").reminders[0].state, "resolved");
});

test("receipt capacity never prevents cancellation or exact retries", t => {
  const f = fixture(t), request = f.request(); f.save(request);
  f.store.transaction(() => {
    const insert = f.store.db.prepare("INSERT INTO private_reminder_commands VALUES('commons','owner',?,?,?)");
    for (let i = 1; i < reminderLimits.receipts; i++) insert.run(`synthetic-${i}`, "fixture", "{}");
  });
  assert.throws(() => f.save(f.request({ expectedRevision: 1 })), { code: "reminder_limit" });
  assert.equal(f.cancel(1).reminders[0].state, "cancelled");
  assert.equal(f.save(request).duplicate, true);
});

test("active capacity rejects new reminders but permits rescheduling and removing existing ones", t => {
  const f = fixture(t); f.save(f.request());
  for (let i = 1; i <= reminderLimits.active; i++) {
    const workItemId = `capacity-${i}`;
    f.send(T.WORK_PROPOSED, { workItemId, title: "Synthetic capacity", definitionOfDone: "Test only", accountableMemberId: "owner", mode: "read" });
    if (i < reminderLimits.active) f.save(f.request({ workItemId }));
  }
  const extra = f.request({ workItemId: `capacity-${reminderLimits.active}` });
  assert.throws(() => f.save(extra), { code: "reminder_limit" });
  f.save(f.request({ expectedRevision: 1 })); f.cancel(2);
  assert.equal(f.save(extra).duplicate, false);
});

test("real HTTP agents own only their reminders; responses are uncached and malformed writes fail", async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = new RoomAgentClient({ origin, roomId: "commons", token: f.keys.producer });
  const request = f.request(), initial = await agent.snapshot();
  assert.equal((await agent.reminders(request)).duplicate, false);
  assert.equal((await agent.reminders(request)).duplicate, true);
  assert.equal((await agent.reminders()).viewerId, "producer");
  assert.equal(f.read().reminders.length, 0);
  assert.deepEqual(await agent.snapshot(), initial);
  const url = `${origin}/api/rooms/commons/reminders`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${f.keys.producer}` } });
  assert.match(response.headers.get("cache-control"), /no-store/);
  await assert.rejects(agent.reminders({ ...request, memberId: "owner" }), { code: "invalid_reminder" });
  const login = await fetch(`${origin}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: f.keys.owner }) });
  const cookie = login.headers.get("set-cookie").split(";")[0], session = await login.json();
  const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json" };
  const post = additional => fetch(url, { method: "POST", headers: { ...headers, ...additional }, body: JSON.stringify(f.request()) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ "X-CSRF-Token": session.csrf, Origin: "https://elsewhere.invalid" })).status, 403);
  assert.equal((await post({ "X-CSRF-Token": session.csrf, "X-Session-Binding": "0".repeat(64) })).status, 409);
  assert.equal((await post({ "X-CSRF-Token": session.csrf, "X-Session-Binding": session.sessionBinding })).status, 201);
});

test("browser reminder requests suppress late successes and errors from an obsolete identity", async () => {
  for (const status of [200, 401]) {
    let release;
    const client = new RoomClient({ fetcher: () => new Promise(resolve => { release = resolve; }) });
    const identity = id => ({ member: { id }, account: { id: `account-${id}`, authEpoch: 0 }, roomId: "commons", sessionBinding: `binding-${id}` });
    client.session = identity("old");
    const flight = client.reminders(); client.disconnect(); client.session = identity("new");
    release({ ok: status === 200, status, json: async () => ({ error: { message: "old error" }, reminders: [] }) });
    assert.equal(await flight, null); assert.equal(client.session.member.id, "new");
  }
});

test("local time parsing rejects invalid dates and DST gaps, shows offsets and schedules calendar tomorrow", () => {
  const previous = process.env.TZ; process.env.TZ = "America/Los_Angeles";
  try {
    for (const value of ["2026-02-30T12:00", "2026-03-08T02:30", "2026-01-01T24:00", "junk"]) assert.ok(Number.isNaN(localReminderTime(value)));
    const repeated = localReminderTime("2026-11-01T01:30");
    assert.match(formatReminderTime(repeated), /UTC−07:00/);
    const now = localReminderTime("2026-03-07T09:00");
    assert.equal(reminderTime("tomorrow", now), localReminderTime("2026-03-08T09:00"));
    assert.equal(reminderTime("tomorrow", now) - now, 23 * 3600000);
    assert.equal(reminderTime("hour", now), now + 3600000);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
