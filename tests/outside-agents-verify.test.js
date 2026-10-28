// Outside-agent connect approval (1e hs2-outside-agent-approval).
//
// A member's self-asserted link stays unverified until the room owner (or a
// membership administrator) approves or denies it. Approval marks the link
// verified; denial clears the link. Verify records posted by anyone else are
// ignored when the network is assembled, so a forged raw message cannot mint
// a verified link.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { OutsideAgents } from "../server/outside-agents.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { membershipDelegationSchema } from "../server/membership-delegation.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import {
  outsideAgentBody,
  parseOutsideAgentBody,
  planOutsideAgentVerify,
  assembleOutsideAgents,
} from "../src/outside-agents.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const bodyOf = record => outsideAgentBody(record);
const msg = (record, authorId, id) => ({
  id, authorId, body: bodyOf(record), toMemberId: null, deletedAt: null,
});
const introduce = externalRef => ({ v: 1, kind: "introduce", externalRef, displayName: "Ext", origin: "bus", reach: "bus:ext" });
const link = externalRef => ({ v: 1, kind: "link", externalRef, memberId: "producer" });
const verifyRec = (externalRef, decision, decidedBy = "owner", decidedAt = 1700000000000) =>
  ({ v: 1, kind: "verify", externalRef, decision, decidedBy, decidedAt });

const members = {
  owner: { active: true },
  producer: { active: true },
  mallory: { active: true },
};
const verifiers = new Set(["owner"]);

function linkedMessages() {
  return [
    msg(introduce("bus:cursor"), "producer", "m1"),
    msg(link("bus:cursor"), "producer", "m2"),
  ];
}

test("parseOutsideAgentBody accepts a verify record and rejects bad decisions", () => {
  const parsed = parseOutsideAgentBody(bodyOf(verifyRec("bus:cursor", "approved")));
  assert.equal(parsed.kind, "verify");
  assert.equal(parsed.decision, "approved");
  assert.equal(parsed.decidedBy, "owner");
  assert.equal(parseOutsideAgentBody(bodyOf(verifyRec("bus:cursor", "maybe"))), null);
  assert.equal(parseOutsideAgentBody(bodyOf({ v: 1, kind: "verify", externalRef: "bus:cursor" })), null);
});

test("planOutsideAgentVerify plans approval for a linked agent", () => {
  const messages = linkedMessages();
  const plan = planOutsideAgentVerify(messages, members, "room1", "owner",
    { externalRef: "bus:cursor", decision: "approved" });
  assert.equal(plan.recorded, "verify");
  assert.equal(plan.record.kind, "verify");
  assert.equal(plan.record.decision, "approved");
  assert.equal(plan.record.decidedBy, "owner");
  assert.ok(plan.commandId.startsWith("oa-verify-"));
  assert.equal(typeof plan.body, "string");
});

test("planOutsideAgentVerify rejects unknown agents, unlinked agents, and replays decided ones", () => {
  const messages = linkedMessages();
  const opts = { verifiers };
  assert.throws(() => planOutsideAgentVerify(messages, members, "room1", "owner",
    { externalRef: "bus:unknown", decision: "approved" }, opts), { code: "outside_agent_not_found" });
  assert.throws(() => planOutsideAgentVerify(
    [msg(introduce("bus:lonely"), "producer", "m1")], members, "room1", "owner",
    { externalRef: "bus:lonely", decision: "approved" }, opts), { code: "outside_agent_unlinked" });
  assert.throws(() => planOutsideAgentVerify(messages, members, "room1", "owner",
    { externalRef: "bus:cursor", decision: "maybe" }, opts), { code: "invalid_outside_agent" });
  const decided = [...messages, msg(verifyRec("bus:cursor", "approved"), "owner", "m3")];
  const replay = planOutsideAgentVerify(decided, members, "room1", "owner",
    { externalRef: "bus:cursor", decision: "approved" }, opts);
  assert.equal(replay.recorded, "replay");
});

test("assembleOutsideAgents marks the link verified on an owner approval", () => {
  const messages = [...linkedMessages(), msg(verifyRec("bus:cursor", "approved"), "owner", "m3")];
  const agents = assembleOutsideAgents(messages, members, { verifiers });
  const cursor = agents.find(a => a.externalRef === "bus:cursor");
  assert.equal(cursor.linkedMemberId, "producer");
  assert.equal(cursor.verified, true);
  assert.equal(cursor.verifiedBy, "owner");
});

test("assembleOutsideAgents ignores an approval when no link is in effect, so it cannot pre-verify a later link", () => {
  // A verify record replayed over a windowed/out-of-order message set:
  // the approval is seen before any link exists (#2978).
  const noLink = [msg(introduce("bus:cursor"), "producer", "m1"),
    msg(verifyRec("bus:cursor", "approved"), "owner", "m2")];
  const unlinked = assembleOutsideAgents(noLink, members, { verifiers })
    .find(a => a.externalRef === "bus:cursor");
  assert.equal(unlinked.linkedMemberId, null);
  assert.equal(unlinked.verified, false);
  assert.equal(unlinked.latestDecision, null);
  assert.equal(unlinked.decidedLinkMessageId, null);
  assert.equal(unlinked.verificationPending, false);

  // The same approval must not pre-verify a link that arrives after it:
  // the later link goes back to pending and waits for a fresh decision.
  const laterLink = [...noLink, msg(link("bus:cursor"), "producer", "m3")];
  const cursor = assembleOutsideAgents(laterLink, members, { verifiers })
    .find(a => a.externalRef === "bus:cursor");
  assert.equal(cursor.linkedMemberId, "producer");
  assert.equal(cursor.verified, false);
  assert.equal(cursor.verificationPending, true);
  // And a fresh decision on that link is planned, not treated as a replay.
  const plan = planOutsideAgentVerify(laterLink, members, "room1", "owner",
    { externalRef: "bus:cursor", decision: "approved" }, { verifiers });
  assert.equal(plan.recorded, "verify");
});

test("assembleOutsideAgents ignores a decision replayed after its link was denied, until a re-link is decided", () => {
  const messages = [...linkedMessages(),
    msg(verifyRec("bus:cursor", "denied"), "owner", "m3"),
    msg(verifyRec("bus:cursor", "approved"), "owner", "m4"),
    msg(link("bus:cursor"), "producer", "m5")];
  const cursor = assembleOutsideAgents(messages, members, { verifiers })
    .find(a => a.externalRef === "bus:cursor");
  assert.equal(cursor.linkedMemberId, "producer");
  assert.equal(cursor.verified, false);
  assert.equal(cursor.verificationPending, true);
});

test("assembleOutsideAgents still honors an approval for a link buffered before its introduction", () => {
  const messages = [msg(link("bus:cursor"), "producer", "m1"),
    msg(introduce("bus:cursor"), "producer", "m2"),
    msg(verifyRec("bus:cursor", "approved"), "owner", "m3")];
  const cursor = assembleOutsideAgents(messages, members, { verifiers })
    .find(a => a.externalRef === "bus:cursor");
  assert.equal(cursor.linkedMemberId, "producer");
  assert.equal(cursor.verified, true);
  assert.equal(cursor.decidedLinkMessageId, "m1");
});

test("assembleOutsideAgents ignores verify records from non-verifiers", () => {
  const messages = [...linkedMessages(), msg(verifyRec("bus:cursor", "approved", "mallory"), "mallory", "m3")];
  const agents = assembleOutsideAgents(messages, members, { verifiers });
  const cursor = agents.find(a => a.externalRef === "bus:cursor");
  assert.equal(cursor.linkedMemberId, "producer");
  assert.equal(cursor.verified, false);
});

test("assembleOutsideAgents ignores verify records when no verifier set is given", () => {
  const messages = [...linkedMessages(), msg(verifyRec("bus:cursor", "approved"), "owner", "m3")];
  const agents = assembleOutsideAgents(messages, members);
  assert.equal(agents.find(a => a.externalRef === "bus:cursor").verified, false);
});

test("assembleOutsideAgents clears the link on denial and lets the latest decision win", () => {
  const denied = [...linkedMessages(), msg(verifyRec("bus:cursor", "denied"), "owner", "m3")];
  const afterDeny = assembleOutsideAgents(denied, members, { verifiers });
  const cursor = afterDeny.find(a => a.externalRef === "bus:cursor");
  assert.equal(cursor.linkedMemberId, null);
  assert.equal(cursor.verified, false);
  assert.equal(cursor.verifiedBy, "owner");
  // A later approval re-verifies (e.g. after the member re-links).
  const relinked = [...denied,
    msg(link("bus:cursor"), "producer", "m4"),
    msg(verifyRec("bus:cursor", "approved"), "owner", "m5")];
  const afterReapprove = assembleOutsideAgents(relinked, members, { verifiers });
  const again = afterReapprove.find(a => a.externalRef === "bus:cursor");
  assert.equal(again.linkedMemberId, "producer");
  assert.equal(again.verified, true);
});

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.net = new OutsideAgents(f.store);
  return f;
}

test("server: owner approves a link; the list surfaces the verified link", t => {
  const f = fixture(t);
  f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor", origin: "bus", reach: "bus:cursor",
  });
  f.net.link(f.keys.producer, "commons", { externalRef: "bus:cursor", memberId: "producer" });
  const pending = f.net.list(f.keys.owner, "commons").agents.find(a => a.externalRef === "bus:cursor");
  assert.equal(pending.linkedMemberId, "producer");
  assert.equal(pending.verified, false);
  assert.equal(pending.verificationPending, true);
  const decided = f.net.verify(f.keys.owner, "commons", { externalRef: "bus:cursor", decision: "approved" });
  assert.equal(decided.recorded, "verify");
  const agent = decided.agents.find(a => a.externalRef === "bus:cursor");
  assert.equal(agent.verified, true);
  assert.equal(agent.verifiedBy, "owner");
  assert.equal(agent.verificationPending, false);
});

test("server: non-owners cannot verify; denial clears the link", t => {
  const f = fixture(t);
  f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor", origin: "bus", reach: "bus:cursor",
  });
  f.net.link(f.keys.producer, "commons", { externalRef: "bus:cursor", memberId: "producer" });
  assert.throws(() => f.net.verify(f.keys.producer, "commons", { externalRef: "bus:cursor", decision: "approved" }),
    { code: "outside_agent_forbidden", status: 403 });
  const denied = f.net.verify(f.keys.owner, "commons", { externalRef: "bus:cursor", decision: "denied" });
  const agent = denied.agents.find(a => a.externalRef === "bus:cursor");
  assert.equal(agent.linkedMemberId, null);
  assert.equal(agent.verified, false);
});

test("server: a membership-delegation grant holder can verify a link", t => {
  // #2851: #verifiers looked the grant up with room.id, but store.room()
  // returns { sequence, state } with no .id, so hasGrant always answered
  // false and a membership-administration delegate could never verify.
  const directory = mkdtempSync(join(tmpdir(), "project-room-outside-agents-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  store.db.exec(membershipDelegationSchema);
  const net = new OutsideAgents(store);
  const ownerToken = store.issueAccessKey("commons", "owner");
  const producer = store.identities.create("Producer Agent");
  const producerLinked = linkWithProof(store, ownerToken, "commons", producer, { displayName: "Producer Agent", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, "commons", producerLinked.memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  // The delegate holds work permissions only (no manage_members), so its
  // only path into the verifier set is the delegation grant.
  const delegate = store.identities.create("Delegate Agent");
  const delegateLinked = linkWithProof(store, ownerToken, "commons", delegate, { displayName: "Delegate Agent", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, "commons", delegateLinked.memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });

  net.record(producer.secret, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor", origin: "bus", reach: "bus:cursor",
  });
  net.link(producer.secret, "commons", { externalRef: "bus:cursor", memberId: producerLinked.memberId });

  // No grant yet: the delegate is not a verifier.
  assert.throws(() => net.verify(delegate.secret, "commons", { externalRef: "bus:cursor", decision: "approved" }),
    { code: "outside_agent_forbidden", status: 403 });

  store.delegation.grant(ownerToken, "commons", { identityId: delegate.identityId });

  const decided = net.verify(delegate.secret, "commons", { externalRef: "bus:cursor", decision: "approved" });
  assert.equal(decided.recorded, "verify");
  const agent = decided.agents.find(a => a.externalRef === "bus:cursor");
  assert.equal(agent.verified, true);
  assert.equal(agent.verifiedBy, delegateLinked.memberId);
});

test("server: list names the verify step for pending links", t => {
  const f = fixture(t);
  f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor", origin: "bus", reach: "bus:cursor",
  });
  f.net.link(f.keys.producer, "commons", { externalRef: "bus:cursor", memberId: "producer" });
  const view = f.net.list(f.keys.owner, "commons");
  const pending = view.pendingVerifications ?? [];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].externalRef, "bus:cursor");
  const next = (view.next ?? []).find(n => n.action === "verify");
  assert.ok(next, "expected a verify next action");
  assert.equal(next.method, "POST");
  assert.ok(next.path.includes("/outside-agents"));
});
