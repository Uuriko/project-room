import test from "node:test";
import assert from "node:assert/strict";
import {
  identityIdOf, mergeFriendBonds, bondWithPeer, friendChrome, proposeBondData,
  friendBondCommand, friendFailureMessage, friendFocusTarget
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
  assert.equal(posted.type, "dm.posted");
  assert.deepEqual(posted.data, { messageId: "m1", to: "ai_quill", body: "hi" });
  assert.deepEqual(Object.keys(posted.data), ["messageId", "to", "body"]);
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
  assert.equal(unknown.state, "pending");
  assert.equal(unknown.label, "Proposed");
  assert.deepEqual(unknown.actions, []);
});

test("an active bond is Friends, and Message stays unless scopes omit peer.dm", () => {
  const chrome = friendChrome({
    bond: bond({ state: "active", acceptedAt: 20, acceptedScopes: ["peer.wake", "peer.card", "peer.context", "peer.dm"] }),
    selfIdentityId: "ai_muse"
  });
  assert.equal(chrome.state, "active");
  assert.equal(chrome.label, "Friends");
  assert.deepEqual(chrome.actions.map(action => action.action), ["dm", "revoke"]);
  const noDm = friendChrome({
    bond: bond({ state: "active", acceptedAt: 20, acceptedScopes: ["peer.card"] }),
    selfIdentityId: "ai_muse"
  });
  assert.equal(noDm.label, "Friends");
  assert.deepEqual(noDm.actions.map(action => action.action), ["revoke"]);
  for (const acceptedScopes of [undefined, null, []]) {
    const missing = friendChrome({
      bond: bond({ state: "active", acceptedAt: 20, acceptedScopes }),
      selfIdentityId: "ai_muse"
    });
    assert.equal(missing.label, "Friends");
    assert.deepEqual(missing.actions.map(action => action.action), ["dm", "revoke"]);
  }
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

test("an active projection beats a proposed list row that shares its stamp", () => {
  const listed = [bond({ state: "proposed", proposedAt: 10 })];
  const projected = {
    "bond-1": bond({
      state: "active", proposedAt: 10, acceptedAt: 10,
      acceptedScopes: ["peer.dm"]
    })
  };
  const merged = mergeFriendBonds(listed, projected);
  assert.equal(merged[0].state, "active");
  assert.equal(friendChrome({ bond: merged[0], selfIdentityId: "ai_muse" }).label, "Friends");
  assert.equal(friendChrome({ bond: merged[0], selfIdentityId: "ai_muse" }).actions.some(action => action.action === "dm"), true);
});

test("a same-stamp re-proposal still replaces a revoked projection of another id", () => {
  const listed = [bond({ id: "bond-2", state: "proposed", proposedAt: 12 })];
  const projected = { "bond-1": bond({ id: "bond-1", state: "revoked", proposedAt: 10, revokedAt: 12 }) };
  const merged = mergeFriendBonds(listed, projected);
  assert.equal(bondWithPeer(merged, "ai_muse", "ai_quill").id, "bond-2");
  assert.equal(bondWithPeer(merged, "ai_muse", "ai_quill").state, "proposed");
});

test("a live accept on the projection beats a stale proposed list row", () => {
  const listed = [bond({ state: "proposed", proposedAt: 1_000 })];
  const projected = { "bond-1": bond({ state: "active", proposedAt: "1970-01-01T00:00:01.000Z", acceptedAt: "1970-01-01T00:00:02.000Z" }) };
  const merged = mergeFriendBonds(listed, projected);
  assert.equal(merged[0].state, "active");
  const chrome = friendChrome({ bond: merged[0], selfIdentityId: "ai_muse" });
  assert.equal(chrome.label, "Friends");
  assert.deepEqual(chrome.actions.map(action => action.action), ["dm", "revoke"]);
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
  for (const code of ["no_bond", "bond_pending", "bond_revoked"]) {
    const text = friendFailureMessage({ code });
    assert.doesNotMatch(text, /scope/i);
    assert.doesNotMatch(text, /\{ to, scopes \}/);
  }
});

test("friend actions focus the group so a repeated Enter cannot hit Revoke", () => {
  for (const action of ["propose", "accept", "decline", "revoke"]) {
    assert.equal(friendFocusTarget(action), "group");
  }
  assert.equal(friendFocusTarget("dm"), "composer");
  assert.notEqual(friendFocusTarget("accept"), "revoke");
  assert.notEqual(friendFocusTarget("propose"), "revoke");
});
