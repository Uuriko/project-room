// F4-Q1-T2 (CONSENT-COPY-CURE, PR #5026): the sitemap builder must carry
// every public receipt, as the decided consent copy states —
//   D3: "it is listed in the site's sitemap (`/sitemap.xml` carries every
//        public receipt),"
//   H2: "They are listed in the site's sitemap and can be indexed by
//        search engines."
// At base (e850efef) listPublicReceiptSitemap failed both legs:
//   (a) it clamped to the newest 1,000 stored receipts
//       (Math.min(limit, 1000); PR #4189, the vehicle named at #3710
//       decision time, was closed unmerged 2026-10-25), and
//   (b) it queried only public_receipts, so lot_ receipts — which have
//       no row there, the journal is their record — never appeared at
//       any volume.
// Lot inclusion mirrors the one visibility definition exactly
// (server/public-visibility.mjs lotReceiptVisible, as composed by
// publicLotReceiptById): a lot is listed iff its bounty is settled
// (a recorded settlement verdict exists) AND the lot is publicly
// visible — recorded opt-in on, directory toggle not off, not
// operator-unpublished. Hidden, opted-out, unsettled, and non-bounty
// lots are never listed.
//
// Run: node --test tests/sitemap-lot-clamp-cure.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import {
  PUBLIC_READ_MODEL_SCHEMA,
  listPublicReceiptSitemap,
} from "../server/public-read-model.mjs";
import { publicUnpublishSchema } from "../server/legal-store.mjs";
import { roomDirectorySchema } from "../server/room-directory.mjs";

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

// --- Lot harness: the real BountyEscrow state machine drives a real
// ledger, exactly as tests/lot-receipt-page.test.js seeds it. The read
// tables the visibility rule consults get their minimal real shapes.
function seedReadTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS room_directory_settings (
    room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0,
    public_receipts INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS public_unpublish (kind TEXT, target TEXT);
  CREATE TABLE IF NOT EXISTS room_public_receipts_setting (
    room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
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
    db.exec("SAVEPOINT sitemap_lot_test");
    try { const out = fn(); db.exec("RELEASE sitemap_lot_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO sitemap_lot_test"); db.exec("RELEASE sitemap_lot_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
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

// #3594: a settled lot is public only with the owner's recorded opt-in.
// This store carries no rooms relation, so lotReceiptVisible falls back
// to the mirror row syncRoomPublication writes — the same fallback the
// lot detail read uses on such a store.
const recordOptIn = db => db.prepare(
  "INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 1)").run(ROOM);

const sitemapPaths = store => listPublicReceiptSitemap(store).map(entry => entry.path);

test("sitemap carries a public (settled, opted-in) lot receipt", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  recordOptIn(db);
  const payoutLot = lotOfKind(db, bounty.bountyId, "payout");
  assert.match(payoutLot, /^lot_[a-f0-9]{16}$/);
  const paths = sitemapPaths(store);
  assert.ok(paths.includes(`/receipts/${payoutLot}`),
    `the settled payout lot is in the sitemap (got ${JSON.stringify(paths)})`);
  // Every lot of the settled bounty resolves as a receipt, so every
  // one of them is carried — not only the payout lot.
  const allLots = db.prepare(
    "SELECT DISTINCT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND lot_id IS NOT NULL")
    .all(ROOM, bounty.bountyId).map(row => row.lot_id);
  assert.ok(allLots.length >= 2, "the settled bounty has several lots");
  for (const lotId of allLots) {
    assert.ok(paths.includes(`/receipts/${lotId}`), `settled lot ${lotId} is in the sitemap`);
  }
});

test("sitemap never carries a hidden or opted-out lot receipt", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  const payoutLot = lotOfKind(db, bounty.bountyId, "payout");
  const path = `/receipts/${payoutLot}`;

  assert.ok(!sitemapPaths(store).includes(path),
    "never recorded an opt-in: the settled lot stays out of the sitemap");
  recordOptIn(db);
  assert.ok(sitemapPaths(store).includes(path), "recorded opt-in: the lot is listed");

  db.prepare("INSERT INTO room_directory_settings (room_id, discoverable, public_receipts) VALUES (?, 0, 0)")
    .run(ROOM);
  assert.ok(!sitemapPaths(store).includes(path),
    "directory toggle off (owner-hidden): the lot drops out of the sitemap");
  db.prepare("UPDATE room_directory_settings SET public_receipts=1 WHERE room_id=?").run(ROOM);
  assert.ok(sitemapPaths(store).includes(path), "toggle back on: the lot is listed again");

  db.prepare("INSERT INTO public_unpublish (kind, target) VALUES ('receipt', ?)").run(payoutLot);
  assert.ok(!sitemapPaths(store).includes(path),
    "operator-unpublished: the lot drops out of the sitemap");
  db.prepare("DELETE FROM public_unpublish").run();
  assert.ok(sitemapPaths(store).includes(path), "unpublish cleared: the lot is listed again");

  db.prepare("UPDATE room_public_receipts_setting SET enabled=0 WHERE room_id=?").run(ROOM);
  assert.ok(!sitemapPaths(store).includes(path),
    "recorded opt-out: the lot drops out of the sitemap");
});

test("sitemap carries no unsettled or non-bounty lot", () => {
  const { escrow, db, store } = makeEscrow();
  recordOptIn(db);
  const open = post(escrow);
  escrow.fundBounty(ROOM, open.bountyId, { funder: JILL });
  const fundLot = lotOfKind(db, open.bountyId, "escrow-lock");
  assert.match(fundLot, /^lot_[a-f0-9]{16}$/);
  assert.ok(!sitemapPaths(store).includes(`/receipts/${fundLot}`),
    "a funded but unsettled bounty has no public lot receipt to list");

  escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 1 });
  const transferLot = db.prepare(
    "SELECT lot_id FROM bounty_journal WHERE room_id=? AND kind='transfer' LIMIT 1").get(ROOM)?.lot_id;
  assert.match(transferLot, /^lot_[a-f0-9]{16}$/);
  assert.ok(!sitemapPaths(store).includes(`/receipts/${transferLot}`),
    "a plain transfer lot is not a bounty receipt and is never listed");
});

// --- Clamp harness: a bare read-model store with only stored receipts.
function makeStoredDb(count) {
  const db = new DatabaseSync(":memory:");
  db.exec(PUBLIC_READ_MODEL_SCHEMA);
  db.exec(publicUnpublishSchema);
  db.exec(roomDirectorySchema);
  const insert = db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  db.exec("BEGIN");
  for (let i = 0; i < count; i += 1) {
    const id = `wcr_${i.toString(16).padStart(32, "0")}`;
    insert.run(id, `Receipt ${i}`, "work-claim", "room-open", "room-open", null,
      "[]", "[]", null, null, null, "[]",
      new Date(base + i * 60_000).toISOString(), "https://room.trydemigod.com/?start=room");
  }
  db.exec("COMMIT");
  return db;
}

test("sitemap carries more than 1,000 public receipts — no silent clamp", () => {
  const store = { db: makeStoredDb(1005) };
  const bare = listPublicReceiptSitemap(store);
  assert.equal(bare.length, 1005,
    "the bare call the /sitemap.xml handler makes carries every public receipt");
  assert.equal(bare[0].path, `/receipts/wcr_${(1004).toString(16).padStart(32, "0")}`,
    "newest first, as before");
  assert.equal(listPublicReceiptSitemap(store, 1005).length, 1005,
    "an explicit limit above 1,000 is honoured exactly, not clamped");
  assert.equal(listPublicReceiptSitemap(store, 3).length, 3,
    "an explicit small limit is still honoured");
});
