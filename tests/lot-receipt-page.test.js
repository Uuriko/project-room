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
import { publicReceiptById } from "../server/receipts-live.mjs";
import { renderReceiptDetailHtml, receiptJson } from "../server/receipts-page.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane
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
    pull_request TEXT, merged_at TEXT, hashes_json TEXT NOT NULL,
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
  return { origin: `http://127.0.0.1:${server.address().port}`, lotId: rejected.receipt.lotId };
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
