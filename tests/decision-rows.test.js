// #3616 (R-5/R-11): decision-row export — filed acceptance test.
//
// Acceptance (from the issue): an auditor script computes acceptance
// rates by rubric version from the export alone. The fixtures below
// span all three verdict surfaces (public-work, bounty, board), and the
// rate computation in this file reads ONLY the exported rows.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  DECISION_ROWS_SCHEMA, DECISION_ROW_FIELDS,
  rowsFromPublicWork, rowsFromBounty, rowsFromBoardClaim,
  acceptanceRatesByRubricVersion,
} from "../server/decision-rows.mjs";

const PROVENANCE = { sessionInstanceId: "sess_0123456789abcdef01234567", authorizingPrincipalId: "principal-1", claimedModelVersion: "model-x/1", claimedHarnessVersion: "harness/2", claimedEnvironment: "test" };

// --- Fixtures spanning all three surfaces ---------------------------------

function fixtureRows() {
  const rows = [];
  // Public-work, terms v1: one accepted (legacy, no provenance stamp),
  // one rejected. Terms v2: one accepted, stamped with #3612 provenance.
  rows.push(...rowsFromPublicWork({ roomId: "commons",
    receipt: { receiptId: "pwr_a", identityId: "identity-a", termsVersion: 1, createdAt: "2026-10-01T00:00:00.000Z" },
    review: { decision: { decision: "accepted", actorId: "owner", reason: "Meets criteria", at: "2026-10-02T00:00:00.000Z" } } }));
  rows.push(...rowsFromPublicWork({ roomId: "commons",
    receipt: { receiptId: "pwr_b", identityId: "identity-b", termsVersion: 1, createdAt: "2026-10-01T00:00:00.000Z" },
    review: { decision: { decision: "rejected", actorId: "owner", reason: "Missing check", at: "2026-10-02T00:00:00.000Z" } } }));
  rows.push(...rowsFromPublicWork({ roomId: "commons",
    receipt: { receiptId: "pwr_c", identityId: "identity-c", termsVersion: 2, createdAt: "2026-10-03T00:00:00.000Z" },
    review: { decision: { decision: "accepted", actorId: "reviewer", reason: "Pass", at: "2026-10-04T00:00:00.000Z", provenance: PROVENANCE } } }));
  // Public-work verification only (no decision): a verification row,
  // never an acceptance row.
  rows.push(...rowsFromPublicWork({ roomId: "commons",
    receipt: { receiptId: "pwr_d", identityId: "identity-d", termsVersion: 2, createdAt: "2026-10-03T00:00:00.000Z" },
    review: { verification: { verdict: "PASS", actorId: "reviewer", reason: "Checked", at: "2026-10-04T00:00:00.000Z", executedChecks: [{ name: "artifact_integrity", result: "pass" }] } } }));
  // Bounty, rubric v1 accepted (attestation with citations); rubric v2
  // rejected (resolution); rubric v1 disputed (non-terminal, excluded).
  rows.push(...rowsFromBounty({ roomId: "commons", bounty: {
    bountyId: "COMMONS-1", claimant: "lane-a", poster: "owner", verifier: "lane-v", state: "accepted",
    createdAt: "2026-10-01T00:00:00.000Z", stateChangedAt: "2026-10-02T00:00:00.000Z",
    rubric: { version: 1 }, attestation: { recordedBy: "lane-v", recordedAt: "2026-10-02T00:00:00.000Z", rubricVersion: 1,
      citations: [{ criterionId: "c1", verdict: "pass" }] } } }));
  rows.push(...rowsFromBounty({ roomId: "commons", bounty: {
    bountyId: "COMMONS-2", claimant: "lane-b", poster: "owner", verifier: "lane-v", state: "refunded",
    createdAt: "2026-10-01T00:00:00.000Z", stateChangedAt: "2026-10-02T00:00:00.000Z",
    rubric: { version: 2 }, resolution: { kind: "rejected", rejectedBy: "lane-v", rejectedAt: "2026-10-02T00:00:00.000Z", reason: "Failed verification" } } }));
  rows.push(...rowsFromBounty({ roomId: "commons", bounty: {
    bountyId: "COMMONS-3", claimant: "lane-c", poster: "owner", verifier: "lane-v", state: "disputed", disputeDecider: "owner",
    createdAt: "2026-10-01T00:00:00.000Z", stateChangedAt: "2026-10-02T00:00:00.000Z", rubric: { version: 1 }, attestation: null } }));
  // Board: a self-attested completion (accepted) and an independent
  // verification sent back (changes_requested), plus review rows.
  rows.push(...rowsFromBoardClaim({ roomId: "commons", item: {
    id: "claim-1", owner: "agent-a", reviewPolicy: "self_attested", claimedAt: "2026-10-01T00:00:00.000Z",
    reviews: [], verification: { state: "self_attested", by: "agent-a", at: "2026-10-02T00:00:00.000Z", executedChecks: [] } } }));
  rows.push(...rowsFromBoardClaim({ roomId: "commons", item: {
    id: "claim-2", owner: "agent-b", reviewPolicy: "distinct_member", claimedAt: "2026-10-01T00:00:00.000Z",
    reviews: [{ memberId: "reviewer", verdict: "approve", summary: "Looks right", at: "2026-10-02T00:00:00.000Z", provenance: PROVENANCE }],
    verification: { state: "changes_requested", by: "reviewer", at: "2026-10-03T00:00:00.000Z", executedChecks: [{ name: "criteria_coverage", result: "fail" }] } } }));
  return rows;
}

// The auditor computation, written against the export alone.
function ratesFromExportAlone(rows) {
  const groups = {};
  for (const entry of rows) {
    if (entry.decisionKind !== "acceptance" || entry.accepted === null) continue;
    const group = groups[entry.rubricVersion] ?? { decided: 0, accepted: 0 };
    group.decided += 1;
    if (entry.accepted) group.accepted += 1;
    groups[entry.rubricVersion] = group;
  }
  for (const group of Object.values(groups)) group.rate = group.accepted / group.decided;
  return groups;
}

test("acceptance rates by rubric version compute from the export alone, over all three surfaces", () => {
  const rows = fixtureRows();
  // All three surfaces contributed rows.
  assert.deepEqual([...new Set(rows.map(r => r.surface))].sort(), ["board", "bounty", "public-work"]);
  const rates = ratesFromExportAlone(rows);
  // Rubric "1": public-work 1/2 + bounty 1/1 = 2/3. (The disputed bounty
  // is non-terminal and the verification/review rows never count.)
  assert.deepEqual(rates["1"], { decided: 3, accepted: 2, rate: 2 / 3 });
  // Rubric "2": public-work 1/1 + bounty 0/1 = 1/2.
  assert.deepEqual(rates["2"], { decided: 2, accepted: 1, rate: 1 / 2 });
  // Board policies are their own rubric versions.
  assert.deepEqual(rates["self_attested"], { decided: 1, accepted: 1, rate: 1 });
  assert.deepEqual(rates["distinct_member"], { decided: 1, accepted: 0, rate: 0 });
  // The module's helper agrees with the independent computation.
  const helper = Object.fromEntries(acceptanceRatesByRubricVersion(rows).map(entry =>
    [entry.rubricVersion, { decided: entry.decided, accepted: entry.accepted, rate: entry.acceptanceRate }]));
  assert.deepEqual(helper, rates);
});

test("schema is pinned: every row carries exactly the documented fields, in order", () => {
  const rows = fixtureRows();
  const names = DECISION_ROW_FIELDS.map(field => field.name);
  for (const entry of rows) {
    assert.equal(entry.schema, DECISION_ROWS_SCHEMA);
    assert.equal(entry.schema, "decision-rows/1");
    assert.deepEqual(Object.keys(entry), names);
  }
  // The in-repo document defines every field (schema stability is the product).
  const doc = readFileSync(new URL("../docs/DECISION-ROWS.md", import.meta.url), "utf8");
  for (const name of names) assert.ok(doc.includes(`\`${name}\``), `docs/DECISION-ROWS.md documents ${name}`);
  assert.ok(doc.includes("decision-rows/1"));
});

test("no protected-class attributes or proxies are introduced", () => {
  const banned = /race|racial|gender|ethnic|religion|religious|disabilit|national_?origin|sexual|pregnan|marital|veteran/i;
  for (const field of DECISION_ROW_FIELDS) assert.ok(!banned.test(field.name), field.name);
  for (const entry of fixtureRows()) for (const key of Object.keys(entry)) assert.ok(!banned.test(key), key);
});

test("provenance flattens when present and is null — never fabricated — on legacy records", () => {
  const rows = fixtureRows();
  const stamped = rows.find(r => r.rowId === "public-work:pwr_c:acceptance");
  assert.equal(stamped.sessionInstanceId, PROVENANCE.sessionInstanceId);
  assert.equal(stamped.authorizingPrincipalId, PROVENANCE.authorizingPrincipalId);
  assert.equal(stamped.claimedModelVersion, PROVENANCE.claimedModelVersion);
  const stampedReview = rows.find(r => r.rowId.startsWith("board:claim-2:review:"));
  assert.equal(stampedReview.sessionInstanceId, PROVENANCE.sessionInstanceId);
  const legacy = rows.find(r => r.rowId === "public-work:pwr_a:acceptance");
  assert.equal(legacy.sessionInstanceId, null);
  assert.equal(legacy.authorizingPrincipalId, null);
  assert.equal(legacy.claimedModelVersion, null);
});

// --- Store + HTTP integration ----------------------------------------------

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "decision-rows-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { token } = {}) => fetch(origin + path, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { request, ownerKey, agentKey, store };
}

function seedVerdicts(store) {
  // Board: a done claim with a verification fact + a review.
  store.workClaims.set("commons", { id: "claim-http", title: "HTTP claim", state: "done", owner: "agent",
    reviewPolicy: "distinct_member", claimedAt: "2026-10-01T00:00:00.000Z", history: [],
    reviews: [{ memberId: "owner", verdict: "approve", summary: "ok", url: null, at: "2026-10-02T00:00:00.000Z" }],
    verification: { state: "verified", by: "owner", at: "2026-10-02T01:00:00.000Z", executedChecks: [{ name: "bundle_integrity", result: "pass" }] } });
  // Public-work: task + receipt + accepted review, inserted at the
  // record layer (the review flow itself is covered by its own suites).
  store.db.prepare("INSERT INTO public_work_tasks VALUES (?,?,?,?,?,?,?,?,?)")
    .run("task-http", "ns", "commons", 3, "https://example.invalid/repo", "main", "[]", 1, Date.now());
  const receipt = { schema: "public-work-receipt/1", receiptId: "pwr_http", taskId: "task-http", identityId: "identity-http",
    termsVersion: 3, generation: 1, artifact: { sha256: "a".repeat(64) } };
  store.db.prepare(`INSERT INTO public_work_receipts (receipt_id, offer_id, namespace_key, generation, identity_id, artifact_text, artifact_sha256, artifact_bytes, receipt_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run("pwr_http", "task-http", "ns", 1, "identity-http", "artifact", "a".repeat(64), 8, JSON.stringify(receipt), Date.parse("2026-10-01T00:00:00.000Z"));
  store.db.exec("CREATE TABLE IF NOT EXISTS public_work_reviews (receipt_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, revision INTEGER NOT NULL, state_json TEXT NOT NULL)");
  store.db.prepare("INSERT INTO public_work_reviews VALUES (?,?,?,?)")
    .run("pwr_http", "commons", 1, JSON.stringify({ revision: 1, state: "accepted",
      decision: { decision: "accepted", actorId: "owner", reason: "Good", at: "2026-10-02T00:00:00.000Z" }, verification: null }));
  // Bounty: an accepted record with an attestation.
  store.db.prepare(`INSERT INTO bounty_records (bounty_id, room_id, title, criteria, amount_millis, poster, verifier, claimant, state,
      state_changed_ms, deadline_ms, created_at, updated_at, attestation_json, rubric_version, rubric_json, rubric_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("COMMONS-9", "commons", "Bounty", "Do it", 1000, "owner", "agent", "agent", "accepted",
      Date.parse("2026-10-02T00:00:00.000Z"), Date.parse("2027-01-01T00:00:00.000Z"), "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z",
      JSON.stringify({ recordedBy: "agent", recordedAt: "2026-10-02T00:00:00.000Z", rubricVersion: 4, citations: [{ criterionId: "c1", verdict: "pass" }] }),
      4, JSON.stringify([{ id: "c1" }]), "hash");
}

test("export is owner-gated, audited (room event + access log), and contains all surfaces", async t => {
  const { request, ownerKey, agentKey, store } = await serve(t);
  seedVerdicts(store);
  // Non-owner member and anonymous are refused, and record nothing.
  assert.equal((await request("/api/rooms/commons/decision-rows", { token: agentKey })).status, 403);
  assert.equal((await request("/api/rooms/commons/decision-rows")).status, 401);
  assert.equal(store.decisionRows.listAccessLog("commons").length, 0);

  const res = await request("/api/rooms/commons/decision-rows", { token: ownerKey });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.schema, "decision-rows/1");
  assert.equal(payload.requestedBy, "owner");
  assert.equal(payload.rowCount, payload.rows.length);
  assert.ok(payload.rowCount >= 4, `expected board+public+bounty rows, got ${payload.rowCount}`);
  assert.deepEqual([...new Set(payload.rows.map(r => r.surface))].sort(), ["board", "bounty", "public-work"]);
  const rates = ratesFromExportAlone(payload.rows);
  assert.equal(rates["3"].rate, 1); // public-work terms v3 accepted
  assert.equal(rates["4"].rate, 1); // bounty rubric v4 accepted
  assert.equal(rates["distinct_member"].rate, 1); // board verified

  // R-11 audit: the access log names schema, row count, requester.
  const log = store.decisionRows.listAccessLog("commons");
  assert.equal(log.length, 1);
  assert.deepEqual(
    { kind: log[0].kind, readerId: log[0].readerId, schemaVersion: log[0].schemaVersion, rowCount: log[0].rowCount },
    { kind: "export", readerId: "owner", schemaVersion: "decision-rows/1", rowCount: payload.rowCount });
  // …and the room event log carries the same room.exported audit record.
  const { events } = store.eventsAfter(ownerKey, "commons", 0, 100);
  const audit = events.map(entry => entry.event).find(event => event.type === T.ROOM_EXPORTED);
  assert.ok(audit, "room.exported audit event present");
  assert.deepEqual(audit.data, { format: "decision-rows", schemaVersion: "decision-rows/1", rowCount: payload.rowCount, requesterId: "owner" });

  // The access-log route is owner-only too.
  assert.equal((await request("/api/rooms/commons/decision-rows/access-log", { token: agentKey })).status, 403);
  const logRes = await request("/api/rooms/commons/decision-rows/access-log", { token: ownerKey });
  assert.equal(logRes.status, 200);
  assert.equal((await logRes.json()).entries.length, 1);
});

test("a member-side evidence read (work-claim receipts) leaves an access record", async t => {
  const { request, ownerKey, store } = await serve(t);
  seedVerdicts(store);
  const res = await request("/api/rooms/commons/receipts", { token: ownerKey });
  assert.equal(res.status, 200);
  const log = store.decisionRows.listAccessLog("commons");
  const read = log.find(entry => entry.kind === "evidence_read");
  assert.ok(read, "evidence_read entry recorded");
  assert.equal(read.readerId, "owner");
  assert.equal(read.surface, "work-claim-receipts");
  assert.ok(typeof read.at === "string" && read.at.length > 0);
});

test("store-level export refuses non-owners and logs evidence reads", t => {
  const directory = mkdtempSync(join(tmpdir(), "decision-rows-store-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  assert.throws(() => store.decisionRows.exportRoom("commons", "agent"), error => error.code === "owner_required");
  const payload = store.decisionRows.exportRoom("commons", "owner");
  assert.equal(payload.rowCount, 0);
  store.decisionRows.logEvidenceRead({ roomId: "commons", readerId: "owner", surface: "public-work-review", recordId: "pwr_x" });
  const log = store.decisionRows.listAccessLog("commons");
  assert.deepEqual(log.map(entry => entry.kind).sort(), ["evidence_read", "export"]);
  assert.equal(log.find(entry => entry.kind === "evidence_read").recordId, "pwr_x");
});

// --- Dispute resolutions: accepted follows the work's fate ---------------
//
// A dispute resolution (server/bounty-escrow.mjs _settleDispute, with the
// settlement merged in by _recordSettlement) carries two different
// verdicts: resolution.outcome names the CHALLENGE's fate ("upheld" =
// the challenge won) and resolution.kind names the WORK's fate under
// the settlement ("cancel" = refunded to the poster, "release" = award
// vests with the worker, "split" = halved). The acceptance row must
// read the work's fate. Fixtures are the production record shapes,
// settlement records included; each test pins the row against the
// settlement kind the same record carries.

function disputeBounty({ bountyId, state, resolution }) {
  return {
    bountyId, claimant: "lane-worker", poster: "owner", verifier: "lane-v",
    disputeDecider: "lane-decider", disputeId: "dsp_" + bountyId,
    state,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
    stateChangedAt: "2026-10-03T00:00:00.000Z",
    rubric: { version: 7 },
    attestation: { recordedBy: "lane-v", recordedAt: "2026-10-02T00:00:00.000Z",
      rubricVersion: 7, citations: [{ criterionId: "c1", verdict: "pass" }] },
    resolution, evidence: null,
  };
}
const DISPUTE_SETTLED_BY = { kind: "member", id: "lane-decider" };

test("dispute upheld (kind cancel, settlement failed) exports accepted false", () => {
  const bounty = disputeBounty({ bountyId: "B-DISPUTE-UPHELD", state: "refunded", resolution: {
    kind: "cancel", outcome: "upheld", terminal: "resolved",
    decidedAt: "2026-10-03T00:00:00.000Z", bondForfeited: false,
    settlement: { kind: "failed", workerMillis: 0, workerCredits: 0, refundMillis: 10000, refundCredits: 10,
      reason: "dispute upheld: work judged bad — escrow returned to poster, worker settles 0",
      settledAt: "2026-10-03T00:00:00.000Z", settledBy: DISPUTE_SETTLED_BY } } });
  // The money truth on the same record: the settlement failed, the
  // worker settled 0 and the escrow refunded — the work was NOT accepted.
  assert.equal(bounty.resolution.settlement.kind, "failed");
  const rows = rowsFromBounty({ roomId: "commons", bounty });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decisionKind, "acceptance");
  assert.equal(rows[0].outcome, "upheld");
  assert.equal(rows[0].accepted, false);
});

test("dispute rejected (kind release, settlement verified-complete) exports accepted true", () => {
  const bounty = disputeBounty({ bountyId: "B-DISPUTE-REJECTED", state: "approved", resolution: {
    kind: "release", outcome: "rejected", terminal: "resolved",
    decidedAt: "2026-10-03T00:00:00.000Z", bondForfeited: false,
    settlement: { kind: "verified-complete", workerMillis: 10000, workerCredits: 10, refundMillis: 0, refundCredits: 0,
      reason: "dispute rejected: award vests with the worker",
      settledAt: "2026-10-03T00:00:00.000Z", settledBy: DISPUTE_SETTLED_BY } } });
  assert.equal(bounty.resolution.settlement.kind, "verified-complete");
  const rows = rowsFromBounty({ roomId: "commons", bounty });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decisionKind, "acceptance");
  assert.equal(rows[0].outcome, "rejected");
  assert.equal(rows[0].accepted, true);
});

test("dispute split (kind split, settlement partial) exports accepted true", () => {
  const bounty = disputeBounty({ bountyId: "B-DISPUTE-SPLIT", state: "approved", resolution: {
    kind: "split", outcome: "split", terminal: "resolved",
    decidedAt: "2026-10-03T00:00:00.000Z", bondForfeited: false,
    settlement: { kind: "partial", workerMillis: 5000, workerCredits: 5, refundMillis: 5000, refundCredits: 5,
      reason: "dispute split: half the award vests with the worker, half refunds to the poster",
      settledAt: "2026-10-03T00:00:00.000Z", settledBy: DISPUTE_SETTLED_BY } } });
  assert.equal(bounty.resolution.settlement.kind, "partial");
  const rows = rowsFromBounty({ roomId: "commons", bounty });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decisionKind, "acceptance");
  assert.equal(rows[0].outcome, "split");
  assert.equal(rows[0].accepted, true);
});

test("dispute accepted follows resolution.kind when the challenge outcome differs", () => {
  // Every non-upheld, non-split outcome settles as a release in
  // _settleDispute — including outcomes whose names say nothing about
  // the work (frivolous, the keeper's timeout-default) and the keeper
  // retry shape whose outcome is null. All of them paid the worker.
  const releases = [
    ["B-DISPUTE-FRIVOLOUS", { kind: "release", outcome: "frivolous", terminal: "resolved",
      decidedAt: "2026-10-03T00:00:00.000Z", bondForfeited: true,
      settlement: { kind: "verified-complete", workerMillis: 10000, workerCredits: 10, refundMillis: 0, refundCredits: 0,
        reason: "dispute frivolous: award vests with the worker",
        settledAt: "2026-10-03T00:00:00.000Z", settledBy: DISPUTE_SETTLED_BY } }, "frivolous"],
    ["B-DISPUTE-TIMEOUT-DEFAULT", { kind: "release", outcome: "timeout-default", terminal: "timeout",
      decidedAt: "2026-10-03T00:00:00.000Z", bondForfeited: false,
      settlement: { kind: "verified-complete", workerMillis: 10000, workerCredits: 10, refundMillis: 0, refundCredits: 0,
        reason: "dispute timeout-default: award vests with the worker",
        settledAt: "2026-10-03T00:00:00.000Z", settledBy: DISPUTE_SETTLED_BY } }, "timeout-default"],
    ["B-DISPUTE-KIND-ONLY", { kind: "release", outcome: null, terminal: "resolved",
      decidedAt: "2026-10-03T00:00:00.000Z", bondForfeited: false,
      settlement: { kind: "verified-complete", workerMillis: 10000, workerCredits: 10, refundMillis: 0, refundCredits: 0,
        reason: "dispute null: award vests with the worker",
        settledAt: "2026-10-03T00:00:00.000Z", settledBy: DISPUTE_SETTLED_BY } }, "release"],
  ];
  for (const [bountyId, resolution, expectedOutcome] of releases) {
    const rows = rowsFromBounty({ roomId: "commons",
      bounty: disputeBounty({ bountyId, state: "approved", resolution }) });
    assert.equal(rows.length, 1, bountyId);
    assert.equal(rows[0].outcome, expectedOutcome, bountyId);
    assert.equal(rows[0].accepted, true, bountyId);
  }
});
