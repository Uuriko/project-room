// Issue #3958: settled lot (lot_) receipts absent from the stranger
// /receipts index. A lot receipt resolves by direct link only when its
// room's public-receipts opt-in is recorded ON (publicLotReceiptById),
// but the listing surfaces (queryPublicReceipts, collectPublicReceipts,
// listPublicReceiptSitemap) read only stored public_receipts rows — and
// lots have no stored row — so a settled, opted-in lot never appeared
// on the index at all.
//
// Behavior protected:
//   - opt-in ON: the settled lot appears on all three listing surfaces,
//     with its bounty title, alongside ordinary receipts;
//   - opt-in OFF or never recorded: the lot appears on none of them;
//   - an ordinary (stored) receipt's listing is unchanged;
//   - pagination can start from a lot cursor and continue past it.
//
// Seam: the real BountyEscrow state machine drives a real ledger, as in
// tests/lot-receipt-page.test.js. No mocks of the code under test.
// Run: node --test tests/lot-receipts-index.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createReceiptSigner, generateReceiptKeyPair } from "../server/bounty-receipts.mjs";
import {
  queryPublicReceipts, collectPublicReceipts, listPublicReceiptSitemap,
} from "../server/receipts-live.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const CHALLENGE_WINDOW_MS = 3 * 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });

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
    at TEXT NOT NULL, start_href TEXT NOT NULL, agent_ids_json TEXT NOT NULL DEFAULT '[]');`);
}

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT lot_index_test");
    try { const out = fn(); db.exec("RELEASE lot_index_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO lot_index_test"); db.exec("RELEASE lot_index_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const keyPair = generateReceiptKeyPair();
  const signer = createReceiptSigner({ seedHex: keyPair.seedHex, ref: "test-operator" });
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true, receipts: signer });
  escrow.ensureGenesis(ROOM);
  seedReadTables(db);
  return { escrow, db, store };
}

function runToPaid(escrow) {
  const bounty = escrow.postBounty(ROOM,
    { poster: JILL, title: "Write the migration guide", criteria: "C", amount: 10,
      deadline: isoFuture(3_600_000), approvalMode: "human" }).bounty;
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

const ORDINARY_ID = `pwr_${"cd".repeat(32)}`;
function insertOrdinaryReceipt(db) {
  db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
    VALUES (?, 'Ordinary work', 'public-work', NULL, NULL, NULL, '[]', '[]', NULL, NULL, '[]', '2026-10-01T00:00:00.000Z', 'https://room.trydemigod.com/?start=room')`)
    .run(ORDINARY_ID);
}

const setOptIn = (db, enabled) => db.prepare(
  "INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled")
  .run(ROOM, enabled);

test("specimen: settled lot with opt-in ON appears on the stranger index surfaces", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  insertOrdinaryReceipt(db);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  setOptIn(db, 1);

  const page = queryPublicReceipts(store, {});
  const listed = page.receipts.find(r => r.id === lotId);
  assert.ok(listed, "opt-in ON: the settled lot must appear in queryPublicReceipts");
  assert.equal(listed.title, "Write the migration guide");
  assert.equal(listed.source, "bounty-lot");
  assert.ok(page.receipts.some(r => r.id === ORDINARY_ID), "the ordinary receipt is still listed");

  assert.ok(collectPublicReceipts(store).some(r => r.id === lotId),
    "opt-in ON: the settled lot must appear in collectPublicReceipts");
  assert.ok(listPublicReceiptSitemap(store, 100).some(e => e.path === `/receipts/${lotId}`),
    "opt-in ON: the settled lot must appear in the sitemap");
});

test("specimen: opt-in OFF or never recorded keeps the lot off every index surface", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  insertOrdinaryReceipt(db);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");

  // never recorded
  assert.ok(!queryPublicReceipts(store, {}).receipts.some(r => r.id === lotId), "never recorded: absent from query");
  assert.ok(!collectPublicReceipts(store).some(r => r.id === lotId), "never recorded: absent from collect");
  assert.ok(!listPublicReceiptSitemap(store, 100).some(e => e.path === `/receipts/${lotId}`), "never recorded: absent from sitemap");
  assert.ok(queryPublicReceipts(store, {}).receipts.some(r => r.id === ORDINARY_ID), "ordinary receipt unchanged (never recorded)");

  // recorded OFF
  setOptIn(db, 0);
  assert.ok(!queryPublicReceipts(store, {}).receipts.some(r => r.id === lotId), "opt-in OFF: absent from query");
  assert.ok(!collectPublicReceipts(store).some(r => r.id === lotId), "opt-in OFF: absent from collect");
  assert.ok(!listPublicReceiptSitemap(store, 100).some(e => e.path === `/receipts/${lotId}`), "opt-in OFF: absent from sitemap");
  assert.ok(queryPublicReceipts(store, {}).receipts.some(r => r.id === ORDINARY_ID), "ordinary receipt unchanged (opt-in OFF)");
});

test("specimen: pagination walks through a lot entry via its cursor", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  insertOrdinaryReceipt(db);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");
  setOptIn(db, 1);

  // Walk the whole list one entry at a time: every settled lot of the
  // bounty (funding, payout, ...) plus the ordinary receipt is reached
  // exactly once, and no page repeats an entry.
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = queryPublicReceipts(store, { limit: 1, cursor });
    assert.equal(page.error, undefined);
    assert.equal(page.receipts.length, 1);
    seen.push(page.receipts[0].id);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null, "the walk terminates");
  assert.equal(new Set(seen).size, seen.length, "no receipt is repeated across pages");
  assert.ok(seen.includes(lotId), "the payout lot is reached by pagination");
  assert.ok(seen.includes(ORDINARY_ID), "the ordinary receipt is reached by pagination");
  // A lot id is itself a valid cursor when it is visible.
  const afterLot = queryPublicReceipts(store, { limit: 10, cursor: lotId });
  assert.equal(afterLot.error, undefined);
  assert.ok(!afterLot.receipts.some(r => r.id === lotId), "the cursor lot is not repeated");
});
