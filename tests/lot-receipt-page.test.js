// Bounty lot receipts: a settled bounty's lots resolve at /receipts/<lotId>.
//
// Before this fix the public receipt routes and the receipt id gate only
// knew pwr_/wcr_/wir_ shapes, so every bounty lot id 404'd — including
// the payout lot of a fully settled bounty, even though the member-gated
// credits history serves the same lot as a receipt. The lot shape is
// composed at read time from the escrow ledger (bounty_journal +
// bounty_records), the same derivation the credits history uses.
//
// Behavior protected:
//   - a settled lot renders with the fields the ledger actually has
//     (poster, worker, amount, movement, rubric hash, settlement verdict);
//   - the payout lot of a paid bounty and the refund lot of a failed
//     bounty both resolve, with their signed receipt ids when a signer
//     is configured;
//   - unknown lot ids, malformed ids, lots of unsettled bounties, and
//     non-bounty lots (transfers) still 404;
//   - the room's public-receipts directory toggle and operator
//     unpublish hide a lot receipt like any other shape;
//   - the room's recorded public-receipts setting governs lots too:
//     recording it off hides a lot receipt, recording it on serves
//     it, and never recording it leaves the settled lot served;
//   - other receipt shapes gain no lot field and stay unchanged.
//
// Seams: the real BountyEscrow state machine drives a real ledger
// (unit part), and the real HTTP server + RoomStore serve the page
// (route part). No mocks of the code under test.
//
// Run: node --test tests/lot-receipt-page.test.js
// (TMPDIR must be worktree-local, never the shared /tmp tmpfs.)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createReceiptSigner, generateReceiptKeyPair } from "../server/bounty-receipts.mjs";
import { publicReceiptById } from "../server/public-read-model.mjs";
import { renderReceiptDetailHtml, receiptJson } from "../server/receipts-page.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane
const INSTINCT = "id:agent/instinct"; // designated verifier / dispute decider
const CODEX = "id:agent/codex";    // dispute challenger lane
const CHALLENGE_WINDOW_MS = 3 * 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

// The read path joins tables outside the escrow schema (directory
// settings, unpublish, public rooms). Give the fake store the minimal
// real shapes those queries run against.
function seedReadTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS room_directory_settings (
    room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0,
    public_receipts INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS room_public_settings (
    room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS public_unpublish (kind TEXT, target TEXT);
  CREATE TABLE IF NOT EXISTS room_public_receipts_setting (
    room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS public_rooms (slug TEXT PRIMARY KEY, title TEXT);`);
}

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT lot_receipt_test");
    try { const out = fn(); db.exec("RELEASE lot_receipt_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO lot_receipt_test"); db.exec("RELEASE lot_receipt_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const keyPair = generateReceiptKeyPair();
  const signer = createReceiptSigner({ seedHex: keyPair.seedHex, ref: "test-operator" });
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true, receipts: signer });
  escrow.ensureGenesis(ROOM);
  seedReadTables(db);
  return { escrow, db, store };
}

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "Write the migration guide", criteria: "C", amount: 10,
    deadline: isoFuture(3_600_000), approvalMode: "human", ...overrides }).bounty;

function runToPaid(escrow) {
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: attest() });
  tick(CHALLENGE_WINDOW_MS + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ROOM, {});
  return escrow.getBounty(ROOM, bounty.bountyId);
}

const lotOfKind = (db, bountyId, kind) => db.prepare(
  "SELECT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind=? ORDER BY seq LIMIT 1")
  .get(ROOM, bountyId, kind)?.lot_id;

test("a settled payout lot composes a public receipt with the ledger's real fields", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  assert.equal(bounty.state, "paid");
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  assert.match(lotId, /^lot_[a-f0-9]{16}$/);

  const receipt = publicReceiptById(store, lotId);
  assert.ok(receipt, "the settled payout lot must resolve");
  assert.equal(receipt.id, lotId);
  assert.equal(receipt.source, "bounty-lot");
  assert.equal(receipt.title, "Write the migration guide");
  assert.deepEqual(receipt.room, { id: ROOM, title: null });
  const lot = receipt.lot;
  assert.equal(lot.bountyId, bounty.bountyId);
  assert.equal(lot.kind, "payout");
  assert.equal(lot.poster, JILL);
  assert.equal(lot.worker, GROK);
  // 10 credits accepted; the sweep pays 99% and moves the 1% fee to the
  // pool inside the same lot.
  assert.equal(lot.amountMillis, 9900);
  assert.equal(lot.amountCredits, 9.9);
  assert.deepEqual(lot.from, { account: GROK, lotState: "approved" });
  assert.deepEqual(lot.to, { account: GROK, lotState: "payable" });
  const fee = lot.movements.find(movement => movement.kind === "fee" && movement.amountMillis > 0);
  assert.ok(fee, "the fee leg stays visible in the lot's movements");
  assert.equal(fee.account, "pool");
  assert.equal(fee.amountMillis, 100);
  assert.equal(lot.awardCredits, 10);
  assert.equal(lot.bountyState, "paid");
  assert.match(lot.rubricHash, /^[a-f0-9]{64}$/);
  assert.equal(lot.rubricVersion, 1);
  assert.equal(lot.settlement.kind, "verified-complete");
  assert.equal(lot.settlement.workerCredits, 9.9);
  assert.equal(lot.settlement.refundCredits, 0);
  assert.equal(lot.settlement.settledBy.id, "escrow-keeper");
  assert.equal(lot.signedReceiptIds.length, 1);
  assert.match(lot.signedReceiptIds[0], /^room-bounty-receipt:pr:[0-9a-f]{32}$/);
  assert.ok(receipt.hashes.length >= 2);
  assert.ok(receipt.hashes.every(hash => /^sha256:[a-f0-9]{64}$/.test(hash)));

  const html = renderReceiptDetailHtml(receipt);
  assert.match(html, /Write the migration guide/);
  assert.match(html, /id:agent\/jill/);
  assert.match(html, /id:agent\/grokbot/);
  assert.match(html, /verified-complete/);
  assert.match(html, /9\.9 credits/);
  assert.match(html, /not identity-verified/);
  assert.match(html, /not re-verified/);
  assert.match(html, /unsigned/);
  assert.doesNotMatch(html, /verified the merge/);

  const json = receiptJson(receipt);
  assert.equal(json.schema, "project-room-public-receipt/1");
  assert.equal(json.lot.bountyId, bounty.bountyId);
  assert.equal(json.lot.settlement.kind, "verified-complete");
});

// --- Cross-references (#3781): work receipt <-> payout lot ------------------
//
// A settled public-work bounty leaves two public artifacts: the worker's
// pwr_ work receipt (a stored public_receipts row) and the payout lot
// receipt (composed at read time from bounty_journal). The settlement
// layer stamps the work receipt id on the payout movement's journal
// entries — the same two-entry stamping _issueReceipt performs for signed
// receipts — and each read must name the other artifact, so a stranger can
// walk from the proof of work to the proof of payment and back. A receipt
// or lot without the counterpart stays exactly as it was: no lot fields on
// the receipt, a null workReceiptId on the lot.

const PWR_ID = `pwr_${"ab".repeat(32)}`;

function seedPublicReceipts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS public_receipts (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
    origin_room_id TEXT, room_id TEXT, room_title TEXT,
    agents_json TEXT NOT NULL, humans_json TEXT NOT NULL,
    pull_request TEXT, merged_at TEXT, verification_state TEXT, hashes_json TEXT NOT NULL,
    at TEXT NOT NULL, start_href TEXT NOT NULL)`);
}

function insertWorkReceipt(db, id, title = "Write the migration guide") {
  seedPublicReceipts(db);
  db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, ?, 'public-work', NULL, NULL, NULL, '[]', '[]', NULL, NULL, '[]', '2026-10-01T00:00:00.000Z', 'https://room.trydemigod.com/?start=room')`)
    .run(id, title);
}

// Drive a bounty to paid, then stamp the work receipt id on the payout
// movement's journal entries, as the settlement layer does, and store the
// matching public work receipt.
function runToPaidCrossReferenced(escrow, db) {
  const bounty = runToPaid(escrow);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  db.prepare("UPDATE bounty_journal SET receipt_id=? WHERE room_id=? AND lot_id=? AND kind='payout'")
    .run(PWR_ID, ROOM, lotId);
  insertWorkReceipt(db, PWR_ID);
  return { bounty, lotId };
}

test("a settled work receipt names its payout lot, and the lot names the receipt back", () => {
  const { escrow, db, store } = makeEscrow();
  const { lotId } = runToPaidCrossReferenced(escrow, db);

  const receipt = publicReceiptById(store, PWR_ID);
  assert.ok(receipt, "the stored work receipt must resolve");
  assert.equal(receipt.lotId, lotId);
  assert.equal(receipt.settlement.lotId, lotId);
  // The payout movement moves 9.9 of the 10 credits to the worker; the
  // settlement block reports the stamped journal row's own amount and
  // lot state.
  assert.equal(receipt.settlement.amountCredits, 9.9);
  const stamped = db.prepare(
    "SELECT lot_state FROM bounty_journal WHERE receipt_id=? ORDER BY seq LIMIT 1").get(PWR_ID);
  assert.equal(receipt.settlement.lotState, stamped.lot_state);

  const lot = publicReceiptById(store, lotId);
  assert.ok(lot, "the payout lot must resolve");
  assert.equal(lot.lot.workReceiptId, PWR_ID);
  // The linkage also survives the JSON serialization the routes serve.
  assert.equal(receiptJson(lot).lot.workReceiptId, PWR_ID);
});

test("a work receipt with no journal lot row gains no lot fields", () => {
  const { escrow, db, store } = makeEscrow();
  runToPaid(escrow); // a settled ledger exists, but nothing references this receipt
  const orphanId = `pwr_${"ef".repeat(32)}`;
  insertWorkReceipt(db, orphanId);
  const receipt = publicReceiptById(store, orphanId);
  assert.ok(receipt, "the receipt itself still resolves");
  assert.equal(receipt.title, "Write the migration guide");
  assert.equal(receipt.lotId, undefined);
  assert.equal("settlement" in receipt, false);
});

test("a lot whose entries carry no work receipt id reports workReceiptId null", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  const lot = publicReceiptById(store, lotId);
  assert.ok(lot);
  assert.equal(lot.lot.workReceiptId, null);
  // The signed bounty receipt linkage is untouched.
  assert.equal(lot.lot.signedReceiptIds.length, 1);
  assert.match(lot.lot.signedReceiptIds[0], /^room-bounty-receipt:pr:/);
});


// --- Multi-movement lots: the HTML face must state the whole settlement ---
//
// One lot id can carry several journal movements (dispute splits, epoch
// payout+fee). The headline fields derive from the first legs only, so
// before the #3765 fix the HTML face headlined a split lot as the full
// award going to the worker though half refunded to the poster, and hid
// the refund leg of an accepted-split and the fee leg of a payout
// entirely. The JSON was always complete; these tests pin the HTML face.

// #3726 (Option A) closed the submitted -> disputed edge: no new dispute
// can open on submitted work. A store written before the gate can still
// hold one, and _settleDispute keeps its from-submitted arm for exactly
// those rows — so seed the state the way such a store holds it: the
// dispute machine walked to a seated decider, the challenger's bond
// locked, the bounty row disputed, all through the escrow's own
// writers, minus the one gate check disputeBounty now applies first.
function seedLegacySubmittedDispute(escrow, bountyId) {
  escrow._ensure();
  const row = escrow.db.prepare("SELECT * FROM bounty_records WHERE room_id=? AND bounty_id=?").get(ROOM, bountyId);
  const bounty = escrow._mutable(row);
  const disputeId = "dsp_legacysubmitted";
  const bondMillis = 2500; // exactly 25% of the 10-credit award, as disputeBounty requires
  escrow._move({ roomId: ROOM, at: new Date(nowMs).toISOString(),
    from: { account: CODEX, state: "payable" }, to: { account: CODEX, state: "locked" },
    amountMillis: bondMillis, kind: "bond-lock", bountyId, lotId: "lot_deadbeefdeadbeef",
    memo: `dispute bond for ${disputeId}`, actor: escrow._actorFor(ROOM, undefined, CODEX),
    receipt: { type: "bond-locked", payload: { bondKind: "dispute", fromAccount: CODEX } } });
  const machine = escrow._disputes;
  let dispute = machine.open({ disputeId, bountyId, bountyAmount: bounty.amountMillis,
    raisedBy: CODEX, reason: "partial credit", kind: "economic", bond: bondMillis });
  escrow._persistDispute(ROOM, dispute);
  dispute = machine.challenge(disputeId, { by: CODEX });
  escrow._persistDispute(ROOM, dispute);
  dispute = machine.submitEvidence(disputeId, { by: CODEX, summary: "partial credit" });
  escrow._persistDispute(ROOM, dispute);
  dispute = machine.seatDecider(disputeId, { decider: INSTINCT });
  escrow._persistDispute(ROOM, dispute);
  bounty.disputeId = disputeId;
  bounty.disputeOpenedMs = nowMs;
  escrow._transition(bounty, "disputed");
  escrow._saveBounty(bounty);
}

function runToSplit(escrow, { fromAccepted }) {
  const bounty = post(escrow, { verifierId: INSTINCT });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  if (fromAccepted) {
    escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: attest() });
    escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "partial credit" });
  } else {
    seedLegacySubmittedDispute(escrow, bounty.bountyId);
  }
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("split from a pre-gate submitted dispute: the page shows both halves, not the full award to the worker", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToSplit(escrow, { fromAccepted: false });
  // The decide lot carries attribute (full award) + approve (worker half)
  // + refund (poster half) under one lot id.
  const lotId = lotOfKind(db, bounty.bountyId, "approve");
  const receipt = publicReceiptById(store, lotId);
  assert.ok(receipt, "the split decide lot must resolve");
  const lot = receipt.lot;
  assert.deepEqual(lot.movements.map(movement => movement.kind),
    ["attribute", "attribute", "approve", "approve", "refund", "refund"]);
  assert.equal(lot.settlement.kind, "partial");
  assert.equal(lot.settlement.workerCredits, 5);
  assert.equal(lot.settlement.refundCredits, 5);
  // The JSON headline still names the first movement; the truth a stranger
  // needs is the settlement amounts and the full movement list, both now
  // on the HTML face.
  assert.equal(lot.kind, "attribute");
  assert.equal(lot.amountCredits, 10);

  const html = renderReceiptDetailHtml(receipt);
  assert.ok(html.includes("Movement</dt><dd>attribute, approve, refund</dd>"),
    "the movement row names every kind in the lot");
  assert.ok(html.includes("Worker received</dt><dd>5 credits</dd>"));
  assert.ok(html.includes("Refunded to poster</dt><dd>5 credits</dd>"));
  assert.ok(html.includes(`attribute: ${JILL} · locked → ${GROK} · attributed — 10 credits (10000 milli-credits)`));
  assert.ok(html.includes(`approve: ${GROK} · attributed → ${GROK} · approved — 5 credits (5000 milli-credits)`));
  assert.ok(html.includes(`refund: ${GROK} · attributed → ${JILL} · payable — 5 credits (5000 milli-credits)`),
    "the poster-half refund is on the face, naming the poster as recipient");
});

test("split from accepted: the page shows the poster refund the headline omits", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToSplit(escrow, { fromAccepted: true });
  const lotId = lotOfKind(db, bounty.bountyId, "approve");
  const receipt = publicReceiptById(store, lotId);
  assert.ok(receipt, "the split decide lot must resolve");
  const lot = receipt.lot;
  assert.deepEqual(lot.movements.map(movement => movement.kind),
    ["approve", "approve", "refund", "refund"]);
  // The headline is the approve leg alone (worker half); on its own it
  // reads as the whole story. The face must still show the refund leg.
  assert.equal(lot.kind, "approve");
  assert.equal(lot.amountCredits, 5);
  assert.equal(lot.settlement.workerCredits, 5);
  assert.equal(lot.settlement.refundCredits, 5);

  const html = renderReceiptDetailHtml(receipt);
  assert.ok(html.includes("Movement</dt><dd>approve, refund</dd>"));
  assert.ok(html.includes("Worker received</dt><dd>5 credits</dd>"));
  assert.ok(html.includes("Refunded to poster</dt><dd>5 credits</dd>"));
  assert.ok(html.includes(`approve: ${GROK} · attributed → ${GROK} · approved — 5 credits (5000 milli-credits)`));
  assert.ok(html.includes(`refund: ${GROK} · attributed → ${JILL} · payable — 5 credits (5000 milli-credits)`));
});

test("payout lot: the page shows the pool fee leg; single-movement lots gain no movements list", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  const receipt = publicReceiptById(store, lotId);
  assert.ok(receipt);
  const html = renderReceiptDetailHtml(receipt);
  assert.ok(html.includes("Movement</dt><dd>payout, fee</dd>"));
  assert.ok(html.includes(`payout: ${GROK} · approved → ${GROK} · payable — 9.9 credits (9900 milli-credits)`));
  assert.ok(html.includes("fee: " + GROK + " · approved → pool · payable — 0.1 credits (100 milli-credits)"),
    "the 1% pool fee leg is on the face");
  assert.ok(html.includes("Worker received</dt><dd>9.9 credits</dd>"));
  assert.ok(html.includes("Refunded to poster</dt><dd>0 credits</dd>"));

  // The funding lot is a single movement: its headline is already exact,
  // so no Movements list appears.
  const fundReceipt = publicReceiptById(store, lotOfKind(db, bounty.bountyId, "escrow-lock"));
  assert.ok(fundReceipt);
  assert.doesNotMatch(renderReceiptDetailHtml(fundReceipt), /<dt>Movements<\/dt>/);
});

test("every lot of a settled bounty resolves, each showing its own movement", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  const fundLot = lotOfKind(db, bounty.bountyId, "escrow-lock");
  const receipt = publicReceiptById(store, fundLot);
  assert.ok(receipt, "the funding lot of a settled bounty resolves");
  assert.equal(receipt.lot.kind, "escrow-lock");
  assert.equal(receipt.lot.amountCredits, 10);
  assert.deepEqual(receipt.lot.to, { account: JILL, lotState: "locked" });
  assert.equal(receipt.lot.settlement.kind, "verified-complete");
});

test("unknown, malformed, unsettled, and non-bounty lots stay 404", () => {
  const { escrow, db, store } = makeEscrow();
  assert.equal(publicReceiptById(store, `lot_${"0".repeat(16)}`), null);
  assert.equal(publicReceiptById(store, "lot_nope"), null);
  assert.equal(publicReceiptById(store, "lot_ABCDEF0123456789"), null);

  // A funded but unsettled bounty has no public lot receipts yet.
  const open = post(escrow);
  escrow.fundBounty(ROOM, open.bountyId, { funder: JILL });
  const fundLot = lotOfKind(db, open.bountyId, "escrow-lock");
  assert.match(fundLot, /^lot_[a-f0-9]{16}$/);
  assert.equal(publicReceiptById(store, fundLot), null);

  // A plain credit transfer mints a lot that is not a bounty movement.
  escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 1 });
  const transferLot = db.prepare(
    "SELECT lot_id FROM bounty_journal WHERE room_id=? AND kind='transfer' LIMIT 1").get(ROOM)?.lot_id;
  assert.match(transferLot, /^lot_[a-f0-9]{16}$/);
  assert.equal(publicReceiptById(store, transferLot), null);
});

test("the directory toggle and operator unpublish hide a lot receipt", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  assert.ok(publicReceiptById(store, lotId));

  db.prepare("INSERT INTO room_directory_settings (room_id, discoverable, public_receipts) VALUES (?, 0, 0)")
    .run(ROOM);
  assert.equal(publicReceiptById(store, lotId), null, "owner turned public receipts off");
  db.prepare("UPDATE room_directory_settings SET public_receipts=1 WHERE room_id=?").run(ROOM);
  assert.ok(publicReceiptById(store, lotId), "flipping the toggle back restores the receipt");

  db.prepare("INSERT INTO public_unpublish (kind, target) VALUES ('room', ?)").run(ROOM);
  assert.equal(publicReceiptById(store, lotId), null, "operator unpublish hides the room's lots");
  db.prepare("DELETE FROM public_unpublish").run();
  assert.ok(publicReceiptById(store, lotId));
});

test("the room's recorded public-receipts setting hides a lot receipt", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  assert.ok(publicReceiptById(store, lotId), "never recorded: the settled lot is served");

  // The mirror row syncRoomPublication writes when the owner records
  // room.public_receipts_set. Only a RECORDED off hides the lot; the
  // end-to-end recording path is covered by the HTTP test below.
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 0)")
    .run(ROOM);
  assert.equal(publicReceiptById(store, lotId), null, "owner recorded public receipts off");
  db.prepare("UPDATE room_public_receipts_setting SET enabled=1 WHERE room_id=?").run(ROOM);
  assert.ok(publicReceiptById(store, lotId), "recording it back on restores the receipt");
});

test("other receipt shapes gain no lot field", () => {
  const json = receiptJson({
    schema: "project-room-public-receipt/1", id: `pwr_${"cd".repeat(32)}`, title: "Public task",
    source: "public-work", room: null, agents: ["a"], humans: [],
    pullRequest: null, mergedAt: null, hashes: [], at: "2026-10-01T00:00:00.000Z",
    startHref: "https://room.trydemigod.com/?start=room",
  });
  assert.equal("lot" in json, false);
});

// --- HTTP seam: the real server serves the lot page -------------------------

async function serveSettledRoom(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-lot-receipt-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added",
    data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis("commons");
  const bounty = escrow.postBounty("commons", { poster: "owner",
    title: "Fix the flaky export", criteria: "Export passes 100 runs in a row.",
    amount: 10, deadline: new Date(Date.now() + 86_400_000).toISOString() }).bounty;
  escrow.fundBounty("commons", bounty.bountyId, { funder: "owner" });
  escrow.claimBounty("commons", bounty.bountyId, { claimant: "ada" });
  escrow.submitWork("commons", bounty.bountyId, { claimant: "ada", evidence });
  const rejected = escrow.rejectWork("commons", bounty.bountyId,
    { rejector: "owner", reason: "Export still flakes on run 41." });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, lotId: rejected.receipt.lotId,
    store, ownerKey };
}

test("GET /receipts/<lotId> serves the settled lot page and JSON; unknown lots 404", async t => {
  const { origin, lotId } = await serveSettledRoom(t);
  assert.match(lotId, /^lot_[a-f0-9]{16}$/);

  const page = await fetch(`${origin}/receipts/${lotId}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Fix the flaky export/);
  assert.match(html, /failed/);
  assert.match(html, /Export still flakes on run 41\./);
  assert.match(html, /Posted by/);
  assert.match(html, /Worker/);
  assert.match(html, /not identity-verified/);
  assert.doesNotMatch(html, /verified the merge/);

  const alias = await fetch(`${origin}/room/receipts/${lotId}`);
  assert.equal(alias.status, 200);

  const jsonRes = await fetch(`${origin}/receipts/${lotId}.json`);
  assert.equal(jsonRes.status, 200);
  const body = JSON.parse(await jsonRes.text());
  assert.equal(body.source, "bounty-lot");
  assert.equal(body.lot.kind, "refund");
  assert.equal(body.lot.amountCredits, 10);
  assert.equal(body.lot.poster, "owner");
  assert.equal(body.lot.worker, "ada");
  assert.equal(body.lot.settlement.kind, "failed");
  assert.equal(body.lot.settlement.workerCredits, 0);
  assert.equal(body.lot.settlement.refundCredits, 10);

  const missing = await fetch(`${origin}/receipts/lot_${"0".repeat(16)}`);
  assert.equal(missing.status, 404);
  const missingJson = await fetch(`${origin}/receipts/lot_${"0".repeat(16)}.json`);
  assert.equal(missingJson.status, 404);

  // The gallery still lists only stored public receipts; lots are
  // detail-only and do not leak into the listing.
  const list = await fetch(`${origin}/receipts`);
  assert.equal(list.status, 200);
  assert.doesNotMatch(await list.text(), /Fix the flaky export/);
});

test("recording the room's public-receipts setting off hides the lot page", async t => {
  const { origin, lotId, store, ownerKey } = await serveSettledRoom(t);
  const record = (id, enabled) => store.command(ownerKey, "commons",
    { id, type: "room.public_receipts_set", data: { enabled } });

  // The room never recorded the setting: the settled lot stays served.
  assert.equal((await fetch(`${origin}/receipts/${lotId}`)).status, 200);
  record("pub-on", true);
  assert.equal((await fetch(`${origin}/receipts/${lotId}`)).status, 200,
    "recorded on: still served");
  record("pub-off", false);
  assert.equal((await fetch(`${origin}/receipts/${lotId}`)).status, 404,
    "recorded off: the lot page hides like every other shape");
  assert.equal((await fetch(`${origin}/receipts/${lotId}.json`)).status, 404,
    "recorded off: the JSON twin hides too");
  record("pub-on-again", true);
  assert.equal((await fetch(`${origin}/receipts/${lotId}`)).status, 200,
    "recorded back on: served again");
});
