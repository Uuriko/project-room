import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_BITS,
  DEFAULT_GRANTS,
  canAct,
  canEmitReceipt,
  canInviteMember,
  hasCapability,
  memberCapabilities
} from "../src/index.js";

const owner = Object.freeze({ id: "owner", kind: "human", role: "owner" });
const human = Object.freeze({ id: "maya", kind: "human", permissions: [] });
const agent = Object.freeze({ id: "guest-agent-1", kind: "agent", permissions: [] });

test("default grants: humans and agents get read only; existing permissions do not widen bits", () => {
  assert.deepEqual(memberCapabilities(human).bits, [...DEFAULT_GRANTS]);
  assert.deepEqual(memberCapabilities(agent).bits, ["read"]);
  assert.equal(memberCapabilities(human).owner, false);
  assert.equal(canAct(human), false);
  assert.equal(canEmitReceipt(agent), false);
  assert.equal(canInviteMember(human), false);

  const steward = { id: "mod", kind: "human", permissions: ["manage_members", "decide", "complete_work"] };
  assert.deepEqual(memberCapabilities(steward).bits, ["read"]);
  assert.equal(canInviteMember(steward), false);
  assert.equal(canAct(steward), false);
  assert.equal(canEmitReceipt(steward), false);
});

test("owner all-bits: role, isOwner, or Room ownerId match holds every bit", () => {
  assert.deepEqual(memberCapabilities(owner).bits, [...CAPABILITY_BITS]);
  assert.equal(memberCapabilities(owner).owner, true);
  assert.equal(canAct(owner), true);
  assert.equal(canEmitReceipt(owner), true);
  assert.equal(canInviteMember(owner), true);

  const flagged = { id: "potter", kind: "human", isOwner: true };
  assert.deepEqual(memberCapabilities(flagged).bits, [...CAPABILITY_BITS]);

  const matched = { id: "owner", kind: "human", permissions: [] };
  const { bits, owner: isOwner } = memberCapabilities(matched, { ownerId: "owner" });
  assert.equal(isOwner, true);
  assert.deepEqual(bits, [...CAPABILITY_BITS]);
});

test("deny act without bit: Approve/Reject stay closed; additive act or overlay list opens it", () => {
  assert.equal(canAct(human), false);
  assert.equal(canAct(agent), false);
  assert.equal(hasCapability({ id: "reviewer", capabilities: ["decide"] }, "act"), false);

  const granted = { id: "maya", kind: "human", act: true };
  assert.equal(canAct(granted), true);
  assert.deepEqual(memberCapabilities(granted).bits, ["read", "act"]);

  const overlay = { id: "codex", kind: "agent" };
  assert.equal(canAct(overlay, { capabilities: ["act"] }), true);
  assert.equal(canAct({ id: "inactive", act: true, active: false }), false);
});

test("invite_member gate: mint/invite stay closed without the bit; owner and grant pass", () => {
  assert.equal(canInviteMember(human), false);
  assert.equal(canInviteMember(agent), false);
  assert.equal(canInviteMember({ id: "mod", permissions: ["manage_members"] }), false);

  const granted = { id: "maya", kind: "human", invite_member: true };
  assert.equal(canInviteMember(granted), true);
  assert.equal(canAct(granted), false);

  const nested = { id: "alex", capabilityBits: { invite_member: true } };
  assert.equal(canInviteMember(nested), true);
  assert.equal(canInviteMember(owner), true);
});

test("emit_receipt gate: Receipt write stays closed without the bit; grant is a subset", () => {
  assert.equal(canEmitReceipt(human), false);
  assert.equal(canEmitReceipt({ id: "worker", permissions: ["complete_work"] }), false);

  const granted = { id: "producer", kind: "agent", emit_receipt: true };
  assert.equal(canEmitReceipt(granted), true);
  assert.deepEqual(memberCapabilities(granted).bits, ["read", "emit_receipt"]);
  assert.equal(canAct(granted), false);
  assert.equal(canInviteMember(granted), false);
  assert.equal(canEmitReceipt(owner), true);
});
