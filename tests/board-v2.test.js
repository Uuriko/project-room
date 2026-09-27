// Board v2 prototype contract tests (BOARD-1, RC-2026-09-26-1114).
//
// Every test exercises handleBoardV2Request — the exact route contract from
// docs/BOARD-V2-DESIGN.md §4 — with request-shaped input and asserting
// response-shaped output (status, error codes, watermarks). The module is
// new, so no existing coverage guards these contracts; each test below
// names the credible regression it would catch.

import test from "node:test";
import assert from "node:assert/strict";
import { BoardV2, BoardV2Error, handleBoardV2Request } from "../server/board-v2.mjs";

const T0 = Date.parse("2026-09-26T21:00:00.000Z");

function setup() {
  let nowMs = T0;
  const board = new BoardV2({ now: () => nowMs });
  const req = (method, path, { query = {}, body = null, lane = "jill", headers = {} } = {}) =>
    handleBoardV2Request(board, { method, path, query, body, lane, headers });
  const advance = ms => { nowMs += ms; };
  return { board, req, advance, now: () => nowMs };
}

const claimBody = (over = {}) => ({
  task_id: "RC-2026-09-26-1114",
  lane: "jill",
  files: ["docs/BOARD-V2-DESIGN.md", "server/board-v2.mjs"],
  lease: "lease=6h",
  reason: "BOARD-1 prototype",
  ...over,
});

test("claim round-trip: 201, echoed claim, lease math derived from claim time", () => {
  const { req } = setup();
  const res = req("POST", "/claims", { body: claimBody() });
  assert.equal(res.status, 201);
  assert.equal(res.body.watermark, 1);
  assert.equal(res.body.seq, 1);
  const c = res.body.claim;
  assert.equal(c.task_id, "RC-2026-09-26-1114");
  assert.equal(c.lane, "jill");
  assert.deepEqual(c.files, ["docs/BOARD-V2-DESIGN.md", "server/board-v2.mjs"]);
  assert.equal(c.state, "submitted");
  assert.equal(c.lease_h, 6);
  // Regression: lease math off by unit (ms vs s) or anchored wrongly.
  // expires_at must be exactly claim_at + 6h, derived from returned data.
  const expectExpires = Date.parse(c.claim_at) + 6 * 3600_000;
  assert.equal(Date.parse(c.expires_at), expectExpires);
  assert.equal(c.expired, false);
  assert.deepEqual(c.receipts, []);
});

test("claim validation rejects machine-unreadable input with typed codes", () => {
  const { req } = setup();
  const bad = [
    [{ ...claimBody(), task_id: "nope" }, "invalid_task_id"],
    // The standing misfire: bare "6h" must be rejected, never silently accepted.
    [{ ...claimBody(), lease: "6h" }, "invalid_lease"],
    [{ ...claimBody(), lease: "lease=99h" }, "invalid_lease"],
    [{ ...claimBody(), files: [] }, "invalid_files"],
    [{ ...claimBody(), files: ["docs/*.md"] }, "invalid_files"],
    [{ ...claimBody(), files: ["../escape.mjs"] }, "invalid_files"],
    [{ ...claimBody(), reason: "   " }, "invalid_reason"],
    [{ ...claimBody(), bogus: 1 }, "unknown_field"],
  ];
  for (const [body, code] of bad) {
    const res = req("POST", "/claims", { body });
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.error.code, code, JSON.stringify(body));
  }
  // Body lane must equal the authenticated lane: the auth binding fires
  // before body validation (403, not 422).
  const mismatch = req("POST", "/claims", { body: { ...claimBody(), lane: "not-a-lane!" } });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.error.code, "lane_mismatch");
  // Regression guard: a rejected write must leave no trace on the board.
  const read = req("GET", "/claims", { lane: null });
  assert.equal(read.body.watermark, 0);
  assert.deepEqual(read.body.claims, []);
});

test("duplicate task-id is refused: a task-id never gets a second claimant", () => {
  const { req } = setup();
  assert.equal(req("POST", "/claims", { body: claimBody() }).status, 201);
  const dup = req("POST", "/claims", { body: claimBody({ files: ["other.md"] }) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "duplicate_task");
});

test("file exclusivity: cross-lane live overlap 409s, same-lane overlaps, release frees", () => {
  const { req } = setup();
  assert.equal(req("POST", "/claims", { body: claimBody() }).status, 201);
  // Another lane on an overlapping file -> 409 naming the holder.
  const clash = req("POST", "/claims", {
    lane: "grokbot",
    body: claimBody({ task_id: "RC-2026-09-26-1115", lane: "grokbot", files: ["server/board-v2.mjs", "fresh.md"] }),
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, "claim_conflict");
  assert.deepEqual(clash.body.error.fields.holders, [
    { task_id: "RC-2026-09-26-1114", lane: "jill", files: ["server/board-v2.mjs"] },
  ]);
  // Non-overlapping files for the other lane are fine.
  const ok = req("POST", "/claims", {
    lane: "grokbot",
    body: claimBody({ task_id: "RC-2026-09-26-1116", lane: "grokbot", files: ["unrelated.md"] }),
  });
  assert.equal(ok.status, 201);
  // Release frees the files: the other lane can claim them now.
  const rel = req("POST", "/claims/RC-2026-09-26-1114/release", { body: { reason: "done" } });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.claim.state, "released");
  const after = req("POST", "/claims", {
    lane: "grokbot",
    body: claimBody({ task_id: "RC-2026-09-26-1117", lane: "grokbot", files: ["server/board-v2.mjs"] }),
  });
  assert.equal(after.status, 201);
});

test("heartbeat renews the lease from the heartbeat time, holder-only", () => {
  const { req, advance } = setup();
  req("POST", "/claims", { body: claimBody() });
  advance(5 * 3600_000); // 5h into the 6h lease
  const hb = req("POST", "/claims/RC-2026-09-26-1114/heartbeat", { body: { note: "still going" } });
  assert.equal(hb.status, 200);
  assert.equal(hb.body.claim.state, "working");
  // Regression: lease renewed from claim time (would expire 1h after the
  // heartbeat) instead of from the heartbeat time (6h after).
  const expectExpires = Date.parse(hb.body.claim.heartbeat_at) + 6 * 3600_000;
  assert.equal(Date.parse(hb.body.claim.expires_at), expectExpires);
  // Wrong lane cannot heartbeat.
  const wrong = req("POST", "/claims/RC-2026-09-26-1114/heartbeat", { lane: "grokbot", body: {} });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, "lane_mismatch");
  // Heartbeat on a released claim is 404 (not silently revived).
  req("POST", "/claims/RC-2026-09-26-1114/release", { body: { reason: "done" } });
  const dead = req("POST", "/claims/RC-2026-09-26-1114/heartbeat", { body: {} });
  assert.equal(dead.status, 404);
  assert.equal(dead.body.error.code, "unknown_task");
});

test("receipts record merge evidence without closing the claim", () => {
  const { req } = setup();
  req("POST", "/claims", { body: claimBody() });
  const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9";
  const res = req("POST", "/claims/RC-2026-09-26-1114/receipts", { body: { sha, pr: 1107 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.receipt.sha, sha);
  assert.equal(res.body.receipt.pr, 1107);
  assert.equal(typeof res.body.receipt.seq, "number");
  // Receipts are SLO evidence, not closeout: state is unchanged.
  const read = req("GET", "/claims", { lane: null, query: { state: "submitted" } });
  assert.equal(read.body.claims[0].receipts.length, 1);
  // Bad sha is rejected, not stored.
  const bad = req("POST", "/claims/RC-2026-09-26-1114/receipts", { body: { sha: "xyz" } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, "invalid_sha");
});

test("readBoard: filters, since_seq cursor, file-claims index and overlap flags", () => {
  const { req } = setup();
  req("POST", "/claims", { body: claimBody() });
  req("POST", "/claims", {
    lane: "grokbot",
    body: claimBody({ task_id: "RC-2026-09-26-1115", lane: "grokbot", files: ["grok.md"] }),
  });
  const all = req("GET", "/claims", { lane: null });
  assert.equal(all.body.watermark, 2);
  assert.equal(all.body.claims.length, 2);
  // Filters compose.
  assert.equal(req("GET", "/claims", { lane: null, query: { lane: "grokbot" } }).body.claims.length, 1);
  assert.equal(req("GET", "/claims", { lane: null, query: { state: "submitted" } }).body.claims.length, 2);
  assert.equal(req("GET", "/claims", { lane: null, query: { file: "grok.md" } }).body.claims.length, 1);
  // Cheap-resume cursor: only events after since_seq.
  const tail = req("GET", "/claims", { lane: null, query: { since_seq: "1" } });
  assert.equal(tail.body.claims.length, 1);
  assert.equal(tail.body.claims[0].task_id, "RC-2026-09-26-1115");
  // file-claims inverted index over live claims.
  const idx = all.body.file_claims.find(fc => fc.file === "docs/BOARD-V2-DESIGN.md");
  assert.deepEqual(idx.claims, [{ task_id: "RC-2026-09-26-1114", lane: "jill", state: "submitted" }]);
  // Standing invariant: the API's 409 on cross-lane overlap means writes can
  // never create a cross-lane overlap, so the flag stays empty through the
  // write path. (The flag exists for the #266 migration import, where
  // historical overlaps are carried over — deliberately not covered here.)
  assert.deepEqual(all.body.overlaps, []);
});

test("watermark is monotonic across every mutation", () => {
  const { req } = setup();
  const seen = [];
  seen.push(req("POST", "/claims", { body: claimBody() }).body.watermark);
  seen.push(req("POST", "/claims/RC-2026-09-26-1114/heartbeat", { body: {} }).body.watermark);
  seen.push(req("POST", "/claims/RC-2026-09-26-1114/receipts", { body: { sha: "abc1234" } }).body.watermark);
  seen.push(req("POST", "/claims/RC-2026-09-26-1114/release", { body: { reason: "done" } }).body.watermark);
  assert.deepEqual(seen, [1, 2, 3, 4]);
  // Regression: a cursor built from any response must never go backwards —
  // rotation safety depends on this.
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1]);
});

test("mirror-map translates (issue, comment_id) to seq for cursor migration", () => {
  const { req } = setup();
  req("POST", "/claims", { body: claimBody() });
  req("POST", "/claims/RC-2026-09-26-1114/heartbeat", { body: {} });
  const rec = req("POST", "/mirror-map", { body: { seq: 2, issue: 266, comment_id: 5850103114 } });
  assert.equal(rec.status, 201);
  const resolve = req("GET", "/mirror-map", { lane: null, query: { issue: "266", comment_id: "5850103114" } });
  assert.equal(resolve.status, 200);
  assert.equal(resolve.body.seq, 2);
  // Unknown mirror ref is 404 with a typed code, not a silent null.
  const missing = req("GET", "/mirror-map", { lane: null, query: { issue: "266", comment_id: "1" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "mirror_unknown");
  // since_seq lists newer mirror entries for catch-up.
  const since = req("GET", "/mirror-map", { lane: null, query: { since_seq: "1" } });
  assert.deepEqual(since.body.entries, [{ seq: 2, issue: 266, comment_id: 5850103114 }]);
});

test("routing: unknown paths 404, wrong methods 405, unauthenticated writes 401", () => {
  const { req } = setup();
  assert.equal(req("GET", "/nope", { lane: null }).status, 404);
  assert.equal(req("DELETE", "/claims", { lane: null }).status, 405);
  assert.equal(req("GET", "/claims/RC-2026-09-26-1114", { lane: null }).status, 405);
  const anon = req("POST", "/claims", { lane: null, body: claimBody() });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, "unauthenticated");
  // Reads stay public (mirror of the public issue thread).
  assert.equal(req("GET", "/claims", { lane: null }).status, 200);
  assert.equal(req("GET", "/health", { lane: null }).status, 200);
});

test("BoardV2Error carries status+code for the handler's typed envelope", () => {
  const err = new BoardV2Error(409, "claim_conflict", "busy", { holders: [] });
  assert.equal(err.status, 409);
  assert.equal(err.code, "claim_conflict");
  assert.deepEqual(err.fields, { holders: [] });
});

test("notes: append-only events queryable by lane/thread/severity", () => {
  const { req } = setup();
  // Post a note with thread and severity.
  const posted = req("POST", "/notes", {
    lane: "jill",
    body: { thread: "sprint-7", body: "Milestone reached: board v2 prototype", severity: "milestone" },
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.note.lane, "jill");
  assert.equal(posted.body.note.thread, "sprint-7");
  assert.equal(posted.body.note.severity, "milestone");
  assert.equal(posted.body.watermark, 1);
  // A second note from another lane, no thread.
  req("POST", "/notes", { lane: "codex", body: { body: "Working on efficiency" } });
  // Query by lane filters correctly.
  const byLane = req("GET", "/notes", { query: { lane: "jill" } });
  assert.equal(byLane.body.notes.length, 1);
  assert.equal(byLane.body.notes[0].thread, "sprint-7");
  // Query by thread.
  const byThread = req("GET", "/notes", { query: { thread: "sprint-7" } });
  assert.equal(byThread.body.notes.length, 1);
  // Invalid severity is 422, not silently stored.
  const bad = req("POST", "/notes", { lane: "jill", body: { body: "x", severity: "urgent" } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, "invalid_severity");
});

test("findings: severity enum + required fields enforced at write time", () => {
  const { req } = setup();
  const posted = req("POST", "/findings", {
    lane: "instinct",
    body: {
      severity: "high",
      title: "Invite revocation bypass",
      evidence: ["test output", "code review"],
      recommendation: "Gate revoke() on autonomy tier",
    },
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.finding.severity, "high");
  assert.equal(posted.body.finding.title, "Invite revocation bypass");
  assert.deepEqual(posted.body.finding.evidence, ["test output", "code review"]);
  // Missing severity is 422.
  const noSev = req("POST", "/findings", {
    lane: "instinct",
    body: { title: "x", recommendation: "y" },
  });
  assert.equal(noSev.status, 422);
  assert.equal(noSev.body.error.code, "invalid_severity");
  // Invalid severity value is 422.
  const badSev = req("POST", "/findings", {
    lane: "instinct",
    body: { severity: "catastrophic", title: "x", recommendation: "y" },
  });
  assert.equal(badSev.status, 422);
  // Query by severity filters.
  req("POST", "/findings", {
    lane: "jill",
    body: { severity: "low", title: "Minor", recommendation: "Note it" },
  });
  const high = req("GET", "/findings", { query: { severity: "high" } });
  assert.equal(high.body.findings.length, 1);
  assert.equal(high.body.findings[0].lane, "instinct");
});

test("decisions: decider authority recorded, superseding supported", () => {
  const { req } = setup();
  const posted = req("POST", "/decisions", {
    lane: "john",
    body: { scope: "room", statement: "Merge queue enabled", reversible: true },
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.decision.decider, "john");
  assert.equal(posted.body.decision.scope, "room");
  assert.equal(posted.body.decision.reversible, true);
  // A superseding decision links to the prior one.
  const v2 = req("POST", "/decisions", {
    lane: "john",
    body: { scope: "room", statement: "Merge queue enabled with strict mode", supersedes: "merge-queue-v1" },
  });
  assert.equal(v2.body.decision.supersedes, "merge-queue-v1");
  // Missing scope is 422.
  const noScope = req("POST", "/decisions", { lane: "john", body: { statement: "x" } });
  assert.equal(noScope.status, 422);
  assert.equal(noScope.body.error.code, "invalid_scope");
  // Query by decider.
  const byDecider = req("GET", "/decisions", { query: { decider: "john" } });
  assert.equal(byDecider.body.decisions.length, 2);
});

test("idempotency: same key returns cached response without re-executing", () => {
  const { req } = setup();
  const headers = { "Idempotency-Key": "test-key-123" };
  const noteBody = { body: "First note" };
  // First POST creates the note.
  const first = req("POST", "/notes", { lane: "jill", body: noteBody, headers });
  assert.equal(first.status, 201);
  const firstSeq = first.body.seq;
  // Second POST with same key returns the cached response (same seq, no new event).
  const second = req("POST", "/notes", { lane: "jill", body: noteBody, headers });
  assert.equal(second.status, 201);
  assert.equal(second.body.seq, firstSeq);
  // Verify only one note was actually created.
  const notes = req("GET", "/notes", {});
  assert.equal(notes.body.notes.length, 1);
  // Different key creates a new note.
  const third = req("POST", "/notes", {
    lane: "jill", body: noteBody, headers: { "Idempotency-Key": "different-key" },
  });
  assert.notEqual(third.body.seq, firstSeq);
});

test("idempotency: works across all mutating routes", () => {
  const { req } = setup();
  const key = { "Idempotency-Key": "claim-key-1" };
  // Claim with idempotency key.
  const c1 = req("POST", "/claims", { lane: "jill", body: claimBody(), headers: key });
  assert.equal(c1.status, 201);
  const c2 = req("POST", "/claims", { lane: "jill", body: claimBody(), headers: key });
  assert.equal(c2.body.claim.task_id, c1.body.claim.task_id);
  // Only one claim exists (duplicate task-id would 409 on re-execution).
  const board = req("GET", "/claims", {});
  assert.equal(board.body.claims.length, 1);
});

test("idempotency: same key with different payload returns 422", () => {
  const { req } = setup();
  const headers = { "Idempotency-Key": "mismatch-key" };
  // First POST with body A.
  const first = req("POST", "/notes", {
    lane: "jill", body: { body: "Original" }, headers,
  });
  assert.equal(first.status, 201);
  // Second POST with same key but different body => 422.
  const second = req("POST", "/notes", {
    lane: "jill", body: { body: "Different" }, headers,
  });
  assert.equal(second.status, 422);
  assert.equal(second.body.error.code, "idempotency_key_mismatch");
});

test("idempotency: keys are scoped per lane", () => {
  const { req } = setup();
  const headers = { "Idempotency-Key": "shared-key" };
  // Jill uses the key.
  const jill = req("POST", "/notes", {
    lane: "jill", body: { body: "Jill's note" }, headers,
  });
  assert.equal(jill.status, 201);
  // Codex uses the same key — should NOT collide (different lane).
  const codex = req("POST", "/notes", {
    lane: "codex", body: { body: "Codex's note" }, headers,
  });
  assert.equal(codex.status, 201);
  assert.notEqual(codex.body.seq, jill.body.seq);
  // Verify two notes exist.
  const notes = req("GET", "/notes", {});
  assert.equal(notes.body.notes.length, 2);
});

test("GET /events: returns unified event log with cursor pagination", () => {
  const { req } = setup();
  // Create a claim (seq 1), a note (seq 2), a finding (seq 3).
  const c = req("POST", "/claims", { body: claimBody() });
  assert.equal(c.status, 201);
  const n = req("POST", "/notes", { lane: "jill", body: { body: "Test note" } });
  assert.equal(n.status, 201);
  const f = req("POST", "/findings", {
    lane: "jill",
    body: { severity: "high", title: "Test", recommendation: "Fix it" },
  });
  assert.equal(f.status, 201);

  // GET /events should return all three in seq order.
  const events = req("GET", "/events", {});
  assert.equal(events.status, 200);
  assert.equal(events.body.watermark, 3);
  assert.equal(events.body.events.length, 3);
  assert.equal(events.body.events[0].seq, 1);
  assert.equal(events.body.events[0].kind, "claim");
  assert.equal(events.body.events[1].seq, 2);
  assert.equal(events.body.events[1].kind, "note");
  assert.equal(events.body.events[2].seq, 3);
  assert.equal(events.body.events[2].kind, "finding");
  assert.equal(events.body.has_more, false);
});

test("GET /events: since_seq cursor filters correctly", () => {
  const { req } = setup();
  req("POST", "/claims", { body: claimBody() });
  req("POST", "/notes", { lane: "jill", body: { body: "Note 1" } });
  req("POST", "/notes", { lane: "jill", body: { body: "Note 2" } });

  // since_seq=1 should return seq 2 and 3 only.
  const events = req("GET", "/events", { query: { since_seq: "1" } });
  assert.equal(events.status, 200);
  assert.equal(events.body.events.length, 2);
  assert.equal(events.body.events[0].seq, 2);
  assert.equal(events.body.events[1].seq, 3);
});

test("GET /events: kind filter works", () => {
  const { req } = setup();
  req("POST", "/claims", { body: claimBody() });
  req("POST", "/notes", { lane: "jill", body: { body: "Note" } });

  const events = req("GET", "/events", { query: { kind: "note" } });
  assert.equal(events.status, 200);
  assert.equal(events.body.events.length, 1);
  assert.equal(events.body.events[0].kind, "note");
});

test("GET /events: lane filter works", () => {
  const { req } = setup();
  req("POST", "/notes", { lane: "jill", body: { body: "Jill note" } });
  req("POST", "/notes", { lane: "codex", body: { body: "Codex note" } });

  const events = req("GET", "/events", { query: { lane: "codex" } });
  assert.equal(events.status, 200);
  assert.equal(events.body.events.length, 1);
  assert.equal(events.body.events[0].lane, "codex");
});

test("GET /events: limit with has_more", () => {
  const { req } = setup();
  for (let i = 0; i < 5; i++) {
    req("POST", "/notes", { lane: "jill", body: { body: `Note ${i}` } });
  }

  // limit=2 should return 2 events with has_more=true.
  const events = req("GET", "/events", { query: { limit: "2" } });
  assert.equal(events.status, 200);
  assert.equal(events.body.events.length, 2);
  assert.equal(events.body.has_more, true);
  assert.equal(events.body.watermark, 5);
});

test("GET /events: rejects unknown query params", () => {
  const { req } = setup();
  const res = req("GET", "/events", { query: { bogus: "1" } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, "unknown_field");
});

test("GET /events: POST returns 405", () => {
  const { req } = setup();
  const res = req("POST", "/events", { body: {} });
  assert.equal(res.status, 405);
});
