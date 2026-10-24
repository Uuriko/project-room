// Machine-checkable proof on the public receipt JSON (U-08 proposals 2+3):
//   - every public receipt JSON — row-composed (detail + list) and
//     lot-composed — carries `verification: { state }` with a state from
//     the one canonical tier enum, always present, always an object, so a
//     consumer can tell "recorded, nothing stronger" from "field missing";
//   - a `?verify=1` read returns the read-time re-derivation as data
//     (verdict, checkedAt, per-check results) in the SAME verification
//     object, next to the tier state — the fresh verdict never evicts the
//     recorded tier, and the served verdict matches an independent
//     re-derivation of the same record field by field;
//   - the proof-level words the page and badge speak (proofLevelOf) are
//     unchanged: the enum is a serialization of what the code already
//     decides, not a new semantics.
// Seams: real RoomStore + read model + HTTP (GitHub is the injected
// fetchPullRequest stub); the lot fixture drives the real BountyEscrow
// state machine on an in-memory store, as receipt-verify.test.js does.
// Run: node --test tests/receipt-proof-json.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { collectPublicReceipts, projectPublicWorkReceipt, publicReceiptById } from "../server/receipts-live.mjs";
import { RECEIPT_TIER_STATES, proofLevelOf } from "../server/public-read-model.mjs";
import { verifyPublicReceipt } from "../server/receipt-verify.mjs";
import { receiptJson } from "../server/receipts-page.mjs";

const PR_URL = "https://github.com/Uuriko/project-room/pull/2099";
const github = body => async () => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
const mergedFetch = github({ state: "closed", merged: true,
  merged_at: "2026-10-01T00:00:00.000Z", merge_commit_sha: "a".repeat(40) });
const HASH = `sha256:${"ab".repeat(32)}`;
const PWR = `pwr_${"cd".repeat(32)}`;
const WIR = `wir_${"ef".repeat(16)}`;

const EXPECTED_TIER = {
  "Ship the door": "server_verified_merge",
  "Reviewed result": "verified",
  "Solo result": "self_attested",
  "Weekly changelog drafted": "recorded",
  "Public task": "hash_only",
};

async function serve(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "receipt-proof-json-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-ada", type: "member.added",
    data: { memberId: "ada", displayName: "Ada", kind: "agent", permissions: ["accept_work"] } });
  store.workClaims.set("commons", {
    id: "claim-merged", title: "Ship the door", state: "done", owner: "ada",
    history: [{ action: "pr_merged", agentId: "owner", actor: "ada", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: PR_URL, outcome: "merged", syncedAt: "2026-10-01T12:00:00.000Z" },
    blobs: [HASH], updatedAt: "2026-10-01T12:00:00.000Z",
  });
  store.workClaims.set("commons", {
    id: "claim-verified", title: "Reviewed result", state: "done", owner: "ada",
    verification: { state: "verified", by: "owner", at: "2026-10-02T00:00:00.000Z" },
    history: [{ action: "state:done", agentId: "ada", actor: "ada", at: "2026-10-02T00:00:00.000Z" }],
    updatedAt: "2026-10-02T00:00:00.000Z",
  });
  store.workClaims.set("commons", {
    id: "claim-self", title: "Solo result", state: "done", owner: "ada",
    history: [{ action: "state:done", agentId: "ada", actor: "ada", at: "2026-10-03T00:00:00.000Z" }],
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
  const publicWork = { schema: "public-work-receipt/1", receiptId: PWR, namespaceId: "commons",
    identityId: "ai_public", title: "Public task", createdAt: "2026-10-01T00:00:00.000Z",
    artifact: { sha256: "cd".repeat(32) } };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    PWR, "offer-1", "commons", 1, "ai_public", "note", "cd".repeat(32), 4, JSON.stringify(publicWork), Date.now());
  projectPublicWorkReceipt(store, publicWork, "cd".repeat(32));
  store.command(ownerKey, "commons", { id: "publish", type: "room.public_receipts_set", data: { enabled: true } });
  // A work-item row, seeded the way proof-page.test.js seeds its rows: the
  // read model composes it through the same rowToPublic path as projected rows.
  store.db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    WIR, "Weekly changelog drafted", "work-item", "commons", "commons", "Commons",
    JSON.stringify(["ada"]), JSON.stringify([]), null, null, JSON.stringify([]),
    "2026-10-04T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  const server = createRoomServer({ store, fetchPullRequest: mergedFetch, githubToken: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true }); });
  const byTitle = Object.fromEntries(collectPublicReceipts(store).map(item => [item.title, item]));
  return { origin: `http://127.0.0.1:${server.address().port}`, store, byTitle };
}

const getJson = async (origin, path) => {
  const res = await fetch(`${origin}${path}`);
  assert.equal(res.status, 200, `${path} serves`);
  return res.json();
};

test("every receipt JSON carries the tier field, always an object, from the one enum", async t => {
  const { origin, byTitle } = await serve(t);
  for (const [title, tier] of Object.entries(EXPECTED_TIER)) {
    const receipt = byTitle[title];
    assert.ok(receipt, `fixture receipt ${title} projected`);
    const json = await getJson(origin, `/receipts/${receipt.id}.json`);
    assert.equal(typeof json.verification, "object", `${title}: verification is an object, never a bare string or absent`);
    assert.equal(json.verification.state, tier, `${title}: tier state`);
    assert.ok(RECEIPT_TIER_STATES.includes(json.verification.state), `${title}: state is in the canonical enum`);
    assert.equal(json.verification.checkedAt, undefined, `${title}: no verify run, no checkedAt`);
    assert.equal(json.verification.verdict, undefined, `${title}: no verify run, no verdict`);
  }
  const list = await getJson(origin, "/api/public/receipts?limit=50");
  assert.ok(list.receipts.length >= 5, "the list serves the fixture receipts");
  for (const item of list.receipts) {
    assert.equal(typeof item.verification, "object", `list ${item.id}: verification present`);
    assert.ok(RECEIPT_TIER_STATES.includes(item.verification.state), `list ${item.id}: state in enum`);
  }
  const byListTitle = Object.fromEntries(list.receipts.map(item => [item.title, item]));
  for (const [title, tier] of Object.entries(EXPECTED_TIER)) {
    assert.equal(byListTitle[title]?.verification.state, tier, `list ${title}: tier state`);
  }
});

test("?verify=1 returns the re-derivation as data next to the tier, matching an independent re-derivation", async t => {
  const { origin, store, byTitle } = await serve(t);
  const receipt = byTitle["Ship the door"];
  const json = await getJson(origin, `/receipts/${receipt.id}.json?verify=1`);
  assert.equal(json.verification.state, "server_verified_merge", "the recorded tier survives the verify run");
  assert.equal(json.verification.schema, "project-room-receipt-verification/1");
  assert.equal(json.verification.verdict, "server-verified");
  assert.ok(json.verification.checkedAt, "checkedAt is data, not prose");
  assert.ok(Array.isArray(json.verification.checks), "per-check results are data");
  // Independent re-derivation of the same record, compared field by field
  // (checkedAt is the run's own stamp and is the one field allowed to differ).
  const independent = await verifyPublicReceipt(store, publicReceiptById(store, receipt.id),
    { fetchImpl: mergedFetch, nowMs: Date.parse(json.verification.checkedAt) });
  const { checkedAt: _servedStamp, ...servedRun } = json.verification;
  const { state: _tier, ...rest } = servedRun;
  assert.deepEqual(rest, {
    schema: independent.schema, receiptId: independent.receiptId, verdict: independent.verdict,
    verdictLabel: independent.verdictLabel, summary: independent.summary, checks: independent.checks,
    scope: independent.scope,
  });
});

test("proofLevelOf still names only what each record proves (no semantics change)", async t => {
  const { byTitle } = await serve(t);
  assert.equal(proofLevelOf(byTitle["Ship the door"]), "server-verified-merge");
  assert.equal(proofLevelOf(byTitle["Reviewed result"]), "member-verified-completion");
  assert.equal(proofLevelOf(byTitle["Solo result"]), "self-attested-completion");
  assert.equal(proofLevelOf(byTitle["Weekly changelog drafted"]), "room-recorded-completion");
  assert.equal(proofLevelOf(byTitle["Public task"]), "artifact-hash-recorded");
});

// --- bounty lot: composed at read from the escrow ledger -------------------

const LOT_ROOM = "room-test";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
let lotNowMs = 1_786_000_000_000;

function settledLot() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT receipt_proof_json_test");
    try { const out = fn(); db.exec("RELEASE receipt_proof_json_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO receipt_proof_json_test"); db.exec("RELEASE receipt_proof_json_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => lotNowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(LOT_ROOM);
  db.exec(`CREATE TABLE room_directory_settings (room_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 0, public_receipts INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE room_public_settings (room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE room_public_receipts_setting (room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
    CREATE TABLE public_unpublish (kind TEXT, target TEXT);
    CREATE TABLE public_rooms (slug TEXT PRIMARY KEY, title TEXT);`);
  const bounty = escrow.postBounty(LOT_ROOM, { poster: JILL, title: "Write the migration guide",
    criteria: "C", amount: 10, deadline: new Date(lotNowMs + 3_600_000).toISOString(), approvalMode: "human" }).bounty;
  escrow.fundBounty(LOT_ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(LOT_ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(LOT_ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(LOT_ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation:
    { at: new Date(lotNowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  lotNowMs += 3 * 24 * 3600 * 1000 + 1;
  escrow.finalizeBounty(LOT_ROOM, bounty.bountyId, {}); escrow.closeEpoch(LOT_ROOM, {});
  const lotId = db.prepare("SELECT lot_id FROM bounty_journal WHERE room_id=? AND bounty_id=? AND kind='payout' ORDER BY seq LIMIT 1")
    .get(LOT_ROOM, bounty.bountyId).lot_id;
  db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 1)").run(LOT_ROOM);
  return { store, lotId };
}

test("the lot composition path carries the tier field too, and verify data rides with it", async () => {
  const { store, lotId } = settledLot();
  const receipt = publicReceiptById(store, lotId);
  assert.ok(receipt, "fixture lot resolves");
  const plain = receiptJson(receipt);
  assert.deepEqual(plain.verification, { state: "ledger_recorded" });
  const verification = await verifyPublicReceipt(store, receipt, { nowMs: 1_786_100_000_000 });
  const verified = receiptJson(receipt, verification);
  assert.equal(verified.verification.state, "ledger_recorded", "tier survives the verify run on the lot path");
  assert.equal(verified.verification.verdict, "record-checked");
  assert.equal(verified.verification.checkedAt, new Date(1_786_100_000_000).toISOString());
  assert.ok(verified.verification.checks.some(entry => entry.id === "journal" && entry.status === "pass"));
});
