// #3616 (R-5/R-11): the auditor decision-row export (decision-rows/1).
//
// Pins: the versioned schema (exact field names/order/types on every row —
// the pin is also the never-collect guard: a row can never gain a
// demographic/protected-class field without breaking this suite), one row
// per verdict across public-work reviews, bounty verdicts/settlements, and
// board claim reviews (never pre-aggregated), the filed acceptance (an
// auditor computes acceptance rates by rubric version from the export
// alone), owner-only gating at parity with the room export, the export
// audit record naming schema + row count + requester, and member-side
// evidence-read logging at the same audit surface.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import {
  DECISION_ROWS_SCHEMA, DECISION_ROW_FIELDS, DECISION_ROW_FIELD_NAMES,
  collectDecisionRows, decisionRowsExportText, acceptanceRatesByRubricVersion,
} from "../server/decision-rows.mjs";
import { publicWorkReviewsSchema } from "../server/public-work-reviews.mjs";
import { publicWorkClaimsSchema } from "../server/public-work-claims.mjs";
import { bountyEscrowSchema } from "../server/bounty-escrow.mjs";
import { workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { encodeRow } from "../server/persisted-row.mjs";
import { WORK_CLAIM_ROW_KIND } from "../server/work-claim-sqlite.mjs";

const AT = {
  pwPass: "2026-09-01T10:00:00.000Z", pwDecision: "2026-09-01T11:00:00.000Z",
  pwFail: "2026-09-02T10:00:00.000Z",
  bountyAccept: "2026-09-03T10:00:00.000Z", bountyReject: "2026-09-04T10:00:00.000Z",
  bountyDispute: "2026-09-05T10:00:00.000Z", bountySettle: "2026-09-05T11:00:00.000Z",
  claimReview: "2026-09-06T10:00:00.000Z", claimVerify: "2026-09-06T11:00:00.000Z",
};

function seedVerdicts(db, roomId = "commons") {
  db.exec(publicWorkClaimsSchema);
  db.exec(publicWorkReviewsSchema);
  db.exec(bountyEscrowSchema);
  db.exec(workClaimSchema);
  // Public-work: one receipt verified PASS then accepted; one verified FAIL
  // with no decision yet; one still pending (no verdict -> no row).
  const receipt = (receiptId, termsVersion) => db.prepare(
    "INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(receiptId, "offer-1", "ns", 0, "identity-1", "bytes", "a".repeat(64), 5,
      JSON.stringify({ receiptId, taskId: "task-1", termsVersion }), 0);
  receipt("pwr_a", 3); receipt("pwr_b", 3); receipt("pwr_c", 4);
  const review = (receiptId, state) => db.prepare(
    "INSERT INTO public_work_reviews VALUES (?,?,?,?)")
    .run(receiptId, roomId, 1, JSON.stringify(state));
  review("pwr_a", {
    revision: 2, state: "accepted",
    verification: { verdict: "PASS", actorId: "verifier-1", reason: "checks pass", at: AT.pwPass },
    decision: { decision: "accepted", actorId: "owner", reason: "meets criteria", at: AT.pwDecision },
  });
  review("pwr_b", {
    revision: 1, state: "pending",
    verification: { verdict: "FAIL", actorId: "verifier-1", reason: "hash mismatch", at: AT.pwFail },
    decision: null,
  });
  review("pwr_c", { revision: 0, state: "pending", verification: null, decision: null });
  // Bounty: one accepted with a settlement; one rejected; one dispute that
  // settled as a release (resolution carries the dispute + settlement).
  const bounty = (bountyId, { attestation = null, resolution = null, rubricVersion = 2 }) => db.prepare(
    `INSERT INTO bounty_records (bounty_id, room_id, title, criteria, amount_millis, poster, verifier,
       approval_mode, claimant, state, state_changed_ms, deadline_ms, attestation_json, resolution_json,
       rubric_json, rubric_hash, rubric_version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(bountyId, roomId, "title", "do the thing", 1000, "poster-lane", "verifier-lane", "agent",
      "worker-lane", "approved", 0, 0,
      attestation ? JSON.stringify(attestation) : null,
      resolution ? JSON.stringify(resolution) : null,
      JSON.stringify([{ criterionId: "c1", description: "works" }]), "hash-2", rubricVersion,
      AT.bountyAccept, AT.bountyAccept);
  bounty("bty_a", {
    attestation: { citations: [{ criterionId: "c1", verdict: "pass" }], rubricVersion: 2, rubricHash: "hash-2", recordedBy: "verifier-lane", recordedAt: AT.bountyAccept },
    resolution: { settlement: { kind: "verified-complete", workerMillis: 1000, refundMillis: 0, reason: "award vested", settledAt: AT.bountySettle, settledBy: { kind: "member", id: "verifier-lane" } } },
  });
  bounty("bty_b", {
    resolution: { kind: "rejected", rejectedBy: "poster-lane", rejectedAt: AT.bountyReject, reason: "work judged bad" },
  });
  bounty("bty_c", {
    attestation: { citations: [{ criterionId: "c1", verdict: "pass" }], rubricVersion: 1, rubricHash: "hash-1", recordedBy: "verifier-lane", recordedAt: AT.bountyAccept },
    resolution: {
      kind: "release", outcome: "dismissed", decidedAt: AT.bountyDispute, bondForfeited: false,
      settlement: { kind: "verified-complete", workerMillis: 1000, refundMillis: 0, reason: "dispute dismissed: award vests", settledAt: AT.bountySettle, settledBy: { kind: "member", id: "decider-lane" } },
    },
    rubricVersion: 1,
  });
  // Board claim: one recorded review + the verification fact.
  const item = {
    id: "claim-1", title: "Claim", state: "done", owner: "worker-1", history: [],
    reviewPolicy: "distinct_member",
    reviews: [{ memberId: "reviewer-1", verdict: "approve", summary: "looks right", url: null, at: AT.claimReview }],
    verification: { state: "verified", by: "reviewer-1", at: AT.claimVerify, executedChecks: [{ name: "ci", result: "pass" }] },
    acceptanceCriteria: ["ship it"], delivery: null,
  };
  db.prepare("INSERT INTO work_claims VALUES (?,?,?,?)")
    .run(roomId, "claim-1", JSON.stringify(encodeRow(WORK_CLAIM_ROW_KIND, item)), 0);
}

test("decision-rows/1: schema is pinned — exact fields, order, and types on every row", () => {
  const db = new DatabaseSync(":memory:");
  seedVerdicts(db);
  const rows = collectDecisionRows(db, "commons");
  assert.ok(rows.length >= 8, `expected at least 8 verdict rows, got ${rows.length}`);
  for (const entry of rows) {
    assert.deepEqual(Object.keys(entry), [...DECISION_ROW_FIELD_NAMES], "row keys are exactly the pinned fields, in order");
    assert.equal(entry.schema, DECISION_ROWS_SCHEMA);
    for (const field of DECISION_ROW_FIELDS) {
      const value = entry[field.name];
      if (field.type === "string") assert.equal(typeof value, "string", `${field.name} is a string`);
      else if (field.type === "string|null") assert.ok(value === null || typeof value === "string", `${field.name} is string|null`);
      else if (field.type === "boolean|null") assert.ok(value === null || typeof value === "boolean", `${field.name} is boolean|null`);
    }
    // Never-collect guard (R-5): no field name may carry a demographic or
    // protected-class attribute — the join is the deployer's.
    for (const key of Object.keys(entry))
      assert.doesNotMatch(key, /race|ethnic|gender|sex|religio|disab|national|demograph|protected|age|marital|veteran/i,
        `field ${key} must never appear in decision-rows/1`);
  }
  db.close();
});

test("decision-rows/1: one row per verdict across the three sources, never pre-aggregated", () => {
  const db = new DatabaseSync(":memory:");
  seedVerdicts(db);
  const rows = collectDecisionRows(db, "commons");
  const byKind = rows.map(entry => `${entry.source}:${entry.decisionKind}:${entry.subjectId}`);
  // public-work: verification + decision are separate verdicts, separate rows.
  assert.ok(byKind.includes("public-work:verification:pwr_a"));
  assert.ok(byKind.includes("public-work:decision:pwr_a"));
  assert.ok(byKind.includes("public-work:verification:pwr_b"));
  // The pending review (pwr_c) has no verdict and yields no row.
  assert.ok(!rows.some(entry => entry.subjectId === "pwr_c"));
  // bounty: acceptance, rejection, dispute, and settlement rows.
  assert.ok(byKind.includes("bounty:acceptance:bty_a"));
  assert.ok(byKind.includes("bounty:settlement:bty_a"));
  assert.ok(byKind.includes("bounty:rejection:bty_b"));
  assert.ok(byKind.includes("bounty:dispute:bty_c"));
  assert.ok(byKind.includes("bounty:settlement:bty_c"));
  // board-claim: the review and the verification fact are separate rows.
  assert.ok(byKind.includes("board-claim:review:claim-1"));
  assert.ok(byKind.includes("board-claim:verification:claim-1"));
  // Row ids are unique — no verdict was folded into another.
  assert.equal(new Set(rows.map(entry => entry.rowId)).size, rows.length);
  // Spot-check the projected facts ride along.
  const bountyAccept = rows.find(entry => entry.rowId === "bounty:bty_a:acceptance");
  assert.equal(bountyAccept.rubricVersion, "2");
  assert.equal(bountyAccept.rubricHash, "hash-2");
  assert.equal(bountyAccept.criteriaSummary, "c1:pass");
  assert.equal(bountyAccept.verifierId, "verifier-lane");
  assert.equal(bountyAccept.decidedAt, AT.bountyAccept);
  const claimVerify = rows.find(entry => entry.rowId === "board-claim:claim-1:verification");
  assert.equal(claimVerify.criteriaSummary, "ci:pass");
  assert.equal(claimVerify.rubricVersion, "distinct_member");
  db.close();
});

test("auditor acceptance: rates by rubric version computed from the export alone", () => {
  const db = new DatabaseSync(":memory:");
  seedVerdicts(db);
  const { header, text } = decisionRowsExportText(db, "commons", { exportedAt: AT.claimVerify, requester: "owner" });
  assert.equal(header.schema, "decision-rows/1");
  assert.equal(header.rows, collectDecisionRows(db, "commons").length);
  // The auditor's position: parse the export text, read nothing else.
  const lines = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].kind, "decision-rows");
  const rates = acceptanceRatesByRubricVersion(lines.slice(1));
  const byVersion = new Map(rates.map(entry => [entry.rubricVersion, entry]));
  // Terms v3 (public-work): PASS + accepted + FAIL = 2 accepted of 3 judged.
  assert.equal(byVersion.get("3").accepted, 2);
  assert.equal(byVersion.get("3").rejected, 1);
  assert.equal(byVersion.get("3").acceptanceRate, 2 / 3);
  // Bounty rubric v2: acceptance + verified-complete settlement accepted,
  // rejection rejected -> 2/3. (The v1 rows: acceptance + dispute-dismissed
  // + settlement, all accepting.)
  assert.equal(byVersion.get("2").accepted, 2);
  assert.equal(byVersion.get("2").rejected, 1);
  assert.equal(byVersion.get("1").acceptanceRate, 1);
  db.close();
});

async function serve(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { token } = {}) => fetch(origin + path, {
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const post = (path, { token, data } = {}) => fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data),
  });
  return { store, ownerKey, agentKey, request, post };
}

test("HTTP export: owner-only, framed NDJSON, and the audit record names schema + row count + requester", async t => {
  const { store, ownerKey, agentKey, request } = await serve(t);
  seedVerdicts(store.db, "commons");
  const expected = collectDecisionRows(store.db, "commons").length;

  const res = await request("/api/rooms/commons/export?format=decision-rows", { token: ownerKey });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /room-commons-decision-rows\.ndjson/);
  const text = await res.text();
  assert.equal(Number(res.headers.get("content-length")), Buffer.byteLength(text));
  const lines = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].schema, "decision-rows/1");
  assert.equal(lines[0].requester, "owner");
  assert.equal(lines.length - 1, expected);
  // The export alone supports the auditor computation over HTTP too.
  assert.ok(acceptanceRatesByRubricVersion(lines.slice(1)).length >= 3);

  // Gating parity with the room export: members and strangers are refused.
  assert.equal((await request("/api/rooms/commons/export?format=decision-rows", { token: agentKey })).status, 403);
  assert.equal((await request("/api/rooms/commons/export?format=decision-rows")).status, 401);
  assert.equal((await request("/api/rooms/commons/export?format=pdf", { token: ownerKey })).status, 422);

  // The audit record: exactly one room.exported for the decision-row
  // export (the two refusals and the 422 recorded nothing), naming the
  // schema, the row count, and the requester.
  const events = [...store.exportEvents(ownerKey, "commons")].map(line => line.event);
  const exports_ = events.filter(event => event.type === "room.exported" && event.data.format === "decision-rows");
  assert.equal(exports_.length, 1);
  assert.equal(exports_[0].data.schema, "decision-rows/1");
  assert.equal(exports_[0].data.rowCount, expected);
  assert.equal(exports_[0].data.requester, "owner");
  assert.equal(exports_[0].actorId, "owner");
});

test("evidence reads: a member reading a board claim's verdict surface leaves an access record", async t => {
  const { store, ownerKey, agentKey, request, post } = await serve(t);
  // Create a claim on the board (owner), then read it back as another
  // member — the single-claim read carries reviews/verification/evidence.
  const created = await post("/api/rooms/commons/work-claims", { token: ownerKey, data: { id: "claim-evidence", reviewPolicy: "distinct_member" } });
  assert.equal(created.status, 201);
  const read = await request("/api/rooms/commons/work-claims/claim-evidence", { token: agentKey });
  assert.equal(read.status, 200);

  const events = [...store.exportEvents(ownerKey, "commons")].map(line => line.event);
  const reads = events.filter(event => event.type === "evidence.read");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].actorId, "agent");
  assert.equal(reads[0].data.surface, "board-claim");
  assert.equal(reads[0].data.subjectId, "claim-evidence");
});
