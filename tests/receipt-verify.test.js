// Verify at read time (server/receipt-verify.mjs): a public receipt's
// stored values are re-checked when a stranger asks — the source record
// is re-derived and compared, a bounty lot's ledger entries are
// re-hashed and their chain links re-checked, a public-work artifact is
// re-hashed. Behavior protected:
//   - a clean record of every shape verifies, with the verdict word
//     matching what the server itself actually checked;
//   - a tampered stored row, journal entry, chain link, or artifact
//     degrades the verdict to no-longer-verifiable (the check itself reports contradicted);
//   - a check that cannot run (GitHub unreachable, stubbed down here)
//     is reported not-checked and the verdict drops to partially
//     verifiable — never silently covered, never failed;
//   - a source that no longer yields the receipt (backing record
//     pruned) reads as no-longer-verifiable, not a contradiction.
// Seams: the real BountyEscrow state machine drives the lot ledger and
// the real RoomStore + read model serve the room receipts.
//
// Run: node --test tests/receipt-verify.test.js
// (TMPDIR must be worktree-local, never the shared /tmp tmpfs.)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { publicReceiptById, projectPublicWorkReceipt } from "../server/receipts-live.mjs";
import { verifyPublicReceipt } from "../server/receipt-verify.mjs";

const NOW = 1_786_100_000_000;
const PR_URL = "https://github.com/Uuriko/project-room/pull/2099";
const check = (verification, id) => verification.checks.find(entry => entry.id === id);
const downFetch = async () => { throw new Error("network down"); };
const verify = async (store, id, fetchImpl = downFetch) =>
  verifyPublicReceipt(store, publicReceiptById(store, id), { fetchImpl, nowMs: NOW });

// --- bounty lot: the escrow ledger is the source ---------------------------

const ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
let nowMs = 1_786_000_000_000;

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT receipt_verify_test");
    try { const out = fn(); db.exec("RELEASE receipt_verify_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO receipt_verify_test"); db.exec("RELEASE receipt_verify_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  // The read path joins directory/unpublish/public-room tables; stub them.
  db.exec(`CREATE TABLE room_directory_settings (room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0, public_receipts INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE room_public_settings (room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE room_public_receipts_setting (room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
    CREATE TABLE public_unpublish (kind TEXT, target TEXT);
    CREATE TABLE public_rooms (slug TEXT PRIMARY KEY, title TEXT);`);
  return { escrow, db, store };
}

function settledLot() {
  const { escrow, db, store } = makeEscrow();
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "Write the migration guide",
    criteria: "C", amount: 10, deadline: new Date(nowMs + 3_600_000).toISOString(), approvalMode: "human" }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation:
    { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  nowMs += 3 * 24 * 3600 * 1000 + 1; // let the challenge window elapse
  escrow.finalizeBounty(ROOM, bounty.bountyId, {}); escrow.closeEpoch(ROOM, {});
  const lotId = db.prepare("SELECT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' ORDER BY seq LIMIT 1")
    .get(ROOM, bounty.bountyId).lot_id;
  // #3594: verification runs on the public shape, so the fixture records
  // the owner's public-receipts opt-in (the room_public_receipts_setting
  // mirror row) — without it the settled lot is private and unresolvable.
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 1)").run(ROOM);
  return { db, store, lotId };
}

test("lot: a clean settled lot re-validates its ledger chain", async () => {
  const { store, lotId } = settledLot();
  const receipt = publicReceiptById(store, lotId);
  assert.ok(receipt, "fixture lot resolves");
  const verification = await verifyPublicReceipt(store, receipt, { nowMs: NOW });
  assert.equal(verification.verdict, "room-recorded");
  assert.equal(verification.checkedAt, new Date(NOW).toISOString());
  assert.equal(check(verification, "journal").status, "pass");
  assert.ok(verification.scope.notChecked.some(line => /any good/.test(line)), "scope names what no check judges");
});

test("lot: a tampered journal entry flips the verdict to contradicted", async () => {
  const { db, store, lotId } = settledLot();
  const entry = db.prepare("SELECT entry_id FROM bounty_journal WHERE lot_id=? ORDER BY seq LIMIT 1").get(lotId);
  db.prepare("UPDATE bounty_journal SET amount = amount + 1000 WHERE entry_id=?").run(entry.entry_id);
  const verification = await verify(store, lotId);
  assert.equal(check(verification, "journal").status, "contradicted");
  assert.match(check(verification, "journal").detail, /altered after it was written/);
  assert.equal(verification.verdict, "no-longer-verifiable");
});

test("lot: a rewritten predecessor hash breaks the chain link check", async () => {
  const { db, store, lotId } = settledLot();
  const first = db.prepare("SELECT seq, account_id FROM bounty_journal WHERE lot_id=? ORDER BY seq LIMIT 1").get(lotId);
  const prev = db.prepare("SELECT entry_id FROM bounty_journal WHERE room_id=? AND account_id=? AND seq<? ORDER BY seq DESC LIMIT 1")
    .get(ROOM, first.account_id, first.seq);
  assert.ok(prev, "the lot's first entry has a chain predecessor in this fixture");
  db.prepare("UPDATE bounty_journal SET hash=? WHERE entry_id=?").run("f".repeat(64), prev.entry_id);
  const verification = await verify(store, lotId);
  assert.equal(check(verification, "journal").status, "contradicted");
  assert.match(check(verification, "journal").detail, /chain is broken/);
  assert.equal(verification.verdict, "no-longer-verifiable");
});

// --- work-claim receipt: the room record is the source ---------------------

function serveClaimRoom(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "receipt-verify-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  const key = store.issueAccessKey("alpha", "owner");
  const claim = { id: "alpha-claim", title: "Done work in alpha", state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: PR_URL, outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: ["sha256:" + "ab".repeat(32)], updatedAt: "2026-10-01T00:00:00.000Z" };
  store.workClaims.set("alpha", claim);
  store.command(key, "alpha", { id: "publish-alpha", type: "room.public_receipts_set", data: { enabled: true } });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const receiptId = store.db.prepare("SELECT id FROM public_receipts WHERE origin_room_id='alpha'").get().id;
  return { store, claim, receiptId };
}

test("work claim: a clean record re-validates; an unreachable GitHub leaves it partially verifiable", async t => {
  const { store, receiptId } = serveClaimRoom(t);
  const verification = await verify(store, receiptId);
  assert.equal(check(verification, "source-record").status, "pass");
  assert.equal(check(verification, "pull-request").status, "not-checked");
  assert.equal(verification.verdict, "partially-verifiable",
    "a check that could not run is never silently covered by the verdict");
  assert.deepEqual(verification.scope.checked, ["Source record"]);
  assert.ok(verification.scope.notChecked.includes("Pull request on GitHub"));
});

test("work claim: a tampered stored row contradicts its source", async t => {
  const { store, receiptId } = serveClaimRoom(t);
  store.db.prepare("UPDATE public_receipts SET title='Forged title' WHERE id=?").run(receiptId);
  const verification = await verify(store, receiptId);
  assert.equal(check(verification, "source-record").status, "contradicted");
  assert.match(check(verification, "source-record").detail, /title/);
  assert.equal(verification.verdict, "no-longer-verifiable");
});

// --- public-work receipt: stored delivery record + artifact ----------------

function servePublicWork(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "receipt-verify-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const artifactText = "the delivered teardown";
  const sha = createHash("sha256").update(artifactText, "utf8").digest("hex");
  const receiptId = `pwr_${"aa".repeat(32)}`;
  const body = { schema: "public-work-receipt/1", receiptId, namespaceId: `public_${"bb".repeat(16)}`,
    identityId: "ai_public", title: "Public task alpha", createdAt: "2026-10-01T00:00:00.000Z",
    artifact: { sha256: sha } };
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("offer-alpha", body.namespaceId, "alpha", 1,
      "https://github.com/Uuriko/project-room", "main", "[]", 1, Date.now());
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(receiptId, "offer-alpha", body.namespaceId, 1, "ai_public", artifactText, sha,
      Buffer.byteLength(artifactText), JSON.stringify(body), Date.now());
  projectPublicWorkReceipt(store, body, sha);
  return { store, receiptId };
}

test("public work: record + artifact re-validate; a forged artifact contradicts", async t => {
  const { store, receiptId } = servePublicWork(t);
  const clean = await verify(store, receiptId);
  assert.equal(check(clean, "source-record").status, "pass");
  assert.equal(check(clean, "artifact").status, "pass");
  assert.equal(clean.verdict, "room-recorded");

  store.db.prepare("UPDATE public_work_receipts SET artifact_text='forged after the fact' WHERE receipt_id=?").run(receiptId);
  const forged = await verify(store, receiptId);
  assert.equal(check(forged, "artifact").status, "contradicted");
  assert.equal(forged.verdict, "no-longer-verifiable");
});

test("public work: a pruned delivery record is no longer verifiable", async t => {
  const { store, receiptId } = servePublicWork(t);
  store.db.prepare("DELETE FROM public_work_receipts WHERE receipt_id=?").run(receiptId);
  const verification = await verify(store, receiptId);
  assert.equal(check(verification, "source-record").status, "missing");
  assert.equal(verification.verdict, "no-longer-verifiable");
});
