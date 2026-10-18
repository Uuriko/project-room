// Receipt <-> payout lot cross-reference at the page layer (#3781).
//
// The read model (PR #3783, server/public-read-model.mjs) emits two
// extra fields on a paid work receipt: top-level lotId and
// settlement { lotId, amountCredits, lotState }, derived from the
// bounty_journal payout row stamped with the receipt id. The lot read
// names the receipt back (lot.workReceiptId). This file pins the PAGE
// layer only — server/receipts-page.mjs, whose receiptJson /
// receiptsListJson / renderReceiptDetailHtml are the exact functions
// the /receipts routes serve (server/http.mjs):
//
//   - receiptJson forwards lotId + settlement when the read model
//     carries them, in both the detail and the list serialization;
//   - the detail HTML links the receipt to its payout lot page;
//   - a receipt with no lot linkage gains neither key and no link
//     (absent, never null-forged);
//   - the bounty-lot receipt's own page/JSON is undisturbed.
//
// Layer note: the linked receipt below starts from the REAL read
// model over a REAL settled ledger. Until #3783 lands, publicReceiptById
// does not yet attach the two fields, so the test attaches them with
// #3783's own expressions, derived from the same journal row its query
// reads; once #3783 lands the read model returns identical values and
// the attachment is skipped. The page assertions fail on main without
// this PR's receipts-page.mjs change either way.
//
// Run: node --test tests/receipt-cross-reference-page.test.js
// (TMPDIR must be worktree-local, never the shared /tmp tmpfs.)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createReceiptSigner, generateReceiptKeyPair } from "../server/bounty-receipts.mjs";
import { publicReceiptById } from "../server/receipts-live.mjs";
import { renderReceiptDetailHtml, receiptJson, receiptsListJson } from "../server/receipts-page.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane
const CHALLENGE_WINDOW_MS = 3 * 24 * 3600 * 1000;
const PWR_ID = `pwr_${"ab".repeat(32)}`;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

// Same fixture idiom as tests/lot-receipt-page.test.js.
function seedReadTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS room_directory_settings (
    room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0,
    public_receipts INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS room_public_settings (
    room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS public_unpublish (kind TEXT, target TEXT);
  CREATE TABLE IF NOT EXISTS room_public_receipts_setting (
    room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS public_rooms (slug TEXT PRIMARY KEY, title TEXT);
  CREATE TABLE IF NOT EXISTS public_receipts (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
    origin_room_id TEXT, room_id TEXT, room_title TEXT,
    agents_json TEXT NOT NULL, humans_json TEXT NOT NULL,
    pull_request TEXT, merged_at TEXT, verification_state TEXT, hashes_json TEXT NOT NULL,
    at TEXT NOT NULL, start_href TEXT NOT NULL)`);
}

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT xref_page_test");
    try { const out = fn(); db.exec("RELEASE xref_page_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO xref_page_test"); db.exec("RELEASE xref_page_test"); throw error; }
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

function insertWorkReceipt(db, id) {
  db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, 'Write the migration guide', 'public-work', NULL, NULL, NULL, '[]', '[]', NULL, NULL, '[]', '2026-10-01T00:00:00.000Z', 'https://room.trydemigod.com/?start=room')`)
    .run(id);
}

// Drive a bounty to paid, stamp the work receipt id on the payout
// movement's journal entries (as the settlement layer does), store the
// matching public work receipt, and return its read-model receipt with
// the #3783 linkage attached (see the layer note in the header).
function linkedWorkReceipt(escrow, db, store) {
  const bounty = runToPaid(escrow);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  db.prepare("UPDATE bounty_journal SET receipt_id=? WHERE room_id=? AND lot_id=? AND kind='payout'")
    .run(PWR_ID, ROOM, lotId);
  insertWorkReceipt(db, PWR_ID);
  const receipt = publicReceiptById(store, PWR_ID);
  assert.ok(receipt, "the stored work receipt must resolve");
  const j = db.prepare("SELECT lot_id, amount, lot_state FROM bounty_journal WHERE receipt_id=? LIMIT 1").get(PWR_ID);
  assert.ok(j?.lot_id, "the stamped journal row must exist");
  const settlement = { lotId: j.lot_id, amountCredits: Math.abs(j.amount) / 1000, lotState: j.lot_state };
  const linked = receipt.lotId === undefined ? { ...receipt, lotId: j.lot_id, settlement } : receipt;
  assert.deepEqual(linked.settlement, settlement);
  return { linked, lotId };
}

test("the receipt JSON forwards the payout lot cross-reference, detail and list", () => {
  const { escrow, db, store } = makeEscrow();
  const { linked, lotId } = linkedWorkReceipt(escrow, db, store);

  const json = receiptJson(linked);
  assert.equal(json.id, PWR_ID);
  assert.equal(json.lotId, lotId);
  assert.deepEqual(json.settlement, linked.settlement);
  assert.equal(json.settlement.lotId, lotId);
  // The payout movement moves 9.9 of the 10 credits to the worker.
  assert.equal(json.settlement.amountCredits, 9.9);

  const list = receiptsListJson({ receipts: [linked], nextCursor: null });
  assert.equal(list.receipts[0].lotId, lotId);
  assert.deepEqual(list.receipts[0].settlement, linked.settlement);
});

test("the receipt page links to the payout lot", () => {
  const { escrow, db, store } = makeEscrow();
  const { linked, lotId } = linkedWorkReceipt(escrow, db, store);

  const html = renderReceiptDetailHtml(linked);
  assert.match(html, /Payout lot/);
  assert.ok(html.includes(`<a href="/receipts/${lotId}">`), "the page must link the lot receipt");
  assert.match(html, /9\.9 credits/);
  assert.ok(html.includes(linked.settlement.lotState), "the journal row's lot state is shown");
});

test("a work receipt with no lot linkage gains neither key and no link", () => {
  const { escrow, db, store } = makeEscrow();
  runToPaid(escrow); // a settled ledger exists, but nothing references this receipt
  const orphanId = `pwr_${"ef".repeat(32)}`;
  insertWorkReceipt(db, orphanId);
  const receipt = publicReceiptById(store, orphanId);
  assert.ok(receipt, "the receipt itself still resolves");
  assert.equal(receipt.lotId, undefined);

  const json = receiptJson(receipt);
  assert.equal("lotId" in json, false);
  assert.equal("settlement" in json, false);

  const html = renderReceiptDetailHtml(receipt);
  assert.doesNotMatch(html, /Payout lot/);
});

test("the lot receipt's own page and JSON are undisturbed", () => {
  const { escrow, db, store } = makeEscrow();
  const { lotId } = linkedWorkReceipt(escrow, db, store);
  // The lot serves under the owner's recorded public-receipts opt-in
  // (#3594), mirrored here as syncRoomPublication writes it.
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 1)").run(ROOM);

  const lot = publicReceiptById(store, lotId);
  assert.ok(lot, "the payout lot must resolve");
  const json = receiptJson(lot);
  assert.equal(json.source, "bounty-lot");
  assert.equal(json.lot.kind, "payout");
  assert.equal(json.lot.amountCredits, 9.9);
  assert.equal("lotId" in json, false, "the cross-reference fields belong to work receipts");

  const html = renderReceiptDetailHtml(lot);
  assert.match(html, /Settlement/);
  assert.match(html, /verified-complete/);
});
