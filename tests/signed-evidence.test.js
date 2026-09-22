// Canonical signed external evidence for work.completed (integration map slice #5).
// Unit tests for server/signed-evidence.mjs plus store-level tests for the
// live work.completed command path. The room_text path is covered by
// tests/text-results.test.js; one regression test here pins that it is untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, applyEvent, emptyRoomState, event } from "../src/events.js";
import { canonicalJson, verifyBytes } from "../server/bounty-receipts.mjs";
import { generateKeyPair } from "../server/agent-card-signing.mjs";
import { textVersion } from "../server/text-results.mjs";
import {
  issueSignedEvidence,
  verifySignedEvidence,
  verifyCompletionEvidence,
  contentHashOf,
  sha256Hex,
  EVIDENCE_SCHEMA_VERSION,
  EvidenceError,
} from "../server/signed-evidence.mjs";
import { issueTestIdentity, signTestEvidence } from "./helpers/signed-evidence.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function openRoom(t) {
  const directory = mkdtempSync(join(tmpdir(), "signed-evidence-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const key = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, key };
}

function proposeWork(store, key, workItemId) {
  const cmd = (type, data) => store.command(key, "commons", { id: randomUUID(), type, data });
  cmd(T.WORK_PROPOSED, { workItemId, title: "T", definitionOfDone: "D", accountableMemberId: "owner",
    independentVerificationRequired: false, ownerDecisionRequired: false });
  cmd(T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 });
  cmd(T.WORK_STARTED, { workItemId, expectedRevision: 1 });
}

function complete(store, key, workItemId, data) {
  const revision = store.room("commons").state.workItems[workItemId].revision;
  return store.command(key, "commons", { id: randomUUID(), type: T.WORK_COMPLETED,
    data: { workItemId, expectedRevision: revision, summary: "Done", nextAction: "None", ...data } });
}

const registryOf = rows => ({ keysFor: () => rows });
const keyRow = (publicKey, overrides = {}) =>
  ({ publicKey, validFrom: 0, validUntil: null, revokedAt: null, ...overrides });

// ---------------------------------------------------------------------------
// Unit: issuing and verifying
// ---------------------------------------------------------------------------

test("issued evidence is frozen, canonically ordered, and verifies", () => {
  const { publicKey, privateKey } = generateKeyPair();
  const seedHex = Buffer.from(privateKey, "base64").toString("hex");
  const evidence = issueSignedEvidence({ signerIdentityId: "ai_test", issuedAt: "2026-09-22T12:00:00Z",
    contentHash: contentHashOf("hello"), contentType: "text/plain",
    evidenceUrl: "https://example.com/out", label: "first cut", seedHex });
  assert.equal(Object.isFrozen(evidence), true);
  assert.deepEqual(Object.keys(evidence),
    ["schemaVersion", "evidenceId", "kind", "signerIdentityId", "issuedAt", "contentHash",
     "contentType", "evidenceUrl", "label", "signature"]);
  assert.equal(evidence.schemaVersion, EVIDENCE_SCHEMA_VERSION);
  assert.match(evidence.evidenceId, /^room-evidence:ex:[0-9a-f]{32}$/);
  assert.match(evidence.signature, /^[0-9a-f]{128}$/);
  const result = verifySignedEvidence(evidence, { registry: registryOf([keyRow(publicKey)]) });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceId, evidence.evidenceId);
  assert.equal(result.signerIdentityId, "ai_test");
  assert.equal(result.contentHash, evidence.contentHash);
});

test("signature verifies with an independent Ed25519 implementation (node:crypto)", () => {
  const { publicKey, privateKey } = generateKeyPair();
  const seedHex = Buffer.from(privateKey, "base64").toString("hex");
  const evidence = issueSignedEvidence({ signerIdentityId: "ai_x", issuedAt: "2026-09-22T12:00:00Z",
    contentHash: contentHashOf("bytes"), seedHex });
  const { signature, ...unsigned } = evidence;
  const bytes = Buffer.from(canonicalJson(unsigned), "utf8");
  const jwk = { kty: "OKP", crv: "Ed25519",
    x: Buffer.from(publicKey, "base64").toString("base64url") };
  assert.equal(verify(null, bytes, createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "hex")), true);
  // And the module's own verifier agrees on the same canonical bytes.
  assert.equal(verifyBytes(bytes, signature, Buffer.from(publicKey, "base64").toString("hex")), true);
});

test("tampering with any signed field breaks verification", () => {
  const { publicKey, privateKey } = generateKeyPair();
  const seedHex = Buffer.from(privateKey, "base64").toString("hex");
  const evidence = issueSignedEvidence({ signerIdentityId: "ai_x", issuedAt: "2026-09-22T12:00:00Z",
    contentHash: contentHashOf("bytes"), label: "original", seedHex });
  const registry = registryOf([keyRow(publicKey)]);
  for (const tampered of [
    { ...evidence, label: "tampered" },
    { ...evidence, contentHash: contentHashOf("other bytes") },
    { ...evidence, signerIdentityId: "ai_y" },
    { ...evidence, issuedAt: "2026-09-22T12:00:01Z" },
    { ...evidence, signature: "0".repeat(128) },
  ]) {
    const result = verifySignedEvidence(tampered, { registry });
    assert.equal(result.ok, false, JSON.stringify(tampered.label ?? tampered.contentHash));
    assert.equal(result.code, "bad_signature");
  }
});

test("structural validation rejects malformed objects without touching crypto", () => {
  const { publicKey, privateKey } = generateKeyPair();
  const seedHex = Buffer.from(privateKey, "base64").toString("hex");
  const good = issueSignedEvidence({ signerIdentityId: "ai_x", issuedAt: "2026-09-22T12:00:00Z",
    contentHash: contentHashOf("bytes"), seedHex });
  const registry = registryOf([keyRow(publicKey)]);
  const cases = [
    ["missing signature", { ...good, signature: undefined }, "invalid_evidence"],
    ["bad signature encoding", { ...good, signature: "zz".repeat(64) }, "invalid_evidence"],
    ["unknown key", { ...good, bogus: "x" }, "invalid_evidence"],
    ["wrong schema version", { ...good, schemaVersion: "room-signed-evidence/0" }, "invalid_evidence"],
    ["bad evidence id", { ...good, evidenceId: "nope" }, "invalid_evidence"],
    ["bad issuedAt", { ...good, issuedAt: "yesterday" }, "invalid_evidence"],
    ["bad content hash", { ...good, contentHash: "sha256:xyz" }, "invalid_evidence"],
    ["bad kind", { ...good, kind: "room_text" }, "invalid_evidence"],
    ["not an object", "just a string", "invalid_evidence"],
  ];
  for (const [label, input, code] of cases) {
    const result = verifySignedEvidence(input, { registry });
    assert.equal(result.ok, false, label);
    assert.equal(result.code, code, label);
  }
});

test("JSON numbers inside the signed body are rejected (number ban)", () => {
  const { publicKey } = generateKeyPair();
  const registry = registryOf([keyRow(publicKey)]);
  const text = `{"schemaVersion":"room-signed-evidence/1","evidenceId":"room-evidence:ex:${"a".repeat(32)}",`
    + `"kind":"external","signerIdentityId":"ai_x","issuedAt":"2026-09-22T12:00:00Z",`
    + `"contentHash":"sha256:${"b".repeat(64)}","label":42,"signature":"${"0".repeat(128)}"}`;
  const result = verifySignedEvidence(text, { registry });
  assert.equal(result.ok, false);
  assert.equal(result.code, "number_ban");
});

test("duplicate JSON keys are rejected by strict parsing", () => {
  const { publicKey } = generateKeyPair();
  const registry = registryOf([keyRow(publicKey)]);
  const text = `{"schemaVersion":"room-signed-evidence/1","evidenceId":"room-evidence:ex:${"a".repeat(32)}",`
    + `"kind":"external","kind":"external","signerIdentityId":"ai_x","issuedAt":"2026-09-22T12:00:00Z",`
    + `"contentHash":"sha256:${"b".repeat(64)}","signature":"${"0".repeat(128)}"}`;
  const result = verifySignedEvidence(text, { registry });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_evidence");
});

test("unknown signer is rejected", () => {
  const { privateKey } = generateKeyPair();
  const evidence = issueSignedEvidence({ signerIdentityId: "ai_ghost", issuedAt: "2026-09-22T12:00:00Z",
    contentHash: contentHashOf("bytes"), seedHex: Buffer.from(privateKey, "base64").toString("hex") });
  const result = verifySignedEvidence(evidence, { registry: registryOf([]) });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown_signer");
});

test("a key rotated out before issuedAt cannot sign (expired key)", () => {
  const { publicKey, privateKey } = generateKeyPair();
  const seedHex = Buffer.from(privateKey, "base64").toString("hex");
  // Key was valid for one hour, then rotated away. Evidence backdated into
  // the gap after expiry verifies against nothing.
  const evidence = issueSignedEvidence({ signerIdentityId: "ai_x", issuedAt: "2026-09-22T12:00:00Z",
    contentHash: contentHashOf("bytes"), seedHex });
  const rows = [keyRow(publicKey, { validFrom: Date.parse("2026-09-22T10:00:00Z"),
    validUntil: Date.parse("2026-09-22T11:00:00Z") })];
  const result = verifySignedEvidence(evidence, { registry: registryOf(rows) });
  assert.equal(result.ok, false);
  assert.equal(result.code, "expired_key");
});

test("a revoked key cannot sign new evidence, but pre-revocation evidence still verifies", () => {
  const { publicKey, privateKey } = generateKeyPair();
  const seedHex = Buffer.from(privateKey, "base64").toString("hex");
  const revokedAt = Date.parse("2026-09-22T12:00:00Z");
  const rows = [keyRow(publicKey, { revokedAt })];
  const registry = registryOf(rows);
  const before = issueSignedEvidence({ signerIdentityId: "ai_x", issuedAt: "2026-09-22T11:59:59Z",
    contentHash: contentHashOf("bytes"), seedHex });
  assert.equal(verifySignedEvidence(before, { registry }).ok, true);
  const after = issueSignedEvidence({ signerIdentityId: "ai_x", issuedAt: "2026-09-22T12:00:00Z",
    contentHash: contentHashOf("bytes"), seedHex });
  const result = verifySignedEvidence(after, { registry });
  assert.equal(result.ok, false);
  assert.equal(result.code, "revoked_key");
});

test("rotation overlap: the superseded key still verifies inside its window", () => {
  const oldPair = generateKeyPair(), newPair = generateKeyPair();
  const oldSeed = Buffer.from(oldPair.privateKey, "base64").toString("hex");
  const cutover = Date.parse("2026-09-22T12:00:00Z");
  const rows = [
    keyRow(oldPair.publicKey, { validFrom: 0, validUntil: cutover + 3600_000, supersededBy: newPair.publicKey }),
    keyRow(newPair.publicKey, { validFrom: cutover }),
  ];
  const evidence = issueSignedEvidence({ signerIdentityId: "ai_x", issuedAt: "2026-09-22T12:30:00Z",
    contentHash: contentHashOf("bytes"), seedHex: oldSeed });
  assert.equal(verifySignedEvidence(evidence, { registry: registryOf(rows) }).ok, true);
});

test("the seen guard dedupes replays and records verified ids", () => {
  const { publicKey, privateKey } = generateKeyPair();
  const seedHex = Buffer.from(privateKey, "base64").toString("hex");
  const evidence = issueSignedEvidence({ signerIdentityId: "ai_x", issuedAt: "2026-09-22T12:00:00Z",
    contentHash: contentHashOf("bytes"), seedHex });
  const registry = registryOf([keyRow(publicKey)]);
  const ids = new Set(), seen = { has: id => ids.has(id), add: id => ids.add(id) };
  assert.equal(verifySignedEvidence(evidence, { registry, seen }).ok, true);
  assert.equal(ids.has(evidence.evidenceId), true);
  const replay = verifySignedEvidence(evidence, { registry, seen });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "duplicate_evidence");
});

test("contentHashOf matches a known sha256 vector", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(contentHashOf("abc"), "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("verifyCompletionEvidence rejects a missing evidence object before touching the database", () => {
  const db = { prepare: () => { throw new Error("must not query"); } };
  assert.throws(() => verifyCompletionEvidence(db, registryOf([]), "commons", {}),
    error => error instanceof EvidenceError && error.code === "missing_signed_evidence");
  assert.throws(() => verifyCompletionEvidence(db, registryOf([]), "commons", { signedEvidence: "nope" }),
    error => error instanceof EvidenceError && error.code === "missing_signed_evidence");
});

// ---------------------------------------------------------------------------
// Store: the live work.completed command path
// ---------------------------------------------------------------------------

test("a signed external completion is accepted and the evidence rides the receipt", t => {
  const { store, key } = openRoom(t);
  const identity = issueTestIdentity(store);
  proposeWork(store, key, "w1");
  const evidence = signTestEvidence(identity, { evidenceUrl: "https://example.com/out", label: "first cut" });
  const saved = complete(store, key, "w1", { evidenceUrl: "https://example.com/out", signedEvidence: evidence });
  assert.equal(saved.duplicate, false);
  const receipt = store.room("commons").state.workItems.w1.receipt;
  assert.deepEqual(receipt.signedEvidence, evidence);
  assert.equal(receipt.evidenceVersion, null);
  assert.equal(receipt.evidenceUrl, "https://example.com/out");
});

test("an unsigned external completion is rejected", t => {
  const { store, key } = openRoom(t);
  issueTestIdentity(store);
  proposeWork(store, key, "w2");
  assert.throws(() => complete(store, key, "w2", { evidenceUrl: "https://example.com", evidenceVersion: "v1" }),
    error => error.status === 422 && error.code === "missing_signed_evidence");
  assert.equal(store.room("commons").state.workItems.w2.state, "working");
});

test("replayed evidence is deduped, not double-counted", t => {
  const { store, key } = openRoom(t);
  const identity = issueTestIdentity(store);
  proposeWork(store, key, "w3");
  const evidence = signTestEvidence(identity);
  complete(store, key, "w3", { signedEvidence: evidence });
  proposeWork(store, key, "w4");
  assert.throws(() => complete(store, key, "w4", { signedEvidence: evidence }),
    error => error.status === 409 && error.code === "duplicate_evidence");
  assert.equal(store.room("commons").state.workItems.w4.state, "working");
});

test("tampered evidence is rejected", t => {
  const { store, key } = openRoom(t);
  const identity = issueTestIdentity(store);
  proposeWork(store, key, "w5");
  const evidence = { ...signTestEvidence(identity), label: "tampered after signing" };
  assert.throws(() => complete(store, key, "w5", { signedEvidence: evidence }),
    error => error.status === 422 && error.code === "bad_signature");
});

test("evidence from an unknown signer is rejected", t => {
  const { store, key } = openRoom(t);
  const identity = issueTestIdentity(store);
  proposeWork(store, key, "w6");
  const evidence = { ...signTestEvidence(identity), signerIdentityId: "ai_nonexistent" };
  assert.throws(() => complete(store, key, "w6", { signedEvidence: evidence }),
    error => error.status === 422 && error.code === "unknown_signer");
});

test("evidence signed with a rotated-out key is rejected as a key mismatch", t => {
  const { store, key } = openRoom(t);
  const identity = issueTestIdentity(store, "Rotator");
  store.keyRegistry.rotateKey(identity.identityId,
    { identitySecret: identity.secret, newPublicKey: generateKeyPair().publicKey, overlapMs: 0 });
  proposeWork(store, key, "w7");
  const evidence = signTestEvidence(identity); // old seed, issued after rotation
  assert.throws(() => complete(store, key, "w7", { signedEvidence: evidence }),
    error => error.status === 422 && error.code === "bad_signature");
});

test("backdated evidence is rejected when no key covered its issuedAt", t => {
  const { store, key } = openRoom(t);
  const identity = issueTestIdentity(store);
  proposeWork(store, key, "w8");
  const evidence = signTestEvidence(identity, { issuedAt: "2020-01-01T00:00:00Z" });
  assert.throws(() => complete(store, key, "w8", { signedEvidence: evidence }),
    error => error.status === 422 && error.code === "expired_key");
});

test("evidence signed with a revoked key is rejected", t => {
  const { store, key } = openRoom(t);
  const identity = issueTestIdentity(store, "Revokee");
  store.keyRegistry.revokeKey(identity.identityId, { identitySecret: identity.secret, publicKey: identity.publicKey });
  proposeWork(store, key, "w9");
  const evidence = signTestEvidence(identity);
  assert.throws(() => complete(store, key, "w9", { signedEvidence: evidence }),
    error => error.status === 422 && error.code === "revoked_key");
});

test("a JSON number inside the evidence body is rejected on the live path", t => {
  const { store, key } = openRoom(t);
  const identity = issueTestIdentity(store);
  proposeWork(store, key, "w10");
  const evidence = { ...signTestEvidence(identity), label: 42 };
  assert.throws(() => complete(store, key, "w10", { signedEvidence: evidence }),
    error => error.status === 422 && error.code === "number_ban");
});

test("the room_text path is unchanged: native completion needs no signed evidence", t => {
  const { store, key } = openRoom(t);
  proposeWork(store, key, "w11");
  const messageId = randomUUID();
  const posted = store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId, workItemId: "w11", body: "the exact result" } });
  const saved = complete(store, key, "w11", { evidenceKind: "room_text", evidenceMessageId: messageId,
    evidenceMessageEventId: posted.event.id, evidenceVersion: textVersion("the exact result"),
    previousCompletionEventId: null, producerId: null });
  assert.equal(saved.duplicate, false);
  const receipt = store.room("commons").state.workItems.w11.receipt;
  assert.ok(receipt.nativeText);
  assert.equal(receipt.signedEvidence, undefined);
  assert.equal(store.room("commons").state.workItems.w11.state, "completed");
});

test("historical unsigned completions still replay through recovery", t => {
  const { store, key } = openRoom(t);
  proposeWork(store, key, "legacy");
  const revision = store.room("commons").state.workItems.legacy.revision;
  const next = store.room("commons").sequence + 1;
  // Simulate an event persisted before the signed contract existed: it goes
  // straight into the event log, bypassing the live command path.
  const body = JSON.stringify(event({ type: T.WORK_COMPLETED, roomId: "commons", actorId: "owner",
    data: { workItemId: "legacy", expectedRevision: revision, summary: "Old",
      evidenceUrl: "https://example.com/old", evidenceVersion: "v1", nextAction: "N" } }));
  store.db.prepare("INSERT INTO events(room_id,sequence,id,body) VALUES(?,?,?,?)")
    .run("commons", next, randomUUID(), body);
  // The raw insert bypasses the command path, so advance the room's recorded
  // sequence the way the persister would.
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(next, "commons");
  const rebuilt = store.rebuildProjection("commons", next);
  assert.equal(rebuilt.state.workItems.legacy.state, "completed");
  assert.equal(rebuilt.state.workItems.legacy.receipt.evidenceUrl, "https://example.com/old");
  assert.equal(rebuilt.state.workItems.legacy.receipt.signedEvidence, undefined);
});
