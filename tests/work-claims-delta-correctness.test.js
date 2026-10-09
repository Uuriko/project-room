// WAVE-500-W5: delta board cursor correctness (F3 design contract).
//
// The F3 design (docs/WAVE300-FANOUT-DESIGN.md, "F3 — Delta board cursor")
// adds a per-room monotonic boardSeq, bumped inside the same transaction as
// every claim mutation, plus a `?since=<boardSeq>` board query that returns
// only claims with boardSeq > since, in mutation order.
//
// W4's wave500 implementation had NOT landed when these tests were written
// (no boardSeq surface in server/). These tests assert the CONTRACT: they
// fail on the current base and should turn green once W4 lands. They were
// validated against the landed wave300-fanout-perf F3 implementation
// (in-memory registry) — see docs/WAVE500-DELTA.md for the per-test report.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWork, claimWork, updateWork, attestWork, releaseExpired, isTerminalClaimState } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, buildWorkClaimPage } from "../server/work-claim-routes.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { ServiceError } from "../server/service-error.mjs";

const ROOM = "delta-room";
const VIEWER = "delta-viewer";
const NOW = Date.parse("2026-10-08T20:00:00.000Z");
const throwsHttp = (fn, status, code) =>
  assert.throws(fn, error => error instanceof ServiceError && error.status === status && error.code === code);

const mkClaim = (id, lane = "quill", extra = {}) => {
  let item = createWork({ id, title: `work ${id}`, note: "contract fixture", ...extra }, { now: NOW, agentId: lane });
  item = claimWork(item, lane, { now: NOW + 1000 });
  return item;
};
// Stamp stored rows the way an F3 registry's set() does.
const stamped = (items, from = 0) => items.map((item, i) => ({ ...item, boardSeq: from + i + 1 }));

// --- In-memory registry: seq bookkeeping ------------------------------------

test("delta: registry.boardSeq starts at 0 and bumps on every set()", () => {
  const registry = createWorkClaimRegistry();
  assert.equal(registry.boardSeq(ROOM), 0);
  const first = registry.set(ROOM, mkClaim("c1"));
  assert.equal(registry.boardSeq(ROOM), 1);
  assert.equal(first.boardSeq, 1);
  const second = registry.set(ROOM, mkClaim("c2", "grok"));
  assert.equal(registry.boardSeq(ROOM), 2);
  assert.equal(second.boardSeq, 2);
});

test("delta: re-setting the same claim (update/renew/release) advances the seq", () => {
  const registry = createWorkClaimRegistry();
  registry.set(ROOM, mkClaim("c1"));
  const updated = registry.set(ROOM, updateWork(mkClaim("c1"), "quill", { note: "progress", now: NOW + 2000 }));
  assert.equal(updated.boardSeq, 2);
  assert.equal(registry.boardSeq(ROOM), 2);
  // Stored rows carry the seq of their LAST mutation.
  assert.equal(registry.get(ROOM, "c1").boardSeq, 2);
});

test("delta: boardSeq is per-room", () => {
  const registry = createWorkClaimRegistry();
  registry.set(ROOM, mkClaim("c1"));
  registry.set("other-room", mkClaim("c1", "grok"));
  assert.equal(registry.boardSeq(ROOM), 1);
  assert.equal(registry.boardSeq("other-room"), 1);
});

test("delta: lease-expiry auto-release goes through set() so the sweep advances the seq", () => {
  const registry = createWorkClaimRegistry();
  const expired = claimWork(createWork({ id: "c1", title: "w" }, { now: NOW - 48 * 3600 * 1000, agentId: "quill" }),
    "quill", { leaseHours: 1, now: NOW - 48 * 3600 * 1000 });
  registry.set(ROOM, expired);
  const seqBefore = registry.boardSeq(ROOM);
  const released = releaseExpired([expired], NOW).find(item => item.state === "unclaimed");
  assert.ok(released, "fixture claim should have lapsed");
  registry.set(ROOM, released);
  assert.equal(registry.boardSeq(ROOM), seqBefore + 1);
});

// --- Page builder: full page -------------------------------------------------

test("delta: full page carries top-level boardSeq; per-claim boardSeq is stripped", () => {
  const items = stamped([mkClaim("c1"), mkClaim("c2", "grok")]);
  const page = buildWorkClaimPage(items, ROOM, VIEWER, new URLSearchParams(), NOW, 2);
  assert.equal(page.boardSeq, 2);
  assert.ok(page.claims.every(claim => !Object.hasOwn(claim, "boardSeq")),
    "full pages keep the claim shape byte-for-byte identical");
});

// --- Page builder: ?since= delta ---------------------------------------------

test("delta: ?since=N returns only claims with boardSeq > N, in mutation order, self-describing", () => {
  const items = stamped([mkClaim("c1"), mkClaim("c2", "grok"), mkClaim("c3", "codex"), mkClaim("c4", "fo")]);
  const page = buildWorkClaimPage(items, ROOM, VIEWER, new URLSearchParams("since=1"), NOW, 4);
  assert.equal(page.boardSeq, 4, "page carries the room's current cursor");
  assert.deepEqual(page.claims.map(c => c.id), ["c2", "c3", "c4"]);
  assert.deepEqual(page.claims.map(c => c.boardSeq), [2, 3, 4], "delta claims keep their boardSeq");
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null, "deltas are never paged");
  assert.equal(page.historyScope, "delta");
  assert.equal(page.openClaims, items.filter(i => !isTerminalClaimState(i.state)).length);
  assert.equal(page.terminalClaims, items.length - page.openClaims);
});

test("delta: steady-state since=current returns an empty delta with counts", () => {
  const items = stamped([mkClaim("c1"), mkClaim("c2", "grok")]);
  const page = buildWorkClaimPage(items, ROOM, VIEWER, new URLSearchParams("since=2"), NOW, 2);
  assert.deepEqual(page.claims, []);
  assert.equal(page.boardSeq, 2);
  assert.equal(page.openClaims, 2);
});

test("delta: a stale since returns exactly the changes since that seq", () => {
  const items = stamped([mkClaim("c1"), mkClaim("c2", "grok"), mkClaim("c3", "codex")]);
  // Poller last saw seq 1; only c2/c3 mutated after.
  const page = buildWorkClaimPage(items, ROOM, VIEWER, new URLSearchParams("since=1"), NOW, 3);
  assert.deepEqual(page.claims.map(c => c.boardSeq), [2, 3]);
});

test("delta: since=0 excludes pre-F3 rows (seq 0) — they re-send only when they change", () => {
  const legacy = mkClaim("legacy"); // no boardSeq: written before F3
  const items = [...stamped([mkClaim("c1")]), legacy];
  const page = buildWorkClaimPage(items, ROOM, VIEWER, new URLSearchParams("since=0"), NOW, 1);
  assert.deepEqual(page.claims.map(c => c.id), ["c1"],
    "a seq-0 row is not > 0, so it is excluded until it mutates");
});

test("delta: interleaved multi-writer mutations never miss or duplicate", () => {
  // Writers interleave create/update/release; the poller drains with an
  // advancing cursor and must see every mutation exactly once, at its final seq.
  const registry = createWorkClaimRegistry();
  const writers = ["quill", "grok", "codex", "fo"];
  const seqs = [];
  const ops = [];
  for (let i = 0; i < 12; i++) {
    const lane = writers[i % writers.length];
    const id = `w${i}`;
    registry.set(ROOM, mkClaim(id, lane));
    seqs.push(registry.boardSeq(ROOM)); ops.push([id, registry.boardSeq(ROOM)]);
    if (i % 3 === 1) {
      registry.set(ROOM, attestWork(registry.get(ROOM, id), lane, { note: "churn", now: NOW + i }));
      seqs.push(registry.boardSeq(ROOM)); ops.push([id, registry.boardSeq(ROOM)]);
    }
  }
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq strictly increasing under interleaved writers");
  assert.equal(new Set(seqs).size, seqs.length, "no seq is ever reused");

  // Drain: repeated deltas with an advancing cursor cover every mutation once.
  const seen = new Map();
  let cursor = 0;
  const seqNow = registry.boardSeq(ROOM);
  const pageAll = buildWorkClaimPage(registry.list(ROOM), ROOM, VIEWER, new URLSearchParams("since=0"), NOW, seqNow);
  for (const claim of pageAll.claims) {
    assert.ok(claim.boardSeq > cursor, "delta sorted in mutation order");
    cursor = claim.boardSeq;
    assert.ok(!seen.has(claim.id), `claim ${claim.id} duplicated in one delta`);
    seen.set(claim.id, claim.boardSeq);
  }
  assert.equal(seen.size, 12, "every created claim appears exactly once");
  const pageEmpty = buildWorkClaimPage(registry.list(ROOM), ROOM, VIEWER,
    new URLSearchParams(`since=${seqNow}`), NOW, seqNow);
  assert.deepEqual(pageEmpty.claims, [], "draining to the current cursor yields an empty delta");
  // The final seq recorded per claim matches the registry's stored row.
  for (const [id, finalSeq] of seen) {
    assert.equal(registry.get(ROOM, id).boardSeq, finalSeq, `${id} visible at its last-mutation seq`);
  }
});

// --- Page builder: since validation ------------------------------------------

test("delta: since validation — bad values and bad combinations are 400; limit/view compose", () => {
  const items = stamped([mkClaim("c1"), mkClaim("c2", "grok"), mkClaim("c3", "codex")]);
  const page = (q) => buildWorkClaimPage(items, ROOM, VIEWER, new URLSearchParams(q), NOW, 3);
  // A non-^\d+$ value is 400 invalid_input; a huge-but-numeric since is
  // accepted and simply yields an empty delta (seq beyond the cursor).
  for (const bad of ["since=abc", "since=-1", "since=2.5", "since="]) {
    throwsHttp(() => page(bad), 400, "invalid_input");
  }
  assert.deepEqual(page("since=99999999999999999999").claims, [],
    "numeric-but-enormous since is accepted; it just matches nothing");
  for (const bad of ["since=1&cursor=x", "since=1&queue=ready", "since=1&state=claimed"]) {
    throwsHttp(() => page(bad), 400, "invalid_input");
  }
  // limit composes but never truncates the delta.
  const limited = page("since=0&limit=1");
  assert.equal(limited.claims.length, 3, "delta is never truncated by limit (an unpageable truncation)");
  // view composes.
  assert.equal(page("since=0&view=summary").claims.length, 3);
});

// --- ?fast=1 cross-check ------------------------------------------------------

test("delta: no ?fast=1 param exists on the board route — unknown params stay 422", () => {
  // The task asked to cross-check delta against a ?fast=1 fast path; no such
  // param exists on the work-claims board in this base (or on the
  // wave300-fanout-perf F3 branch). This pins the current behavior so a
  // future fast path cannot silently change the unknown-param contract.
  const items = stamped([mkClaim("c1")]);
  assert.throws(
    () => buildWorkClaimPage(items, ROOM, VIEWER, new URLSearchParams("fast=1"), NOW, 1),
    error => error instanceof ServiceError && error.status === 422);
});

// --- Durable registry (sqlite) -------------------------------------------------

test("delta: durable registry set() stamps boardSeq; delete() advances the seq with no tombstones", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  assert.equal(registry.boardSeq(ROOM), 0);
  registry.set(ROOM, mkClaim("c1"));
  registry.set(ROOM, mkClaim("c2", "grok"));
  assert.equal(registry.boardSeq(ROOM), 2);
  assert.equal(registry.get(ROOM, "c1").boardSeq, 1);

  // A pre-F3 row (written before the seq table existed) reads back as seq 0.
  const seqBeforeDelete = registry.boardSeq(ROOM);
  registry.delete(ROOM, "c1");
  assert.equal(registry.boardSeq(ROOM), seqBeforeDelete + 1, "deletion advances the board seq");
  const page = buildWorkClaimPage(registry.list(ROOM), ROOM, VIEWER,
    new URLSearchParams(`since=${seqBeforeDelete}`), NOW, registry.boardSeq(ROOM));
  assert.deepEqual(page.claims, [],
    "no tombstones ship: the seq jumps but the delta is empty, so a caching " +
    "client that sees the jump without matching deltas must re-fetch the full page");
});

test("delta: durable registry survives a seq-table-less database (lazy creation)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  // boardSeq() must not throw on a database that predates the F3 table.
  assert.equal(registry.boardSeq(ROOM), 0);
});
