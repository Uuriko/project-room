import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { resolveMentionTargetsInText } from "../server/mention-lifecycle.mjs";

// Contract copied from the running Commons Claude Code receiver
// (bin/commons-claude/receiver.mjs): it accepts only these kinds and
// silently skips any other, including "ask".
const COMMONS_CLAUDE_RECEIVER_KINDS = new Set(["direct", "dm", "mention", "reply"]);
const receiverAccepts = kind => COMMONS_CLAUDE_RECEIVER_KINDS.has(kind);

function fixture(t, extraMembers = []) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const link = (memberId, displayName) => {
    const identity = store.identities.create(displayName);
    linkWithProof(store, ownerKey, "commons", identity, { memberId, displayName, permissions: [] });
    return { identity, key: store.issueAccessKey("commons", memberId) };
  };
  const receiver = link("receiver", "Receiver");
  const extras = Object.fromEntries(extraMembers.map(({ memberId, displayName }) => [memberId, link(memberId, displayName)]));
  const post = data => store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted", data
  });
  const signal = (identity, messageId) => store.db.prepare(
    "SELECT kind, delivered_at, message_id AS messageId FROM agent_wake_signals WHERE agent_id=? AND room_id=? AND message_id=?"
  ).get(identity.identityId, "commons", messageId);
  return { store, keys: { owner: ownerKey, receiver: receiver.key }, receiver, extras, post, signal };
}

function beat(store, identity, hostId = "host-1") {
  return store.agentHeartbeats.heartbeat({
    agentId: identity.identityId, hostId, mode: "wakeable",
    wakeUrl: "https://host.example.test/wake"
  });
}

test("a formal request to a hostless addressee queues a pull signal that the receiver filter accepts", t => {
  const { store, keys, receiver, post, signal } = fixture(t);
  const opened = post({
    messageId: "formal-ask",
    toMemberId: "receiver",
    requestKind: "reply",
    body: "Please give an exact-head verdict"
  });
  assert.deepEqual(opened.wakeDelivery, [{ memberId: "receiver", status: "queued" }]);
  const row = signal(receiver.identity, "formal-ask");
  assert.equal(row.kind, "dm");
  assert.equal(row.messageId, "formal-ask");
  assert.equal(row.delivered_at, null);
  assert.equal(receiverAccepts(row.kind), true);
  const delivery = store.replyRequests.selected(keys.owner, "commons", "formal-ask").current.wakeDelivery;
  assert.equal(delivery.pull, "queued");
  assert.equal(delivery.nextAction, "check_delivery");
});

test("an existing connected delivery keeps its original kind, not ask", t => {
  const { store, receiver, post, signal } = fixture(t);
  beat(store, receiver.identity);
  const kinds = [];
  const emit = store.enqueueNativeMcpEvent;
  store.enqueueNativeMcpEvent = args => {
    kinds.push(args.kind);
    return typeof emit === "function" ? emit(args) : 0;
  };
  const opened = post({
    messageId: "connected-ask",
    toMemberId: "receiver",
    requestKind: "reply",
    body: "Connected seat formal request"
  });
  assert.deepEqual(opened.wakeDelivery, [{ memberId: "receiver", status: "queued" }]);
  const row = signal(receiver.identity, "connected-ask");
  assert.equal(row.kind, "dm");
  assert.notEqual(row.kind, "ask");
  assert.equal(receiverAccepts(row.kind), true);
  assert.deepEqual(kinds, ["dm"], "existing native emit keeps the original kind");
});

test("a mentioned non-addressee gets no formal-request fallback", t => {
  const { store, receiver, extras, post, signal } = fixture(t, [
    { memberId: "bystander", displayName: "Bystander" }
  ]);
  const body = "Please review this, @Bystander, and answer the addressee request";
  const members = store.room("commons").state.members;
  assert.ok(resolveMentionTargetsInText(members, {}, body, "owner").includes("bystander"),
    "the @Bystander mention must actually resolve so this is not a vacuously passing filter");
  const opened = post({
    messageId: "mention-ask",
    toMemberId: "receiver",
    requestKind: "reply",
    body
  });
  assert.deepEqual(opened.wakeDelivery, [{ memberId: "receiver", status: "queued" }]);
  const addressee = signal(receiver.identity, "mention-ask");
  assert.ok(addressee);
  assert.equal(receiverAccepts(addressee.kind), true);
  assert.equal(signal(extras.bystander.identity, "mention-ask"), undefined);
  const bystanderRows = store.db.prepare(
    "SELECT kind FROM agent_wake_signals WHERE agent_id=? AND room_id=?"
  ).all(extras.bystander.identity.identityId, "commons");
  assert.deepEqual(bystanderRows, []);
});

test("an ordinary directed message to a hostless linked seat stays no_receiver", t => {
  const { receiver, post, signal } = fixture(t);
  const sent = post({
    messageId: "plain-dm",
    toMemberId: "receiver",
    body: "Just a note, not a formal request"
  });
  assert.deepEqual(sent.wakeDelivery, [{ memberId: "receiver", status: "no_receiver" }]);
  assert.equal(signal(receiver.identity, "plain-dm"), undefined);
});

test("a later host poll can drain the queued formal-request fallback signal", t => {
  const { store, receiver, post } = fixture(t);
  post({
    messageId: "later-host-ask",
    toMemberId: "receiver",
    requestKind: "reply",
    body: "Still waiting on this ask"
  });
  beat(store, receiver.identity);
  const page = beat(store, receiver.identity);
  const hit = page.pendingWakes.find(row => row.messageId === "later-host-ask");
  assert.equal(hit.kind, "dm");
  assert.equal(receiverAccepts(hit.kind), true);
});
