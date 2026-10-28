// Tests for the standalone receipt verifier (tools/receipt-verifier/).
//
// The verifier is an INDEPENDENT implementation of Receipt Standard v0.1
// §4: it must agree with the shipped server verifiers on real receipts,
// reproduce the dasha-receipt/1 reference vectors byte-for-byte, and reject
// every negative class in the spec's conformance table with the named
// reason code. Fixtures in tools/receipt-verifier/fixtures/conformance.json
// were generated with the repo's own server modules using TEST KEYS ONLY.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  parseStrict,
  publicWorkReceiptId,
  verifyReceipt,
} from "../tools/receipt-verifier/receipt-verifier.mjs";
import {
  canonicalJson as serverCanonicalJson,
  generateReceiptKeyPair,
  issueBountyReceipt,
  verifyBountyReceipt,
} from "../server/bounty-receipts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = JSON.parse(readFileSync(join(ROOT, "tools/receipt-verifier/fixtures/conformance.json"), "utf8"));
const CLI = join(ROOT, "tools/receipt-verifier/room-receipt-verify.mjs");

const BOUNTY = FIXTURES.bounty.receipts["escrow-locked"];
const BOUNTY_PAYOUT = FIXTURES.bounty.receipts["payout-released"];
const BOUNTY_KEY = FIXTURES.bounty.pubkeyHex;
const VETTING = FIXTURES.vetting.receipt;
const VETTING_KEY = FIXTURES.vetting.pubkeyHex;
const VETTING_NOW = Date.parse(FIXTURES.vetting.now);
const EVIDENCE = FIXTURES.signedEvidence.evidence;
const PUBLIC_WORK = FIXTURES.publicWork.receipt;

const clone = v => JSON.parse(JSON.stringify(v));
const jwksOf = pubkeyHex => ({
  keys: [{ kty: "OKP", crv: "Ed25519", x: Buffer.from(pubkeyHex, "hex").toString("base64url"), kid: "test-key" }],
});

// --- canonicalization: the dasha-receipt/1 reference vectors -------------------
// Copied from tests/bounty-receipts.test.js (Python reference implementation).

const CANONICAL_VECTORS = [
  { input: { "z": "1", "a": "2", "é": "3" },
    canonical: "{\"a\":\"2\",\"z\":\"1\",\"é\":\"3\"}" },
  { input: { "key": "quote \" backslash \\ slash / newline \n tab \t ctrl \u0001" },
    canonical: "{\"key\":\"quote \\\" backslash \\\\ slash / newline \\n tab \\t ctrl \\u0001\"}" },
  { input: { "emoji": "☕", "plain": "é" },
    canonical: "{\"emoji\":\"☕\",\"plain\":\"é\"}" },
  { input: { "𝄞": "g-clef", "z": "z", "é": "e-acute" },
    canonical: "{\"z\":\"z\",\"é\":\"e-acute\",\"𝄞\":\"g-clef\"}" },
  { input: { "nested": { "b": ["x", true, null], "a": { "y": "deep" } } },
    canonical: "{\"nested\":{\"a\":{\"y\":\"deep\"},\"b\":[\"x\",true,null]}}" },
  { input: { "arr": [{ "k2": "v", "k1": "w" }, []] },
    canonical: "{\"arr\":[{\"k1\":\"w\",\"k2\":\"v\"},[]]}" },
  { input: { "empty_obj": {}, "empty_arr": [], "empty_str": "" },
    canonical: "{\"empty_arr\":[],\"empty_obj\":{},\"empty_str\":\"\"}" },
  { input: { "mixed_keys": { "A": "1", "a": "2", "0": "3", "_": "4", "ÿ": "5", "😀": "6" } },
    canonical: "{\"mixed_keys\":{\"0\":\"3\",\"A\":\"1\",\"_\":\"4\",\"a\":\"2\",\"ÿ\":\"5\",\"😀\":\"6\"}}" },
];

test("canonical encoding matches the reference vectors byte-for-byte", () => {
  for (const { input, canonical } of CANONICAL_VECTORS) {
    assert.equal(canonicalJson(input).toString("utf8"), canonical);
    assert.deepEqual([...canonicalJson(input)], [...Buffer.from(canonical, "utf8")], "byte-exact");
    // …and agrees with the shipped server implementation on the same input.
    assert.equal(canonicalJson(input).toString("utf8"), serverCanonicalJson(input).toString("utf8"));
  }
});

test("standalone canonicalJson rejects JSON numbers anywhere in signed bodies", () => {
  for (const bad of [{ a: 1 }, { a: { b: [1] } }, [1]])
    assert.throws(() => canonicalJson(bad), /number_ban|forbidden/i);
});

test("standalone parseStrict rejects duplicate keys, lone surrogates, trailing data", () => {
  assert.throws(() => parseStrict('{"a":"1","a":"2"}'), /duplicate object key/);
  assert.throws(() => parseStrict('{"a":"\\ud834"}'), /lone high surrogate/);
  assert.throws(() => parseStrict('{"a":"1"} trailing'), /trailing/);
});

// --- positive fixtures -----------------------------------------------------------

test("bounty fixtures verify against the pinned test key (object and text paths)", () => {
  for (const receipt of [BOUNTY, BOUNTY_PAYOUT]) {
    const v = verifyReceipt(receipt, { expectedPubkey: BOUNTY_KEY });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.family, "bounty");
    assert.equal(v.signer, BOUNTY_KEY);
    assert.equal(v.keySource, "pinned");
    assert.equal(verifyReceipt(JSON.stringify(receipt), { expectedPubkey: BOUNTY_KEY }).ok, true);
  }
});

test("bounty fixture verifies via JWKS discovery", () => {
  const v = verifyReceipt(BOUNTY, { jwks: jwksOf(BOUNTY_KEY) });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.keySource, "jwks");
});

test("bounty fixture verifies against the journal fixture; integrity-only is labelled", () => {
  const v = verifyReceipt(BOUNTY, { expectedPubkey: BOUNTY_KEY, journal: FIXTURES.bounty.journal });
  assert.equal(v.ok, true, JSON.stringify(v));
  const forensic = verifyReceipt(BOUNTY, { integrityOnly: true });
  assert.equal(forensic.ok, true);
  assert.equal(forensic.integrityOnly, true);
  assert.equal(forensic.mode, "integrity-only");
  assert.equal(forensic.signer, BOUNTY_KEY, "integrity-only still reports who signed");
});

test("vetting fixture verifies with the room key inside its freshness window", () => {
  const v = verifyReceipt(VETTING, { expectedPubkey: VETTING_KEY, now: VETTING_NOW });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.verdict, "pass");
  assert.equal(v.candidateId, "agent:rivet");
});

test("signed-evidence fixture verifies against the registry fixture", () => {
  const v = verifyReceipt(EVIDENCE, { registry: FIXTURES.signedEvidence.registry });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.signer, "ai_verifier_fixture");
  assert.equal(v.keySource, "registry");
});

test("public-work fixture verifies in explicit integrity-only (hash) mode", () => {
  const v = verifyReceipt(PUBLIC_WORK, { integrityOnly: true });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.verification, "hash_only");
  assert.equal(v.mode, "integrity-only");
  const withArtifact = verifyReceipt(PUBLIC_WORK,
    { integrityOnly: true, artifactText: FIXTURES.publicWork.artifactText });
  assert.equal(withArtifact.ok, true);
  // The exported id helper reproduces the fixture's content hash.
  assert.equal(publicWorkReceiptId({
    taskId: PUBLIC_WORK.taskId, identityId: PUBLIC_WORK.identityId,
    generation: PUBLIC_WORK.generation, sha256: PUBLIC_WORK.artifact.sha256,
    checksReported: PUBLIC_WORK.checksReported,
  }), PUBLIC_WORK.receiptId);
});

// --- parity with the shipped server verifier --------------------------------------

test("standalone and server bounty verifiers agree on genuine and tampered receipts", () => {
  const cases = [
    ["genuine", r => r],
    ["tampered lotId", r => { r.lotId = "lot_dddddddddddddddd"; }],
    ["tampered actor", r => { r.actor.id = "id:agent/mallory"; }],
    ["tampered entry hash", r => { r.payload.entryHashes[0] = "c".repeat(64); }],
    ["extra key", r => { r.extra = "x"; }],
    ["missing payload field", r => { delete r.payload.fromAccount; }],
    ["impossible timestamp", r => { r.issuedAt = "2026-13-45T99:99:99Z"; }],
  ];
  for (const [label, mutate] of cases) {
    const receipt = clone(BOUNTY);
    mutate(receipt);
    const server = verifyBountyReceipt(receipt, { expectedPubkey: BOUNTY_KEY });
    const standalone = verifyReceipt(receipt, { expectedPubkey: BOUNTY_KEY });
    assert.equal(standalone.ok, server.ok, `${label}: standalone=${JSON.stringify(standalone)} server=${JSON.stringify(server)}`);
  }
});

test("the one intentional divergence: no trusted key fails closed standalone", () => {
  // The server verifier treats "no expected key" as integrity-only. The
  // standalone spec (§4.2) forbids silent acceptance: fail closed instead.
  assert.equal(verifyBountyReceipt(BOUNTY).ok, true);
  const v = verifyReceipt(BOUNTY);
  assert.equal(v.ok, false);
  assert.equal(v.code, "untrusted_issuer");
});

// --- spec §4.3 negative battery -----------------------------------------------------

test("tampered payload is rejected with bad_signature", () => {
  const r = clone(BOUNTY);
  r.lotId = "lot_dddddddddddddddd";
  const v = verifyReceipt(r, { expectedPubkey: BOUNTY_KEY });
  assert.equal(v.ok, false);
  assert.equal(v.code, "bad_signature");
});

test("tampered structure is rejected before crypto with invalid_receipt", () => {
  const added = clone(BOUNTY);
  added.extra = "x";
  assert.equal(verifyReceipt(added, { expectedPubkey: BOUNTY_KEY }).code, "invalid_receipt");
  const removed = clone(BOUNTY);
  delete removed.payload.fromAccount;
  assert.equal(verifyReceipt(removed, { expectedPubkey: BOUNTY_KEY }).code, "invalid_receipt");
});

test("wrong key: unexpected_signer with a pin, untrusted_issuer outside the JWKS set", () => {
  const other = generateReceiptKeyPair();
  const v = verifyReceipt(BOUNTY, { expectedPubkey: other.pubkeyHex });
  assert.equal(v.ok, false);
  assert.equal(v.code, "unexpected_signer");
  const viaJwks = verifyReceipt(BOUNTY, { jwks: jwksOf(other.pubkeyHex) });
  assert.equal(viaJwks.ok, false);
  assert.equal(viaJwks.code, "untrusted_issuer");
  // A receipt genuinely signed by a different (test) key: valid signature,
  // wrong signer — the server verifier agrees on the reason class.
  const foreign = issueBountyReceipt({
    type: "escrow-locked", roomId: "room-test", bountyId: "ROOM-1", lotId: "lot_cccccccccccccccc",
    amountMillis: "10000", actor: { kind: "agent", id: "id:agent/jill" },
    entries: ["ent_aaaaaaaaaaaaaaaa", "ent_bbbbbbbbbbbbbbbb"],
    entryHashes: ["a".repeat(64), "b".repeat(64)],
    payload: { fromAccount: "id:agent/jill", fromLotState: "payable" },
    issuer: { pubkey: other.pubkeyHex, role: "escrow-keeper", ref: "someone-else" },
    issuedAt: "2026-09-22T12:00:00.000Z", seedHex: other.seedHex,
  });
  assert.equal(verifyReceipt(foreign, { expectedPubkey: BOUNTY_KEY }).code, "unexpected_signer");
});

test("unknown key with no pin is rejected with untrusted_issuer (fail closed)", () => {
  assert.equal(verifyReceipt(BOUNTY).code, "untrusted_issuer");
  assert.equal(verifyReceipt(VETTING, { now: VETTING_NOW }).code, "untrusted_issuer");
  assert.equal(verifyReceipt(EVIDENCE).code, "untrusted_issuer");
  assert.equal(verifyReceipt(EVIDENCE, { registry: {} }).code, "unknown_signer");
});

test("revoked and expired registry keys are rejected with their named codes", () => {
  assert.equal(verifyReceipt(EVIDENCE, { registry: FIXTURES.signedEvidence.revokedRegistry }).code, "revoked_key");
  assert.equal(verifyReceipt(EVIDENCE, { registry: FIXTURES.signedEvidence.expiredRegistry }).code, "expired_key");
});

test("stale and future vetting receipts are rejected with their named codes", () => {
  const day = 24 * 60 * 60 * 1000;
  const stale = verifyReceipt(VETTING, { expectedPubkey: VETTING_KEY, now: VETTING_NOW + 8 * day });
  assert.equal(stale.code, "stale_receipt");
  const future = verifyReceipt(VETTING, { expectedPubkey: VETTING_KEY, now: VETTING_NOW - 10 * 60 * 1000 });
  assert.equal(future.code, "future_receipt");
});

test("replay: a shared seen-set rejects the second verification", () => {
  const seen = new Set();
  assert.equal(verifyReceipt(BOUNTY, { expectedPubkey: BOUNTY_KEY, seen }).ok, true);
  assert.equal(verifyReceipt(BOUNTY, { expectedPubkey: BOUNTY_KEY, seen }).code, "duplicate_receipt");
  const seenEvidence = new Set();
  assert.equal(verifyReceipt(EVIDENCE, { registry: FIXTURES.signedEvidence.registry, seen: seenEvidence }).ok, true);
  assert.equal(verifyReceipt(EVIDENCE, { registry: FIXTURES.signedEvidence.registry, seen: seenEvidence }).code, "duplicate_evidence");
});

test("broken chain: a journal hash mismatch is rejected with journal_mismatch", () => {
  const wrong = { ...FIXTURES.bounty.journal, ent_aaaaaaaaaaaaaaaa: "f".repeat(64) };
  assert.equal(verifyReceipt(BOUNTY, { expectedPubkey: BOUNTY_KEY, journal: wrong }).code, "journal_mismatch");
  const missing = { ent_bbbbbbbbbbbbbbbb: FIXTURES.bounty.journal.ent_bbbbbbbbbbbbbbbb };
  assert.equal(verifyReceipt(BOUNTY, { expectedPubkey: BOUNTY_KEY, journal: missing }).code, "journal_mismatch");
});

test("number smuggling is rejected with number_ban before signature checking", () => {
  const text = JSON.stringify(BOUNTY).replace('"amountMillis":"10000"', '"amountMillis":10000');
  assert.notEqual(text, JSON.stringify(BOUNTY), "the smuggled text actually differs");
  const v = verifyReceipt(text, { expectedPubkey: BOUNTY_KEY });
  assert.equal(v.ok, false);
  assert.equal(v.code, "number_ban");
});

test("duplicate keys in the receipt text are rejected with invalid_json", () => {
  const dup = JSON.stringify(BOUNTY).replace(/^{/, '{"type":"escrow-locked","type":"payout-released",');
  const v = verifyReceipt(dup, { expectedPubkey: BOUNTY_KEY });
  assert.equal(v.ok, false);
  assert.equal(v.code, "invalid_json");
});

test("wrong-room replay is rejected: context_mismatch for a genuine receipt, bad_signature for a rewritten one", () => {
  const v = verifyReceipt(BOUNTY, { expectedPubkey: BOUNTY_KEY, expectedRoomId: "room-other" });
  assert.equal(v.ok, false);
  assert.equal(v.code, "context_mismatch");
  const moved = clone(BOUNTY);
  moved.roomId = "room-other";
  assert.equal(verifyReceipt(moved, { expectedPubkey: BOUNTY_KEY }).code, "bad_signature");
});

test("id/type mismatch and unknown versions are rejected", () => {
  const wrongShort = clone(BOUNTY);
  wrongShort.receiptId = wrongShort.receiptId.replace(":el:", ":rf:");
  assert.equal(verifyReceipt(wrongShort, { expectedPubkey: BOUNTY_KEY }).code, "invalid_receipt");
  const wrongType = clone(BOUNTY);
  wrongType.type = "refund-issued";
  assert.equal(verifyReceipt(wrongType, { expectedPubkey: BOUNTY_KEY }).code, "invalid_receipt");
  const futureVersion = clone(BOUNTY);
  futureVersion.schemaVersion = "room-bounty-receipt/2";
  assert.equal(verifyReceipt(futureVersion, { expectedPubkey: BOUNTY_KEY }).code, "unknown_version");
});

test("public-work: hash mode is explicit and tampering breaks the content hash", () => {
  assert.equal(verifyReceipt(PUBLIC_WORK).code, "integrity_only_required");
  const tamperedHash = clone(PUBLIC_WORK);
  tamperedHash.artifact.sha256 = "e".repeat(64);
  assert.equal(verifyReceipt(tamperedHash, { integrityOnly: true }).code, "hash_mismatch");
  const tamperedId = clone(PUBLIC_WORK);
  tamperedId.receiptId = `pwr_${"e".repeat(64)}`;
  assert.equal(verifyReceipt(tamperedId, { integrityOnly: true }).code, "hash_mismatch");
  const wrongArtifact = verifyReceipt(PUBLIC_WORK,
    { integrityOnly: true, artifactText: "not the artifact\n" });
  assert.equal(wrongArtifact.code, "hash_mismatch");
});

test("the unsigned public projection is labelled server_attested, never verified", () => {
  const projection = { schema: "project-room-public-receipt/1", id: PUBLIC_WORK.receiptId, title: "x" };
  const v = verifyReceipt(projection, { integrityOnly: true });
  assert.equal(v.ok, false);
  assert.equal(v.code, "server_attested");
});

// --- CLI ----------------------------------------------------------------------------

function runCli(t, files, args) {
  const dir = mkdtempSync(join(tmpdir(), "receipt-verifier-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    paths[name] = join(dir, name);
    writeFileSync(paths[name], typeof content === "string" ? content : JSON.stringify(content));
  }
  const argv = args.map(a => paths[a] ?? a);
  const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
  return { result, paths, dir };
}

test("CLI: verified receipt exits 0 with a JSON verdict", t => {
  const { result } = runCli(t, { "receipt.json": BOUNTY },
    ["verify", "receipt.json", "--key", BOUNTY_KEY]);
  assert.equal(result.status, 0, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.receiptId, BOUNTY.receiptId);
});

test("CLI: rejected receipt exits 1 with the reason code", t => {
  const { result } = runCli(t, { "receipt.json": BOUNTY }, ["verify", "receipt.json"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, "untrusted_issuer");
});

test("CLI: missing receipt file is a usage/IO error (exit 2)", t => {
  const { result } = runCli(t, {}, ["verify", "nope.json"]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).code, "io_error");
});

test("CLI: --jwks file resolves the key; --journal mismatch rejects", t => {
  const okRun = runCli(t, { "receipt.json": BOUNTY, "jwks.json": jwksOf(BOUNTY_KEY) },
    ["verify", "receipt.json", "--jwks", "jwks.json"]);
  assert.equal(okRun.result.status, 0, okRun.result.stderr);
  assert.equal(JSON.parse(okRun.result.stdout).keySource, "jwks");
  const badJournal = { ...FIXTURES.bounty.journal, ent_aaaaaaaaaaaaaaaa: "f".repeat(64) };
  const badRun = runCli(t, { "receipt.json": BOUNTY, "journal.json": badJournal },
    ["verify", "receipt.json", "--key", BOUNTY_KEY, "--journal", "journal.json"]);
  assert.equal(badRun.result.status, 1);
  assert.equal(JSON.parse(badRun.result.stdout).code, "journal_mismatch");
});

test("CLI: --seen-file persists verified ids and rejects the replay", t => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-verifier-seen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const receiptPath = join(dir, "receipt.json");
  const seenPath = join(dir, "seen.json");
  writeFileSync(receiptPath, JSON.stringify(BOUNTY));
  const first = spawnSync(process.execPath,
    [CLI, "verify", receiptPath, "--key", BOUNTY_KEY, "--seen-file", seenPath], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(readFileSync(seenPath, "utf8")), [BOUNTY.receiptId]);
  const second = spawnSync(process.execPath,
    [CLI, "verify", receiptPath, "--key", BOUNTY_KEY, "--seen-file", seenPath], { encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stdout).code, "duplicate_receipt");
});

test("CLI: public-work requires --integrity-only and labels the verdict", t => {
  const refused = runCli(t, { "receipt.json": PUBLIC_WORK }, ["verify", "receipt.json"]);
  assert.equal(refused.result.status, 1);
  assert.equal(JSON.parse(refused.result.stdout).code, "integrity_only_required");
  const accepted = runCli(t, { "receipt.json": PUBLIC_WORK },
    ["verify", "receipt.json", "--integrity-only"]);
  assert.equal(accepted.result.status, 0, accepted.result.stderr);
  const verdict = JSON.parse(accepted.result.stdout);
  assert.equal(verdict.mode, "integrity-only");
  assert.equal(verdict.verification, "hash_only");
});

test("CLI: signed-evidence verifies with --registry and rejects the revoked registry", t => {
  const okRun = runCli(t, { "evidence.json": EVIDENCE, "registry.json": FIXTURES.signedEvidence.registry },
    ["verify", "evidence.json", "--registry", "registry.json"]);
  assert.equal(okRun.result.status, 0, okRun.result.stderr);
  const revokedRun = runCli(t, { "evidence.json": EVIDENCE, "registry.json": FIXTURES.signedEvidence.revokedRegistry },
    ["verify", "evidence.json", "--registry", "registry.json"]);
  assert.equal(revokedRun.result.status, 1);
  assert.equal(JSON.parse(revokedRun.result.stdout).code, "revoked_key");
});
