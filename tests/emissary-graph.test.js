// Emissary slice 1a — external identity graph tests (RC-2026-09-27-2860).
//
// Contracts guarded (test-audit gate):
//  1. Registration mints a well-formed ex1 id at status stranger.
//  2. Registration fails closed on unknown rooms, bad shapes, unknown
//     referrers (nothing written on failure).
//  3. A verified venue handle is exclusive per room (409 + existing id);
//     self-asserted handles never collide.
//  4. A valid signed_card proof promotes stranger -> known; a forged or
//     mismatched card fails closed with no state change (real Ed25519
//     sign/verify, no mocks).
//  5. venue_api proofs store opaquely and never promote.
//  6. The status ladder is monotonic: one rung up, never a skip or demotion.
//  7. Reads fail closed on unknown/malformed ids; list is deterministic,
//     filterable, paginated.
//  8. Merge moves venues, dedupes, reassigns receipts, deletes the loser.
//  9. Store wiring: fresh RoomStore carries the tables and services.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EXTERNAL_ID_RE } from "../server/emissary-graph.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const ROOM = "commons";

function freshStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-emissary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(ROOM));
  return store;
}

const serviceError = (fn) => {
  try { fn(); } catch (error) { return { status: error.status, code: error.code }; }
  return null;
};

test("store wiring: fresh RoomStore carries the external identity table and services", t => {
  const store = freshStore(t);
  assert.ok(store.emissaryGraph, "store.emissaryGraph exists");
  assert.ok(store.emissaryReceipts, "store.emissaryReceipts exists");
  const tables = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('external_identities','external_receipts')"
  ).all().map(r => r.name).sort();
  assert.deepEqual(tables, ["external_identities", "external_receipts"]);
});

test("register mints an ex1 id at status stranger", t => {
  const store = freshStore(t);
  const record = store.emissaryGraph.register(ROOM, {
    kind: "agent",
    displayName: "Longcat",
    venues: [{ venue: "thecolony", handle: "longcat" }],
  });
  assert.match(record.external_id, EXTERNAL_ID_RE);
  assert.equal(record.status, "stranger");
  assert.equal(record.kind, "agent");
  assert.equal(record.display_name, "Longcat");
  assert.deepEqual(record.venues, [
    { venue: "thecolony", handle: "longcat", proof: "self_asserted", verified_at: null, operatorKey: null },
  ]);
  assert.equal(record.referrer_external_id, null);
  assert.equal(record.reputation, 0);
});

test("register links a valid referrer", t => {
  const store = freshStore(t);
  const referrer = store.emissaryGraph.register(ROOM, { kind: "human", displayName: "Pat" });
  const record = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Newcomer", referrerExternalId: referrer.external_id,
  });
  assert.equal(record.referrer_external_id, referrer.external_id);
});

test("register fails closed on bad input and writes nothing", t => {
  const store = freshStore(t);
  const before = store.emissaryGraph.list(ROOM).length;
  // Unknown room.
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.register("nope", { kind: "agent", displayName: "X" })),
    { status: 404, code: "unknown_room" });
  // Bad kind / display name / venues.
  for (const args of [
    { kind: "bot", displayName: "X" },
    { kind: "agent", displayName: "" },
    { kind: "agent", displayName: "x".repeat(81) },
    { kind: "agent", displayName: "bad\u0000name" },
    { kind: "agent", displayName: "X", venues: "nope" },
    { kind: "agent", displayName: "X", venues: [{ venue: "v", handle: "h", proof: "bogus" }] },
    { kind: "agent", displayName: "X", venues: [
      { venue: "v", handle: "h" }, { venue: "v", handle: "h" },
    ] },
  ]) {
    assert.deepEqual(serviceError(() => store.emissaryGraph.register(ROOM, args)),
      { status: 422, code: "invalid_emissary_input" }, JSON.stringify(args));
  }
  // Unknown / malformed referrer.
  assert.deepEqual(serviceError(() => store.emissaryGraph.register(ROOM,
    { kind: "agent", displayName: "X", referrerExternalId: "ex1." + "a".repeat(32) })),
    { status: 404, code: "unknown_referrer" });
  assert.deepEqual(serviceError(() => store.emissaryGraph.register(ROOM,
    { kind: "agent", displayName: "X", referrerExternalId: "bogus" })),
    { status: 422, code: "invalid_emissary_input" });
  assert.equal(store.emissaryGraph.list(ROOM).length, before, "no rows written by failed registrations");
});

test("verified venue handles are exclusive per room; self-asserted handles are not", t => {
  const store = freshStore(t);
  const first = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "First",
    venues: [{ venue: "thecolony", handle: "agent1", proof: "venue_api" }],
  });
  // Same verified handle on a second identity -> 409 naming the first.
  const err = serviceError(() => store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Second",
    venues: [{ venue: "thecolony", handle: "agent1", proof: "venue_api" }],
  }));
  assert.equal(err.status, 409);
  assert.equal(err.code, "venue_handle_taken");
  // Self-asserted handles never collide.
  const a = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "A", venues: [{ venue: "x", handle: "same" }],
  });
  const b = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "B", venues: [{ venue: "x", handle: "same" }],
  });
  assert.notEqual(a.external_id, b.external_id);
  assert.equal(first.status, "stranger");
});

test("verifyVenue with a valid signed card promotes stranger to known", t => {
  const store = freshStore(t);
  const { publicKey, privateKey } = generateKeyPair();
  const record = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Carded",
    venues: [{ venue: "thecolony", handle: "carded-agent", operatorKey: publicKey }],
  });
  const card = { name: "carded-agent", description: "test agent", version: "1" };
  const signature = signCard({ agentId: "agent-123", card, privateKey });
  const updated = store.emissaryGraph.verifyVenue(roomOf(record), record.external_id, 0, {
    kind: "signed_card", agentId: "agent-123", card, publicKey, signature,
  });
  assert.equal(updated.status, "known");
  assert.equal(updated.venues[0].proof, "signed_card");
  assert.ok(typeof updated.venues[0].verified_at === "number");
});

test("verifyVenue fails closed on forged or mismatched cards with no state change", t => {
  const store = freshStore(t);
  const { publicKey, privateKey } = generateKeyPair();
  const record = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Target",
    venues: [{ venue: "thecolony", handle: "real-handle", operatorKey: publicKey }],
  });
  const other = generateKeyPair();
  const card = { name: "real-handle", version: "1" };
  const goodSig = signCard({ agentId: "agent-1", card, privateKey });
  const cases = [
    // Wrong key signs the card.
    [{ kind: "signed_card", agentId: "agent-1", card, publicKey, signature: signCard({ agentId: "agent-1", card, privateKey: other.privateKey }) }, "invalid_proof"],
    // Card name does not bind the claimed handle.
    [{ kind: "signed_card", agentId: "agent-1", card: { ...card, name: "someone-else" }, publicKey, signature: goodSig }, "proof_handle_mismatch"],
    // Garbage signature.
    [{ kind: "signed_card", agentId: "agent-1", card, publicKey, signature: "AAAA" }, "invalid_proof"],
    // Malformed proof shape.
    [{ kind: "signed_card", agentId: "agent-1" }, "invalid_proof"],
    // self_asserted cannot be verified.
    [{ kind: "self_asserted" }, "invalid_proof"],
    // Unknown proof kind.
    [{ kind: "web_of_trust" }, "invalid_proof"],
  ];
  for (const [proof, code] of cases) {
    const err = serviceError(() =>
      store.emissaryGraph.verifyVenue(ROOM, record.external_id, 0, proof));
    assert.equal(err.code, code, JSON.stringify(proof));
  }
  const unchanged = store.emissaryGraph.get(ROOM, record.external_id);
  assert.equal(unchanged.status, "stranger", "no promotion on failed verification");
  assert.equal(unchanged.venues[0].proof, "self_asserted");
  // Out-of-range venue index.
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.verifyVenue(ROOM, record.external_id, 7, { kind: "venue_api", evidence: {} })),
    { status: 404, code: "unknown_venue" });
});

test("verifyVenue with venue_api stores evidence opaquely and never promotes", t => {
  const store = freshStore(t);
  const record = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Api",
    venues: [{ venue: "sssnack", handle: "api-agent" }],
  });
  const updated = store.emissaryGraph.verifyVenue(ROOM, record.external_id, 0, {
    kind: "venue_api", evidence: { checked_at: 123, note: "server-side check pending" },
  });
  assert.equal(updated.status, "stranger", "venue_api never promotes in slice 1a");
  assert.equal(updated.venues[0].proof, "venue_api");
  assert.equal(updated.venues[0].verified_at, null);
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.verifyVenue(ROOM, record.external_id, 0, { kind: "venue_api", evidence: "nope" })),
    { status: 422, code: "invalid_proof" });
});

test("verifyVenue binds the signed_card key to the venue's registered operator key (L-P2-12)", t => {
  const store = freshStore(t);
  const operator = generateKeyPair();
  const attacker = generateKeyPair();
  const record = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Keyed",
    venues: [{ venue: "thecolony", handle: "keyed-agent", operatorKey: operator.publicKey }],
  });
  // Attacker self-signs a card for the victim's handle with their own key:
  // signature is valid, name matches — but the key is not the operator's.
  const forgedCard = { name: "keyed-agent", version: "1" };
  const forgedSig = signCard({ agentId: "attacker", card: forgedCard, privateKey: attacker.privateKey });
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.verifyVenue(ROOM, record.external_id, 0,
      { kind: "signed_card", agentId: "attacker", card: forgedCard, publicKey: attacker.publicKey, signature: forgedSig })),
    { status: 422, code: "proof_key_mismatch" });
  // The real operator's card still verifies.
  const card = { name: "keyed-agent", version: "1" };
  const sig = signCard({ agentId: "agent-9", card, privateKey: operator.privateKey });
  const updated = store.emissaryGraph.verifyVenue(ROOM, record.external_id, 0,
    { kind: "signed_card", agentId: "agent-9", card, publicKey: operator.publicKey, signature: sig });
  assert.equal(updated.status, "known");
  // A venue with no registered operator key cannot be verified by signed card.
  const keyless = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Keyless",
    venues: [{ venue: "thecolony", handle: "keyless-agent" }],
  });
  const kCard = { name: "keyless-agent", version: "1" };
  const kSig = signCard({ agentId: "agent-9", card: kCard, privateKey: operator.privateKey });
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.verifyVenue(ROOM, keyless.external_id, 0,
      { kind: "signed_card", agentId: "agent-9", card: kCard, publicKey: operator.publicKey, signature: kSig })),
    { status: 422, code: "no_operator_key" });
  assert.equal(store.emissaryGraph.get(ROOM, keyless.external_id).status, "stranger");
});

test("status ladder is monotonic: one rung up, never a skip or demotion", t => {
  const store = freshStore(t);
  const record = store.emissaryGraph.register(ROOM, { kind: "agent", displayName: "Climber" });
  const known = store.emissaryGraph.setStatus(ROOM, record.external_id, "known");
  assert.equal(known.status, "known");
  const working = store.emissaryGraph.setStatus(ROOM, record.external_id, "working");
  assert.equal(working.status, "working");
  // Skip a rung.
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.setStatus(ROOM, record.external_id, "member")),
    { status: 422, code: "invalid_status_transition" });
  // Demote.
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.setStatus(ROOM, record.external_id, "known")),
    { status: 422, code: "invalid_status_transition" });
  // Unknown word.
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.setStatus(ROOM, record.external_id, "famous")),
    { status: 422, code: "invalid_emissary_input" });
  assert.equal(store.emissaryGraph.get(ROOM, record.external_id).status, "working");
});

test("get and list fail closed; list is deterministic, filterable, paginated", t => {
  const store = freshStore(t);
  assert.deepEqual(serviceError(() => store.emissaryGraph.get(ROOM, "ex1." + "b".repeat(32))),
    { status: 404, code: "unknown_external" });
  assert.deepEqual(serviceError(() => store.emissaryGraph.get(ROOM, "bogus")),
    { status: 422, code: "invalid_emissary_input" });
  assert.deepEqual(serviceError(() => store.emissaryGraph.get("nope", "ex1." + "b".repeat(32))),
    { status: 404, code: "unknown_room" });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = store.emissaryGraph.register(ROOM, { kind: "agent", displayName: `Agent ${i}` });
    ids.push(r.external_id);
    if (i < 2) store.emissaryGraph.setStatus(ROOM, r.external_id, "known");
  }
  const known = store.emissaryGraph.list(ROOM, { status: "known" });
  assert.equal(known.length, 2);
  assert.ok(known.every(r => r.status === "known"));
  const page1 = store.emissaryGraph.list(ROOM, { limit: 2, offset: 0 });
  const page2 = store.emissaryGraph.list(ROOM, { limit: 2, offset: 2 });
  const page3 = store.emissaryGraph.list(ROOM, { limit: 2, offset: 4 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.equal(page3.length, 1);
  const ordered = [...page1, ...page2, ...page3].map(r => r.external_id);
  const full = store.emissaryGraph.list(ROOM, { limit: 50 });
  assert.deepEqual(ordered, full.map(r => r.external_id), "pages tile the full list in order");
  const keys = full.map(r => [r.created_at, r.external_id]);
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)),
    "created_at ASC, external_id ASC");
  assert.deepEqual(serviceError(() => store.emissaryGraph.list(ROOM, { status: "famous" })),
    { status: 422, code: "invalid_emissary_input" });
});

test("merge moves venues, dedupes, reassigns receipts, deletes the loser", t => {
  const store = freshStore(t);
  const from = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Dup",
    venues: [
      { venue: "thecolony", handle: "dup" },
      { venue: "sssnack", handle: "dup-s" },
    ],
  });
  const to = store.emissaryGraph.register(ROOM, {
    kind: "agent", displayName: "Canon",
    venues: [{ venue: "thecolony", handle: "dup" }],
  });
  const receipt = store.emissaryReceipts.record(ROOM, {
    externalId: from.external_id, kind: "work", payload: { job: 1 },
  });
  const merged = store.emissaryGraph.merge(ROOM, from.external_id, to.external_id);
  assert.equal(merged.external_id, to.external_id);
  assert.deepEqual(
    merged.venues.map(v => `${v.venue}/${v.handle}`).sort(),
    ["sssnack/dup-s", "thecolony/dup"],
    "shared handle deduped, novel handle moved");
  assert.deepEqual(serviceError(() => store.emissaryGraph.get(ROOM, from.external_id)),
    { status: 404, code: "unknown_external" }, "loser row deleted");
  const moved = store.emissaryReceipts.get(ROOM, receipt.receipt_id);
  assert.equal(moved.external_id, to.external_id, "receipt reassigned to survivor");
  assert.deepEqual(serviceError(() =>
    store.emissaryGraph.merge(ROOM, to.external_id, to.external_id)),
    { status: 422, code: "invalid_emissary_input" });
});

function roomOf(record) { return record.room_id; }
