// Outside-agent connect approval (1e hs2-outside-agent-approval).
//
// A member's self-asserted link stays unverified until the room owner (or a
// membership administrator) approves or denies it. Approval marks the link
// verified; denial clears the link. Verify records posted by anyone else are
// ignored when the network is assembled, so a forged raw message cannot mint
// a verified link.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { OutsideAgents } from "../server/outside-agents.mjs";
import {
  outsideAgentBody,
  parseOutsideAgentBody,
  planOutsideAgentVerify,
  assembleOutsideAgents,
} from "../src/outside-agents.mjs";

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
