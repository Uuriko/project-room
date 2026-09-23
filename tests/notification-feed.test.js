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
import { deriveNotifications, NOTIFICATION_TAIL } from "../server/notifications.mjs";

// B4: the feed is a read model over the event tail after the member's cursor.
// Preferences filter it, edits never duplicate, the cursor expires it, ended
// access returns 401/403 with no items, and reading never writes anything.
async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-notifications-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["steer", "accept_work", "complete_work", "verify"] });
  send(ownerKey, T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] });
  const mayaKey = store.issueAccessKey("commons", "maya"), agentKey = store.issueAccessKey("commons", "agent");
  // Consent-bound DMs: the owner's directed test message needs the agent's approval.
  store.dmConsents.request("commons", "owner", "agent", "test fixture");
  store.dmConsents.decide("commons", "agent", "owner", "approve");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const feed = async (token, query = "") => { const res = await request(`/api/rooms/commons/notifications${query}`, { token }); return { status: res.status, body: await res.json() }; };
  const prefs = (token, preferences) => send(token, T.NOTIFICATION_PREFERENCES_SET, { preferences });
  return { store, request, feed, send, prefs, ownerKey, mayaKey, agentKey };
}

const kinds = body => body.notifications.map(item => `${item.kind}:${item.messageId ?? item.workItemId}`);

test("mentions, replies and assignments appear; own actions and unrelated traffic do not", async t => {
  const { feed, send, ownerKey, mayaKey, agentKey } = await serve(t);
  send(agentKey, T.MESSAGE_POSTED, { messageId: "agent-hello", body: "Hello room" });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m1", body: "Can @Test agent take a look?" });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m2", body: "Directed without @", toMemberId: "agent" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "m3", body: "Replying to the agent", replyToId: "agent-hello" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "m4", body: "Unrelated chatter" });
  send(ownerKey, T.WORK_PROPOSED, { workItemId: "w1", title: "Agent work", definitionOfDone: "Done", accountableMemberId: "agent", mode: "read" });
  send(ownerKey, T.WORK_PROPOSED, { workItemId: "w2", title: "Maya work", definitionOfDone: "Done", accountableMemberId: "maya", mode: "read" });
  const { status, body } = await feed(agentKey);
  assert.equal(status, 200);
  assert.deepEqual(kinds(body), ["assignment:w1", "reply:m3", "mention:m2", "mention:m1"]);
  assert.equal(body.unread, 4);
  assert.equal(body.viewerId, "agent");
  assert.equal(body.cursor, 0);
  assert.deepEqual(body.preferences, { mentions: "all", replies: "all", work_updates: "all", announcements: "all" });
  // Work updates on work you are on: one item per work item, latest change wins.
  send(agentKey, T.WORK_ACCEPTED, { workItemId: "w1", expectedRevision: 0 });
  send(agentKey, T.WORK_STARTED, { workItemId: "w1", expectedRevision: 1 });
  send(mayaKey, T.WORK_ACCEPTED, { workItemId: "w2", expectedRevision: 0 });
  send(mayaKey, T.WORK_STARTED, { workItemId: "w2", expectedRevision: 1 });
  const owner = (await feed(ownerKey)).body;
  const w2 = owner.notifications.find(item => item.kind === "work_update" && item.workItemId === "w2");
  assert.ok(w2, "the proposer is involved in the work they proposed");
  assert.equal(w2.changes, 2);
  assert.equal(w2.eventType, T.WORK_STARTED);
  assert.equal(owner.notifications.filter(item => item.kind === "work_update").length, 2, "one work_update item per work item");
  assert.ok(!owner.notifications.some(item => item.actorId === "owner"), "your own actions never notify you");
});

test("mentions-only preference filters replies and work updates to items that address the member", async t => {
  const { feed, send, prefs, ownerKey, mayaKey, agentKey } = await serve(t);
  prefs(agentKey, { replies: "mentions_only", work_updates: "mentions_only" });
  send(agentKey, T.MESSAGE_POSTED, { messageId: "agent-hello", body: "Hello room" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "plain-reply", body: "Reply without addressing", replyToId: "agent-hello" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "addressed-reply", body: "Reply for @Test agent", replyToId: "agent-hello" });
  send(ownerKey, T.WORK_PROPOSED, { workItemId: "w1", title: "Agent work", definitionOfDone: "Done", accountableMemberId: "agent", mode: "read" });
  send(ownerKey, T.WORK_PROPOSED, { workItemId: "w2", title: "Maya work", definitionOfDone: "Done", accountableMemberId: "maya", verifierMemberId: "agent", independentVerificationRequired: true, mode: "read" });
  send(mayaKey, T.WORK_ACCEPTED, { workItemId: "w2", expectedRevision: 0 });
  let body = (await feed(agentKey)).body;
  assert.deepEqual(kinds(body), ["assignment:w2", "assignment:w1", "reply:addressed-reply"]);
  // mentions: none silences addressed messages but leaves replies and work alone.
  prefs(agentKey, { mentions: "none", replies: "all", work_updates: "all" });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "shout", body: "@Test agent ping" });
  body = (await feed(agentKey)).body;
  assert.ok(!body.notifications.some(item => item.kind === "mention"));
  assert.deepEqual(kinds(body).filter(k => k.startsWith("reply")), ["reply:addressed-reply", "reply:plain-reply"]);
  assert.ok(kinds(body).includes("work_update:w2"));
  // work_updates: none drops assignments and state changes together.
  prefs(agentKey, { work_updates: "none" });
  body = (await feed(agentKey)).body;
  assert.ok(!body.notifications.some(item => ["assignment", "work_update"].includes(item.kind)));
});

test("edits do not duplicate; the item follows the current body and a deletion removes it", async t => {
  const { feed, send, ownerKey, agentKey } = await serve(t);
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m1", body: "@Test agent please review" });
  send(ownerKey, T.MESSAGE_EDITED, { messageId: "m1", body: "@Test agent please review the agenda", expectedMessageRevision: 0 });
  send(ownerKey, T.MESSAGE_EDITED, { messageId: "m1", body: "@Test agent please review the final agenda", expectedMessageRevision: 1 });
  let body = (await feed(agentKey)).body;
  assert.deepEqual(kinds(body), ["mention:m1"]);
  assert.equal(body.notifications[0].changes, 1);
  // An edit that newly addresses the member surfaces one item, keyed by the message.
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m2", body: "no one addressed" });
  send(ownerKey, T.MESSAGE_EDITED, { messageId: "m2", body: "now for @Test agent", expectedMessageRevision: 0 });
  body = (await feed(agentKey)).body;
  assert.deepEqual(kinds(body), ["mention:m2", "mention:m1"]);
  // A tombstone hides the item with the body.
  send(ownerKey, T.MESSAGE_DELETED, { messageId: "m1", expectedMessageRevision: 2, reason: "retracted" });
  body = (await feed(agentKey)).body;
  assert.deepEqual(kinds(body), ["mention:m2"]);
});

test("items expire once the member's cursor passes them; later events start a fresh tail", async t => {
  const { feed, request, send, ownerKey, agentKey } = await serve(t);
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m1", body: "@Test agent first" });
  let body = (await feed(agentKey)).body;
  assert.equal(body.unread, 1);
  const caught = await request("/api/rooms/commons/cursor", { method: "POST", token: agentKey, data: { sequence: body.sequence } });
  assert.equal(caught.status, 200);
  body = (await feed(agentKey)).body;
  assert.equal(body.unread, 0);
  assert.deepEqual(body.notifications, []);
  assert.equal(body.cursor, body.sequence);
  assert.equal(body.basis.from, null);
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m2", body: "@Test agent second" });
  body = (await feed(agentKey)).body;
  assert.deepEqual(kinds(body), ["mention:m2"]);
  assert.equal(body.basis.from, body.sequence);
  assert.equal(body.basis.truncated, false);
  // Fetching never acknowledges: the cursor is where the explicit POST left it.
  assert.equal(body.cursor, body.sequence - 1);
});

test("a member whose access ended gets 401/403 and no stale items; unauthenticated reads are refused", async t => {
  const { store, feed, request, send, ownerKey, agentKey } = await serve(t);
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m1", body: "@Test agent before removal" });
  assert.equal((await feed(agentKey)).body.unread, 1);
  send(ownerKey, T.MEMBER_ACCESS_CHANGED, { memberId: "agent", expectedMemberRevision: 0, permissions: [], active: false });
  const revoked = await feed(agentKey);
  assert.ok([401, 403].includes(revoked.status), `expected 401/403, got ${revoked.status}`);
  assert.equal(revoked.body.notifications, undefined);
  assert.equal(revoked.body.unread, undefined);
  assert.throws(() => store.notifications.list(agentKey, "commons"), error => [401, 403].includes(error.status));
  const anonymous = await request("/api/rooms/commons/notifications");
  assert.equal(anonymous.status, 401);
  const bad = await request("/api/rooms/commons/notifications?limit=0", { token: ownerKey });
  assert.equal(bad.status, 422); assert.equal((await bad.json()).error.code, "invalid_notification_limit");
  const other = await request("/api/rooms/commons/notifications?kind=mention", { token: ownerKey });
  assert.equal(other.status, 422); assert.equal((await other.json()).error.code, "invalid_notification_selection");
  const repeated = await request("/api/rooms/commons/notifications?limit=1&limit=2", { token: ownerKey });
  assert.equal(repeated.status, 422); assert.equal((await repeated.json()).error.code, "invalid_notification_selection");
});

test("reading the feed grants no wake and changes no store row", async t => {
  const { store, feed, send, ownerKey, agentKey } = await serve(t);
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "m1", body: "@Test agent wake me?" });
  send(ownerKey, T.WORK_PROPOSED, { workItemId: "w1", title: "Agent work", definitionOfDone: "Done", accountableMemberId: "agent", mode: "read" });
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const dump = () => Object.fromEntries(tables.map(name => [name, store.db.prepare(`SELECT * FROM "${name}"`).all()]));
  const before = dump();
  const wakes = store.db.prepare("SELECT count(*) AS n FROM wake_queue").get().n;
  for (let i = 0; i < 3; i++) assert.equal((await feed(agentKey)).status, 200);
  assert.equal((await feed(ownerKey)).status, 200);
  assert.deepEqual(dump(), before, "every table is byte-for-byte unchanged after reads");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM wake_queue").get().n, wakes);
  assert.equal(store.wakeQueue.list(agentKey, "commons").wakes?.length ?? 0, 0);
});

test("limit pages the list while unread counts the whole tail; the scan is bounded", async t => {
  const { feed, send, ownerKey, agentKey } = await serve(t);
  for (let i = 0; i < 5; i++) send(ownerKey, T.MESSAGE_POSTED, { messageId: `m${i}`, body: `@Test agent ${i}` });
  const body = (await feed(agentKey, "?limit=2")).body;
  assert.equal(body.unread, 5);
  assert.deepEqual(kinds(body), ["mention:m4", "mention:m3"]);
  assert.equal(body.notifications.every(item => Number.isSafeInteger(item.sequence) && typeof item.at === "string"), true);
  assert.equal(NOTIFICATION_TAIL, 500);
});

test("truncation is reported only when the unread tail exceeds the bound, and names the oldest scanned event", async t => {
  const { store, send, ownerKey, agentKey } = await serve(t);
  store.markCaughtUp(agentKey, "commons", store.room("commons").sequence); // Setup events are behind the marker.
  const sequences = [0, 1, 2].map(i => send(ownerKey, T.MESSAGE_POSTED, { messageId: `m${i}`, body: `@Test agent ${i}` }).sequence);
  const exact = store.notifications.list(agentKey, "commons", null, { tail: 3 });
  assert.equal(exact.basis.truncated, false, "exactly tail rows is a complete scan");
  assert.equal(exact.basis.from, sequences[0]); assert.equal(exact.unread, 3);
  const cut = store.notifications.list(agentKey, "commons", null, { tail: 2 });
  assert.equal(cut.basis.truncated, true);
  assert.equal(cut.basis.from, sequences[1]); assert.equal(cut.unread, 2);
  assert.deepEqual(kinds(cut), ["mention:m2", "mention:m1"]);
  const wide = store.notifications.list(agentKey, "commons", null, { tail: 10 });
  assert.equal(wide.basis.truncated, false); assert.equal(wide.unread, 3);
  assert.throws(() => store.notifications.list(agentKey, "commons", null, { tail: 0 }), error => error.status === 422);
});

test("a muted author's events leave the viewer's feed; unmuting brings them back; the owner cannot be muted", async t => {
  const { feed, send, ownerKey, mayaKey, agentKey } = await serve(t);
  send(agentKey, T.MESSAGE_POSTED, { messageId: "agent-hello", body: "Hello room" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "maya-mention", body: "@Test agent from Maya" });
  send(mayaKey, T.MESSAGE_POSTED, { messageId: "maya-reply", body: "Replying to the agent", replyToId: "agent-hello" });
  send(ownerKey, T.MESSAGE_POSTED, { messageId: "owner-mention", body: "@Test agent from the owner" });
  send(ownerKey, T.WORK_PROPOSED, { workItemId: "w1", title: "Maya work", definitionOfDone: "Done", accountableMemberId: "maya", verifierMemberId: "agent", independentVerificationRequired: true, mode: "read" });
  send(mayaKey, T.WORK_ACCEPTED, { workItemId: "w1", expectedRevision: 0 });
  let body = (await feed(agentKey)).body;
  assert.deepEqual(kinds(body), ["work_update:w1", "assignment:w1", "mention:owner-mention", "reply:maya-reply", "mention:maya-mention"]);
  // The viewer mutes Maya: her mention, reply and work update vanish from this viewer's feed and unread count alone.
  send(agentKey, T.MEMBER_MUTE_SET, { memberId: "maya", muted: true });
  body = (await feed(agentKey)).body;
  assert.deepEqual(kinds(body), ["assignment:w1", "mention:owner-mention"]);
  assert.equal(body.unread, 2);
  assert.ok(!body.notifications.some(item => item.actorId === "maya"), "no item from a muted actor");
  const ownerFeed = (await feed(ownerKey)).body;
  assert.ok(ownerFeed.notifications.some(item => item.actorId === "maya"), "another member's feed still shows Maya");
  // Unmute: the feed is computed per read, so the same items return with nothing else changed.
  send(agentKey, T.MEMBER_MUTE_SET, { memberId: "maya", muted: false });
  body = (await feed(agentKey)).body;
  assert.deepEqual(kinds(body), ["work_update:w1", "assignment:w1", "mention:owner-mention", "reply:maya-reply", "mention:maya-mention"]);
  // The owner can never be muted, so the owner's items are always present.
  assert.throws(() => send(agentKey, T.MEMBER_MUTE_SET, { memberId: "owner", muted: true }), /owner cannot be muted/);
  body = (await feed(agentKey)).body;
  assert.ok(kinds(body).includes("mention:owner-mention"));
});

test("deriveNotifications is pure: same input, same output, and unknown preferences fall back to defaults", () => {
  const member = { id: "agent", displayName: "Test agent" };
  const state = { messages: [{ id: "m1", authorId: "owner", body: "@Test agent hi" }], workItems: {}, members: {} };
  const events = [{ sequence: 3, event: { id: "e1", type: T.MESSAGE_POSTED, actorId: "owner", at: "2026-09-14T00:00:00.000Z", data: { messageId: "m1", body: "@Test agent hi" } } }];
  const first = deriveNotifications({ events, state, member });
  assert.deepEqual(first, [{ kind: "mention", messageId: "m1", sequence: 3, at: "2026-09-14T00:00:00.000Z", actorId: "owner", changes: 1, workItemId: null }]);
  assert.deepEqual(deriveNotifications({ events, state, member }), first);
  assert.deepEqual(state.messages[0], { id: "m1", authorId: "owner", body: "@Test agent hi" }, "input untouched");
});


test("older mentions remain reachable after 600 unrelated events, with read and access fencing", async t => {
  const { store, send, feed, ownerKey, agentKey } = await serve(t);
  store.markCaughtUp(agentKey, "commons", store.room("commons").sequence);
  const mention = send(ownerKey, T.MESSAGE_POSTED, { messageId: "buried", body: "@Test agent please check" });
  for (let i = 0; i < 600; i++) send(ownerKey, T.MESSAGE_POSTED, { messageId: `noise-${i}`, body: "Routine progress" });
  const newest = (await feed(agentKey)).body;
  assert.equal(newest.notifications.length, 0);
  assert.ok(newest.nextBefore);
  const older = (await feed(agentKey, `?before=${newest.nextBefore}`)).body;
  assert.deepEqual(kinds(older), ["mention:buried"]);
  assert.equal(older.nextBefore, null);
  assert.equal(older.basis.through, newest.nextBefore - 1);
  store.markCaughtUp(agentKey, "commons", mention.sequence);
  assert.deepEqual((await feed(agentKey, `?before=${newest.nextBefore}`)).body.notifications, []);
  assert.equal((await feed(agentKey, "?before=0")).status, 422);
  assert.equal((await feed(agentKey, "?before=1&before=2")).status, 422);
  send(ownerKey, T.MEMBER_ACCESS_CHANGED, { memberId: "agent", expectedMemberRevision: 0, active: false, permissions: [] });
  assert.ok([401, 403].includes((await feed(agentKey, `?before=${newest.nextBefore}`)).status));
});

test("notification item limits also provide a continuation without skipping items", async t => {
  const { feed, send, ownerKey, agentKey } = await serve(t);
  for (let i = 0; i < 5; i++) send(ownerKey, T.MESSAGE_POSTED, { messageId: `page-${i}`, body: "@Test agent check" });
  let before = null; const found = [];
  do {
    const page = (await feed(agentKey, `?limit=2${before ? `&before=${before}` : ""}`)).body;
    found.push(...kinds(page)); before = page.nextBefore;
  } while (before !== null);
  assert.deepEqual(found, [4,3,2,1,0].map(i => `mention:page-${i}`));
});
