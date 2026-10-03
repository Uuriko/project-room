// Updates projection over the real store and HTTP server.
// A handled request leaves the actionable list and needs-me. A clarification
// makes it actionable again. Exact retries, partial pages, revoked keys,
// mention receipts, and cross-room reads keep the same state.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { claimAttentionFromEvents } from "../server/updates.mjs";

function serve(t, roomId = "commons") {
  const directory = mkdtempSync(join(tmpdir(), "room-updates-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom(roomId));
  const ownerKey = store.issueAccessKey(roomId, "owner");
  const server = createRoomServer({ store });
  const origin = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = async (path, { method = "GET", token, data, headers = {} } = {}) => {
    const root = await origin;
    const response = await fetch(root + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json" } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  return { store, file, directory, ownerKey, roomId, request, origin };
}

function addAgent(store, roomId, ownerKey, memberId = "agent", displayName = "Reply Agent") {
  store.command(ownerKey, roomId, { id: randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId, displayName, kind: "agent", permissions: ["accept_work", "complete_work"]
  } });
  return store.issueAccessKey(roomId, memberId);
}

function persistedUpdates(store) {
  return {
    marks: store.db.prepare("SELECT * FROM private_update_marks ORDER BY room_id, member_id, item_id").all(),
    receipts: store.db.prepare("SELECT * FROM private_update_commands ORDER BY room_id, member_id, request_id").all(),
    journal: store.db.prepare("SELECT COUNT(*) AS count, MAX(sequence) AS lastSequence FROM events").get()
  };
}

function clarify(store, ownerKey, messageId, body = "one more detail on the plan") {
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body, replyToId: messageId
  } });
}

function ask(store, roomId, ownerKey, toMemberId, body = "please confirm the plan") {
  const messageId = randomUUID();
  const opened = store.command(ownerKey, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId, body, toMemberId, requestKind: "reply"
  } });
  return { messageId, opened };
}

test("system events are not updates and claim attention stays empty without a signal", async t => {
  const { ownerKey, request } = serve(t);
  const listed = await request("/api/rooms/commons/updates", { token: ownerKey });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items, []);
  assert.equal(listed.body.incompleteSources.claims, false);
  assert.deepEqual(claimAttentionFromEvents([{ type: "work_claim.updated", data: { workClaim: "c1" } }], "owner"), []);
  const signaled = claimAttentionFromEvents([{
    type: "work_claim.updated", roomId: "commons", id: "e1", at: "2026-10-02T00:00:00.000Z", actorId: "owner",
    data: { attention: "ci_failed", attentionMemberId: "owner", workClaim: "c1", title: "Fix the build" }
  }], "owner");
  assert.equal(signaled[0].kind, "claim_ci_failed");
  assert.equal(signaled[0].sourceRef.claimId, "c1");
});

test("a reply request is answered with linkage and then leaves the list", async t => {
  const { store, ownerKey, request } = serve(t);
  const agentKey = addAgent(store, "commons", ownerKey);
  const { messageId, opened } = ask(store, "commons", ownerKey, "agent");
  const first = await request("/api/rooms/commons/updates", { token: agentKey });
  assert.equal(first.status, 200);
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.items[0].kind, "request");
  assert.equal(first.body.items[0].state, "unread");
  assert.equal(first.body.items[0].untrusted, true);
  assert.equal(first.body.items[0].sourceRef.requestId, messageId);
  const answered = store.command(agentKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "confirmed", replyToId: messageId, responseToRequestId: messageId,
    expectedRequestRevision: 0, responseOutcome: "answered", toMemberId: "owner", workItemId: null,
    contextEventId: opened.event.id, contextSequence: opened.sequence
  } });
  assert.equal(answered.event.data.responseOutcome, "answered");
  const after = await request("/api/rooms/commons/updates", { token: agentKey });
  assert.deepEqual(after.body.items, []);
  const all = await request("/api/rooms/commons/updates?state=all", { token: agentKey });
  assert.equal(all.body.items[0].state, "answered");
});

test("done retires the item from updates and needs-me, and a clarification brings it back", async t => {
  const { store, ownerKey, request } = serve(t);
  const identity = store.identities.create("Needs Reader");
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId: "reader", displayName: "Needs Reader", permissions: []
  });
  const { messageId } = ask(store, "commons", ownerKey, "reader", "please take this");
  const readerKey = store.issueAccessKey("commons", "reader");
  const open = await request("/api/needs-me", { token: identity.secret });
  assert.equal(open.status, 200);
  assert.ok(open.body.items.some(item => item.kind === "direct_ask" && item.id === messageId));
  const listed = await request("/api/rooms/commons/updates", { token: readerKey });
  const item = listed.body.items.find(entry => entry.sourceRef.requestId === messageId);
  const done = await request(`/api/rooms/commons/updates/${item.id}/done`, {
    method: "POST", token: readerKey, data: { requestId: randomUUID(), expectedBasis: item.basisToken }
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.item.state, "handled");
  const retired = await request("/api/rooms/commons/updates", { token: readerKey });
  assert.equal(retired.body.items.some(entry => entry.id === item.id), false);
  const needs = await request("/api/needs-me", { token: identity.secret });
  assert.equal(needs.body.items.some(entry => entry.kind === "direct_ask" && entry.id === messageId), false);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "one more detail on the plan", replyToId: messageId
  } });
  const again = await request("/api/rooms/commons/updates", { token: readerKey });
  const revived = again.body.items.find(entry => entry.sourceRef.requestId === messageId);
  assert.equal(revived.state, "unread");
});

// These cases own the stale-click contract at HTTP + durable storage: a source
// clarification between listing and clicking must not acknowledge unseen work.
for (const [action, expectedState] of [["read", "read"], ["done", "handled"], ["clear", "cleared"]]) {
  test(`${action} rejects an unseen clarification and replays only its committed basis`, async t => {
    const { store, ownerKey, request } = serve(t);
    const agentKey = addAgent(store, "commons", ownerKey);
    const { messageId } = ask(store, "commons", ownerKey, "agent");
    const listed = await request("/api/rooms/commons/updates", { token: agentKey });
    assert.equal(listed.status, 200);
    const item = listed.body.items[0];
    assert.match(item.basisToken, /^ub1_[a-f0-9]{64}$/);
    const repeated = await request("/api/rooms/commons/updates", { token: agentKey });
    assert.equal(repeated.body.items[0].basisToken, item.basisToken);
    clarify(store, ownerKey, messageId);
    const beforeStale = persistedUpdates(store);
    const requestId = randomUUID();
    const path = `/api/rooms/commons/updates/${item.id}/${action}`;
    const stale = await request(path, {
      method: "POST", token: agentKey, data: { requestId, expectedBasis: item.basisToken }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "update_changed");
    assert.deepEqual(persistedUpdates(store), beforeStale, "stale clicks write no mark, receipt, or source event");

    const fresh = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items[0];
    assert.equal(fresh.id, item.id);
    assert.equal(fresh.state, "unread");
    assert.notEqual(fresh.basisToken, item.basisToken);
    const data = { requestId, expectedBasis: fresh.basisToken };
    const committed = await request(path, { method: "POST", token: agentKey, data });
    assert.equal(committed.status, 200);
    assert.equal(committed.body.duplicate, false);
    assert.equal(committed.body.item.state, expectedState);
    assert.equal(committed.body.item.basisToken, fresh.basisToken);
    assert.equal(persistedUpdates(store).marks.length, beforeStale.marks.length + 1);
    assert.equal(persistedUpdates(store).receipts.length, beforeStale.receipts.length + 1);
    assert.deepEqual(persistedUpdates(store).journal, beforeStale.journal);

    clarify(store, ownerKey, messageId, "a later clarification after the acknowledgement");
    const beforeRetry = persistedUpdates(store);
    const retry = await request(path, { method: "POST", token: agentKey, data });
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, { ...committed.body, duplicate: true });
    assert.deepEqual(persistedUpdates(store), beforeRetry, "an old exact retry cannot mark the newer source");
    const current = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items[0];
    assert.equal(current.id, item.id);
    assert.equal(current.state, "unread");
    assert.notEqual(current.basisToken, fresh.basisToken);
  });
}

test("request id reuse conflicts on a changed basis, action, or item", async t => {
  const { store, ownerKey, request } = serve(t);
  const agentKey = addAgent(store, "commons", ownerKey);
  const { messageId } = ask(store, "commons", ownerKey, "agent");
  const item = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items[0];
  const requestId = randomUUID();
  const first = await request(`/api/rooms/commons/updates/${item.id}/read`, {
    method: "POST", token: agentKey, data: { requestId, expectedBasis: item.basisToken }
  });
  assert.equal(first.status, 200);
  clarify(store, ownerKey, messageId);
  const newer = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items[0];
  const other = ask(store, "commons", ownerKey, "agent", "a separate request");
  const otherItem = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items
    .find(entry => entry.sourceRef.requestId === other.messageId);
  const before = persistedUpdates(store);
  for (const [label, itemId, action, expectedBasis] of [
    ["basis", item.id, "read", newer.basisToken],
    ["action", item.id, "done", item.basisToken],
    ["item", otherItem.id, "read", otherItem.basisToken]
  ]) {
    const conflict = await request(`/api/rooms/commons/updates/${itemId}/${action}`, {
      method: "POST", token: agentKey, data: { requestId, expectedBasis }
    });
    assert.equal(conflict.status, 409, label);
    assert.equal(conflict.body.error.code, "idempotency_conflict", label);
    assert.deepEqual(persistedUpdates(store), before, label);
  }
});

test("new marks distinguish missing basis from malformed basis without writing", async t => {
  const { store, ownerKey, request } = serve(t);
  const agentKey = addAgent(store, "commons", ownerKey);
  ask(store, "commons", ownerKey, "agent");
  const item = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items[0];
  const before = persistedUpdates(store);
  for (const [label, fields, code] of [
    ["missing", {}, "update_basis_required"],
    ["null", { expectedBasis: null }, "invalid_update"],
    ["number", { expectedBasis: 7 }, "invalid_update"],
    ["object", { expectedBasis: {} }, "invalid_update"],
    ["empty", { expectedBasis: "" }, "invalid_update"],
    ["short digest", { expectedBasis: "ub1_abc" }, "invalid_update"],
    ["wrong version", { expectedBasis: `ub2_${"a".repeat(64)}` }, "invalid_update"],
    ["extra field", { expectedBasis: item.basisToken, extra: true }, "invalid_update"]
  ]) {
    const rejected = await request(`/api/rooms/commons/updates/${item.id}/done`, {
      method: "POST", token: agentKey, data: { requestId: randomUUID(), ...fields }
    });
    assert.equal(rejected.status, 422, label);
    assert.equal(rejected.body.error.code, code, label);
    assert.deepEqual(persistedUpdates(store), before, label);
  }
  const current = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items[0];
  assert.equal(current.state, "unread");
});

// The receipt and mark form one durable operation. A real SQLite failure
// after the mark upsert must roll it back, without a production injection seam.
test("a failed receipt insert rolls back its private mark and leaves the request retryable", async t => {
  const { store, ownerKey, request } = serve(t);
  const agentKey = addAgent(store, "commons", ownerKey);
  ask(store, "commons", ownerKey, "agent");
  const item = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items[0];
  store.db.exec(`CREATE TEMP TRIGGER fail_update_receipt BEFORE INSERT ON private_update_commands
    WHEN EXISTS (SELECT 1 FROM private_update_marks
      WHERE room_id=NEW.room_id AND member_id=NEW.member_id AND action='done')
    BEGIN SELECT RAISE(ABORT, 'synthetic update receipt failure'); END`);
  const before = persistedUpdates(store);
  const path = `/api/rooms/commons/updates/${item.id}/done`;
  const data = { requestId: randomUUID(), expectedBasis: item.basisToken };
  const refused = await request(path, { method: "POST", token: agentKey, data });
  assert.equal(refused.status, 500, "the receipt trigger fires only after the mark exists within the transaction");
  assert.deepEqual(persistedUpdates(store), before, "receipt failure rolls back the mark without changing the shared journal");
  const current = (await request("/api/rooms/commons/updates", { token: agentKey })).body.items[0];
  assert.equal(current.state, "unread");
  assert.equal(current.basisToken, item.basisToken);
  store.db.exec("DROP TRIGGER fail_update_receipt");
  const retry = await request(path, { method: "POST", token: agentKey, data });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, false, "the failed transaction consumed no request id");
  assert.equal(retry.body.item.state, "handled");
  assert.equal(persistedUpdates(store).marks.length, before.marks.length + 1);
  assert.equal(persistedUpdates(store).receipts.length, before.receipts.length + 1);
  assert.deepEqual(persistedUpdates(store).journal, before.journal);
});

test("pages stay stable and a restarted store keeps the mark", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-updates-restart-"));
  const file = join(directory, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const agentKey = addAgent(store, "commons", ownerKey);
  for (const word of ["one", "two", "three"]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
      messageId: randomUUID(), body: `note ${word}`, toMemberId: "agent"
    } });
  }
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, token = agentKey) => {
    const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  };
  const seen = [];
  let cursor = "";
  for (let page = 0; page < 5; page += 1) {
    const listed = await get(`/api/rooms/commons/updates?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    seen.push(listed.body.items[0]);
    if (!listed.body.hasMore) break;
    cursor = listed.body.cursor;
  }
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.map(item => item.id)).size, 3);
  const item = seen[0];
  const requestId = randomUUID();
  const marked = await fetch(`${origin}/api/rooms/commons/updates/${item.id}/read`, {
    method: "POST", headers: { Authorization: `Bearer ${agentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, expectedBasis: item.basisToken })
  });
  assert.equal(marked.status, 200);
  const committed = await marked.json();
  server.closeStreams(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store.close();
  const reopened = new RoomStore(file);
  const server2 = createRoomServer({ store: reopened });
  t.after(async () => {
    server2.closeStreams(); server2.closeAllConnections();
    if (server2.listening) await new Promise(resolve => server2.close(resolve));
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server2.listen(0, "127.0.0.1", resolve));
  const origin2 = `http://127.0.0.1:${server2.address().port}`;
  const after = await (await fetch(`${origin2}/api/rooms/commons/updates?state=all`, { headers: { Authorization: `Bearer ${agentKey}` } })).json();
  assert.equal(after.items.find(entry => entry.id === item.id).state, "read");
  const beforeRetry = persistedUpdates(reopened);
  const lost = await fetch(`${origin2}/api/rooms/commons/updates/${item.id}/read`, {
    method: "POST", headers: { Authorization: `Bearer ${agentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, expectedBasis: item.basisToken })
  });
  const replay = await lost.json();
  assert.equal(lost.status, 200);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay, { ...committed, duplicate: true });
  assert.deepEqual(persistedUpdates(reopened), beforeRetry);
});

test("pre-upgrade committed receipts remain retryable under current authorization only", async t => {
  const { store, ownerKey, request } = serve(t);
  const oldKey = addAgent(store, "commons", ownerKey);
  const { messageId } = ask(store, "commons", ownerKey, "agent");
  const listed = await request("/api/rooms/commons/updates", { token: oldKey });
  const item = listed.body.items[0];
  const requestId = randomUUID();
  const legacyItem = { ...item, state: "handled" };
  delete legacyItem.basisToken;
  // Explicit persisted pre-upgrade fixture, using the historical row format.
  // New-policy receipt creation is exercised by the HTTP cases above.
  const legacyReceipt = {
    roomId: "commons", viewerId: "agent", viewerAccountId: listed.body.viewerAccountId,
    viewerAuthEpoch: listed.body.viewerAuthEpoch, viewerSessionBinding: listed.body.viewerSessionBinding,
    viewerSessionRevision: listed.body.viewerSessionRevision,
    requestId, duplicate: false, item: legacyItem
  };
  const source = store.room("commons").state.replyRequests[messageId];
  const legacyBasis = `${source.status}|${source.revision}|${source.contextEventId ?? ""}`;
  const legacyFingerprint = createHash("sha256").update(`done|${item.id}|${requestId}`).digest("hex");
  store.transaction(() => {
    store.db.prepare("INSERT INTO private_update_marks (room_id,member_id,item_id,action,basis,updated_at) VALUES(?,?,?,?,?,?)")
      .run("commons", "agent", item.id, "done", legacyBasis, store.now());
    store.db.prepare("INSERT INTO private_update_commands (room_id,member_id,request_id,fingerprint,response) VALUES(?,?,?,?,?)")
      .run("commons", "agent", requestId, legacyFingerprint, JSON.stringify(legacyReceipt));
  });
  clarify(store, ownerKey, messageId);
  store.revoke(oldKey);
  const currentKey = store.issueAccessKey("commons", "agent");
  const before = persistedUpdates(store);
  const path = `/api/rooms/commons/updates/${item.id}/done`;
  const retry = await request(path, { method: "POST", token: currentKey, data: { requestId } });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.item, legacyItem);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.viewerId, "agent");
  assert.deepEqual(persistedUpdates(store), before);
  const fresh = (await request("/api/rooms/commons/updates", { token: currentKey })).body.items[0];
  assert.equal(fresh.id, item.id);
  assert.equal(fresh.state, "unread");

  const newUnbound = await request(path, {
    method: "POST", token: currentKey, data: { requestId: randomUUID() }
  });
  assert.equal(newUnbound.status, 422);
  assert.equal(newUnbound.body.error.code, "update_basis_required");
  const alteredRetry = await request(path, {
    method: "POST", token: currentKey, data: { requestId, expectedBasis: fresh.basisToken }
  });
  assert.equal(alteredRetry.status, 409);
  assert.equal(alteredRetry.body.error.code, "idempotency_conflict");
  assert.deepEqual(persistedUpdates(store), before);
  store.revoke(currentKey);
  const beforeDenied = persistedUpdates(store);
  const denied = await request(path, { method: "POST", token: currentKey, data: { requestId } });
  assert.equal(denied.status, 401);
  assert.deepEqual(persistedUpdates(store), beforeDenied, "a durable receipt does not bypass revocation");
});

test("marks and request ids stay private to each member and a basis token grants no access", async t => {
  const { store, ownerKey, request } = serve(t);
  const firstKey = addAgent(store, "commons", ownerKey);
  const secondKey = addAgent(store, "commons", ownerKey, "second", "Other Agent");
  const outsiderKey = addAgent(store, "commons", ownerKey, "outsider", "Outside Agent");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "@Reply Agent and @Other Agent please review this"
  } });
  const first = (await request("/api/rooms/commons/updates?kinds=mention", { token: firstKey })).body.items[0];
  const second = (await request("/api/rooms/commons/updates?kinds=mention", { token: secondKey })).body.items[0];
  assert.equal(first.id, second.id);
  const requestId = randomUUID();
  const path = `/api/rooms/commons/updates/${first.id}/done`;
  const marked = await request(path, {
    method: "POST", token: firstKey, data: { requestId, expectedBasis: first.basisToken }
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.duplicate, false);
  const secondAfter = (await request("/api/rooms/commons/updates?kinds=mention", { token: secondKey })).body.items[0];
  assert.equal(secondAfter.state, "unread");
  const beforeDenied = persistedUpdates(store);
  const forbidden = await request(path, {
    method: "POST", token: outsiderKey, data: { requestId, expectedBasis: first.basisToken }
  });
  assert.equal(forbidden.status, 404);
  assert.equal(forbidden.body.error.code, "update_not_found");
  assert.deepEqual(persistedUpdates(store), beforeDenied);
  const independentlyMarked = await request(path, {
    method: "POST", token: secondKey, data: { requestId, expectedBasis: secondAfter.basisToken }
  });
  assert.equal(independentlyMarked.status, 200);
  assert.equal(independentlyMarked.body.duplicate, false, "another member cannot retrieve the first member's receipt");
  assert.equal(independentlyMarked.body.viewerId, "second");
  assert.equal(persistedUpdates(store).marks.length, beforeDenied.marks.length + 1);
  assert.equal(persistedUpdates(store).receipts.length, beforeDenied.receipts.length + 1);
});

test("a revoked key is refused and mentions arrive through mention receipts", async t => {
  const { store, ownerKey, request } = serve(t);
  const agentKey = addAgent(store, "commons", ownerKey);
  store.revoke(agentKey);
  const denied = await request("/api/rooms/commons/updates", { token: agentKey });
  assert.equal(denied.status, 401);
  const liveKey = store.issueAccessKey("commons", "agent");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "@Reply Agent the receipt landed"
  } });
  const listed = await request("/api/rooms/commons/updates?kinds=mention", { token: liveKey });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].kind, "mention");
  assert.equal(listed.body.items[0].state, "unread");
});

test("cross-room updates include only rooms the identity or account can access", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-updates-cross-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  store.initialize(initialRoom("beta"));
  const alphaOwner = store.issueAccessKey("alpha", "owner");
  const betaOwner = store.issueAccessKey("beta", "owner");
  const identity = store.identities.create("Alpha Reader");
  store.identities.link(alphaOwner, "alpha", {
    identityId: identity.identityId, memberId: "reader", displayName: "Alpha Reader", permissions: []
  });
  const readerKey = store.issueAccessKey("alpha", "reader");
  store.command(alphaOwner, "alpha", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "for the reader", toMemberId: "reader"
  } });
  store.command(readerKey, "alpha", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "for the account", toMemberId: "owner"
  } });
  store.command(betaOwner, "beta", { id: randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId: "beta-agent", displayName: "Beta Agent", kind: "agent", permissions: []
  } });
  const betaKey = store.issueAccessKey("beta", "owner");
  const betaAgentKey = store.issueAccessKey("beta", "beta-agent");
  store.command(betaKey, "beta", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "beta only", toMemberId: "beta-agent"
  } });
  const server = createRoomServer({ store });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identityList = await (await fetch(`${origin}/api/updates`, { headers: { Authorization: `Bearer ${identity.secret}` } })).json();
  const betaVisible = await (await fetch(`${origin}/api/rooms/beta/updates`, { headers: { Authorization: `Bearer ${betaAgentKey}` } })).json();
  assert.equal(betaVisible.items.length, 1);
  assert.equal(betaVisible.items[0].roomId, "beta");
  assert.ok(identityList.items.length >= 1);
  assert.ok(identityList.items.every(item => item.roomId === "alpha"));
  const accountId = store.authenticate(alphaOwner).account.id;
  const accessKey = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, accessKey, 0);
  const accountList = await (await fetch(`${origin}/api/updates`, {
    headers: { Cookie: `account_session=${slot.token}`, "X-Session-Binding": session.sessionBinding }
  })).json();
  assert.ok(accountList.items.some(item => item.roomId === "alpha"));
  assert.ok(accountList.items.every(item => item.roomId === "alpha"));
  assert.equal(accountList.items.some(item => item.roomId === "beta"), false);
});

test("event tail returns the newest events in ascending order and orient ranks a query", async t => {
  const { store, ownerKey, request } = serve(t);
  addAgent(store, "commons", ownerKey);
  ask(store, "commons", ownerKey, "agent", "please confirm");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: {
    messageId: randomUUID(), body: "zebra-token belongs in the orient match"
  } });
  const tail = await request("/api/rooms/commons/events?tail=2", { token: ownerKey });
  assert.equal(tail.status, 200);
  assert.equal(tail.body.events.length, 2);
  assert.ok(tail.body.events[0].sequence < tail.body.events[1].sequence);
  assert.equal(tail.body.next, tail.body.events.at(-1).sequence);
  const badTail = await request("/api/rooms/commons/events?tail=2&after=0", { token: ownerKey });
  assert.equal(badTail.status, 422);
  const conversation = await request("/api/rooms/commons/orient?focus=conversation", { token: ownerKey });
  assert.equal(conversation.status, 200);
  assert.ok(conversation.body.updates.every(item => item.kind === "request" || item.kind === "mention" || item.kind === "dm" || item.kind === "invite_pending" || item.kind === "access_request"));
  assert.ok(conversation.body.you.member.id === "owner");
  assert.ok(Array.isArray(conversation.body.nextActions));
  const work = await request("/api/rooms/commons/orient?focus=work", { token: ownerKey });
  assert.equal(work.body.updates.some(item => item.kind === "request"), false);
  const matched = await request("/api/rooms/commons/orient?q=zebra-token&maxTokens=50", { token: ownerKey });
  assert.ok(matched.body.matched.lines.some(line => line.text.includes("zebra-token")));
  assert.equal(matched.body.matched.lines[0].untrusted, true);
  const invalid = await request("/api/rooms/commons/orient?maxTokens=0", { token: ownerKey });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, "invalid_orient");
});
