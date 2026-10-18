// SECURITY-FIX C3 (HUNT-ADVERSARY P3, issue #942): a direct identity
// link must prove the identity HOLDER consented to the binding. Before
// this gate, anyone who learned an identity's public ai_… id could have
// a room owner (or membership delegate) bind it into a room the holder
// never asked to join — no secret, code, or signature from the holder
// anywhere in link(). The holder's proofs are: a link code they minted
// for this room (consumed at bind), or an approved access request on
// record (filing was secret-proven under #2912; decide() records the
// approval before it drives link()).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { linkWithProof, mintHolderLinkCode } from "./helpers/link-with-proof.mjs";

const proofRequired = error => error.status === 422 && error.code === "identity_link_proof_required";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-link-proof-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("lab"));
  const ownerCommons = store.issueAccessKey("commons", "owner");
  const ownerLab = store.issueAccessKey("lab", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerCommons, ownerLab };
}

const linkRows = (store, identityId) =>
  store.db.prepare("SELECT room_id AS roomId FROM identity_links WHERE identity_id=?")
    .all(identityId).map(row => ({ roomId: row.roomId }));

test("C3: a direct link without holder proof is refused 422 and writes nothing", async t => {
  const { store, ownerCommons } = setup(t);
  const victim = store.identities.create("Unconsenting Agent");
  assert.throws(
    () => store.identities.link(ownerCommons, "commons", { identityId: victim.identityId, permissions: [] }),
    proofRequired);
  assert.deepEqual(linkRows(store, victim.identityId), [], "no link row was written");
  assert.equal(store.room("commons").state.members[victim.identityId], undefined, "no member was created");
});

test("C3: a code minted for a different identity does not bind this one", async t => {
  const { store, ownerCommons } = setup(t);
  const victim = store.identities.create("Victim Agent");
  const other = store.identities.create("Other Agent");
  const othersCode = mintHolderLinkCode(store, other, "commons");
  assert.throws(
    () => store.identities.link(ownerCommons, "commons",
      { identityId: victim.identityId, permissions: [], identityLinkCode: othersCode }),
    proofRequired);
  assert.deepEqual(linkRows(store, victim.identityId), []);
  // The refused attempt must not burn the other identity's code either:
  // it still redeems for the identity it was minted for.
  assert.doesNotThrow(() => store.identities.link(ownerCommons, "commons",
    { identityId: other.identityId, permissions: [], identityLinkCode: othersCode }));
});

test("C3: a code minted for another room does not bind here; the holder's own code does", async t => {
  const { store, ownerCommons } = setup(t);
  const agent = store.identities.create("Two-Room Agent");
  const labCode = store.identities.mintLinkCode(agent.identityId, agent.secret, { roomId: "lab" }).linkCode;
  assert.throws(
    () => store.identities.link(ownerCommons, "commons",
      { identityId: agent.identityId, permissions: [], identityLinkCode: labCode }),
    proofRequired);
  const linked = linkWithProof(store, ownerCommons, "commons", agent, { permissions: [] });
  assert.equal(linked.memberId, agent.identityId);
  assert.deepEqual(linkRows(store, agent.identityId), [{ roomId: "commons" }]);
  const row = store.db.prepare(
    "SELECT consumed_at AS consumedAt FROM identity_link_codes WHERE identity_id=? AND room_id='commons'").get(agent.identityId);
  assert.notEqual(row.consumedAt, null, "the redeemed code is consumed");
});

test("C3: a consumed code cannot be replayed after unlink", async t => {
  const { store, ownerCommons } = setup(t);
  const agent = store.identities.create("Replay Agent");
  const code = mintHolderLinkCode(store, agent, "commons");
  store.identities.link(ownerCommons, "commons",
    { identityId: agent.identityId, permissions: [], identityLinkCode: code });
  store.identities.unlink(ownerCommons, "commons", agent.identityId);
  assert.throws(
    () => store.identities.link(ownerCommons, "commons",
      { identityId: agent.identityId, permissions: [], identityLinkCode: code }),
    proofRequired, "the same code must not bind twice");
  // A fresh code from the holder re-links (the re-link branch is gated too).
  assert.doesNotThrow(() => linkWithProof(store, ownerCommons, "commons", agent, { permissions: [] }));
});

test("C3: a code pre-named to a sponsor account fails closed at the direct-link door", async t => {
  const { store, ownerCommons } = setup(t);
  const agent = store.identities.create("Sponsored Agent");
  // link() acts for a room member, not an enrolling account, so it can
  // never present the named sponsor: the code refuses here and remains
  // redeemable only through the enrollment flow it was minted for.
  const code = store.identities.mintLinkCode(agent.identityId, agent.secret,
    { roomId: "commons", sponsorAccountId: "acct_sponsor" }).linkCode;
  assert.throws(
    () => store.identities.link(ownerCommons, "commons",
      { identityId: agent.identityId, permissions: [], identityLinkCode: code }),
    proofRequired);
  assert.deepEqual(linkRows(store, agent.identityId), []);
});

test("C3: the access-request approval path binds without a code (decide exemption)", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-link-proof-decide-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Requesting Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"],
    requestId: "ar_holder_proof"
  }, identity.secret);
  // No link code exists anywhere in this flow: filing was secret-proven,
  // and decide() records the approval before driving link(), so the
  // approved request on record is the holder proof.
  const decided = requests.decide(ownerToken, "commons", "ar_holder_proof", { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.equal(decided.memberId, identity.identityId);
  assert.deepEqual(linkRows(store, identity.identityId), [{ roomId: "commons" }]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM identity_link_codes").get().n, 0,
    "the approval path minted and consumed no link code");
});

// ATLAS-SECURITY-2 S2-1: at the original C3 head, link() ran
// closePendingAccessRequests BEFORE requireLinkHolderProof, so a
// merely PENDING request — which the link call itself flipped to
// 'approved' as a side effect — satisfied the gate, with permissions
// bounded only by what the linker held, never by what the holder
// asked for. The gate must evaluate proof against the record as it
// stood on entry, and a request-based exemption covers only the
// permissions that request asked for.
function setupWithRequests(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-link-proof-s2-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, ownerToken };
}

const requestRow = (store, requestId) => store.db.prepare(
  "SELECT status, decided_by AS decidedBy, decision_note AS decisionNote FROM access_requests WHERE request_id=?")
  .get(requestId);

test("S2-1: a merely pending access request does not satisfy the holder-proof gate", async t => {
  const { store, requests, ownerToken } = setupWithRequests(t);
  const agent = store.identities.create("Pending Agent");
  requests.request("commons", {
    identityId: agent.identityId,
    displayName: "Pending Agent",
    requestedPermissions: ["accept_work"],
    requestId: "ar_s2_pending"
  }, agent.secret);
  assert.equal(requestRow(store, "ar_s2_pending").status, "pending");
  // The ATLAS-SECURITY-2 repro: direct link, no code, permissions the
  // holder never asked for. Pre-fix this succeeded and the request row
  // afterwards read 'approved … linked directly'.
  assert.throws(
    () => store.identities.link(ownerToken, "commons",
      { identityId: agent.identityId, permissions: ["steer"] }),
    proofRequired);
  assert.deepEqual(linkRows(store, agent.identityId), [], "no link row was written");
  assert.equal(store.room("commons").state.members[agent.identityId], undefined, "no member was created");
  const row = requestRow(store, "ar_s2_pending");
  assert.equal(row.status, "pending", "the refused link must not manufacture an approval");
  assert.equal(row.decidedBy, null);
});

test("S2-1: an approved request exempts only the permissions it asked for", async t => {
  const { store, requests, ownerToken } = setupWithRequests(t);
  const agent = store.identities.create("Scoped Agent");
  requests.request("commons", {
    identityId: agent.identityId,
    displayName: "Scoped Agent",
    requestedPermissions: ["accept_work"],
    requestId: "ar_s2_scoped"
  }, agent.secret);
  const decided = requests.decide(ownerToken, "commons", "ar_s2_scoped", { decision: "approve" });
  assert.equal(decided.status, "approved");
  store.identities.unlink(ownerToken, "commons", agent.identityId);
  // Re-link within the approved scope: the standing approval is the proof.
  assert.doesNotThrow(() => store.identities.link(ownerToken, "commons",
    { identityId: agent.identityId, permissions: ["accept_work"] }));
  store.identities.unlink(ownerToken, "commons", agent.identityId);
  // Re-link beyond the approved scope: the request never asked for
  // 'steer', so the exemption does not cover it — a holder code is
  // required for the broader grant.
  assert.throws(
    () => store.identities.link(ownerToken, "commons",
      { identityId: agent.identityId, permissions: ["steer"] }),
    proofRequired);
  assert.deepEqual(linkRows(store, agent.identityId), [], "the over-broad re-link wrote nothing");
});

test("S2-1: decide() may still grant more than was requested (decider sovereignty)", async t => {
  const { store, requests, ownerToken } = setupWithRequests(t);
  const agent = store.identities.create("Sovereign Grant Agent");
  requests.request("commons", {
    identityId: agent.identityId,
    displayName: "Sovereign Grant Agent",
    requestedPermissions: ["accept_work"],
    requestId: "ar_s2_sovereign"
  }, agent.secret);
  // The decider is present in this very call and is sovereign (see
  // decide(): "the owner chooses the final permissions"). The
  // requestedPermissions bound governs LATER direct links that lean on
  // the standing approved row, not the decision's own link.
  const decided = requests.decide(ownerToken, "commons", "ar_s2_sovereign",
    { decision: "approve", permissions: ["accept_work", "steer"] });
  assert.equal(decided.status, "approved");
  assert.deepEqual([...decided.grantedPermissions].sort(), ["accept_work", "steer"]);
  assert.deepEqual(linkRows(store, agent.identityId), [{ roomId: "commons" }]);
});

test("S2-1: a holder code proves a broader grant while a request is pending", async t => {
  const { store, requests, ownerToken } = setupWithRequests(t);
  const agent = store.identities.create("Code Over Pending Agent");
  requests.request("commons", {
    identityId: agent.identityId,
    displayName: "Code Over Pending Agent",
    requestedPermissions: ["accept_work"],
    requestId: "ar_s2_code"
  }, agent.secret);
  // A holder-minted code is unbounded proof: it binds with permissions
  // broader than the pending request asked for, and only then does
  // closePendingAccessRequests clear the owner's queue.
  const code = mintHolderLinkCode(store, agent, "commons");
  const linked = store.identities.link(ownerToken, "commons",
    { identityId: agent.identityId, permissions: ["steer"], identityLinkCode: code });
  assert.equal(linked.memberId, agent.identityId);
  assert.deepEqual(store.room("commons").state.members[agent.identityId].permissions, ["steer"]);
  assert.equal(requestRow(store, "ar_s2_code").status, "approved",
    "a successful code-proven link still closes the pending request");
});

test("C3: the HTTP route carries identityLinkCode and enforces the gate", async t => {
  const { store, ownerCommons } = setup(t);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${origin}/api/rooms/commons/identity-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, authorization: `Bearer ${ownerCommons}` },
    body: JSON.stringify(body)
  });
  const agent = store.identities.create("HTTP Agent");

  const refused = await post({ identityId: agent.identityId, permissions: [] });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error.code, "identity_link_proof_required");
  assert.deepEqual(linkRows(store, agent.identityId), []);

  const identityLinkCode = mintHolderLinkCode(store, agent, "commons");
  const linked = await post({ identityId: agent.identityId, permissions: [], identityLinkCode });
  assert.equal(linked.status, 201);
  assert.deepEqual(linkRows(store, agent.identityId), [{ roomId: "commons" }]);
});
