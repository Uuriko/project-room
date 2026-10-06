// ACT-1a: starter room and Room Guide, at the HTTP and store boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { seedStarter } from "../server/starter-room.mjs";
import { runGuideStep } from "../server/room-guide.mjs";
import { postReceiptCard } from "../server/receipt-cards.mjs";
import { buildGrowthEvent } from "../src/growth-emit.js";
import { roomUsageSummary } from "../server/usage-summary.mjs";

function assertIndexedMessage(store, roomId, message) {
  const row = store.db.prepare("SELECT seq, body, record_json FROM messages WHERE room_id=? AND message_id=?").get(roomId, message.id);
  assert.ok(row, "Guide/receipt message is indexed immediately without backfill");
  const { editHistory: _history, ...current } = message;
  assert.deepEqual(JSON.parse(row.record_json), current, "complete current metadata agrees with authoritative projection");
  assert.equal(row.body, message.body);
  const event = store.db.prepare("SELECT sequence FROM events WHERE room_id=? AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')=? ORDER BY sequence LIMIT 1").get(roomId, message.id);
  assert.equal(row.seq, event.sequence, "index retains original posting order");
}

const WELCOME = "I'm Room Guide, a demo agent. I took **See how work closes here** to show you how work closes. Pick what your own agent should do first:";

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

test("intent seeds one guide and one starter set, and a retry does not add another", async t => {
  const { origin, store } = await serve(t);
  const session = signIn(store, "ada");
  const body = { roomId: "bug-room", title: "Scratch", purpose: "Fix the crash.", kind: "personal", displayName: "Ada", intent: "bug" };
  const post = () => fetch(`${origin}/api/account-rooms`, {
    method: "POST", headers: accountHeaders(origin, session), body: JSON.stringify(body)
  });
  const createdResponse = await post();
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  assert.equal(created.room.title, "Fix a bug");
  const retryResponse = await post();
  const retry = await retryResponse.json();
  assert.equal(retryResponse.status, 200, JSON.stringify(retry));
  assert.equal(retry.duplicate, true);
  const before = store.room("bug-room").state;
  seedStarter(store, "bug-room", { intent: "bug", ownerMemberId: "owner" });
  const state = store.room("bug-room").state;
  const guides = Object.values(state.members).filter(member => member.id === "room-guide");
  assert.equal(guides.length, 1);
  assert.equal(guides[0].displayName, "Room Guide");
  assert.equal(guides[0].kind, "agent");
  assert.equal(guides[0].agentType, "room-guide");
  assert.equal(guides[0].system, true);
  assert.deepEqual(guides[0].permissions, ["accept_work", "complete_work"]);
  assert.equal(guides[0].identityId, undefined);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM credentials WHERE room_id=? AND member_id='room-guide'").get("bug-room").n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM identity_links WHERE room_id=? AND member_id='room-guide'").get("bug-room").n, 0);
  assert.equal(store.workClaims.list("bug-room").filter(item => item.id === "starter-receipt").length, 1);
  assert.equal(store.workClaims.list("bug-room").filter(item => (item.tags ?? []).includes("starter-choice")).length, 3);
  assert.equal(before.messages.filter(message => message.authorId === "room-guide").length, 1);
  assert.equal(state.messages.filter(message => message.authorId === "room-guide").length, 1);
  assert.equal(state.room.starterSeeded.templateSlug, "agent-pair");
  assert.equal(state.room.starterSeeded.intentKind, "bug");
});

test("a room without intent or start has no guide", async t => {
  const { origin, store } = await serve(t);
  await createRoom(origin, store, "no-intent", {
    roomId: "plain-room", title: "Plain", purpose: "No starter.", kind: "personal", displayName: "Bea"
  });
  const state = store.room("plain-room").state;
  assert.equal(state.room.title, "Plain");
  assert.equal(state.room.starterSeeded, undefined);
  assert.equal(state.members["room-guide"], undefined);
  assert.equal(store.workClaims.list("plain-room").length, 0);
});

test("guide claims and closes only starter-tagged claims", async t => {
  const { origin, store } = await serve(t);
  await createRoom(origin, store, "guide-guard", {
    roomId: "guard-room", title: "Guard", purpose: "Limit the guide.", kind: "personal", displayName: "Cara", intent: "bug"
  });
  const ownerKey = store.issueAccessKey("guard-room", "owner");
  const other = await bearer(origin, "/api/rooms/guard-room/work-claims", ownerKey, { id: "other", title: "Other work" });
  assert.equal(other.status, 201, await other.text());
  const extra = await bearer(origin, "/api/rooms/guard-room/work-claims", ownerKey, { id: "extra-starter", title: "Extra starter", tags: ["starter"] });
  assert.equal(extra.status, 201, await extra.clone().text());
  const guideKey = store.issueAccessKey("guard-room", "room-guide");
  const allowed = await bearer(origin, "/api/rooms/guard-room/work-claims/extra-starter/claim", guideKey, {});
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const claimOther = await bearer(origin, "/api/rooms/guard-room/work-claims/other/claim", guideKey, {});
  const claimBody = await claimOther.json();
  assert.equal(claimOther.status, 403);
  assert.equal(claimBody.error.code, "guide_starter_only");
  const updateOther = await bearer(origin, "/api/rooms/guard-room/work-claims/other/update", guideKey, { state: "in_progress" });
  const updateBody = await updateOther.json();
  assert.equal(updateOther.status, 403);
  assert.equal(updateBody.error.code, "guide_starter_only");
});

test("a choice closes the starter with a result card, then the first agent is assigned and woken", async t => {
  const { origin, store } = await serve(t);
  await createRoom(origin, store, "script", {
    roomId: "script-room", title: "Scratch", purpose: "See a close.", kind: "personal", displayName: "Dan", intent: "bug"
  });
  const state = store.room("script-room").state;
  const welcome = state.messages.find(message => message.authorId === "room-guide");
  assert.equal(welcome.body, WELCOME);
  assertIndexedMessage(store, "script-room", welcome);
  assert.deepEqual(welcome.actions.map(action => action.claimId), ["agent-pair-agree", "agent-pair-next", "agent-pair-receipt"]);
  assert.equal(store.workClaims.get("script-room", "starter-receipt").owner, "room-guide");
  assert.equal(store.workClaims.get("script-room", "starter-receipt").state, "claimed");
  const ownerKey = store.issueAccessKey("script-room", "owner");
  const choice = await bearer(origin, "/api/rooms/script-room/commands", ownerKey, {
    id: "pick-agree", type: "message.posted", data: { messageId: "pick-agree", body: "agent-pair-agree" }
  });
  assert.equal(choice.status, 201, await choice.clone().text());
  const starter = store.workClaims.get("script-room", "starter-receipt");
  assert.equal(starter.state, "done");
  assert.equal(starter.deliveryMode, "result");
  const card = store.room("script-room").state.messages.find(message => message.kind === "receipt_card" && message.claimId === "starter-receipt");
  assert.ok(card);
  assert.equal(card.deliveryMode, "result");
  assert.equal(card.closedBy, "Room Guide");
  assertIndexedMessage(store, "script-room", card);
  const done = store.db.prepare("SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')='work_claim.updated' AND json_extract(body,'$.data.workClaim')='starter-receipt' AND json_extract(body,'$.data.claimState')='done'").get("script-room");
  assert.ok(done, "the done work_claim.updated event is the claim_completed record");
  const welcomeEvent = store.db.prepare("SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.data.messageId')=?").get("script-room", welcome.id);
  const welcomeBody = JSON.parse(welcomeEvent.body);
  assert.equal(welcomeBody.data.actorKind, "system");
  const growth = buildGrowthEvent(welcomeBody, store.room("script-room").state);
  assert.equal(growth.actor.kind, "system");
  assert.equal(roomUsageSummary(store, ownerKey, "script-room").members.agents, 0);
  const identity = store.identities.create("Pair Agent");
  store.identities.link(ownerKey, "script-room", {
    identityId: identity.identityId, displayName: "Pair Agent", permissions: ["accept_work", "complete_work"]
  });
  assert.equal(store.workClaims.get("script-room", "agent-pair-agree").owner, identity.identityId);
  const assign = store.room("script-room").state.messages.find(message => message.authorId === "room-guide" && message.body.includes("is yours"));
  assert.equal(assign.body, "@Pair Agent Agree the change is yours.");
  assertIndexedMessage(store, "script-room", assign);
  assert.ok(store.db.prepare("SELECT 1 FROM agent_wake_signals WHERE agent_id=? AND room_id=? AND message_id=?").get(identity.identityId, "script-room", assign.id));
  assert.equal(roomUsageSummary(store, ownerKey, "script-room").members.agents, 1);
  const before = store.room("script-room").state.messages.length;
  assert.equal(runGuideStep(store, "script-room", store.now()), null);
  assert.equal(store.room("script-room").state.messages.length, before);
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
