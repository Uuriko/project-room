// Bounty lot receipts, post-acceptance: a bounty that has been ACCEPTED
// (settlement not yet recorded — the challenge window is still open) has a
// public lot receipt when the room's public-receipts opt-in is recorded ON.
//
// Before this fix, publicLotReceiptById returned null for every lot whose
// bounty carried no recorded settlement, so the exact state a live demo
// reaches — post -> fund -> claim -> submit -> accept, then open the
// receipt link — 404'd on every public face even with the opt-in ON
// (verify-public.md §8 on the composition tree; gaps-prod.md §7 in
// production). Settlement is stamped only after the challenge window
// (72 h), so acceptance alone never produced a public receipt.
//
// Behavior protected:
//   - post-acceptance lots resolve with the opt-in ON, with
//     lot.settlement === null and a truthful lot.pending block
//     ({ state, challengeEnds, disputeId }) — the page says the challenge
//     window is open and the outcome is NOT settled/final;
//   - a dispute opened during the window flips pending.state to
//     "disputed" and the page says the outcome is not final;
//   - pre-acceptance lots (funded, submitted) still 404;
//   - the opt-in OFF / never-recorded negative control is unchanged:
//     post-acceptance lots stay 404 on every face;
//   - settled lots are unchanged: settlement block present, pending null;
//   - lots stay detail-only: nothing leaks into the public listing.
//
// Seams: the real BountyEscrow state machine drives a real ledger (unit
// part), and the real HTTP server + RoomStore serve the pages (route
// part). No mocks of the code under test.
//
// Run: node --test tests/lot-receipt-pending.test.js
// (TMPDIR must be worktree-local, never the shared /tmp tmpfs.)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { publicReceiptById } from "../server/receipts-live.mjs";
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
// real shapes those queries run against. (Same seam as
// tests/lot-receipt-page.test.js.)
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
    db.exec("SAVEPOINT lot_receipt_pending_test");
    try { const out = fn(); db.exec("RELEASE lot_receipt_pending_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO lot_receipt_pending_test"); db.exec("RELEASE lot_receipt_pending_test"); throw error; }
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

function runToAccepted(escrow, overrides = {}) {
  const bounty = post(escrow, overrides);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: attest() });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

function runToPaid(escrow) {
  const bounty = runToAccepted(escrow);
  tick(CHALLENGE_WINDOW_MS + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ROOM, {});
  return escrow.getBounty(ROOM, bounty.bountyId);
}

const lotOfKind = (db, bountyId, kind) => db.prepare(
  "SELECT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind=? ORDER BY seq LIMIT 1")
  .get(ROOM, bountyId, kind)?.lot_id;

// #3594: a lot is public only with the owner's recorded opt-in; this writes
// the mirror row syncRoomPublication writes for a recorded ON. (The real
// recorded read path is exercised end-to-end by the HTTP tests below.)
const recordOptIn = db => db.prepare(
  "INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 1)").run(ROOM);

test("post-acceptance lots resolve with the opt-in on, labelled pending — not settled", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToAccepted(escrow);
  recordOptIn(db);
  assert.equal(bounty.state, "accepted");
  assert.equal(bounty.resolution?.settlement ?? null, null,
    "acceptance records no settlement — the challenge window runs first");
  assert.ok(bounty.challengeEnds, "the accepted bounty carries a challenge end");

  for (const kind of ["escrow-lock", "bond-lock", "attribute"]) {
    const lotId = lotOfKind(db, bounty.bountyId, kind);
    assert.match(lotId, /^lot_[a-f0-9]{16}$/);
    const receipt = publicReceiptById(store, lotId);
    assert.ok(receipt, `the post-acceptance ${kind} lot must resolve with the opt-in on`);
    assert.equal(receipt.source, "bounty-lot");
    assert.equal(receipt.lot.bountyState, "accepted");
    assert.equal(receipt.lot.settlement, null,
      "no settlement has been recorded, so none may be shown");
    assert.equal(receipt.lot.pending.state, "accepted");
    assert.equal(receipt.lot.pending.challengeEnds, bounty.challengeEnds,
      "the pending block names the real challenge-window end");
    assert.equal(receipt.lot.pending.disputeId, null);
  }

  const attribute = publicReceiptById(store, lotOfKind(db, bounty.bountyId, "attribute"));
  const html = renderReceiptDetailHtml(attribute);
  assert.match(html, /challenge window open until/);
  assert.match(html, /Not settled yet/);
  assert.match(html, /no payment has been recorded/);
  assert.doesNotMatch(html, /settlement verdict shown/,
    "the honesty note must not claim a settlement verdict exists");
  assert.doesNotMatch(html, /<dt>Settlement<\/dt>/,
    "no settlement row may render for an unsettled outcome");

  const json = receiptJson(attribute);
  assert.equal(json.lot.settlement, null);
  assert.equal(json.lot.pending.state, "accepted");
  assert.equal(json.lot.pending.challengeEnds, bounty.challengeEnds);
});

test("a dispute opened in the window keeps the lot public but labelled not final", () => {
  const { escrow, db, store } = makeEscrow();
  const accepted = runToAccepted(escrow, { verifierId: INSTINCT });
  escrow.disputeBounty(ROOM, accepted.bountyId,
    { challenger: CODEX, bond: 2.5, grounds: "partial credit" });
  const bounty = escrow.getBounty(ROOM, accepted.bountyId);
  recordOptIn(db);
  assert.equal(bounty.state, "disputed");
  assert.equal(bounty.resolution?.settlement ?? null, null);

  const lotId = lotOfKind(db, bounty.bountyId, "attribute");
  const receipt = publicReceiptById(store, lotId);
  assert.ok(receipt, "the disputed post-acceptance lot must still resolve with the opt-in on");
  assert.equal(receipt.lot.settlement, null);
  assert.equal(receipt.lot.pending.state, "disputed");
  assert.ok(receipt.lot.pending.disputeId, "the pending block names the open dispute");

  const html = renderReceiptDetailHtml(receipt);
  assert.match(html, /Accepted, then disputed/);
  assert.match(html, /not final/);
  assert.doesNotMatch(html, /settlement verdict shown/);
});

test("negative control: post-acceptance lots stay private without a recorded opt-in on", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToAccepted(escrow);
  const lotId = lotOfKind(db, bounty.bountyId, "attribute");
  assert.equal(publicReceiptById(store, lotId), null,
    "never recorded: the post-acceptance lot stays private — no record is not an opt-in");
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 0)").run(ROOM);
  assert.equal(publicReceiptById(store, lotId), null,
    "recorded off: the post-acceptance lot stays private");
  db.prepare("UPDATE room_public_receipts_setting SET enabled=1 WHERE room_id=?").run(ROOM);
  assert.ok(publicReceiptById(store, lotId),
    "recorded on: the same lot serves — the gate is the opt-in, not the state");
});

test("pre-acceptance lots still 404 even with the opt-in on", () => {
  const { escrow, db, store } = makeEscrow();
  recordOptIn(db);
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  for (const kind of ["escrow-lock", "bond-lock"]) {
    assert.equal(publicReceiptById(store, lotOfKind(db, bounty.bountyId, kind)), null,
      `a submitted bounty's ${kind} lot is not a public receipt — acceptance is the trigger`);
  }
});

test("settled lots are unchanged: settlement present, pending null", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  recordOptIn(db);
  assert.equal(bounty.state, "paid");
  const receipt = publicReceiptById(store, lotOfKind(db, bounty.bountyId, "payout"));
  assert.ok(receipt, "the settled payout lot must resolve as before");
  assert.equal(receipt.lot.settlement.kind, "verified-complete");
  assert.equal(receipt.lot.pending, null);
  const html = renderReceiptDetailHtml(receipt);
  assert.match(html, /verified-complete/);
  assert.doesNotMatch(html, /Not settled yet/);
});

// --- HTTP seam: the real server serves the post-acceptance lot page --------

async function serveAcceptedRoom(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-lot-pending-"));
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
  escrow.submitWork("commons", bounty.bountyId, { claimant: "ada",
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  const accepted = escrow.acceptWork("commons", bounty.bountyId, { acceptor: "owner",
    verifierAttestation: { at: new Date().toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, lotId: accepted.receipt.lotId,
    bounty: escrow.getBounty("commons", bounty.bountyId), store, ownerKey };
}

test("GET /receipts/<lotId> serves the post-acceptance lot on every face with the opt-in on", async t => {
  const { origin, lotId, bounty, store, ownerKey } = await serveAcceptedRoom(t);
  assert.match(lotId, /^lot_[a-f0-9]{16}$/);
  assert.equal(bounty.state, "accepted");
  store.command(ownerKey, "commons",
    { id: "pub-on", type: "room.public_receipts_set", data: { enabled: true } });

  const page = await fetch(`${origin}/receipts/${lotId}`);
  assert.equal(page.status, 200, "the accepted lot page serves — the demo's proof beat");
  const html = await page.text();
  assert.match(html, /Fix the flaky export/);
  assert.match(html, /challenge window open until/);
  assert.match(html, /Not settled yet/);

  const jsonRes = await fetch(`${origin}/receipts/${lotId}.json`);
  assert.equal(jsonRes.status, 200);
  const body = JSON.parse(await jsonRes.text());
  assert.equal(body.source, "bounty-lot");
  assert.equal(body.lot.bountyState, "accepted");
  assert.equal(body.lot.settlement, null);
  assert.equal(body.lot.pending.state, "accepted");
  assert.equal(body.lot.pending.challengeEnds, bounty.challengeEnds);

  assert.equal((await fetch(`${origin}/room/receipts/${lotId}`)).status, 200, "alias serves");
  assert.equal((await fetch(`${origin}/receipts/${lotId}/og.png`)).status, 200, "share card serves");
  assert.equal((await fetch(`${origin}/receipts/${lotId}/badge.svg`)).status, 200, "badge serves");

  // Lots stay detail-only: the outcome is reachable by its link, never
  // leaked into the public listing.
  const list = await fetch(`${origin}/receipts`);
  assert.equal(list.status, 200);
  assert.doesNotMatch(await list.text(), /Fix the flaky export/);
});

test("the recorded opt-in gates the post-acceptance lot page on every face", async t => {
  const { origin, lotId, store, ownerKey } = await serveAcceptedRoom(t);
  const record = (id, enabled) => store.command(ownerKey, "commons",
    { id, type: "room.public_receipts_set", data: { enabled } });
  const faces = [`/receipts/${lotId}`, `/receipts/${lotId}.json`, `/room/receipts/${lotId}`,
    `/receipts/${lotId}/og.png`, `/receipts/${lotId}/badge.svg`];
  for (const face of faces)
    assert.equal((await fetch(`${origin}${face}`)).status, 404,
      `never recorded: ${face} is a 404, not a public receipt`);
  record("pub-on", true);
  for (const face of faces)
    assert.equal((await fetch(`${origin}${face}`)).status, 200, `recorded on: ${face} serves`);
  record("pub-off", false);
  for (const face of faces)
    assert.equal((await fetch(`${origin}${face}`)).status, 404,
      `recorded off: ${face} hides like every other shape`);
});
