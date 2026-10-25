// ACT-1a: starter room and Room Guide, at the HTTP and store boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { seedStarter } from "../server/starter-room.mjs";
import { postReceiptCard } from "../server/receipt-cards.mjs";
import { connectAgentCard, firstTaskAcceptance, firstTaskCard, FIRST_TASK_ID, MCP_URL } from "../src/first-room-copy.js";

function assertIndexedMessage(store, roomId, message) {
  const row = store.db.prepare("SELECT seq, body, record_json FROM messages WHERE room_id=? AND message_id=?").get(roomId, message.id);
  assert.ok(row, "Guide/receipt message is indexed immediately without backfill");
  const { editHistory: _history, ...current } = message;
  assert.deepEqual(JSON.parse(row.record_json), current, "complete current metadata agrees with authoritative projection");
  assert.equal(row.body, message.body);
  const event = store.db.prepare("SELECT sequence FROM events WHERE room_id=? AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')=? ORDER BY sequence LIMIT 1").get(roomId, message.id);
  assert.equal(row.seq, event.sequence, "index retains original posting order");
}

function signIn(store, accountId) {
  store.createAccount(accountId);
  const key = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  return { token: slot.token, binding: session.sessionBinding, csrf: session.csrf };
}

async function serve(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  return { origin, store: fixture.store };
}

const accountHeaders = (origin, session) => ({
  Cookie: `account_session=${session.token}`,
  "X-Session-Binding": session.binding,
  "X-CSRF-Token": session.csrf,
  Origin: origin,
  "Content-Type": "application/json"
});

async function createRoom(origin, store, accountId, body) {
  const session = signIn(store, accountId);
  const response = await fetch(`${origin}/api/account-rooms`, {
    method: "POST",
    headers: accountHeaders(origin, session),
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.status, 201, JSON.stringify(json));
  return json;
}

const bearer = (origin, path, token, body) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(body)
});

test("intent names the room and seeds two cards, and a retry does not add another", async t => {
  const { origin, store } = await serve(t);
  const session = signIn(store, "ada");
  const answer = "Fix the crash";
  const body = { roomId: "bug-room", title: "Scratch", purpose: "Fix the crash.", kind: "personal", displayName: "Ada", intent: answer };
  const post = () => fetch(`${origin}/api/account-rooms`, {
    method: "POST", headers: accountHeaders(origin, session), body: JSON.stringify(body)
  });
  const createdResponse = await post();
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  assert.equal(created.room.title, answer);
  const retryResponse = await post();
  const retry = await retryResponse.json();
  assert.equal(retryResponse.status, 200, JSON.stringify(retry));
  assert.equal(retry.duplicate, true);
  const before = store.room("bug-room").state;
  seedStarter(store, "bug-room", { intent: answer, ownerMemberId: "owner" });
  const state = store.room("bug-room").state;
  assert.equal(state.members["room-guide"], undefined);
  assert.equal(store.workClaims.list("bug-room").filter(item => (item.tags ?? []).includes("starter-choice")).length, 0);
  const connect = state.messages.find(message => message.id === "mc-bug-room");
  const task = state.messages.find(message => message.id === "mt-bug-room");
  assert.equal(connect.body, connectAgentCard());
  assert.equal(task.body, firstTaskCard(answer));
  assert.equal(connect.body.split(MCP_URL).length - 1, 4);
  assertIndexedMessage(store, "bug-room", connect);
  assertIndexedMessage(store, "bug-room", task);
  const claim = store.workClaims.get("bug-room", FIRST_TASK_ID);
  assert.equal(claim.title, answer);
  assert.deepEqual(claim.acceptanceCriteria, [firstTaskAcceptance(answer)]);
  assert.equal(claim.state, "unclaimed");
  assert.equal(before.messages.length, state.messages.length);
  assert.equal(state.room.starterSeeded.templateSlug, "first-room");
  assert.equal(state.room.starterSeeded.intentKind, "custom");
  assert.throws(() => seedStarter(store, "bug-room", { intent: answer, ownerMemberId: "stranger" }), error => error.code === "owner_required");
});

test("a room without intent or start has no seed", async t => {
  const { origin, store } = await serve(t);
  await createRoom(origin, store, "no-intent", {
    roomId: "plain-room", title: "Plain", purpose: "No starter.", kind: "personal", displayName: "Bea"
  });
  const state = store.room("plain-room").state;
  assert.equal(state.room.title, "Plain");
  assert.equal(state.room.starterSeeded, undefined);
  assert.equal(state.members["room-guide"], undefined);
  assert.equal(state.messages.length, 0);
  assert.equal(store.workClaims.list("plain-room").length, 0);
});

test("done claims of every delivery mode get one in-room receipt card", async t => {
  const { origin, store } = await serve(t);
  await createRoom(origin, store, "receipts", {
    roomId: "receipt-room", title: "Receipts", purpose: "Close three ways.", kind: "personal", displayName: "Eve"
  });
  const ownerKey = store.issueAccessKey("receipt-room", "owner");
  for (const mode of ["result", "merged", "production"]) {
    const id = `close-${mode}`;
    assert.equal((await bearer(origin, "/api/rooms/receipt-room/work-claims", ownerKey, { id, title: `Close ${mode}` })).status, 201);
    assert.equal((await bearer(origin, `/api/rooms/receipt-room/work-claims/${id}/claim`, ownerKey, {})).status, 200);
    assert.equal((await bearer(origin, `/api/rooms/receipt-room/work-claims/${id}/update`, ownerKey, { state: "in_progress" })).status, 200);
    const done = await bearer(origin, `/api/rooms/receipt-room/work-claims/${id}/update`, ownerKey, {
      state: "done", deliveryMode: mode, note: `Shipped ${mode}.`
    });
    assert.equal(done.status, 200, await done.clone().text());
  }
  const cards = store.room("receipt-room").state.messages.filter(message => message.kind === "receipt_card");
  assert.deepEqual(cards.map(card => card.deliveryMode).sort(), ["merged", "production", "result"]);
  for (const card of cards) assertIndexedMessage(store, "receipt-room", card);
  const before = cards.length;
  const eventsBefore = store.room("receipt-room").sequence;
  const indexBefore = store.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").get("receipt-room").n;
  postReceiptCard(store, "receipt-room", store.workClaims.get("receipt-room", "close-result"));
  assert.equal(store.room("receipt-room").state.messages.filter(message => message.kind === "receipt_card").length, before);
  assert.equal(store.room("receipt-room").sequence, eventsBefore);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").get("receipt-room").n, indexBefore);
});

test("a caught receipt index failure preserves the done claim without a partial receipt", async t => {
  const { origin, store } = await serve(t);
  await createRoom(origin, store, "receipt-fault", {
    roomId: "fault-room", title: "Fault", purpose: "Atomic receipt", kind: "personal", displayName: "Fay"
  });
  const ownerKey = store.issueAccessKey("fault-room", "owner");
  assert.equal((await bearer(origin, "/api/rooms/fault-room/work-claims", ownerKey, { id: "fault-claim", title: "Fault claim" })).status, 201);
  assert.equal((await bearer(origin, "/api/rooms/fault-room/work-claims/fault-claim/claim", ownerKey, {})).status, 200);
  assert.equal((await bearer(origin, "/api/rooms/fault-room/work-claims/fault-claim/update", ownerKey, { state: "in_progress" })).status, 200);
  const identity = store.identities.create("Receipt observer");
  store.identities.link(ownerKey, "fault-room", { identityId: identity.identityId, displayName: "Observer", permissions: [] });
  const { subscription } = store.agentPlugin.subscribeWebhook({ identityId: identity.identityId,
    url: "https://observer.example/receipt", events: ["message.posted"], secret: "synthetic-receipt-observer-secret" });
  store.db.exec(`CREATE TRIGGER reject_receipt_index BEFORE INSERT ON messages
    WHEN NEW.room_id='fault-room' AND json_extract(NEW.record_json,'$.kind')='receipt_card'
    BEGIN SELECT RAISE(ABORT,'receipt index rejected'); END`);
  const done = await bearer(origin, "/api/rooms/fault-room/work-claims/fault-claim/update", ownerKey, {
    state: "done", deliveryMode: "result", note: "Claim must survive receipt failure."
  });
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal(store.workClaims.get("fault-room", "fault-claim").state, "done");
  assert.equal(store.room("fault-room").state.messages.filter(message => message.kind === "receipt_card").length, 0, "no projection receipt survives the caught write failure");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE room_id=? AND json_extract(body,'$.data.kind')='receipt_card'").get("fault-room").n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=? AND json_extract(record_json,'$.kind')='receipt_card'").get("fault-room").n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_deliveries WHERE subscription_id=?").get(subscription.subscriptionId).n, 0, "failed receipt does not reach fan-out");
  store.db.exec("DROP TRIGGER reject_receipt_index");
  postReceiptCard(store, "fault-room", store.workClaims.get("fault-room", "fault-claim"));
  const cards = store.room("fault-room").state.messages.filter(message => message.kind === "receipt_card");
  assert.equal(cards.length, 1, "same receipt can be retried after storage recovers");
  assertIndexedMessage(store, "fault-room", cards[0]);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_webhook_deliveries WHERE subscription_id=?").get(subscription.subscriptionId).n, 1, "successful retry retains receipt fan-out");
});

test("explicit receipt isolation preserves Node transaction guards and parent rollback", async t => {
  const { store } = await serve(t);
  store.transaction(() => {
    assert.throws(() => store.transaction(() => { store.createAccount('default-kept'); throw new Error('default fault'); }), /default fault/);
    assert.throws(() => store.transaction(() => Promise.resolve(), { isolated: true }), /synchronous/);
  });
  assert.ok(store.account('default-kept'));
  assert.throws(() => store.transaction(() => {
    store.createAccount('outer-lost');
    store.transaction(() => store.createAccount('inner-lost'), { isolated: true });
    throw new Error('outer fault');
  }), /outer fault/);
  for (const id of ['outer-lost', 'inner-lost']) assert.equal(store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id=?").get(id).n, 0);
  assert.throws(() => store.readTransaction(() => store.transaction(() => store.createAccount('readonly-denied'), { isolated: true })), /read-only/);
});
