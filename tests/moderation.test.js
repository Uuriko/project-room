// Issue #6 E4: report a message to the room owner; mute a member for yourself.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { mutedEvent, reportLimits } from "../server/moderation.mjs";
import { classifyCommand, surfaceClass } from "../server/action-classes.mjs";
import { EVENT_TYPES as T, replay, isMutedBy, mutedMemberIds } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-moderation-"));
  let clock = Date.parse("2026-09-14T12:00:00Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const [memberId, kind, permissions] of [["guest", "human", []], ["producer", "agent", ["accept_work"]], ["reviewer", "agent", ["verify"]]]) {
    send("owner", T.MEMBER_ADDED, { memberId, displayName: `Test ${memberId}`, kind, permissions, ...(kind === "agent" ? { accountableHumanId: "owner" } : {}) });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  const post = (actor, messageId, body = `message ${messageId}`) => { send(actor, T.MESSAGE_POSTED, { messageId, body }); return messageId; };
  const state = () => store.room("commons").state;
  const rejects = (fn, pattern, status) => {
    try { fn(); } catch (error) { assert.equal(error.status, status, error.message); assert.match(error.message, pattern); return error; }
    assert.fail("expected a rejection");
  };
  return { store, keys, send, post, state, rejects, advance: ms => { clock += ms; } };
}

async function serve(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (key, route, init = {}) => {
    const res = await fetch(`${origin}/api/rooms/commons/${route}`, { ...init, headers: { Origin: origin, ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...(init.headers || {}) } });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; } // the export route answers NDJSON
    return { status: res.status, body, text };
  };
  return { origin, call, post: (key, route, data) => call(key, route, { method: "POST", body: JSON.stringify(data) }) };
}

test("mute is the muter's own reversible preference: it hides nothing for others and moves no authority", t => {
  const f = fixture(t);
  f.post("producer", "m1");
  const before = f.state().members.guest.revision;
  const first = f.send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: true });
  assert.equal(first.event.type, T.MEMBER_MUTE_SET); assert.equal(first.event.actorId, "guest");
  assert.deepEqual(f.state().members.guest.mutedMemberIds, ["producer"]);
  assert.equal(isMutedBy(f.state(), "guest", "producer"), true);
  assert.equal(isMutedBy(f.state(), "owner", "producer"), false, "only the muter is affected");
  assert.equal(isMutedBy(f.state(), "producer", "guest"), false, "mute is one-directional");
  assert.equal(f.state().members.guest.revision, before, "a preference never moves member.revision");
  assert.equal(f.state().members.producer.mutedMemberIds, undefined);
  // Idempotent and additive.
  f.send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: true });
  f.send("guest", T.MEMBER_MUTE_SET, { memberId: "reviewer", muted: true });
  assert.deepEqual(mutedMemberIds(f.state(), "guest"), ["producer", "reviewer"]);
  // The muted member keeps every permission and can still post, mention and reply.
  f.post("producer", "m2", "still posting @guest");
  assert.deepEqual(f.state().members.producer.permissions, ["accept_work"]);
  assert.equal(f.state().messages.filter(m => m.authorId === "producer").length, 2);
  // Feed composition: a viewer's derived feed skips a muted actor's events, nobody else's.
  const posted = f.state().messages.find(m => m.id === "m2");
  assert.equal(mutedEvent(f.state(), "guest", { actorId: posted.authorId, type: T.MESSAGE_POSTED }), true);
  assert.equal(mutedEvent(f.state(), "owner", { actorId: posted.authorId, type: T.MESSAGE_POSTED }), false);
  assert.equal(mutedEvent(f.state(), "guest", { actorId: "owner" }), false);
  // Reversible: unmuting the last author removes the field entirely.
  f.send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: false });
  assert.deepEqual(mutedMemberIds(f.state(), "guest"), ["reviewer"]);
  f.send("guest", T.MEMBER_MUTE_SET, { memberId: "reviewer", muted: false });
  assert.equal(f.state().members.guest.mutedMemberIds, undefined);
  assert.deepEqual(mutedMemberIds(f.state(), "guest"), []);
  f.send("guest", T.MEMBER_MUTE_SET, { memberId: "reviewer", muted: false }); // unmuting twice is harmless
  // Replay of the exported log reproduces the preference exactly.
  f.send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: true });
  const replayed = replay([...f.store.exportEvents(f.keys.owner, "commons")].map(line => line.event));
  assert.deepEqual(replayed.members.guest.mutedMemberIds, ["producer"]);
  assert.equal(classifyCommand(T.MEMBER_MUTE_SET), "draft", "a mute addresses nobody and grants nothing");
});

test("mute rejects yourself, the owner, unknown members and non-boolean flags", t => {
  const f = fixture(t);
  f.rejects(() => f.send("guest", T.MEMBER_MUTE_SET, { memberId: "guest", muted: true }), /cannot mute yourself/, 422);
  f.rejects(() => f.send("guest", T.MEMBER_MUTE_SET, { memberId: "owner", muted: true }), /owner cannot be muted/, 422);
  f.rejects(() => f.send("guest", T.MEMBER_MUTE_SET, { memberId: "nobody", muted: true }), /Unknown member/, 422);
  f.rejects(() => f.send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: "yes" }), /Invalid field: muted/, 422);
  f.rejects(() => f.send("guest", T.MEMBER_MUTE_SET, { memberId: "producer" }), /missing muted/, 422);
  f.rejects(() => f.send("guest", T.MEMBER_MUTE_SET, { memberId: "producer", muted: true, extra: 1 }), /Unexpected field/, 422);
  assert.equal(f.state().members.guest.mutedMemberIds, undefined);
  // Muting a member whose access ended is allowed (their old messages are still in the room).
  f.send("owner", T.MEMBER_ACCESS_CHANGED, { memberId: "reviewer", expectedMemberRevision: f.state().members.reviewer.revision, permissions: ["verify"], active: false });
  f.send("guest", T.MEMBER_MUTE_SET, { memberId: "reviewer", muted: true });
  assert.deepEqual(f.state().members.guest.mutedMemberIds, ["reviewer"]);
  // A member whose access ended cannot record a preference.
  f.rejects(() => f.send("reviewer", T.MEMBER_MUTE_SET, { memberId: "producer", muted: true }), /./, 401);
});

test("reports: any member reports another member's message once; only the owner lists them, with the reporter's name", async t => {
  const f = fixture(t);
  const http = await serve(t, f);
  f.post("producer", "target", "please look at this");
  f.post("guest", "guest-post", "a human post");
  const first = await http.post(f.keys.guest, "reports", { messageId: "target", reason: "  Off-topic and repeated.  " });
  assert.equal(first.status, 201);
  assert.equal(first.body.duplicate, false); assert.equal(first.body.viewerId, "guest");
  assert.deepEqual(Object.keys(first.body.report).sort(), ["createdAt", "id", "messageId", "reason"], "the reporter's receipt names no one");
  assert.equal(first.body.report.reason, "Off-topic and repeated.");
  const again = await http.post(f.keys.guest, "reports", { messageId: "target", reason: "different words" });
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true); assert.equal(again.body.report.id, first.body.report.id);
  assert.equal(again.body.report.reason, "Off-topic and repeated.", "the first reason stands; nothing is overwritten");
  const agent = await http.post(f.keys.reviewer, "reports", { messageId: "target", reason: "Agent-side report." });
  assert.equal(agent.status, 201);
  const ownerOnGuest = await http.post(f.keys.owner, "reports", { messageId: "guest-post", reason: "Owner can report too." });
  assert.equal(ownerOnGuest.status, 201);
  // Owner list: reporter and message resolved from the room.
  const list = await http.call(f.keys.owner, "reports");
  assert.equal(list.status, 200); assert.equal(list.body.viewerId, "owner");
  assert.equal(list.body.reports.length, 3);
  const byGuest = list.body.reports.find(r => r.reporterId === "guest");
  assert.equal(byGuest.messageId, "target"); assert.equal(byGuest.authorId, "producer");
  assert.deepEqual(byGuest.message, { authorId: "producer", body: "please look at this", createdAt: f.state().messages.find(m => m.id === "target").createdAt, deletedAt: null });
  assert.ok(list.body.reports.some(r => r.reporterId === "reviewer"));
  // Everyone else: 403, including the reporter and the reported author.
  for (const key of [f.keys.guest, f.keys.producer, f.keys.reviewer]) {
    const denied = await http.call(key, "reports");
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, "owner_required");
    assert.equal(denied.text.includes("Off-topic"), false);
  }
  assert.equal((await http.call(null, "reports")).status, 401);
  assert.equal((await http.post(null, "reports", { messageId: "target", reason: "x" })).status, 401);
  // A removed member cannot read or report.
  f.send("owner", T.MEMBER_ACCESS_CHANGED, { memberId: "reviewer", expectedMemberRevision: f.state().members.reviewer.revision, permissions: ["verify"], active: false });
  assert.equal((await http.post(f.keys.reviewer, "reports", { messageId: "guest-post", reason: "x" })).status, 401);
  // Reports live outside the shared log: no event, snapshot or export carries them.
  const events = await http.call(f.keys.guest, "events?after=0&limit=100");
  assert.equal(events.body.events.some(e => /report/i.test(e.event.type)), false);
  for (const key of [f.keys.owner, f.keys.guest]) {
    const exported = await http.call(key, "export");
    assert.equal(exported.status, 200);
    assert.equal(exported.text.includes("Off-topic"), false); assert.equal(exported.text.includes("Agent-side"), false);
    const snapshot = await http.call(key, "");
    assert.equal(snapshot.text.includes("Off-topic"), false);
  }
  assert.equal(surfaceClass("message-reports"), "act", "a report is addressed at the owner about another member");
});

test("reports validate their shape, refuse self-reports and unknown messages, and are rate limited per reporter", async t => {
  const f = fixture(t);
  const http = await serve(t, f);
  f.post("producer", "target");
  f.post("guest", "mine");
  const expect = async (data, status, code, pattern) => {
    const res = await http.post(f.keys.guest, "reports", data);
    assert.equal(res.status, status, JSON.stringify(res.body)); assert.equal(res.body.error.code, code);
    if (pattern) assert.match(res.body.error.message, pattern);
  };
  await expect({ messageId: "target" }, 422, "invalid_report");
  await expect({ messageId: "target", reason: "x", extra: true }, 422, "invalid_report");
  await expect({ messageId: "target", reason: "   " }, 422, "invalid_report", /why/);
  await expect({ messageId: "target", reason: 42 }, 422, "invalid_report");
  await expect({ messageId: "target", reason: "a".repeat(reportLimits.reasonLength + 1) }, 422, "invalid_report", /280 characters/);
  await expect({ messageId: "target", reason: `bad${String.fromCharCode(7)}control` }, 422, "invalid_report", /plain text/);
  await expect({ messageId: "", reason: "x" }, 422, "invalid_report");
  await expect({ messageId: "missing-message", reason: "x" }, 404, "message_not_found");
  await expect({ messageId: "mine", reason: "reporting myself" }, 422, "invalid_report", /own message/);
  assert.equal((await http.call(f.keys.owner, "reports")).body.reports.length, 0, "no rejected report was stored");
  assert.equal((await http.post(f.keys.guest, "reports", { messageId: "target", reason: "a".repeat(reportLimits.reasonLength) })).status, 201, "the maximum length is allowed");
  // Per reporter per hour: the 21st distinct report in an hour is refused; time passing frees it.
  for (let i = 1; i < reportLimits.perReporterPerHour; i++) {
    f.post("producer", `spam-${i}`);
    assert.equal((await http.post(f.keys.guest, "reports", { messageId: `spam-${i}`, reason: "spam" })).status, 201);
  }
  f.post("producer", "one-too-many");
  const limited = await http.post(f.keys.guest, "reports", { messageId: "one-too-many", reason: "spam" });
  assert.equal(limited.status, 429); assert.equal(limited.body.error.code, "report_limit");
  assert.equal((await http.post(f.keys.owner, "reports", { messageId: "one-too-many", reason: "another reporter" })).status, 201, "the limit is per reporter");
  assert.equal((await http.post(f.keys.guest, "reports", { messageId: "target", reason: "x" })).status, 200, "a duplicate receipt is not a new report");
  f.advance(3600001);
  assert.equal((await http.post(f.keys.guest, "reports", { messageId: "one-too-many", reason: "spam" })).status, 201);
  assert.equal((await http.call(f.keys.owner, "reports")).body.reports.length, reportLimits.perReporterPerHour + 2);
});

test("a report outlives the message and its author: deletion and removal keep the owner's record honest", t => {
  const f = fixture(t);
  f.post("producer", "target", "will be deleted");
  const receipt = f.store.moderation.report(f.keys.guest, "commons", { messageId: "target", reason: "Reported before deletion." });
  assert.equal(receipt.duplicate, false);
  f.rejects(() => f.store.moderation.list(f.keys.guest, "commons"), /Only the room owner/, 403);
  // The owner deletes the message: the report stays, the body does not.
  f.send("owner", T.MESSAGE_DELETED, { messageId: "target", expectedMessageRevision: 0 });
  let [report] = f.store.moderation.list(f.keys.owner, "commons").reports;
  assert.equal(report.reporterId, "guest"); assert.equal(report.message.body, null); assert.ok(report.message.deletedAt);
  // Reporting a deleted message is still allowed (the tombstone is a message in this room).
  assert.equal(f.store.moderation.report(f.keys.reviewer, "commons", { messageId: "target", reason: "Also saw it." }).duplicate, false);
  // The owner removes the author (the existing moderation actions): the report keeps who wrote it.
  f.send("owner", T.MEMBER_ACCESS_CHANGED, { memberId: "producer", expectedMemberRevision: f.state().members.producer.revision, permissions: ["accept_work"], active: false });
  [report] = f.store.moderation.list(f.keys.owner, "commons").reports.filter(r => r.reporterId === "guest");
  assert.equal(report.authorId, "producer"); assert.equal(report.message.authorId, "producer");
  // Import replaces history: a report pointing at a message that no longer exists says so instead of failing.
  const lines = [...f.store.exportEvents(f.keys.owner, "commons")].filter(line => line.event.type !== T.MESSAGE_POSTED && line.event.type !== T.MESSAGE_DELETED).map((line, i) => ({ sequence: i + 1, event: line.event }));
  f.store.importEvents(f.keys.owner, "commons", lines);
  [report] = f.store.moderation.list(f.keys.owner, "commons").reports.filter(r => r.reporterId === "guest");
  assert.equal(report.message, null); assert.equal(report.messageId, "target");
  // The report table is immutable: no update path exists.
  assert.throws(() => f.store.db.prepare("UPDATE message_reports SET reason='edited'").run(), /immutable/);
});
