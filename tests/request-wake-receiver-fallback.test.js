import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Linked receiver");
  linkWithProof(store, ownerKey, "commons", identity, {
    memberId: "receiver", displayName: "Receiver", permissions: []
  });
  const keys = {
    owner: ownerKey,
    receiver: store.issueAccessKey("commons", "receiver")
  };
  const post = data => store.command(keys.owner, "commons", {
    id: randomUUID(), type: "message.posted", data
  });
  return { store, keys, identity, post };
}

test("a formal request to a linked seat with no host queues a pull signal instead of no_receiver", t => {
  const { store, keys, identity, post } = fixture(t);
  const opened = post({
    messageId: "formal-ask",
    toMemberId: "receiver",
    requestKind: "reply",
    body: "Please give an exact-head verdict"
  });
  assert.deepEqual(opened.wakeDelivery, [{ memberId: "receiver", status: "queued" }]);
  const row = store.db.prepare(
    "SELECT kind, delivered_at FROM agent_wake_signals WHERE agent_id=? AND room_id=? AND message_id=?"
  ).get(identity.identityId, "commons", "formal-ask");
  assert.equal(row.kind, "ask");
  assert.equal(row.delivered_at, null);
  const delivery = store.replyRequests.selected(keys.owner, "commons", "formal-ask").current.wakeDelivery;
  assert.equal(delivery.pull, "queued");
  assert.equal(delivery.nextAction, "check_delivery");
  assert.equal(delivery.recipientProgressAt, null);
});

test("an ordinary directed message to a hostless linked seat stays no_receiver", t => {
  const { store, identity, post } = fixture(t);
  const sent = post({
    messageId: "plain-dm",
    toMemberId: "receiver",
    body: "Just a note, not a formal request"
  });
  assert.deepEqual(sent.wakeDelivery, [{ memberId: "receiver", status: "no_receiver" }]);
  const row = store.db.prepare(
    "SELECT 1 AS ok FROM agent_wake_signals WHERE agent_id=? AND room_id=? AND message_id=?"
  ).get(identity.identityId, "commons", "plain-dm");
  assert.equal(row, undefined);
});

test("a later host poll can drain the queued formal-request fallback signal", t => {
  const { store, identity, post } = fixture(t);
  post({
    messageId: "later-host-ask",
    toMemberId: "receiver",
    requestKind: "reply",
    body: "Still waiting on this ask"
  });
  store.agentHeartbeats.heartbeat({
    agentId: identity.identityId, hostId: "host-1", mode: "wakeable",
    wakeUrl: "https://host.example.test/wake"
  });
  const page = store.agentHeartbeats.heartbeat({
    agentId: identity.identityId, hostId: "host-1", mode: "wakeable",
    wakeUrl: "https://host.example.test/wake"
  });
  assert.ok(page.pendingWakes.some(signal => signal.messageId === "later-host-ask" && signal.kind === "ask"));
});
