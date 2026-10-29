// Public receipt gallery with clone-as-template (#3526).
//
// A public gallery of completed bounties built on the existing public
// lot receipts: finished work displayed as worked examples, each one
// clonable as a template for posting a similar bounty.
//
// Behavior protected:
//   - the gallery lists a settled bounty only when the worker was paid
//     (settlement workerMillis > 0): failed / unverified settlements and
//     unsettled bounties never appear;
//   - one entry per bounty, keyed by its payout (or split-approve) lot
//     receipt, showing the delivered-work summary (the bounty's criteria),
//     the pinned rubric, and the settled amount;
//   - visibility is the lot rule of the one visibility definition,
//     applied through the same read-time composition as the lot detail
//     page: no recorded opt-in, a recorded opt-out, and the owner's
//     directory public-receipts toggle off all remove the entry;
//   - the clone template carries only what the gallery itself publishes
//     (title + rubric shape) — never poster/worker lanes, amounts, or
//     room content beyond the public entry;
//   - the stored-receipts listing at /receipts is unchanged: lots stay
//     out of it (pinned by tests/lot-receipt-page.test.js); the gallery
//     is its own surface at /receipts/gallery (+ JSON twin).
//
// Seams: the real BountyEscrow state machine drives a real ledger (unit
// part), and the real HTTP server + RoomStore serve the pages (route
// part, with one paid bounty seeded into the ledger because the HTTP
// seam's escrow runs on the wall clock and cannot wait out a challenge
// window). No mocks of the code under test.
//
// Run: node --test tests/receipt-gallery.test.js
// (TMPDIR must be worktree-local, never the shared /tmp tmpfs.)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { createReceiptSigner, generateReceiptKeyPair } from "../server/bounty-receipts.mjs";
import { queryPublicBountyGallery, publicBountyTemplate } from "../server/receipts-live.mjs";
import { renderBountyGalleryHtml, renderBountyCloneHtml, bountyGalleryJson, bountyTemplateJson } from "../server/receipts-page.mjs";
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

const RUBRIC = [
  { criterionId: "accuracy", description: "Claims match the source." },
  { criterionId: "clarity", description: "A new engineer can follow it." },
];
const attest = () => ({ at: new Date(nowMs).toISOString(), note: "lgtm",
  citations: RUBRIC.map(c => ({ criterionId: c.criterionId, verdict: "pass" })) });

// The read path joins tables outside the escrow schema (directory
// settings, unpublish, public rooms). Give the fake store the minimal
// real shapes those queries run against — same seed as the lot tests.
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
    db.exec("SAVEPOINT gallery_test");
    try { const out = fn(); db.exec("RELEASE gallery_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO gallery_test"); db.exec("RELEASE gallery_test"); throw error; }
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
  { poster: JILL, title: "Write the migration guide",
    criteria: "Write the migration guide a new engineer can follow.",
    amount: 10, deadline: isoFuture(3_600_000), approvalMode: "human",
    rubric: RUBRIC, ...overrides }).bounty;

function runToPaid(escrow, overrides = {}) {
  const bounty = post(escrow, overrides);
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

// The recorded opt-in the lot rule requires (#3594): the mirror row
// syncRoomPublication writes when the owner records the setting on.
const recordOptIn = db => db.prepare(
  "INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 1)").run(ROOM);

test("the gallery lists a paid bounty with summary, rubric, and settled amount", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  recordOptIn(db);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");

  const page = queryPublicBountyGallery(store, {});
  assert.equal(page.nextCursor, null);
  assert.equal(page.entries.length, 1);
  const entry = page.entries[0];
  assert.equal(entry.id, lotId);
  assert.equal(entry.title, "Write the migration guide");
  assert.equal(entry.summary, "Write the migration guide a new engineer can follow.");
  assert.deepEqual(entry.rubric.criteria, RUBRIC);
  assert.equal(entry.rubric.version, 1);
  assert.match(entry.rubric.hash, /^[a-f0-9]{64}$/);
  // 10 credits accepted; the sweep pays 99% to the worker.
  assert.equal(entry.settled.kind, "verified-complete");
  assert.equal(entry.settled.amountCredits, 9.9);
  assert.equal(entry.awardCredits, 10);
  assert.equal(entry.receiptHref, `/receipts/${lotId}`);
  assert.equal(entry.cloneHref, `/receipts/${lotId}/clone`);
  // The entry is a public face: no lanes, no journal internals.
  assert.equal("poster" in entry, false);
  assert.equal("worker" in entry, false);
  assert.equal("movements" in entry, false);

  const json = bountyGalleryJson(page);
  assert.equal(json.schema, "project-room-public-bounty-gallery/1");
  assert.equal(json.entries[0].id, lotId);
  assert.equal(json.entries[0].settled.amountCredits, 9.9);

  const html = renderBountyGalleryHtml(page);
  assert.match(html, /Write the migration guide/);
  assert.match(html, /new engineer can follow it/);
  assert.match(html, /Claims match the source/);
  assert.match(html, /9\.9 credits/);
  assert.match(html, new RegExp(`/receipts/${lotId}/clone`));
});

test("clone-as-template pre-fills title and rubric shape, and nothing private", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  recordOptIn(db);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");

  const template = publicBountyTemplate(store, lotId);
  assert.ok(template);
  assert.equal(template.schema, "project-room-bounty-template/1");
  assert.equal(template.sourceReceiptId, lotId);
  assert.equal(template.title, "Write the migration guide");
  assert.deepEqual(template.rubric, RUBRIC);
  assert.match(template.criteria, /accuracy: Claims match the source\./);
  assert.match(template.criteria, /clarity: A new engineer can follow it\./);
  // Never copies private room content: no lanes, no amounts, no journal.
  const served = JSON.stringify(bountyTemplateJson(template));
  assert.doesNotMatch(served, /grokbot|id:agent/);
  assert.doesNotMatch(served, /9\.9|amountCredits|award/);

  const html = renderBountyCloneHtml(template);
  assert.match(html, /Clone as template/);
  assert.match(html, /Write the migration guide/);
  assert.match(html, /Claims match the source/);
  assert.doesNotMatch(html, /grokbot/);
});

test("the lot opt-in rule gates the gallery and the clone, in both directions", () => {
  const { escrow, db, store } = makeEscrow();
  const bounty = runToPaid(escrow);
  const lotId = lotOfKind(db, bounty.bountyId, "payout");

  // Never recorded: private, like every other lot surface (#3594).
  assert.deepEqual(queryPublicBountyGallery(store, {}).entries, []);
  assert.equal(publicBountyTemplate(store, lotId), null);

  recordOptIn(db);
  assert.equal(queryPublicBountyGallery(store, {}).entries.length, 1);
  assert.ok(publicBountyTemplate(store, lotId));

  // Opt-out removes the entry.
  db.prepare("UPDATE room_public_receipts_setting SET enabled=0 WHERE room_id=?").run(ROOM);
  assert.deepEqual(queryPublicBountyGallery(store, {}).entries, []);
  assert.equal(publicBountyTemplate(store, lotId), null);

  // Recorded back on, then hidden by the directory receipts toggle.
  db.prepare("UPDATE room_public_receipts_setting SET enabled=1 WHERE room_id=?").run(ROOM);
  assert.equal(queryPublicBountyGallery(store, {}).entries.length, 1);
  db.prepare("INSERT INTO room_directory_settings (room_id, discoverable, public_receipts) VALUES (?, 0, 0)").run(ROOM);
  assert.deepEqual(queryPublicBountyGallery(store, {}).entries, []);
  assert.equal(publicBountyTemplate(store, lotId), null);
});

test("failed and unsettled bounties never reach the gallery", () => {
  const { escrow, db, store } = makeEscrow();
  recordOptIn(db);
  // Unsettled: posted and funded only.
  const open = post(escrow, { title: "Still open bounty" });
  escrow.fundBounty(ROOM, open.bountyId, { funder: JILL });
  // Failed: submitted work rejected, worker settles at zero.
  const failed = post(escrow, { title: "Rejected bounty" });
  escrow.fundBounty(ROOM, failed.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, failed.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, failed.bountyId, { claimant: GROK, evidence });
  escrow.rejectWork(ROOM, failed.bountyId, { rejector: JILL, reason: "Not the guide." });

  assert.deepEqual(queryPublicBountyGallery(store, {}).entries, []);
  const failedLot = lotOfKind(db, failed.bountyId, "refund");
  assert.equal(publicBountyTemplate(store, failedLot), null);
});

test("the gallery paginates by cursor and validates its limit", () => {
  const { escrow, db, store } = makeEscrow();
  recordOptIn(db);
  runToPaid(escrow, { title: "First paid bounty" });
  tick(60_000);
  runToPaid(escrow, { title: "Second paid bounty" });

  const first = queryPublicBountyGallery(store, { limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].title, "Second paid bounty");
  assert.ok(first.nextCursor);
  const second = queryPublicBountyGallery(store, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].title, "First paid bounty");
  assert.equal(second.nextCursor, null);

  const bad = queryPublicBountyGallery(store, { limit: 0 });
  assert.equal(bad.error.status, 422);
  const badCursor = queryPublicBountyGallery(store, { cursor: "lot_0000000000000000" });
  assert.equal(badCursor.error.status, 422);
});

// --- HTTP seam: the real server serves the gallery and the clone ---------

const PAID_LOT = "lot_0123456789abcdef";
const PAID_BOUNTY = "bty_gallery_paid";

function seedPaidBounty(store) {
  const db = store.db;
  const settlement = { kind: "verified-complete", workerMillis: 9900, workerCredits: 9.9,
    refundMillis: 0, refundCredits: 0, reason: "accepted",
    settledAt: "2026-10-20T00:00:00.000Z", settledBy: { kind: "rule", id: "escrow-keeper" } };
  db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, claimant, state,
     state_changed_ms, deadline_ms, rubric_json, rubric_hash, rubric_version,
     resolution_json, created_at, updated_at)
    VALUES (?, 'commons', 'Seeded paid bounty', 'Seeded criteria a finisher can check.',
     10000, 'owner', 'ada', 'paid', 0, 0, ?, ?, 1, ?, '2026-10-19T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`)
    .run(PAID_BOUNTY,
      JSON.stringify([{ criterionId: "c1", description: "Seeded criteria a finisher can check." }]),
      "a".repeat(64), JSON.stringify({ settlement }));
  const hash = "b".repeat(64);
  const move = db.prepare(`INSERT INTO bounty_journal
    (entry_id, room_id, account_id, at, kind, bounty_id, lot_id, amount, lot_state, hash, prev_hash,
     memo, actor_kind, actor_id, receipt_id)
    VALUES (?, 'commons', 'ada', '2026-10-20T00:00:00.000Z', 'payout', ?, ?, ?, ?, ?, ?, NULL, 'rule', 'escrow-keeper', NULL)`);
  move.run("entry_gallery_1", PAID_BOUNTY, PAID_LOT, -9900, "approved", hash, hash);
  move.run("entry_gallery_2", PAID_BOUNTY, PAID_LOT, 9900, "payable", hash, hash);
}

async function serveGalleryRoom(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-gallery-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added",
    data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  const escrow = store.bountyEscrow;
  escrow.ensureGenesis("commons");
  // A real settled-but-failed bounty through the escrow's own writers:
  // settled, but the worker was paid nothing, so it is not a gallery entry.
  const bounty = escrow.postBounty("commons", { poster: "owner",
    title: "Fix the flaky export", criteria: "Export passes 100 runs in a row.",
    amount: 10, deadline: new Date(Date.now() + 86_400_000).toISOString() }).bounty;
  escrow.fundBounty("commons", bounty.bountyId, { funder: "owner" });
  escrow.claimBounty("commons", bounty.bountyId, { claimant: "ada" });
  escrow.submitWork("commons", bounty.bountyId, { claimant: "ada", evidence });
  escrow.rejectWork("commons", bounty.bountyId,
    { rejector: "owner", reason: "Export still flakes on run 41." });
  seedPaidBounty(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, ownerKey };
}

test("GET /receipts/gallery serves only completed, opted-in bounties; the clone pre-fills from the entry", async t => {
  const { origin, store, ownerKey } = await serveGalleryRoom(t);

  // No recorded opt-in yet: the gallery is empty and the clone 404s.
  const before = await fetch(`${origin}/receipts/gallery`);
  assert.equal(before.status, 200);
  assert.doesNotMatch(await before.text(), /Seeded paid bounty/);
  assert.equal((await fetch(`${origin}/receipts/${PAID_LOT}/clone`)).status, 404);

  store.command(ownerKey, "commons",
    { id: "pub-on", type: "room.public_receipts_set", data: { enabled: true } });

  const page = await fetch(`${origin}/receipts/gallery`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Seeded paid bounty/);
  assert.match(html, /Seeded criteria a finisher can check\./);
  assert.match(html, /9\.9 credits/);
  assert.match(html, new RegExp(`/receipts/${PAID_LOT}/clone`));
  // The failed bounty settled at zero for the worker: not a worked example.
  assert.doesNotMatch(html, /Fix the flaky export/);

  const jsonRes = await fetch(`${origin}/api/public/receipts/gallery`);
  assert.equal(jsonRes.status, 200);
  const body = JSON.parse(await jsonRes.text());
  assert.equal(body.schema, "project-room-public-bounty-gallery/1");
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].id, PAID_LOT);
  assert.equal(body.entries[0].settled.amountCredits, 9.9);
  assert.deepEqual(body.entries[0].rubric.criteria,
    [{ criterionId: "c1", description: "Seeded criteria a finisher can check." }]);

  const clone = await fetch(`${origin}/receipts/${PAID_LOT}/clone`);
  assert.equal(clone.status, 200);
  const cloneHtml = await clone.text();
  assert.match(cloneHtml, /Seeded paid bounty/);
  assert.match(cloneHtml, /Seeded criteria a finisher can check\./);

  const cloneJsonRes = await fetch(`${origin}/receipts/${PAID_LOT}/clone.json`);
  assert.equal(cloneJsonRes.status, 200);
  const cloneJson = JSON.parse(await cloneJsonRes.text());
  assert.equal(cloneJson.schema, "project-room-bounty-template/1");
  assert.equal(cloneJson.title, "Seeded paid bounty");
  assert.deepEqual(cloneJson.rubric,
    [{ criterionId: "c1", description: "Seeded criteria a finisher can check." }]);

  // Opt-out removes the entry and the clone.
  store.command(ownerKey, "commons",
    { id: "pub-off", type: "room.public_receipts_set", data: { enabled: false } });
  const after = await fetch(`${origin}/receipts/gallery`);
  assert.doesNotMatch(await after.text(), /Seeded paid bounty/);
  assert.equal((await fetch(`${origin}/receipts/${PAID_LOT}/clone`)).status, 404);
  assert.equal((await fetch(`${origin}/receipts/${PAID_LOT}/clone.json`)).status, 404);
});
