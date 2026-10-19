// Identity-holder proof-of-possession for identityId enrollment
// (Uuriko/project-room#942, task RC-2026-09-24-210). Replaces the #948
// interim disable: agent-connections create with identityId requires a
// single-use link code minted by the identity holder with their own pri_
// secret. Every failure reads as 422 identity_link_proof_required — no
// oracle. The raw code is never persisted; only its SHA-256 hash is
// stored until consumed (or expired).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AgentRooms } from "../server/agent-rooms.mjs";

function fixture(t) {
  let now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner"), session = store.createSession(ownerKey);
  const secret = () => { const token = randomBytes(32).toString("base64url"); return { token, keyHash: createHash("sha256").update(token).digest("hex") }; };
  const apply = (body, token = session.token, binding = session.session.sessionBinding) => store.agentConnections.apply(token, "commons", body, binding);
  const createRequest = (extra = {}) => ({ action: "create", requestId: randomUUID(), memberId: `agent-${randomUUID()}`, displayName: "My assistant", access: "chat", keyHash: secret().keyHash, expiresAt: now + 3600000, expectedOwnerRevision: 0, ...extra });
  return { store, ownerKey, session, apply, createRequest, setNow: value => now = value, now: () => now };
}

function expectProofFailure(t, fn) {
  // Fail closed: every proof problem reads as the one 422 — no oracle
  // distinguishing missing from wrong from expired from reused.
  assert.throws(fn, { code: "identity_link_proof_required" });
  assert.throws(fn, error => error.status === 422);
}

test("create with identityId but no code fails closed 422 identity_link_proof_required and creates nothing", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const req = f.createRequest({ identityId: identity.identityId });
  expectProofFailure(t, () => f.apply(req));
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("create with malformed codes fails closed as proof failures, not shape errors", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  for (const bad of ["short", "x".repeat(22), null, 42, "a+b/cdefghijklmnopqr", "\u{1f600}".repeat(22)]) {
    expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: bad })));
  }
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("create with unknown identityId and a well-formed code still 422s — no identity oracle", t => {
  const f = fixture(t);
  const code = randomBytes(16).toString("base64url");
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: "ai_doesnotexist000000000000000000000000000000", identityLinkCode: code })));
});

test("create with identityId but no code never discloses identity existence", t => {
  // The proof check fires before the identity lookup: a sponsor with a
  // pri_ secret for one identity can't use the error shape to probe
  // whether a different identityId exists.
  const f = fixture(t);
  const real = f.store.identities.create("Atomic Agent");
  for (const identityId of [real.identityId, "ai_doesnotexist000000000000000000000000000000"]) {
    expectProofFailure(t, () => f.apply(f.createRequest({ identityId })));
  }
});

test("valid proof enrolls atomically: link row, member stamp, receipt echo, bond resolution", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  assert.equal(minted.identityId, identity.identityId);
  assert.match(minted.linkCode, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(minted.expiresAt - f.now(), 10 * 60 * 1000);
  const req = f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode });
  const result = f.apply(req);
  assert.equal(result.receipt.identityId, identity.identityId, "receipt echoes the linked identity");
  const row = f.store.db.prepare("SELECT identity_id FROM identity_links WHERE room_id=? AND member_id=?").get("commons", req.memberId);
  assert.equal(row?.identity_id, identity.identityId, "identity_links row written in the same transaction");
  assert.equal(f.store.room("commons").state.members[req.memberId].identityId, identity.identityId, "member record stamped");
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), identity.identityId, "bond surface resolves the link");
  assert.equal(f.store.db.prepare("SELECT consumed_at FROM identity_link_codes").get().consumed_at !== null, true, "proof consumed");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("the raw link code is never persisted: not in the operation row, receipt, or fingerprint input", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  const req = f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode });
  const result = f.apply(req);
  const op = f.store.db.prepare("SELECT request_json, receipt_json, fingerprint FROM agent_connection_operations").get();
  for (const blob of [op.request_json, op.receipt_json, JSON.stringify(result)]) {
    assert(!blob.includes(minted.linkCode), "raw code must not appear in the journal or receipt");
  }
  const parsed = JSON.parse(op.request_json);
  assert.equal(parsed.identityLinkCode, undefined, "persisted request carries no proof field");
  assert.doesNotThrow(() => f.store.agentConnections.verify(), "history replay works without the code");
});

test("wrong-bound code fails: minted for A, presented for B", t => {
  const f = fixture(t);
  const a = f.store.identities.create("Agent A"), b = f.store.identities.create("Agent B");
  const minted = f.store.identities.mintLinkCode(a.identityId, a.secret, { roomId: "commons" });
  const req = f.createRequest({ identityId: b.identityId, identityLinkCode: minted.linkCode });
  expectProofFailure(t, () => f.apply(req));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0, "nothing linked");
  assert.equal(f.store.room("commons").state.members[req.memberId], undefined, "failed consume rolls back the member");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connection_operations").get().n, 0, "failed consume writes no operation");
  // The unconsumed code is NOT burned by the failed attempt — holder retries still work.
  const result = f.apply(f.createRequest({ identityId: a.identityId, identityLinkCode: minted.linkCode }));
  assert.equal(result.receipt.identityId, a.identityId);
});

test("expired code fails closed", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  f.setNow(f.now() + 10 * 60 * 1000 + 1);
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  // The next mint prunes the expired row (TTL debris never wedges the cap).
  f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_link_codes WHERE identity_id=?").get(identity.identityId).n, 1);
});

test("reused code fails: the second enrollment with a fresh requestId burns", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode }));
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode, displayName: "My assistant again" })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 1, "exactly one link survives");
});

test("tampered code fails", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  const tampered = minted.linkCode.slice(0, 21) + (minted.linkCode[21] === "A" ? "B" : "A");
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: tampered })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("code minted then identity revoked fails closed", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  f.store.identities.revoke(identity.identityId, identity.secret);
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("mintLinkCode: wrong secret is 401, unknown identity is 404, and no code is stored for failures", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, "not-a-secret", { roomId: "commons" }), { code: "unauthenticated" });
  // Well-formed pri_ secret belonging to a DIFFERENT identity: 401, not 403/404.
  const other = f.store.identities.create("Other Agent");
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, other.secret, { roomId: "commons" }), { code: "unauthenticated" });
  assert.throws(() => f.store.identities.mintLinkCode("ai_doesnotexist000000000000000000000000000000", "pri_whatever", { roomId: "commons" }), { code: "identity_not_found" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_link_codes").get().n, 0);
});

test("mintLinkCode stores only the hash, capped per identity, and prunes expired rows", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  const row = f.store.db.prepare("SELECT * FROM identity_link_codes").get();
  assert.equal(row.code_hash.length, 64, "SHA-256 hex");
  assert(!JSON.stringify(row).includes(minted.linkCode), "raw code is not in the row");
  assert.equal(row.consumed_at, null);
  // 9 more mints OK (cap is 10 outstanding); the 11th is refused 429 —
  // the holder should use one or let it expire, not stockpile proofs.
  for (let i = 0; i < 9; i++) f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" }), { code: "too_many_link_codes" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_link_codes WHERE identity_id=?").get(identity.identityId).n, 10);
  // Consuming one code frees a slot; minting works again and the fresh code verifies.
  f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode }));
  const other = f.store.identities.create("Second Agent");
  const otherMint = f.store.identities.mintLinkCode(other.identityId, other.secret, { roomId: "commons" });
  f.apply(f.createRequest({ identityId: other.identityId, identityLinkCode: otherMint.linkCode, displayName: "Second assistant" }));
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("duplicate requestId replays the original receipt without burning a second code", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  // A true idempotency replay: the exact same request bytes, including the
  // same keyHash and the same (already-consumed) proof.
  const req = f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode });
  const first = f.apply(req);
  assert.equal(first.duplicate, false, "first apply is not a replay");
  const second = f.apply({ ...req });
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 1);
});

test("create without identityId is unchanged: no link, no bond resolution", t => {
  const f = fixture(t);
  const req = f.createRequest();
  const result = f.apply(req);
  assert.equal(result.receipt.identityId, undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), null);
});

test("disconnect removes the identity link and echoes unlinkedIdentityId on the receipt", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Atomic Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  const created = f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode }));
  const req = { action: "disconnect", requestId: randomUUID(), memberId: created.receipt.memberId, expectedOwnerRevision: 0, expectedGeneration: created.receipt.generation, expectedMemberRevision: 0 };
  const result = f.apply(req);
  assert.equal(result.receipt.unlinkedIdentityId, identity.identityId, "auditable unlink");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
  assert.equal(f.store.bonds.identityForMember("commons", req.memberId), null, "bond surface stops resolving");
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("disconnect of an unlinked connection carries no unlinkedIdentityId", t => {
  const f = fixture(t);
  const created = f.apply(f.createRequest());
  const result = f.apply({ action: "disconnect", requestId: randomUUID(), memberId: created.receipt.memberId, expectedOwnerRevision: 0, expectedGeneration: created.receipt.generation, expectedMemberRevision: 0 });
  assert.equal(result.receipt.unlinkedIdentityId, undefined);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

// ---- SECURITY-FIX C2: link codes are bound to room + sponsor ----

function twoRoomFixture(t) {
  let now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("annex"));
  t.after(() => store.close());
  const sessionFor = room => store.createSession(store.issueAccessKey(room, "owner"));
  const secret = () => { const token = randomBytes(32).toString("base64url"); return { token, keyHash: createHash("sha256").update(token).digest("hex") }; };
  const createRequest = (extra = {}) => ({ action: "create", requestId: randomUUID(), memberId: `agent-${randomUUID()}`, displayName: "My assistant", access: "chat", keyHash: secret().keyHash, expiresAt: now + 3600000, expectedOwnerRevision: 0, ...extra });
  const applyTo = (room, body) => { const s = sessionFor(room); return store.agentConnections.apply(s.token, room, body, s.session.sessionBinding); };
  return { store, createRequest, applyTo };
}

test("C2: a code minted for one room does not redeem in another room", t => {
  const f = twoRoomFixture(t);
  const identity = f.store.identities.create("Bound Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  assert.equal(minted.roomId, "commons");
  // The P2 attack: a different room's owner who obtains the code enrolls
  // the identity into THEIR room. The binding refuses — same opaque 422.
  expectProofFailure(t, () => f.applyTo("annex", f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0, "nothing linked anywhere");
  // The intended room still redeems, and the failed attempt did not burn the code.
  const result = f.applyTo("commons", f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode }));
  assert.equal(result.receipt.identityId, identity.identityId);
  assert.equal(result.mcpToken !== null && typeof result.mcpToken === "object", true, "onboarding token issued to the intended sponsor only");
});

test("C2: consumeLinkCode enforces the room binding directly", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Bound Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "commons" });
  expectProofFailure(t, () => f.store.identities.consumeLinkCode(identity.identityId, minted.linkCode, { roomId: "annex" }));
  expectProofFailure(t, () => f.store.identities.consumeLinkCode(identity.identityId, minted.linkCode));
  const consumed = f.store.identities.consumeLinkCode(identity.identityId, minted.linkCode, { roomId: "commons" });
  assert.equal(consumed.roomId, "commons");
});

test("C2: minting without a room binding, or for a nonexistent room, is refused", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Bound Agent");
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, identity.secret), { code: "invalid_link_code_request" });
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, identity.secret, {}), { code: "invalid_link_code_request" });
  assert.throws(() => f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: "no-such-room" }), { code: "invalid_link_code_request" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_link_codes").get().n, 0, "no unbound code was stored");
});

test("C2: a pre-named sponsor binds redemption to that account", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Bound Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret,
    { roomId: "commons", sponsorAccountId: "acct_named_sponsor" });
  assert.equal(minted.sponsorAccountId, "acct_named_sponsor");
  expectProofFailure(t, () => f.store.identities.consumeLinkCode(identity.identityId, minted.linkCode,
    { roomId: "commons", sponsorAccountId: "acct_someone_else" }));
  expectProofFailure(t, () => f.store.identities.consumeLinkCode(identity.identityId, minted.linkCode, { roomId: "commons" }));
  const consumed = f.store.identities.consumeLinkCode(identity.identityId, minted.linkCode,
    { roomId: "commons", sponsorAccountId: "acct_named_sponsor" });
  assert.equal(consumed.identityId, identity.identityId);
});

test("C2: enrollment by the wrong sponsor account fails through the connections door", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Bound Agent");
  const minted = f.store.identities.mintLinkCode(identity.identityId, identity.secret,
    { roomId: "commons", sponsorAccountId: "acct_the_intended_sponsor" });
  // The fixture session's account is not the named sponsor: proof failure,
  // nothing created, and the onboarding token is never issued.
  expectProofFailure(t, () => f.apply(f.createRequest({ identityId: identity.identityId, identityLinkCode: minted.linkCode })));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_links").get().n, 0);
});

test("C2: a pre-binding legacy code row (NULL room) never redeems", t => {
  const f = fixture(t);
  const identity = f.store.identities.create("Legacy Agent");
  const code = randomBytes(16).toString("base64url");
  const hash = createHash("sha256").update(code).digest("hex");
  const now = f.now();
  f.store.db.prepare("INSERT INTO identity_link_codes(code_hash,identity_id,created_at,expires_at,consumed_at) VALUES(?,?,?,?,NULL)")
    .run(hash, identity.identityId, now, now + 10 * 60 * 1000);
  expectProofFailure(t, () => f.store.identities.consumeLinkCode(identity.identityId, code, { roomId: "commons" }));
});

// ------------------------------------------------------------------
// SECURITY-FIX-2 TM-8: sponsor binding is REQUIRED when the minter
// holds the sponsor position in the room (its identity is linked as
// the room's owner member). The code is bound at mint to the account
// bound to that member, so a later holder of the sponsor position —
// a second sponsor — cannot redeem a leaked room-only code and be
// issued the onboarding credential as the holder.
// ------------------------------------------------------------------

// Bind the holder identity to the fixture room's owner member: the
// holder now holds the sponsor position in "commons". Returns the
// sponsor account bound to that member (member_accounts).
function makeSponsorHolder(f) {
  const holder = f.store.identities.create("Sponsor Holder");
  f.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES('commons',?,'owner',?)")
    .run(holder.identityId, f.now());
  const accountId = f.store.db.prepare(
    "SELECT account_id AS accountId FROM member_accounts WHERE room_id='commons' AND member_id='owner'").get().accountId;
  return { holder, accountId };
}

test("TM-8: minting by the room's sponsor-holder auto-binds the code to their sponsor account", t => {
  const f = fixture(t);
  const { holder, accountId } = makeSponsorHolder(f);
  const minted = f.store.identities.mintLinkCode(holder.identityId, holder.secret, { roomId: "commons" });
  assert.equal(minted.sponsorAccountId, accountId, "the mint response names the binding");
  const row = f.store.db.prepare("SELECT sponsor_account_id AS sponsor FROM identity_link_codes").get();
  assert.equal(row.sponsor, accountId, "the stored code is sponsor-bound, never room-only");
  // The bound sponsor redeems; a second sponsor cannot.
  expectProofFailure(t, () => f.store.identities.consumeLinkCode(holder.identityId, minted.linkCode,
    { roomId: "commons", sponsorAccountId: "acct_second_sponsor" }));
  const consumed = f.store.identities.consumeLinkCode(holder.identityId, minted.linkCode,
    { roomId: "commons", sponsorAccountId: accountId });
  assert.equal(consumed.identityId, holder.identityId);
});

test("TM-8: the sponsor-holder cannot mint a code naming a different sponsor", t => {
  const f = fixture(t);
  const { holder, accountId } = makeSponsorHolder(f);
  assert.throws(
    () => f.store.identities.mintLinkCode(holder.identityId, holder.secret,
      { roomId: "commons", sponsorAccountId: "acct_second_sponsor" }),
    { code: "invalid_link_code_request" });
  // Naming their OWN sponsor account explicitly is the same binding.
  const minted = f.store.identities.mintLinkCode(holder.identityId, holder.secret,
    { roomId: "commons", sponsorAccountId: accountId });
  assert.equal(minted.sponsorAccountId, accountId);
});

test("TM-8: a legacy unbound code row is still refused to a second sponsor when the minter holds the position", t => {
  const f = fixture(t);
  const { holder, accountId } = makeSponsorHolder(f);
  // A code row minted before binding was required: room-bound, no sponsor.
  const code = randomBytes(16).toString("base64url");
  const hash = createHash("sha256").update(code).digest("hex");
  const now = f.now();
  f.store.db.prepare("INSERT INTO identity_link_codes(code_hash,identity_id,room_id,sponsor_account_id,created_at,expires_at,consumed_at) VALUES(?,?,'commons',NULL,?,?,NULL)")
    .run(hash, holder.identityId, now, now + 10 * 60 * 1000);
  expectProofFailure(t, () => f.store.identities.consumeLinkCode(holder.identityId, code,
    { roomId: "commons", sponsorAccountId: "acct_second_sponsor" }));
  const consumed = f.store.identities.consumeLinkCode(holder.identityId, code,
    { roomId: "commons", sponsorAccountId: accountId });
  assert.equal(consumed.identityId, holder.identityId);
});

test("TM-8: a second sponsor in the same room cannot redeem the sponsor-holder's code at the connections door", t => {
  const f = fixture(t);
  const { holder, accountId } = makeSponsorHolder(f);
  // The holder mints intending their own sponsor account; the code is
  // bound to it at mint (TM-8), with no sponsor named by the caller.
  const minted = f.store.identities.mintLinkCode(holder.identityId, holder.secret, { roomId: "commons" });
  assert.equal(minted.sponsorAccountId, accountId);
  // The sponsor position changes hands: a second human (a second sponsor
  // account) becomes room owner before the code is redeemed.
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "human-two", displayName: "Human Two", kind: "human", permissions: ["manage_members"] } });
  f.store.createAccount("human-two-acct");
  f.store.bindHumanAccount("commons", "human-two", "human-two-acct");
  const rooms = new AgentRooms(f.store);
  rooms.transfer(f.session.token, "commons", { toMemberId: "human-two" }, f.session.session.sessionBinding);
  const twoKey = f.store.issueAccessKey("commons", "human-two");
  const twoSession = f.store.createSession(twoKey);
  const twoRevision = f.store.room("commons").state.members["human-two"].revision;
  // The second sponsor presents the leaked code: proof failure, nothing
  // is created, and the onboarding token is never issued to them.
  expectProofFailure(t, () => f.store.agentConnections.apply(twoSession.token, "commons",
    f.createRequest({ identityId: holder.identityId, identityLinkCode: minted.linkCode, expectedOwnerRevision: twoRevision }),
    twoSession.session.sessionBinding));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM agent_connections").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT consumed_at FROM identity_link_codes").get().consumed_at, null,
    "the refused redemption does not burn the holder's code");
});
