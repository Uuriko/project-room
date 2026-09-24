import test from "node:test";
import assert from "node:assert/strict";
import {
  identityIdOf, mergeFriendBonds, bondWithPeer, friendChrome, proposeBondData,
  friendBondCommand, friendFailureMessage
} from "../src/friend-bond.js";

const bond = (overrides) => ({
  id: "bond-1",
  agentAId: "ai_muse",
  agentBId: "ai_quill",
  state: "proposed",
  proposedById: "ai_muse",
  proposedAt: 10,
  acceptedAt: null,
  revokedAt: null,
  ...overrides
});

test("propose and accept omit scopes", () => {
  const proposed = friendBondCommand("propose", { to: "ai_quill" });
  assert.equal(proposed.type, "bond.propose");
  assert.deepEqual(proposed.data, { to: "ai_quill" });
  assert.equal(Object.hasOwn(proposed.data, "scopes"), false);
  assert.deepEqual(proposeBondData("member-quill"), { to: "member-quill" });
  const accepted = friendBondCommand("accept", { bondId: "bond-1" });
  assert.deepEqual(accepted, { type: "bond.accept", data: { bondId: "bond-1" } });
  assert.equal(Object.hasOwn(accepted.data, "scopes"), false);
  const posted = friendBondCommand("dm", { to: "ai_quill", body: "hi", messageId: "m1" });
  assert.deepEqual(Object.keys(posted.data).sort(), ["body", "messageId", "to"]);
});

test("no bond, revoked, and expired are a Friend button", () => {
  for (const row of [null, bond({ state: "revoked" }), bond({ state: "expired" })]) {
    const chrome = friendChrome({ bond: row, selfIdentityId: "ai_muse" });
    assert.equal(chrome.state, "none");
    assert.equal(chrome.label, "Friend");
    assert.deepEqual(chrome.actions.map(action => action.label), ["Friend"]);
  }
});

test("incoming proposal is Proposed with Accept and Decline", () => {
  const chrome = friendChrome({ bond: bond(), selfIdentityId: "ai_quill" });
  assert.equal(chrome.state, "incoming");
  assert.equal(chrome.label, "Proposed");
  assert.deepEqual(chrome.actions.map(action => action.action), ["accept", "decline"]);
  assert.equal(chrome.bondId, "bond-1");
});

test("outgoing proposal is Proposed with Revoke and no Accept", () => {
  const chrome = friendChrome({ bond: bond(), selfIdentityId: "ai_muse" });
  assert.equal(chrome.state, "outgoing");
  assert.equal(chrome.label, "Proposed");
  assert.deepEqual(chrome.actions.map(action => action.action), ["revoke"]);
  const unknown = friendChrome({ bond: bond(), selfIdentityId: null });
  assert.equal(unknown.state, "outgoing");
  assert.equal(unknown.actions.some(action => action.action === "accept"), false);
});

test("an active bond is Friends plus peer DM and Revoke", () => {
  const chrome = friendChrome({
    bond: bond({ state: "active", acceptedAt: 20 }),
    selfIdentityId: "ai_muse"
  });
  assert.equal(chrome.state, "active");
  assert.equal(chrome.label, "Friends");
  assert.deepEqual(chrome.actions.map(action => action.action), ["dm", "revoke"]);
});

test("the bond list wins a tie so an expired proposal is not stuck proposed", () => {
  const projected = { "bond-1": bond({ state: "proposed", proposedAt: 10 }) };
  const listed = [bond({ state: "expired", proposedAt: 10 })];
  const merged = mergeFriendBonds(listed, projected);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].state, "expired");
  const peer = bondWithPeer(merged, "ai_muse", "ai_quill");
  assert.equal(friendChrome({ bond: peer, selfIdentityId: "ai_muse" }).state, "none");
});

test("a live accept on the projection beats a stale proposed list row", () => {
  const listed = [bond({ state: "proposed", proposedAt: 1_000 })];
  const projected = { "bond-1": bond({ state: "active", proposedAt: "1970-01-01T00:00:01.000Z", acceptedAt: "1970-01-01T00:00:02.000Z" }) };
  const merged = mergeFriendBonds(listed, projected);
  assert.equal(merged[0].state, "active");
  assert.equal(friendChrome({ bond: merged[0], selfIdentityId: "ai_muse" }).label, "Friends");
});

test("a newer projection propose replaces a stale revoked list row", () => {
  const listed = [bond({ state: "revoked", proposedAt: 10, revokedAt: 12 })];
  const projected = { "bond-2": bond({ id: "bond-2", state: "proposed", proposedAt: 30 }) };
  const merged = mergeFriendBonds(listed, projected);
  assert.equal(bondWithPeer(merged, "ai_muse", "ai_quill").id, "bond-2");
});

test("identity id prefers the member record, then presence", () => {
  assert.equal(identityIdOf({ identityId: "ai_muse" }, { ownerIdentityId: "ai_other" }), "ai_muse");
  assert.equal(identityIdOf({ kind: "agent" }, { ownerIdentityId: "ai_muse" }), "ai_muse");
  assert.equal(identityIdOf({ kind: "human" }, null), null);
});

test("peer DM refusals stay honest until the bond is active", () => {
  assert.match(friendFailureMessage({ code: "no_bond" }), /No active bond/);
  assert.match(friendFailureMessage({ code: "no_bond" }), /Friend/);
  assert.match(friendFailureMessage({ code: "bond_pending" }), /not accepted/);
  assert.match(friendFailureMessage({ code: "bond_revoked" }), /revoked/i);
  assert.doesNotMatch(friendFailureMessage({ code: "no_bond" }), /scope/i);
  assert.doesNotMatch(friendFailureMessage({ code: "bond_pending" }), /scope/i);
});
