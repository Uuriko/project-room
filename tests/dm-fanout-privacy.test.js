import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// SEC-19 parity for the push path (DATA-FLOW-TRACE F-1): the read paths hide
// DM follow-up events (edits carrying the new body, deletes, pins, unpins,
// poll votes) from non-parties via server/dm-event-visibility.mjs, but the
// webhook fan-out only fenced the targeted message.posted itself — a
// non-party subscriber journaled a delivery for every DM follow-up, the
// edited DM body included. The fan-out now applies the same predicate, so
// a DM's follow-ups reach only the two parties' subscriptions.
function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "dm-fanout-privacy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  // Seat three agent members through identity links: alice and bob (the DM
  // parties) and hook (a non-party). Link creates the member row.
  const seat = (name, memberId) => {
    const identity = store.identities.create(name);
    store.identities.link(ownerKey, "commons", { identityId: identity.identityId, memberId, displayName: name, permissions: [] });
    return identity;
  };
  const alice = seat("Alice", "alice");
  const bob = seat("Bob", "bob");
  const hook = seat("Hook", "hook");
  // subscribeWebhook runs the SSRF lookup; resolve the hook host publicly
  // for the subscribe, then back to loopback for the (never-drained) rest.
  store.agentPlugin.setWebhookLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  for (const identity of [alice, bob, hook]) {
    store.agentPlugin.subscribeWebhook({ identityId: identity.identityId, url: "https://example.com/hook", events: ["*"] });
  }
  store.agentPlugin.setWebhookLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
  const keys = {
    alice: store.issueAccessKey("commons", "alice"),
    bob: store.issueAccessKey("commons", "bob"),
  };
  const deliveriesFor = identityId => store.db.prepare(
    "SELECT event_type, payload_json FROM agent_webhook_deliveries WHERE agent_id=? ORDER BY created_at").all(identityId);
  return { store, cmd, keys, alice, bob, hook, deliveriesFor };
}

const DM_IDS = ["dm-1", "dm-poll", "dm-2"];
const dmDeliveries = rows => rows.filter(r =>
  DM_IDS.some(id => (r.payload_json ?? "").includes(id)));

test("webhook fan-out: DM follow-up events stay with the two DM parties", async t => {
  const { store, cmd, keys, alice, bob, hook, deliveriesFor } = boot(t);
  store.dmConsents.request("commons", "alice", "bob", "fan-out fixture");
  store.dmConsents.decide("commons", "bob", "alice", "approve");
  const revision = id => store.room("commons").state.messages.find(m => m.id === id)?.revision ?? 0;

  // The DM and every follow-up type that can reference it.
  cmd(keys.alice, T.MESSAGE_POSTED, { messageId: "dm-1", body: "DM_BODY_V1", toMemberId: "bob" });
  cmd(keys.alice, T.MESSAGE_EDITED, { messageId: "dm-1", body: "DM_BODY_V2_EDITED", expectedMessageRevision: revision("dm-1") });
  cmd(keys.bob, T.MESSAGE_PINNED, { messageId: "dm-1" });
  cmd(keys.bob, T.MESSAGE_UNPINNED, { messageId: "dm-1" });
  cmd(keys.alice, T.MESSAGE_POSTED, { messageId: "dm-poll", body: "DM poll?", kind: "poll", poll: { question: "DM poll?", options: ["yes", "no"], allowMultiple: false }, toMemberId: "bob" });
  cmd(keys.bob, T.POLL_VOTED, { messageId: "dm-poll", option: 0, active: true });
  cmd(keys.alice, T.MESSAGE_POSTED, { messageId: "dm-2", body: "DM_BODY_DELETE_ME", toMemberId: "bob" });
  cmd(keys.alice, T.MESSAGE_DELETED, { messageId: "dm-2", expectedMessageRevision: revision("dm-2") });
  // Public control traffic: the fan-out must keep flowing for non-DM events.
  cmd(keys.alice, T.MESSAGE_POSTED, { messageId: "pub-1", body: "hello room" });
  cmd(keys.alice, T.MESSAGE_EDITED, { messageId: "pub-1", body: "hello room, edited", expectedMessageRevision: revision("pub-1") });

  // The non-party subscriber hears nothing about the DM — no delivery of
  // any DM follow-up type, and no DM body in any payload it did receive.
  const hookRows = deliveriesFor(hook.identityId);
  assert.deepEqual(dmDeliveries(hookRows), [], "non-party subscription journals no DM delivery");
  assert.ok(!hookRows.some(r => (r.payload_json ?? "").includes("DM_BODY")), "no DM body reaches the non-party payload journal");
  // ...while public events fan out to it unchanged.
  assert.ok(hookRows.some(r => r.event_type === "message.posted" && r.payload_json.includes("pub-1")), "public post still fans out to the non-party");
  assert.ok(hookRows.some(r => r.event_type === "message.edited" && r.payload_json.includes("pub-1")), "public edit still fans out to the non-party");

  // Both parties' subscriptions receive the DM and its follow-ups.
  const followUpTypes = [T.MESSAGE_EDITED, T.MESSAGE_PINNED, T.MESSAGE_UNPINNED, T.POLL_VOTED, T.MESSAGE_DELETED];
  for (const [identity, label] of [[alice, "sender"], [bob, "addressee"]]) {
    const rows = deliveriesFor(identity.identityId);
    const types = new Set(dmDeliveries(rows).map(r => r.event_type));
    assert.ok(types.has(T.MESSAGE_POSTED), `${label} receives the DM post`);
    for (const type of followUpTypes) assert.ok(types.has(type), `${label} receives the DM ${type} delivery`);
  }
  assert.ok(deliveriesFor(bob.identityId).some(r => (r.payload_json ?? "").includes("DM_BODY_V2_EDITED")),
    "the addressee's delivery carries the edited DM body");
});

test("webhook fan-out: a follow-up-only subscription still gets no DM edit", async t => {
  const { store, cmd, keys, hook, deliveriesFor } = boot(t);
  store.dmConsents.request("commons", "alice", "bob", "fan-out fixture");
  store.dmConsents.decide("commons", "bob", "alice", "approve");
  // A second non-party subscription filtered to edits alone.
  const editsOnly = store.identities.create("EditsOnly");
  store.identities.link(store.issueAccessKey("commons", "owner"), "commons",
    { identityId: editsOnly.identityId, memberId: "edits-only", displayName: "EditsOnly", permissions: [] });
  store.agentPlugin.setWebhookLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  store.agentPlugin.subscribeWebhook({ identityId: editsOnly.identityId, url: "https://example.com/hook", events: ["message.edited"] });
  store.agentPlugin.setWebhookLookup(async () => [{ address: "127.0.0.1", family: 4 }]);

  cmd(keys.alice, T.MESSAGE_POSTED, { messageId: "dm-x", body: "DM_X_V1", toMemberId: "bob" });
  const revision = store.room("commons").state.messages.find(m => m.id === "dm-x")?.revision ?? 0;
  cmd(keys.alice, T.MESSAGE_EDITED, { messageId: "dm-x", body: "DM_X_V2_EDITED", expectedMessageRevision: revision });
  cmd(keys.alice, T.MESSAGE_POSTED, { messageId: "pub-x", body: "public" });
  const pubRevision = store.room("commons").state.messages.find(m => m.id === "pub-x")?.revision ?? 0;
  cmd(keys.alice, T.MESSAGE_EDITED, { messageId: "pub-x", body: "public, edited", expectedMessageRevision: pubRevision });

  const rows = deliveriesFor(editsOnly.identityId);
  assert.equal(rows.length, 1, "the edits-only subscription journals exactly the public edit");
  assert.ok(rows[0].payload_json.includes("pub-x"), "the one delivery is the public edit");
  assert.deepEqual(dmDeliveries(deliveriesFor(hook.identityId)), [], "the wildcard non-party also hears nothing of the DM edit");
});
