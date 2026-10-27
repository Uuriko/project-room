// S4-prep: signed-receipt serving surfaces (proof layer; design B3 §§1–3,
// R5 charter §3 S4 + §4.3 probes + §4.4 sentence probe; B7 D-1/D-2).
//
// Executed here: B3 §6 probes 1–5 and 8, in their S4-prep form:
//   probe 1  gate matrix on GET /receipts/signed/{receiptId} (handler level)
//   probe 2  planted tampered body ⇒ 404, never served
//   probe 3  stamp/body lot mismatch ⇒ 404
//   probe 4  verify leg: five checks, integrity/journal pass, time
//            not-checked, verdict capped at partially-verifiable; a
//            flipped signed byte ⇒ integrity contradicted
//   probe 5  key absent from the key history ⇒ identity not-checked,
//            never pass, never contradicted (the B7 D-1 degradation:
//            S5's key-history reader does not exist yet, so the seam
//            returns no history; a fixture history is also injected to
//            prove the resolution code path itself)
//   probe 8  route coexistence: route-table dispatch reaches the new
//            handler; /receipts/{lot_…} still falls through to legacy
// Probes 6–7 are S5's (key-history serving + revocation windows) and are
// DEFERRED-TO-S5 — not faked here.
//
// TEST KEYS ONLY: the signer is the public reference-vector key from
// tests/bounty-receipts.test.js. No production key material anywhere.
//
// Run: node --test tests/signed-receipt-serving.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createReceiptSigner, verifyBountyReceipt } from "../server/bounty-receipts.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { publicReceiptById } from "../server/receipts-live.mjs";
import { verifyPublicReceipt } from "../server/receipt-verify.mjs";
import { receiptProvenNote, signedProvenSentences } from "../server/receipt-share.mjs";
import { renderReceiptDetailHtml } from "../server/receipts-page.mjs";
import { signedReceiptRoute } from "../server/routes/signed-receipts.mjs";
import { dispatchRoute } from "../server/routes/dispatch.mjs";
import { ROUTES, assertRouteTable } from "../server/routes/table.mjs";
import { signerFingerprint } from "../server/signed-receipt-read.mjs";

const TEST_SEED = "9d61b19deffd5a60ba844af492ec2af44449c5697b326919703bac031cae7f60";
const TEST_PUBKEY = "b9ce0f24f866c0fa02ab7c1ff345f9bb7c73205b4c2ec76a77295ef16592dc0d";
const NOW = 1_786_100_000_000;

const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeWorld() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT s4_test");
    try { const out = fn(); db.exec("RELEASE s4_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO s4_test"); db.exec("RELEASE s4_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true,
    receipts: createReceiptSigner({ seedHex: TEST_SEED, ref: "test-operator" }) });
  store.bountyEscrow = escrow;
  escrow.ensureGenesis(ROOM);
  db.exec(`CREATE TABLE room_directory_settings (room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0, public_receipts INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE room_public_receipts_setting (room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
    CREATE TABLE public_unpublish (kind TEXT, target TEXT);
    CREATE TABLE public_rooms (slug TEXT PRIMARY KEY, title TEXT);`);
  return { escrow, db, store };
}

const optIn = db => db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 1)").run(ROOM);
const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 5, deadline: isoFuture(3_600_000), ...overrides }).bounty;

// A keyed fund: the signed body persists in bounty_idempotency (leg D).
function keyedFund(escrow) {
  const bounty = post(escrow);
  const result = escrow.idemExecute(ROOM, "fund-key-1", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }),
    { callerLane: JILL, bountyId: bounty.bountyId, payload: {} });
  const [body] = result.body.receipt.signed;
  assert.ok(body, "keyed fund issued a signed body");
  return { bounty, body };
}

// --- handler-level ctx mock -------------------------------------------------
function callRoute(store, receiptId, { method = "GET", headers = {} } = {}) {
  const res = { headers: {}, status: null, body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, hdrs) { this.status = status; if (hdrs) Object.assign(this.headers, hdrs); },
    end(body) { this.body = body; return this; } };
  const ctx = { store, params: { receiptId }, req: { method, headers }, res,
    url: new URL(`http://test/receipts/signed/${receiptId}`), remoteAddress: "test",
    rate() {}, reject(status, code, message) { const e = new Error(message); e.status = status; e.code = code; throw e; } };
  try { signedReceiptRoute(ctx); return { status: res.status ?? 200, headers: res.headers, body: res.body, error: null }; }
  catch (error) { return { status: error.status ?? null, code: error.code ?? null, message: error.message, error }; }
}
const expect404 = (r, what) => {
  assert.equal(r.status, 404, `${what}: status`);
  assert.equal(r.code, "not_found", `${what}: code`);
  assert.equal(r.message, "Not found", `${what}: message`);
};

// --- probe 1: the gate matrix ------------------------------------------------
test("probe 1: gate matrix — opted-in serves; every other branch is the identical 404", () => {
  { // opted-in ⇒ 200 + body verifies offline
    const { escrow, db, store } = makeWorld();
    const { body } = keyedFund(escrow);
    optIn(db);
    const r = callRoute(store, body.receiptId);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString("utf8")), body);
    assert.equal(verifyBountyReceipt(JSON.parse(r.body.toString("utf8")), { expectedPubkey: TEST_PUBKEY }).ok, true,
      "served body verifies offline");
    assert.equal(r.headers["Cache-Control"], "no-store");
    assert.equal(r.headers["X-Robots-Tag"], "noindex");
    assert.match(r.headers.ETag, /^"sha256:[0-9a-f]{64}"$/);
  }
  { // opted-out (recorded off) ⇒ 404
    const { escrow, db, store } = makeWorld();
    const { body } = keyedFund(escrow);
    db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 0)").run(ROOM);
    expect404(callRoute(store, body.receiptId), "opted-out");
  }
  { // never-recorded ⇒ 404
    const { escrow, store } = makeWorld();
    const { body } = keyedFund(escrow);
    expect404(callRoute(store, body.receiptId), "never-recorded");
  }
  // Operator-unpublish variants (public_unpublish kinds are 'receipt' and
  // 'room'; a lot is unpublished under kind 'receipt' naming the lot id).
  for (const [name, kindTarget] of [["lot", b => ["receipt", b.lotId]], ["room", () => ["room", ROOM]], ["receiptId", b => ["receipt", b.receiptId]]]) {
    const { escrow, db, store } = makeWorld();
    const { body } = keyedFund(escrow);
    optIn(db);
    const [kind, target] = kindTarget(body);
    db.prepare("INSERT INTO public_unpublish (kind, target) VALUES (?, ?)").run(kind, target);
    expect404(callRoute(store, body.receiptId), `operator-unpublished ${name}`);
  }
  { // fabricated well-formed receiptId ⇒ 404
    const { store } = makeWorld();
    optIn(store.db);
    expect404(callRoute(store, "room-bounty-receipt:pr:" + "1".repeat(32)), "fabricated");
  }
  { // malformed receiptId ⇒ 404
    const { store } = makeWorld();
    expect404(callRoute(store, "room-bounty-receipt:pr:not-hex"), "malformed");
    expect404(callRoute(store, "lot_" + "a".repeat(16)), "wrong family");
  }
});

test("probe 1b: ETag conditional honoured only after the gate; HEAD serves headers only", () => {
  const { escrow, db, store } = makeWorld();
  const { body } = keyedFund(escrow);
  optIn(db);
  const first = callRoute(store, body.receiptId);
  const etag = first.headers.ETag;
  const conditional = callRoute(store, body.receiptId, { headers: { "if-none-match": etag } });
  assert.equal(conditional.status, 304, "matching If-None-Match after the gate ⇒ 304");
  // Same conditional request against a now-private room ⇒ 404, never 304.
  db.prepare("UPDATE room_public_receipts_setting SET enabled=0 WHERE room_id=?").run(ROOM);
  expect404(callRoute(store, body.receiptId, { headers: { "if-none-match": etag } }), "conditional behind a closed gate");
  db.prepare("UPDATE room_public_receipts_setting SET enabled=1 WHERE room_id=?").run(ROOM);
  const head = callRoute(store, body.receiptId, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined, "HEAD carries no body");
  assert.equal(head.headers.ETag, etag, "HEAD ETag matches GET");
});

// --- probe 2: planted tamper --------------------------------------------------
test("probe 2: a tampered body planted in the idempotency store reads 404, never the tampered body", () => {
  const { escrow, db, store } = makeWorld();
  const { body } = keyedFund(escrow);
  optIn(db);
  const row = db.prepare("SELECT response FROM bounty_idempotency WHERE room_id=?").get(ROOM);
  const parsed = JSON.parse(row.response);
  parsed.receipt.signed[0] = { ...parsed.receipt.signed[0], amountMillis: "999999" }; // one signed field flipped
  db.prepare("UPDATE bounty_idempotency SET response=? WHERE room_id=?").run(JSON.stringify(parsed), ROOM);
  expect404(callRoute(store, body.receiptId), "tampered body");
});

// --- probe 3: stamp/body cross-check ------------------------------------------
test("probe 3: a body whose stamp row names a different lot reads 404", () => {
  const { escrow, db, store } = makeWorld();
  const { body } = keyedFund(escrow);
  optIn(db);
  db.prepare("UPDATE bounty_journal SET lot_id=? WHERE receipt_id=?").run("lot_" + "f".repeat(16), body.receiptId);
  expect404(callRoute(store, body.receiptId), "stamp/body lot mismatch");
});

// --- settled signed lot fixture (mirrors tests/receipt-verify.test.js) -------
function settledSignedLot() {
  const { escrow, db, store } = makeWorld();
  const bounty = post(escrow, { amount: 10, approvalMode: "human" });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation:
    { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  nowMs += 3 * 24 * 3600 * 1000 + 1;
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ROOM, {});
  const lotId = db.prepare("SELECT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' ORDER BY seq LIMIT 1")
    .get(ROOM, bounty.bountyId).lot_id;
  optIn(db);
  const receipt = publicReceiptById(store, lotId);
  assert.ok(receipt, "fixture lot resolves");
  assert.equal(receipt.lot.signedReceiptIds.length, 1, "the payout lot carries one signed receipt ID");
  return { escrow, db, store, receipt, lotId };
}
const sigChecks = (verification, id) => verification.checks.filter(c => c.id === id);
const downFetch = async () => { throw new Error("network down"); };

// --- projections: links beside byte-unchanged IDs ------------------------------
test("projections gain signedReceiptLinks (links, never bodies); signedReceiptIds unchanged", async () => {
  const { escrow, receipt } = settledSignedLot();
  const [receiptId] = receipt.lot.signedReceiptIds;
  assert.deepEqual(receipt.lot.signedReceiptLinks,
    [{ receiptId, type: "payout-released", href: `/receipts/signed/${receiptId}` }]);
  assert.ok(!("signature" in (receipt.lot.signedReceiptLinks[0] ?? {})), "links never carry bodies");
  const movement = escrow.history(ROOM, GROK).find(entry => entry.bountyId === receipt.lot.bountyId && entry.kind === "payout");
  assert.ok(movement, "payout movement in history");
  assert.deepEqual(movement.signedReceiptIds, [receiptId], "history IDs byte-unchanged");
  assert.deepEqual(movement.signedReceiptLinks,
    [{ receiptId, type: "payout-released", href: `/receipts/signed/${receiptId}` }], "history twin gains the same links");
});

// --- probe 4: the verify leg ----------------------------------------------------
test("probe 4: verify leg — five checks, integrity/journal pass, time not-checked, verdict capped", async () => {
  const { store, receipt } = settledSignedLot();
  const verification = await verifyPublicReceipt(store, receipt, { fetchImpl: downFetch, nowMs: NOW });
  assert.equal(sigChecks(verification, "signature")[0]?.status, "pass", "integrity pass");
  assert.equal(sigChecks(verification, "signature-journal")[0]?.status, "pass", "journal pass");
  assert.equal(sigChecks(verification, "signature-time")[0]?.status, "not-checked", "time always not-checked (native format)");
  assert.equal(sigChecks(verification, "signer-identity")[0]?.status, "not-checked",
    "no key history published yet (S5 seam) ⇒ identity not-checked, never pass");
  assert.equal(verification.verdict, "partially-verifiable", "a perfect native receipt caps at Partially verifiable");
  assert.ok(!verification.scope.notChecked.some(line => /public receipts are unsigned/.test(line)),
    "the old universal NEVER_CHECKED signature line is gone for signed records");
});

test("probe 4b: a flipped signed byte ⇒ integrity contradicted, overall contradicted", async () => {
  const { db, store, receipt } = settledSignedLot();
  const event = db.prepare("SELECT seq, data FROM bounty_events WHERE room_id=? AND type='epoch.closed'").get(ROOM);
  const data = JSON.parse(event.data);
  const [bountyId] = Object.keys(data.summary.signedReceipts);
  data.summary.signedReceipts[bountyId][0] = { ...data.summary.signedReceipts[bountyId][0], amountMillis: "1" };
  db.prepare("UPDATE bounty_events SET data=? WHERE seq=?").run(JSON.stringify(data), event.seq);
  const verification = await verifyPublicReceipt(store, receipt, { fetchImpl: downFetch, nowMs: NOW });
  assert.equal(sigChecks(verification, "signature")[0]?.status, "contradicted");
  assert.equal(verification.verdict, "contradicted");
});

test("probe 4c: an ID stamped with no admitted body emits signature missing", async () => {
  const { db, store, receipt } = settledSignedLot();
  db.prepare("DELETE FROM bounty_events WHERE room_id=? AND type='epoch.closed'").run(ROOM);
  const verification = await verifyPublicReceipt(store, receipt, { fetchImpl: downFetch, nowMs: NOW });
  assert.equal(sigChecks(verification, "signature")[0]?.status, "missing");
  assert.equal(verification.verdict, "no-longer-verifiable");
});

// --- probe 5: identity resolution against a (fixture) history -------------------
const fixtureHistory = keys => ({ schema: "project-room-receipt-key-history/1", policy: "B", version: 1, keys });
const genesisEntry = { keyId: `test-operator:${signerFingerprint(TEST_PUBKEY)}`, ref: "test-operator",
  role: "escrow-keeper", pubkey: TEST_PUBKEY, fingerprint: signerFingerprint(TEST_PUBKEY),
  status: "active", validFrom: "2026-01-01T00:00:00.000Z", successor: null,
  statement: { kind: "genesis", at: "2026-01-01T00:00:00.000Z", signature: null } };

test("probe 5: key absent from the history ⇒ identity not-checked, never pass, never contradicted", async () => {
  const { store, receipt } = settledSignedLot();
  const verification = await verifyPublicReceipt(store, receipt,
    { fetchImpl: downFetch, nowMs: NOW, keyHistory: fixtureHistory([]) });
  const identity = sigChecks(verification, "signer-identity")[0];
  assert.equal(identity.status, "not-checked");
  assert.match(identity.detail, /does not pin this key/);
});

test("probe 5b: the identity-PASS code path resolves against a fixture history (wiring is S5's)", async () => {
  const { store, receipt } = settledSignedLot();
  const verification = await verifyPublicReceipt(store, receipt,
    { fetchImpl: downFetch, nowMs: NOW, keyHistory: fixtureHistory([genesisEntry]) });
  assert.equal(sigChecks(verification, "signer-identity")[0]?.status, "pass",
    "pinned match passes — exercised here so S5's reader lands on a proven path");
  assert.equal(verification.verdict, "partially-verifiable", "time still caps the verdict");
});

// --- page row + proven note (B3 §2.2/§2.3) + §4.4 sentence probe ----------------
test("page row: ID-as-link + type; the verify outcome only when a run is present", async () => {
  const { store, receipt } = settledSignedLot();
  const [receiptId] = receipt.lot.signedReceiptIds;
  const plain = renderReceiptDetailHtml(receipt, {});
  assert.ok(plain.includes(`<a href="/receipts/signed/${receiptId}"><code>${receiptId}</code></a>`), "ID renders as a link");
  assert.ok(plain.includes("payout-released"), "type rides the row");
  assert.ok(plain.includes("signature not checked on this page"), "no run ⇒ no claim");
  const verification = await verifyPublicReceipt(store, receipt, { fetchImpl: downFetch, nowMs: NOW });
  const withRun = renderReceiptDetailHtml(receipt, { verification });
  assert.ok(withRun.includes("signature: re-verified at read time (see verification block)"), "run ⇒ its outcome, verbatim tier");
});

test("sentence probe: stamped ID with no resolved body renders NO signed claim", () => {
  const { receipt } = settledSignedLot();
  const note = receiptProvenNote(receipt); // no signedInfo: nothing resolved at render time
  assert.ok(note.endsWith("This record is unsigned."), "fallback to the unsigned wording verbatim");
  assert.ok(!/carries a signed receipt/.test(note), "no signed claim for an unresolvable body");
  assert.equal(signedProvenSentences(receipt, null), null);
  assert.equal(signedProvenSentences(receipt, []), null);
  assert.equal(signedProvenSentences(receipt, [{ receiptId: "room-bounty-receipt:pr:" + "9".repeat(32), fingerprint: null, keyHistoryStatus: "unpublished" }]), null,
    "info for a different receipt ID claims nothing about this one");
});

test("sentence probe: absent-key body renders no pinned claim; the fingerprint slot needs a body", () => {
  const { receipt } = settledSignedLot();
  const [receiptId] = receipt.lot.signedReceiptIds;
  const noBody = signedProvenSentences(receipt, [{ receiptId, fingerprint: null, keyHistoryStatus: "unpublished" }]);
  assert.equal(noBody, null, "no fingerprint slot without a resolved body ⇒ no signed sentence at all");
  const sentences = signedProvenSentences(receipt, [{ receiptId,
    fingerprint: signerFingerprint(TEST_PUBKEY), keyHistoryStatus: "unpublished" }]);
  assert.ok(sentences.includes(`readable at /receipts/signed/${receiptId}`), "presence + format + link claimed");
  assert.ok(sentences.includes(`Signer key: escrow-keeper, fingerprint ${signerFingerprint(TEST_PUBKEY)}`), "fingerprint slot from the resolved body");
  assert.ok(sentences.includes("Key history not published — signer identity not pinned"), "absent history degrades by name");
  assert.ok(!/re-verified at read time/.test(sentences), "no run ⇒ no verification claim");
  assert.ok(sentences.includes("not re-checked on this page"), "no run is stated, not hidden");
  const withRun = signedProvenSentences(receipt, [{ receiptId,
    fingerprint: signerFingerprint(TEST_PUBKEY), keyHistoryStatus: "active", verificationOutcome: "pass" }]);
  assert.ok(withRun.includes("Signature and journal linkage re-verified at read time: pass"), "the word verified lives only in the read-time slot");
  const note = receiptProvenNote(receipt, [{ receiptId,
    fingerprint: signerFingerprint(TEST_PUBKEY), keyHistoryStatus: "active" }]);
  assert.ok(note.startsWith("What this record proves: the room's credit ledger recorded this movement"), "middle sentences retained verbatim");
  assert.ok(!note.endsWith("This record is unsigned."), "the signed branch replaces only the final sentence");
});

// --- probe 8: route coexistence ---------------------------------------------------
test("probe 8: route-table rows are valid, dispatch reaches the handler, lot paths fall through", async () => {
  assert.doesNotThrow(() => assertRouteTable(ROUTES), "the whole route table still asserts clean");
  const rows = ROUTES.filter(row => row.path === "/receipts/signed/{receiptId}");
  assert.deepEqual(rows.map(row => row.method).sort(), ["GET", "HEAD"]);
  for (const row of rows) {
    assert.equal(row.auth, "none"); assert.equal(row.scope, "public");
    assert.equal(row.parity, "exempt:public signed-receipt body read; no MCP tool serves bounty receipt bodies");
  }
  const { store } = makeWorld();
  const mkCtx = pathname => ({ store, req: { method: "GET", headers: {} }, url: new URL(`http://test${pathname}`),
    res: { setHeader() {}, writeHead() {}, end() {} }, remoteAddress: "test", rate() {},
    reject(status, code, message) { const e = new Error(message); e.status = status; e.code = code; throw e; } });
  // The signed path is claimed by the table and reaches the handler (which
  // 404s this unknown ID through its gate order).
  await assert.rejects(() => dispatchRoute(mkCtx("/receipts/signed/room-bounty-receipt:pr:" + "2".repeat(32))),
    error => error.status === 404 && error.code === "not_found");
  // The legacy lot detail path is NOT shadowed: the table does not claim it.
  assert.equal(await dispatchRoute(mkCtx("/receipts/lot_" + "a".repeat(16))), false,
    "/receipts/{lot_…} falls through to the legacy chain as before");
});

test("conformance: the page's signed proven-note sentences are the share note's, verbatim", () => {
  const { receipt } = settledSignedLot();
  const [receiptId] = receipt.lot.signedReceiptIds;
  const signedInfo = [{ receiptId, fingerprint: signerFingerprint(TEST_PUBKEY), keyHistoryStatus: "active" }];
  const sentences = signedProvenSentences(receipt, signedInfo);
  assert.ok(sentences, "signed sentences render from resolved info");
  const page = renderReceiptDetailHtml(receipt, { signedInfo });
  assert.ok(page.includes(sentences), "page note carries the identical signed wording (single-source pin)");
  const share = receiptProvenNote(receipt, signedInfo);
  assert.ok(share.endsWith(sentences), "share note ends with the same sentences");
});
