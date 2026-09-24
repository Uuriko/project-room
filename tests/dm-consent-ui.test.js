import test from "node:test";
import assert from "node:assert/strict";
import {
  dmConsentHandleOf, dmConsentPeerSummary, incomingDmRequests, dmConsentPairDescription,
  dmConsentActionsForPeer, dmConsentStatusLabel, fetchDmConsents, requestDmConsent,
  decideDmConsent, revokeDmConsent, blockDmMember, unblockDmMember, dmConsentFailureMessage,
} from "../src/dm-consents.js";

const member = (id, displayName) => ({ id, displayName, kind: "human", active: true, permissions: [] });
const members = {
  me: member("me", "Me"),
  bob: member("bob", "Bob"),
  zed: member("zed", "  Zed  "),
};
const row = (requester, target, status, outgoing, reason = "") =>
  ({ requester, target, status, reason, createdAt: 1000, decidedAt: null, outgoing });
// Rows with authoritative ids, as the server now returns.
const idRow = (requesterId, targetId, requester, target, status, outgoing, reason = "") =>
  ({ requester, target, requesterId, targetId, status, reason, createdAt: 1000, decidedAt: null, outgoing });

test("handles mirror the server: trimmed displayName, id fallback", () => {
  assert.equal(dmConsentHandleOf(members.bob), "Bob");
  assert.equal(dmConsentHandleOf(members.zed), "Zed");
  assert.equal(dmConsentHandleOf({ id: "ghost", displayName: "   " }), "ghost");
});

test("peer summary maps outgoing/incoming directions; self and unknown are null", () => {
  const consents = [
    idRow("me", "bob", "Me", "Bob", "pending", true),
    idRow("bob", "me", "Bob", "Me", "approved", false),
  ];
  const summary = dmConsentPeerSummary(consents, members, "me", "bob");
  assert.equal(summary.outgoing, "pending");
  assert.equal(summary.incoming, "approved");
  assert.equal(dmConsentPeerSummary(consents, members, "me", "me"), null);
  assert.equal(dmConsentPeerSummary(consents, members, "me", "ghost"), null);
  const empty = dmConsentPeerSummary([], members, "me", "zed");
  assert.equal(empty.outgoing, null);
  assert.equal(empty.incoming, null);
});

test("duplicate display names stay unambiguous when rows carry ids", () => {
  const dupes = { ...members, bob2: member("bob2", "Bob") };
  const consents = [
    idRow("me", "bob2", "Me", "Bob", "approved", true),
    idRow("bob", "me", "Bob", "Me", "pending", false),
  ];
  const forBob2 = dmConsentPeerSummary(consents, dupes, "me", "bob2");
  assert.equal(forBob2.outgoing, "approved");
  assert.equal(forBob2.incoming, null);
  const forBob = dmConsentPeerSummary(consents, dupes, "me", "bob");
  assert.equal(forBob.outgoing, null);
  assert.equal(forBob.incoming, "pending");
});

test("incoming requests filter pending incoming and resolve requester ids", () => {
  const consents = [
    idRow("bob", "me", "Bob", "Me", "pending", false, "sync?"),
    idRow("zed", "me", "Zed", "Me", "approved", false),
    idRow("me", "bob", "Me", "Bob", "pending", true),
    idRow("alice", "zed", "Alice", "Zed", "pending", false),
    row("Ghost", "Me", "pending", false),
  ];
  const requests = incomingDmRequests(consents, members, "me");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].requesterId, "bob");
  assert.equal(requests[0].reason, "sync?");
});

test("ambiguous handle fallback fails closed instead of guessing", () => {
  const dupes = { ...members, bob2: member("bob2", "Bob") };
  // No ids on the row (older server): "Bob" maps to two members → dropped.
  const requests = incomingDmRequests([row("Bob", "Me", "pending", false)], dupes, "me");
  assert.equal(requests.length, 0);
  // One member named Bob: the handle fallback still works.
  const single = incomingDmRequests([row("Bob", "Me", "pending", false)], members, "me");
  assert.equal(single.length, 1);
  assert.equal(single[0].requesterId, "bob");
});

test("actions: request when none, pending label while waiting, revoke when approved", () => {
  const actionsFor = (outgoing, incoming) =>
    Object.fromEntries(dmConsentActionsForPeer({ outgoing, incoming, incomingReason: "" }).map(a => [a.action, a]));
  let a = actionsFor(null, null);
  assert.ok(a.request && !a.request.disabled);
  assert.equal(a.block.label, "Block");
  a = actionsFor("pending", null);
  assert.ok(a["noop-pending"].disabled);
  a = actionsFor("approved", null);
  assert.ok(a.revoke);
  a = actionsFor("blocked", null);
  assert.ok(a["noop-blocked"].disabled);
  assert.ok(!a.request);
  a = actionsFor("rejected", null);
  assert.equal(a.request.label, "Request again");
  a = actionsFor("revoked", null);
  assert.equal(a.request.label, "Request again");
});

test("actions: incoming pending gets approve/reject/block; blocked gets unblock", () => {
  const actionsFor = incoming =>
    dmConsentActionsForPeer({ outgoing: null, incoming, incomingReason: "" }).map(a => a.action);
  assert.deepEqual(actionsFor("pending").slice(0, 3), ["approve", "reject", "block"]);
  assert.ok(actionsFor("blocked").includes("unblock"));
  assert.ok(!actionsFor("blocked").includes("block"));
  assert.ok(actionsFor("approved").includes("revoke"));
  assert.ok(actionsFor("approved").includes("block"), "an approved incoming consent can be blocked directly");
});

test("pair descriptions narrate both directions honestly", () => {
  const lines = dmConsentPairDescription({ outgoing: "pending", incoming: null }, "Bob");
  assert.ok(lines.some(l => /still pending/.test(l)));
  const blocked = dmConsentPairDescription({ outgoing: "blocked", incoming: "blocked" }, "Bob");
  assert.ok(blocked.some(l => /isn't accepting/.test(l)));
  assert.ok(blocked.some(l => /You've blocked/.test(l)));
  const none = dmConsentPairDescription({ outgoing: null, incoming: null }, "Bob");
  assert.ok(none.some(l => /open by default/.test(l)));
});

test("status labels are human", () => {
  assert.equal(dmConsentStatusLabel("pending"), "Request pending");
  assert.equal(dmConsentStatusLabel("rejected"), "Declined");
  assert.equal(dmConsentStatusLabel("blocked"), "Blocked");
});

function stubClient() {
  const calls = [];
  return {
    calls,
    path: p => `/api/rooms/commons${p}`,
    request: async (path, opts = {}) => { calls.push({ path, ...opts }); return { ok: true }; },
  };
}

test("API wrappers hit the exact server routes with exact bodies", async () => {
  const client = stubClient();
  await fetchDmConsents(client);
  await requestDmConsent(client, "bob", "sync?");
  await requestDmConsent(client, "bob", "   ");
  await decideDmConsent(client, "alice", "approve");
  await revokeDmConsent(client, "bob");
  await blockDmMember(client, "bob");
  await unblockDmMember(client, "bob");
  const base = "/api/rooms/commons/dm-consents";
  assert.deepEqual(client.calls.map(c => [c.method ?? "GET", c.path]), [
    ["GET", base],
    ["POST", base],
    ["POST", base],
    ["POST", `${base}/alice/decide`],
    ["POST", `${base}/revoke`],
    ["POST", `${base}/block`],
    ["POST", `${base}/unblock`],
  ]);
  assert.deepEqual(client.calls[1].data, { targetId: "bob", reason: "sync?" });
  assert.deepEqual(client.calls[2].data, { targetId: "bob" }, "blank reasons are omitted, not sent empty");
  assert.deepEqual(client.calls[3].data, { decision: "approve" });
  assert.deepEqual(client.calls[5].data, { peerId: "bob" });
  assert.throws(() => decideDmConsent(client, "alice", "maybe"), /decision must be/);
});

test("API wrapper encodes requester ids in the decide path", async () => {
  const client = stubClient();
  await decideDmConsent(client, "a/b", "reject");
  assert.ok(client.calls[0].path.includes("a%2Fb"), client.calls[0].path);
});

test("failure messages: gate codes are actionable, transport failures stay honest", () => {
  assert.match(dmConsentFailureMessage({ code: "dm_consent_required" }, "Bob"), /Bob declined/);
  assert.match(dmConsentFailureMessage({ code: "dm_consent_required" }, "Bob"), /ask in the room/);
  assert.match(dmConsentFailureMessage({ code: "dm_consent_required" }), /They declined/);
  assert.match(dmConsentFailureMessage({ code: "dm_blocked" }, "Bob"), /Bob isn't accepting/);
  assert.match(dmConsentFailureMessage({ code: "dm_already_approved" }), /already approved/);
  assert.match(dmConsentFailureMessage({ code: "dm_no_pending_request" }), /no longer pending/);
  assert.match(dmConsentFailureMessage({ code: "member_not_found" }), /isn't in this room/);
  assert.equal(dmConsentFailureMessage(new TypeError("Failed to fetch")), "Couldn't reach the room — check your connection and try again.");
  assert.equal(dmConsentFailureMessage({ code: "dm_blocked" }), "They aren't accepting direct messages from you.");
  // A 4xx gate code always maps to the actionable copy, never a raw message.
  assert.equal(dmConsentFailureMessage({ code: "dm_blocked", message: "no", status: 403 }, "Bob"), "Bob isn't accepting direct messages from you.");
});
