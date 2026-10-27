// tests/bonds-pins.test.js — B1-3 PIN tests for server/bonds.mjs.
// Landed from the methods audit (wave-2026-10-26-methods-audit, phase-b/B1,
// B1-3): the audit's distinguishing tests for the 24 ACTIONABLE survivor
// groups B-1…B-24 (incl. B-13, propose-over-active-bond reset), unweakened.
// Each test passes on the unmutated module and fails on its named mutants.
// The audit oracle was a replica suite (the repo bonds tests are WAL-blocked
// in the audit environment); these pins drive the Bonds class directly on
// in-memory SQLite, as the audit's did.
// B1-3 distinguishing tests for bonds.mjs survivors (M-A ACTIONABLE triage).
// Each test passes on the unmutated module and is designed to fail on one
// or more named surviving mutants from the B1-3 bonds run.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Bonds, bondSchema, canonicalPair, peerThreadId, BOND_TTL_MS } from "../server/bonds.mjs";

const ROOM = "room1", ROOM2 = "room2";
let nowMs = 1_700_000_000_000;
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(bondSchema);
  db.exec(`CREATE TABLE identity_links (room_id TEXT, member_id TEXT, identity_id TEXT);
           CREATE TABLE agent_identities (identity_id TEXT PRIMARY KEY, revoked_at INTEGER);`);
  const store = { db, now: () => nowMs, room: id => ({ state: { room: { ownerId: id === ROOM ? "m-owner" : "m-owner2" } } }) };
  const bonds = new Bonds(store);
  const link = (member, identity, room = ROOM) => {
    db.prepare("INSERT INTO agent_identities (identity_id, revoked_at) VALUES (?,NULL)").run(identity);
    db.prepare("INSERT INTO identity_links (room_id, member_id, identity_id) VALUES (?,?,?)").run(room, member, identity);
  };
  link("m-alice", "ai_alice"); link("m-bob", "ai_bob"); link("m-carol", "ai_carol"); link("m-dave", "ai_dave");
  return { db, bonds, link };
}
const cmd = (bonds, member, type, data = {}, room = ROOM) => bonds.prepare(room, member, { type, data });
function err(fn) { try { fn(); } catch (e) { return e; } return null; }
const code = fn => err(fn)?.code ?? null;
function proposeOk(bonds, from = "m-alice", to = "ai_bob", data = {}) {
  const r = cmd(bonds, from, "bond.propose", { to, ...data });
  assert.equal(r.eventType, "bond.proposed");
  return r.data.bondId;
}
function activeBond(bonds) {
  const id = proposeOk(bonds);
  const r = cmd(bonds, "m-bob", "bond.accept", { bondId: id });
  assert.equal(r.eventType, "bond.activated");
  return id;
}
function dmOk(bonds, body = "hi", messageId = "msg-1") {
  const r = cmd(bonds, "m-alice", "dm.posted", { to: "ai_bob", body, messageId });
  assert.equal(r.eventType, "dm.posted");
  bonds.sealDm(r.dm, "evt-" + messageId);
  return r;
}

test("D1 BondError carries status (L20)", () => {
  const { bonds } = fixture();
  const e = err(() => cmd(bonds, "m-alice", "bond.propose", { to: "m-alice" }));
  assert.equal(e.code, "bond_self");
  assert.equal(e.status, 422);
});

test("D2 BOND_TTL_MS is literally 7 days (L25 x3)", () => {
  assert.equal(BOND_TTL_MS, 604_800_000);
});

test("D3 canonicalPair rejects non-string operands (L80)", () => {
  assert.equal(code(() => canonicalPair(123, "x")), "invalid_bond");
  assert.equal(code(() => canonicalPair("x", 123)), "invalid_bond");
  assert.equal(code(() => canonicalPair({}, "x")), "invalid_bond");
});

test("D4 proposing with all four scopes explicitly succeeds (L134)", () => {
  const { bonds } = fixture();
  const r = cmd(bonds, "m-alice", "bond.propose",
    { to: "ai_bob", scopes: ["peer.wake", "peer.card", "peer.context", "peer.dm"] });
  assert.equal(r.eventType, "bond.proposed");
  assert.deepEqual(r.data.scopes, ["peer.wake", "peer.card", "peer.context", "peer.dm"]);
});

test("D5 Bonds constructor refuses a missing store with bond_store_missing (L144)", () => {
  assert.equal(code(() => new Bonds(null)), "bond_store_missing");
  assert.equal(code(() => new Bonds({})), "bond_store_missing");
  assert.equal(err(() => new Bonds(null)).status, 500);
});

test("D6 identityForMember with an empty key resolves null (L152)", () => {
  const { bonds } = fixture();
  assert.equal(bonds.identityForMember("", "m-alice"), null);
  assert.equal(bonds.identityForMember(ROOM, ""), null);
  assert.equal(bonds.identityForMember(null, null), null);
});

test("D7 peer linked to a deleted identity does not resolve (L187)", () => {
  const { db, bonds, link } = fixture();
  link("m-eve", "ai_eve");
  db.prepare("DELETE FROM agent_identities WHERE identity_id='ai_eve'").run();
  assert.equal(code(() => cmd(bonds, "m-alice", "bond.propose", { to: "m-eve" })), "peer_not_found");
});

test("D8 public view state field: proposed before TTL, expired after (L216 x2)", () => {
  const { bonds } = fixture();
  const t0 = nowMs;
  proposeOk(bonds);
  assert.equal(bonds.listForMember(ROOM, "m-alice")[0].state, "proposed");
  nowMs = t0 + BOND_TTL_MS + 1;
  assert.equal(bonds.listForMember(ROOM, "m-alice")[0].state, "expired");
  nowMs = t0;
});

test("D9 requirePeerDm expired-vs-none messages (L388 x2)", () => {
  const { bonds } = fixture();
  const t0 = nowMs;
  const e1 = err(() => bonds.requirePeerDm("ai_alice", "ai_bob"));
  assert.equal(e1.code, "no_bond");
  assert.match(e1.message, /No active bond/);
  proposeOk(bonds);
  nowMs = t0 + BOND_TTL_MS + 1;
  const e2 = err(() => bonds.requirePeerDm("ai_alice", "ai_bob"));
  assert.equal(e2.code, "no_bond");
  assert.match(e2.message, /expired/);
  nowMs = t0;
});

test("D10 note and reason surface in public views (L220, L221, L278)", () => {
  const { bonds } = fixture();
  const id = proposeOk(bonds, "m-alice", "ai_bob", { note: "hello note" });
  assert.equal(bonds.listForMember(ROOM, "m-alice")[0].note, "hello note");
  assert.equal(bonds.pendingProposalsFor("ai_bob")[0].note, "hello note");
  cmd(bonds, "m-bob", "bond.revoke", { bondId: id });
  const view = bonds.listForMember(ROOM, "m-alice")[0];
  assert.equal(view.state, "revoked");
  assert.equal(view.reason, "revoked");
});

test("D11 a stranger cannot revoke someone else's bond (L240, L241)", () => {
  const { bonds } = fixture();
  const id = activeBond(bonds);
  assert.equal(code(() => cmd(bonds, "m-carol", "bond.revoke", { bondId: id })), "bond_not_found");
  assert.equal(bonds.listForMember(ROOM, "m-alice")[0].state, "active");
});

test("D12 thread/message views: peer id and untrusted flags (L309 x2, L311, L360, L376)", () => {
  const { bonds } = fixture();
  activeBond(bonds);
  dmOk(bonds);
  const threads = bonds.listThreads(ROOM, "m-alice");
  assert.equal(threads.length, 1);
  assert.equal(threads[0].peerIdentityId, "ai_bob");
  assert.equal(threads[0].untrusted, true);
  const thread = bonds.readThread(ROOM, "m-bob", peerThreadId("ai_alice", "ai_bob"));
  assert.equal(thread.untrusted, true);
  assert.equal(thread.messages[0].untrusted, true);
  assert.equal(thread.messages[0].fromIdentityId, "ai_alice");
});

test("D13 pagination boundaries: limit 1 and 200 valid, exact page has hasMore=false (L327 x2, L351)", () => {
  const { bonds } = fixture();
  activeBond(bonds);
  dmOk(bonds, "one", "p-1"); dmOk(bonds, "two", "p-2");
  const tid = peerThreadId("ai_alice", "ai_bob");
  const one = bonds.readThread(ROOM, "m-bob", tid, { limit: 1 });
  assert.deepEqual(one.messages.map(m => m.body), ["two"]);
  assert.equal(one.hasMore, true);
  const exact = bonds.readThread(ROOM, "m-bob", tid, { limit: 2 });
  assert.equal(exact.messages.length, 2);
  assert.equal(exact.hasMore, false);
  const max = bonds.readThread(ROOM, "m-bob", tid, { limit: 200 });
  assert.equal(max.messages.length, 2);
});

test("D14 proposing over an ACTIVE bond is refused and the bond survives (L454, L455)", () => {
  const { bonds } = fixture();
  activeBond(bonds);
  assert.equal(code(() => cmd(bonds, "m-alice", "bond.propose", { to: "ai_bob" })), "bond_active");
  assert.equal(bonds.listForMember(ROOM, "m-alice")[0].state, "active");
  dmOk(bonds); // DM still works: the active bond was not reset to proposed
});

test("D15 re-propose after revoke creates a fresh proposal (L444, L479)", () => {
  const { bonds } = fixture();
  const id1 = proposeOk(bonds);
  cmd(bonds, "m-bob", "bond.decline", { bondId: id1 });
  const r = cmd(bonds, "m-alice", "bond.propose", { to: "ai_bob" });
  assert.equal(r.eventType, "bond.proposed");
  assert.notEqual(r.data.bondId, id1);
  const view = bonds.listForMember(ROOM, "m-alice")[0];
  assert.equal(view.state, "proposed");
  assert.equal(view.id, r.data.bondId);
  // peer-side: bob's earlier proposal was declined by alice; bob may propose again
  const id2 = proposeOk(bonds, "m-carol", "ai_dave");
  cmd(bonds, "m-dave", "bond.decline", { bondId: id2 });
  const r2 = cmd(bonds, "m-carol", "bond.propose", { to: "ai_dave" });
  assert.equal(r2.eventType, "bond.proposed");
});

test("D16 propose event carries the note when one is given (L497)", () => {
  const { bonds } = fixture();
  const r = cmd(bonds, "m-alice", "bond.propose", { to: "ai_bob", note: "ctx please" });
  assert.equal(r.data.note, "ctx please");
  const r2 = cmd(bonds, "m-carol", "bond.propose", { to: "ai_dave" });
  assert.equal("note" in r2.data, false);
});

test("D17 _loadForParty validation: bad bondId is 422, unknown bondId is a clean 404 (L503 x2, L506)", () => {
  const { bonds } = fixture();
  assert.equal(code(() => cmd(bonds, "m-bob", "bond.accept", { bondId: 123 })), "invalid_bond");
  assert.equal(code(() => cmd(bonds, "m-bob", "bond.accept", { bondId: "" })), "invalid_bond");
  const e = err(() => cmd(bonds, "m-bob", "bond.accept", { bondId: "bond-zzz" }));
  assert.equal(e.code, "bond_not_found");
  assert.equal(e.status, 404);
});

test("D18 a third party cannot accept a proposal (L507, L509)", () => {
  const { bonds } = fixture();
  const id = proposeOk(bonds);
  assert.equal(code(() => cmd(bonds, "m-carol", "bond.accept", { bondId: id })), "bond_not_found");
  assert.equal(bonds.listForMember(ROOM, "m-alice")[0].state, "proposed");
});

test("D19 the room owner (linked, non-party) cannot accept or decline (L502, L508)", () => {
  const { bonds, link } = fixture();
  link("m-owner", "ai_owner");
  const id = proposeOk(bonds);
  assert.equal(code(() => cmd(bonds, "m-owner", "bond.accept", { bondId: id })), "bond_not_found");
  assert.equal(code(() => cmd(bonds, "m-owner", "bond.decline", { bondId: id })), "bond_not_found");
  assert.equal(bonds.listForMember(ROOM, "m-alice")[0].state, "proposed");
});

test("D20 accepting an already-active bond is refused (L522)", () => {
  const { bonds } = fixture();
  const id = activeBond(bonds);
  assert.equal(code(() => cmd(bonds, "m-bob", "bond.accept", { bondId: id })), "bond_active");
});

test("D21 decline guards: active bond and revoked bond (L554, L555)", () => {
  const { bonds } = fixture();
  const id = activeBond(bonds);
  assert.equal(code(() => cmd(bonds, "m-bob", "bond.decline", { bondId: id })), "bond_active");
  assert.equal(bonds.listForMember(ROOM, "m-alice")[0].state, "active");
  const id2 = proposeOk(bonds, "m-carol", "ai_dave");
  cmd(bonds, "m-dave", "bond.decline", { bondId: id2 });
  assert.equal(code(() => cmd(bonds, "m-dave", "bond.decline", { bondId: id2 })), "bond_revoked");
});

test("D22 a party whose identity was deleted cannot revoke (L561, L562)", () => {
  const { db, bonds } = fixture();
  const id = proposeOk(bonds);
  db.prepare("DELETE FROM agent_identities WHERE identity_id='ai_alice'").run();
  assert.equal(code(() => cmd(bonds, "m-alice", "bond.revoke", { bondId: id })), "identity_revoked");
  assert.equal(bonds.listForMember(ROOM, "m-bob")[0].state, "proposed");
});

test("D23 unlinked room owner's revoke is attributed to the member id (L569)", () => {
  const { bonds } = fixture();
  const id = activeBond(bonds);
  const rv = cmd(bonds, "m-owner", "bond.revoke", { bondId: id });
  assert.equal(rv.eventType, "bond.revoked");
  assert.equal(rv.data.revokedById, "m-owner");
});

test("D24 a DM body of exactly 4096 chars is accepted (L596)", () => {
  const { bonds } = fixture();
  activeBond(bonds);
  const r = dmOk(bonds, "x".repeat(4096), "big-1");
  assert.equal(r.data.body.length, 4096);
});

test("D25 messageId replay vs conflict messages (L604 x6, L605)", () => {
  const { bonds } = fixture();
  activeBond(bonds);
  dmOk(bonds, "hello", "dup-9");
  const same = err(() => cmd(bonds, "m-alice", "dm.posted", { to: "ai_bob", body: "hello", messageId: "dup-9" }));
  assert.equal(same.code, "idempotency_conflict");
  assert.match(same.message, /Retry the same command id/);
  const diff = err(() => cmd(bonds, "m-alice", "dm.posted", { to: "ai_bob", body: "other", messageId: "dup-9" }));
  assert.equal(diff.code, "idempotency_conflict");
  assert.match(diff.message, /different peer DM/);
});
