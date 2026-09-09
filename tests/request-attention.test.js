import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { currentAttention } from "../client/attention-inbox.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { requestContextNotices } from "../client/assignment-watcher.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-request-attention-")), store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  for (const memberId of ["agent", "other"]) {
    send("owner", "member.added", { memberId, displayName: memberId, kind: "agent", accountableHumanId: "owner", permissions: ["accept_work", "complete_work"] });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  const client = { snapshot: async () => store.snapshot(keys.agent, "commons"), changes: async (after, limit) => store.eventsAfter(keys.agent, "commons", after, limit) };
  const config = { client, origin: "http://127.0.0.1:12345", roomId: "commons", directory: join(directory, "v3"), version: 3 };
  const post = (actor, data) => send(actor, "message.posted", { messageId: crypto.randomUUID(), body: "PRIVATE synthetic body", ...data });
  return { directory, store, keys, client, config, send, post,
    pull: options => currentAttention({ ...config, ...options }),
    ack: (noticeId, options) => currentAttention({ ...config, noticeId, ...options }),
    open: (actor = "owner", recipient = "agent") => post(actor, { toMemberId: recipient, requestKind: "reply" }),
    respond: (q, outcome = "answered") => post(q.event.data.toMemberId, { replyToId: q.event.data.messageId,
      responseToRequestId: q.event.data.messageId, expectedRequestRevision: 0, responseOutcome: outcome,
      toMemberId: q.event.actorId, workItemId: null, contextEventId: q.event.id, contextSequence: q.sequence }),
    cancel: q => send(q.event.actorId, "reply_request.cancelled", { requestMessageId: q.event.data.messageId, expectedRequestRevision: 0, reason: "No longer needed" }),
    access: (memberId, active) => {
      const member = store.room("commons").state.members[memberId];
      return send("owner", "member.access_changed", { memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active });
    } };
}
const inspect = (directory, fn) => { const db = new DatabaseSync(join(directory, "watch.sqlite")); try { return fn(db); } finally { db.close(); } };
const rows = directory => inspect(directory, db => ({ checkpoint: db.prepare("SELECT * FROM checkpoint").all(), notices: db.prepare("SELECT * FROM attention ORDER BY work_id").all() }));

test("v3 incoming requests survive reconnect; local acknowledgement does not answer or mark read", async t => {
  const f = fixture(t), q = f.open(); f.open("owner", "other");
  f.post("owner", { toMemberId: "agent", body: "An ordinary directed message, not a request" });
  const before = await f.client.snapshot(), first = await f.pull(), n = first.items[0];
  assert.equal(first.schemaVersion, 3); assert.equal(first.pending, 1); assert.equal(n.condition, "reply_requested");
  assert.equal(n.request.id, q.event.data.messageId);
  assert.deepEqual(n.nextRead, { tool: "room_read_request", arguments: { requestMessageId: q.event.data.messageId } });
  assert.deepEqual((await f.pull()).items, first.items);
  assert.equal((await f.ack(n.id)).status, "acknowledged");
  assert.equal((await f.ack(n.id)).status, "already_acknowledged"); assert.equal((await f.pull()).pending, 0);
  assert.deepEqual(await f.client.snapshot(), before);
  const persisted = readFileSync(join(f.config.directory, "watch.sqlite"));
  assert.equal(persisted.includes(Buffer.from("PRIVATE synthetic body")), false);
  for (const token of Object.values(f.keys)) assert.equal(persisted.includes(Buffer.from(token)), false);
});

test("bounded v3 pulls retain unseen requests; acknowledging one only reveals the next slot", async t => {
  const f = fixture(t);
  for (let i = 0; i < 23; i++) f.open();
  const first = await f.pull(); assert.equal(first.items.length, 20); assert.equal(first.pending, 23); assert.equal(first.hasMore, true);
  assert.deepEqual((await f.pull()).items, first.items);
  await f.ack(first.items[0].id);
  const second = await f.pull(); assert.equal(second.items.length, 20); assert.equal(second.pending, 22);
  assert.deepEqual(second.items.slice(0, 19), first.items.slice(1));
  assert.equal(first.items.some(n => n.id === second.items[19].id), false);
  for (const n of second.items) await f.ack(n.id);
  const last = await f.pull(); assert.equal(last.items.length, 2); assert.equal(last.hasMore, false);
});

test("new scoped clarification replaces a request notice; an obsolete acknowledgement cannot dismiss it", async t => {
  const f = fixture(t), q = f.open(), old = (await f.pull()).items[0]; await f.ack(old.id);
  f.post("owner", { body: "Unrelated update" }); assert.equal((await f.pull()).pending, 0);
  const clarification = f.post("owner", { replyToId: q.event.data.messageId, body: "New constraint" });
  assert.equal((await f.ack(old.id)).status, "no_longer_current");
  const fresh = (await f.pull()).items[0]; assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.request.contextEventId, clarification.event.id); assert.equal(fresh.reason, "changed");
  f.cancel(q); assert.equal((await f.ack(fresh.id)).status, "no_longer_current"); assert.equal((await f.pull()).pending, 0);
});

test("outgoing answers and declines are discoverable even when completed between polls", async t => {
  const f = fixture(t), answer = f.open("agent", "other"), decline = f.open("agent", "owner"), cancelled = f.open("agent", "owner");
  assert.equal((await f.pull()).pending, 0);
  const a = f.respond(answer), d = f.respond(decline, "declined"); f.cancel(cancelled);
  const notices = (await f.pull()).items; assert.equal(notices.length, 2);
  assert.deepEqual(notices.map(n => n.condition).sort(), ["answered", "declined"]);
  assert.deepEqual(notices.map(n => n.request.terminalEventId).sort(), [a.event.id, d.event.id].sort());
  for (const n of notices) await f.ack(n.id);
  assert.equal((await f.pull()).pending, 0);
  f.post("owner", { replyToId: answer.event.data.messageId, body: "Ordinary post-close remark" });
  assert.equal((await f.pull()).pending, 0, "closed request attention is not a discussion subscription");
  f.access("other", false);
  assert.equal((await f.pull()).pending, 0, "membership changes do not renotify an already observed answer");
});

test("outgoing unavailable recipient condition clears on reactivation and returns with a new ID", async t => {
  const f = fixture(t), q = f.open("agent", "other"); assert.equal((await f.pull()).pending, 0);
  f.access("other", false);
  const unavailable = (await f.pull()).items[0]; assert.equal(unavailable.condition, "recipient_unavailable");
  assert.equal(unavailable.request.recipientAvailable, false);
  f.access("other", true); assert.equal((await f.ack(unavailable.id)).status, "no_longer_current");
  assert.equal((await f.pull()).pending, 0);
  f.access("other", false); const again = (await f.pull()).items[0]; assert.notEqual(again.id, unavailable.id);
  f.cancel(q); assert.equal((await f.pull()).pending, 0);
});

test("a response during the second observation suppresses an obsolete incoming notice", async t => {
  const f = fixture(t), q = f.open(); let reads = 0;
  const client = { ...f.client, snapshot: async () => { if (++reads === 2) f.respond(q); return f.client.snapshot(); } };
  assert.equal((await f.pull({ client })).pending, 0); assert.equal(reads, 2);
});

test("missing server contract never initializes v3 or clears retained notices; malformed requests also refuse", async t => {
  const f = fixture(t); f.open();
  const unsupported = { ...f.client, snapshot: async () => { const s = await f.client.snapshot(); delete s.replyRequestContractVersion; return s; } };
  await assert.rejects(f.pull({ client: unsupported }), { code: "request_context_unavailable" });
  assert.equal(existsSync(f.config.directory), false);
  for (const snapshot of [null, undefined, {}]) {
    await assert.rejects(f.pull({ client: { ...f.client, snapshot: async () => snapshot } }), { code: "request_context_unavailable" });
    assert.equal(existsSync(f.config.directory), false);
  }
  const n = (await f.pull()).items[0], before = rows(f.config.directory);
  await assert.rejects(f.ack(n.id, { client: unsupported }), { code: "request_context_unavailable" });
  assert.deepEqual(rows(f.config.directory), before);
  for (const damage of [s => s.replyRequestContractVersion = 2, s => s.state.replyRequests = null,
    s => s.state.replyRequests = [], s => Object.values(s.state.replyRequests)[0].revision++,
    s => delete s.state.members.owner]) {
    const s = await f.client.snapshot(); damage(s);
    await assert.rejects(f.pull({ client: { ...f.client, snapshot: async () => s } }));
    assert.deepEqual(rows(f.config.directory), before);
  }
});

test("v1 and v2 stay separate, v2 default ignores requests, and v3 status/stop do not acknowledge", async t => {
  const f = fixture(t); f.open(); const n = (await f.pull()).items[0], before = rows(f.config.directory);
  for (const version of [1, 2]) assert.throws(() => new WatchJournal(f.config.directory, { version }), { code: "state_schema_mismatch" });
  await assert.rejects(f.pull({ version: 2 }), { code: "state_schema_mismatch" });
  assert.deepEqual(rows(f.config.directory), before);
  const v2 = join(f.directory, "v2"); assert.equal((await f.pull({ directory: v2, version: 2 })).pending, 0);
  const prior = rows(v2); await assert.rejects(f.pull({ directory: v2 }), { code: "state_schema_mismatch" }); assert.deepEqual(rows(v2), prior);
  const holder = new WatchJournal(f.config.directory, { version: 3 });
  assert.throws(() => holder.ack(n.id), { code: "explicit_ack_required" });
  const observer = new WatchJournal(f.config.directory, { acquire: false });
  assert.equal(observer.status().schemaVersion, 3); assert.equal(observer.status().pending, 1);
  assert.equal(observer.requestStop().state, "stop_requested"); assert.equal(holder.shouldStop(), true);
  observer.close(); holder.close(); assert.equal((await f.pull()).items[0].id, n.id);
});

test("changed identity, anchor or ended access cannot reveal or dismiss retained request notices", async t => {
  const f = fixture(t); f.open(); const n = (await f.pull()).items[0], before = rows(f.config.directory);
  await assert.rejects(f.ack(n.id, { client: { ...f.client, snapshot: async () => f.store.snapshot(f.keys.other, "commons") } }), { code: "identity_changed" });
  await assert.rejects(f.pull({ client: { ...f.client, changes: async (after, limit) => {
    const p = await f.client.changes(after, limit); if (after > 0) p.events[0].event.id = "different-anchor"; return p;
  } } }), { code: "history_changed" });
  f.store.revoke(f.keys.agent); await assert.rejects(f.ack(n.id), { code: "unauthenticated" });
  assert.deepEqual(rows(f.config.directory), before);
});

test("v3 validates saved signatures, metadata, identities and read pointers before disclosure", async t => {
  const f = fixture(t); f.open(); f.open(); await f.pull(); const before = rows(f.config.directory);
  for (const damage of [n => n.nextRead.tool = "room_respond_to_request", n => n.request.contextEventId = "different-context",
    n => n.condition = "answered", n => n.request.body = "Private prose", n => n.body = "Private prose", n => n.subject = "unknown",
    n => n.id = JSON.parse(before.notices[0].notice).id]) {
    inspect(f.config.directory, db => {
      for (const row of before.notices) db.prepare("UPDATE attention SET notice=? WHERE work_id=?").run(row.notice, row.work_id);
      const row = before.notices[1], notice = JSON.parse(row.notice); damage(notice);
      db.prepare("UPDATE attention SET notice=? WHERE work_id=?").run(JSON.stringify(notice), row.work_id);
    });
    const damaged = rows(f.config.directory);
    await assert.rejects(f.pull(), { code: "state_schema_mismatch" }); assert.deepEqual(rows(f.config.directory), damaged);
  }
});

test("v3 holds 500 work plus 500 request notices and instructions, reopens and rejects overflow atomically", async t => {
  const f = fixture(t); f.open();
  f.send("owner", "work.proposed", { workItemId: "work", title: "Synthetic work", definitionOfDone: "Draft", accountableMemberId: "agent", mode: "read" });
  f.send("owner", "room.charter_updated", { expectedRevision: 0, purpose: "Private room instructions", outputs: null, boundaries: null, escalation: null });
  await f.pull(); const snapshot = await f.client.snapshot(), item = snapshot.state.workItems.work, request = Object.values(snapshot.state.replyRequests)[0];
  snapshot.state.workItems = {}; snapshot.state.replyRequests = {};
  for (let i = 0; i < 500; i++) {
    snapshot.state.workItems["work-" + i] = { ...item, id: "work-" + i };
    snapshot.state.replyRequests["request-" + i] = { ...request, id: "request-" + i };
  }
  const notices = requestContextNotices(snapshot); assert.equal(notices.size, 1001);
  let journal = new WatchJournal(f.config.directory, { version: 3 }), state = journal.state();
  journal.reconcile(state.binding, { sequence: state.sequence, eventId: state.eventId }, notices, Date.now());
  assert.equal(journal.status().pending, 1001); assert.equal(journal.pending(20).length, 20); journal.close();
  journal = new WatchJournal(f.config.directory, { version: 3 }); assert.equal(journal.status().pending, 1001);
  const before = rows(f.config.directory); notices.set("overflow", notices.values().next().value);
  assert.throws(() => journal.reconcile(state.binding, { sequence: state.sequence, eventId: state.eventId }, notices, Date.now()), { code: "attention_capacity" });
  journal.close(); assert.deepEqual(rows(f.config.directory), before);
});
