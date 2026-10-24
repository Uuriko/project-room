// #3464 / #3465: one stored claim row with a malformed `repo` wedged the
// production claim-prs sweep from 2026-10-13T23:57Z onward (380+ consecutive
// failed ticks, checked:0). The durable registry decodes rows WITHOUT
// validation while every state-machine touch re-validates, and the sweep's
// first phase touches every row in every room — so a single poisoned row
// (written verbatim by the work-item-board backfill from the projection's
// free-form `repository`, #3465) aborted the whole tick before any polling.
// These tests pin the two-sided fix: the sweep skips and NAMES invalid rows
// per item instead of wedging, and the backfill validates mapped rows
// through the state machine and never stores an invalid one.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength, roomWorkClaimConfig } from "../server/work-claims.mjs";
import { syncWorkItemClaim } from "../server/work-item-board.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { syncClaimPullRequests, sweepStaleUnclaimedClaims } from "../server/claim-pr-sync.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const NOW = Date.UTC(2026, 9, 14, 19, 0, 0);
const HOUR = 3600_000;
const REPO_ERROR = /repo must be 1\.\.200 characters/;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  return { store: { db, workClaims: registry }, registry };
}

function seedGoodDue(registry, roomId = "aaa-good") {
  let item = claimWork(
    createWork({ id: "good-claim" }, { now: NOW - HOUR, agentId: "agent-a" }),
    "agent-a", { now: NOW - HOUR, leaseHours: null });
  item = appendWorkPullRequest(item, "agent-a", {
    pullRequest: "https://github.com/Uuriko/project-room/pull/2479",
    expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item),
    now: NOW - HOUR
  });
  registry.set(roomId, item);
}

// Written exactly the way the pre-fix backfill wrote: straight through
// registry.set(), never through the state machine.
function seedPoison(registry, repo, { roomId = "zzz-bad", id = "poison-claim", mutate = null } = {}) {
  const base = createWork({ id }, { now: NOW - HOUR, agentId: "agent-b" });
  registry.set(roomId, mutate ? mutate({ ...base, repo }) : { ...base, repo });
}

const openFetch = calls => async url => {
  calls.push(String(url));
  return {
    status: 200, ok: true, headers: { get: () => null },
    text: async () => JSON.stringify({ state: "open", merged: false, head: { sha: "a".repeat(40) } })
  };
};

test("one malformed-repo row no longer wedges the sweep; it is skipped and named", async () => {
  const { store, registry } = setup();
  seedGoodDue(registry);
  seedPoison(registry, "https://github.com/Uuriko/project-room");
  const calls = [];
  const out = await syncClaimPullRequests(store, { fetchImpl: openFetch(calls), nowMs: NOW, token: null, env: {} });
  assert.equal(out.checked, 1, "the good room's due claim is still polled");
  assert.ok(calls.length >= 1, "GitHub was actually called");
  assert.equal(out.skippedInvalid, 1);
  assert.equal(out.skippedInvalidItems[0].roomId, "zzz-bad");
  assert.equal(out.skippedInvalidItems[0].claimId, "poison-claim");
  assert.match(out.skippedInvalidItems[0].error, REPO_ERROR);
});

test("control: without the poisoned row the same store sweeps clean", async () => {
  const { store, registry } = setup();
  seedGoodDue(registry);
  const out = await syncClaimPullRequests(store, { fetchImpl: openFetch([]), nowMs: NOW, token: null, env: {} });
  assert.equal(out.checked, 1);
  assert.equal(out.skippedInvalid, undefined);
});

for (const [label, repo] of [
  ["ssh form", "git@github.com:Uuriko/project-room.git"],
  ["space in name", "Uuriko/project room"],
  ["201 chars", "a".repeat(201)],
  ["non-string", 123],
  ["tilde path", "~/project-room"]
]) {
  test(`poison shape is skipped, not fatal: ${label}`, async () => {
    const { store, registry } = setup();
    seedGoodDue(registry);
    seedPoison(registry, repo);
    const out = await syncClaimPullRequests(store, { fetchImpl: openFetch([]), nowMs: NOW, token: null, env: {} });
    assert.equal(out.checked, 1);
    assert.equal(out.skippedInvalid, 1);
  });
}

for (const repo of ["Uuriko/project-room", "github.com/Uuriko/project-room", "Uuriko/project-room.git"]) {
  test(`valid stored repo shape sweeps without a skip: ${repo}`, async () => {
    const { store, registry } = setup();
    seedGoodDue(registry);
    seedPoison(registry, repo);
    const out = await syncClaimPullRequests(store, { fetchImpl: openFetch([]), nowMs: NOW, token: null, env: {} });
    assert.equal(out.checked, 1);
    assert.equal(out.skippedInvalid, undefined);
  });
}

test("expired-lease poison is skipped while a valid expired lease still releases", async () => {
  const { store, registry } = setup();
  const expiredClaim = (id, owner) => claimWork(
    createWork({ id }, { now: NOW - 3 * HOUR, agentId: owner }),
    owner, { now: NOW - 3 * HOUR, leaseHours: 1 });
  registry.set("room-a", { ...expiredClaim("poison-lease", "agent-b"), repo: "https://github.com/Uuriko/project-room" });
  registry.set("room-b", expiredClaim("good-lease", "agent-c"));
  const out = await syncClaimPullRequests(store, { fetchImpl: openFetch([]), nowMs: NOW, token: null, env: {} });
  assert.equal(registry.get("room-b", "good-lease").state, "unclaimed", "the valid lapsed lease is released");
  assert.equal(registry.get("room-a", "poison-lease").state, "claimed", "the invalid row is left for operator cleanup, untouched");
  assert.ok(out.skippedInvalid >= 1, "the poisoned lease row is reported");
  assert.ok(out.skippedInvalidItems.some(entry => entry.claimId === "poison-lease"));
});

test("stale-unclaimed sweep: a dormant poisoned row is named while the valid dormant row closes", async () => {
  const { store, registry } = setup();
  registry.configure("room-x", { staleSweep: true });
  const old = NOW - 30 * 24 * HOUR;
  registry.set("room-x", { ...createWork({ id: "dormant-poison" }, { now: old, agentId: "agent-b" }), repo: "Uuriko/project room" });
  registry.set("room-x", createWork({ id: "dormant-valid" }, { now: old, agentId: "agent-c" }));
  const skipped = [];
  const closed = sweepStaleUnclaimedClaims(store, NOW, { force: true, skipped });
  assert.equal(closed, 1);
  assert.equal(registry.get("room-x", "dormant-valid").state, "closed");
  assert.equal(registry.get("room-x", "dormant-poison").state, "unclaimed");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].claimId, "dormant-poison");
  assert.match(skipped[0].error, REPO_ERROR);
});

test("backfill validates mapped rows: a URL repository is reported, never stored (#3465)", t => {
  const dir = mkdtempSync(join(tmpdir(), "claimprs-writer-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { workItemBoardBackfill: "manual" });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-worker", type: "member.added",
    data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] }
  });
  const workerKey = store.issueAccessKey("commons", "worker");
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  const revisionOf = id => store.room("commons").state.workItems[id].revision;
  const drive = (workItemId, repository) => {
    send(ownerKey, `propose-${workItemId}`, "work.proposed", {
      workItemId, title: `Task ${workItemId}`, definitionOfDone: "Done", accountableMemberId: "worker", mode: "write"
    });
    send(workerKey, `accept-${workItemId}`, "work.accepted", { workItemId, expectedRevision: revisionOf(workItemId) });
    send(workerKey, `claim-${workItemId}`, "claim.acquired", {
      workItemId, expectedRevision: revisionOf(workItemId),
      repository, ref: "main", paths: ["server/**"], expiresAt: new Date(Date.now() + 2 * HOUR).toISOString()
    });
  };
  drive("task-url", "https://github.com/Uuriko/project-room");
  drive("task-ok", "Uuriko/project-room");
  // Stage the legacy state: board rows gone, backfill rebuilds from the log.
  store.db.prepare("DELETE FROM work_claims WHERE room_id='commons'").run();
  const report = store.backfillRoomWorkItemClaims("commons");
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /task-url/);
  assert.match(report.errors[0], REPO_ERROR);
  assert.equal(store.workClaims.get("commons", "task-url"), null, "the invalid row is not stored");
  assert.equal(store.workClaims.get("commons", "task-ok")?.state, "claimed", "the valid row is stored");
  assert.equal(report.created, 1);
});

// ---------------------------------------------------------------------------
// find:work-item-board-002: the LIVE sync door (syncWorkItemClaim, called by
// RoomStore.command inside the command transaction) stored the same mapped
// rows with NO workOf validation, re-opening the #3464 poisoned-row class
// the backfill door was hardened against in #3465. The sync must mirror the
// backfill exactly: a mapped row that fails workOf is never stored (and
// never emits a board event), valid rows in the same plan still write, and
// the surrounding command is NOT rolled back — the claim itself stays in
// the projection, exactly as a backfill report leaves it there.

function syncSetup(t) {
  const dir = mkdtempSync(join(tmpdir(), "claimprs-sync-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { workItemBoardBackfill: "manual" });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-worker", type: "member.added",
    data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] }
  });
  const workerKey = store.issueAccessKey("commons", "worker");
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  const revisionOf = id => store.room("commons").state.workItems[id].revision;
  const drive = (workItemId, claim) => {
    send(ownerKey, `propose-${workItemId}`, "work.proposed", {
      workItemId, title: `Task ${workItemId}`, definitionOfDone: "Done", accountableMemberId: "worker", mode: "write"
    });
    send(workerKey, `accept-${workItemId}`, "work.accepted", { workItemId, expectedRevision: revisionOf(workItemId) });
    send(workerKey, `claim-${workItemId}`, "claim.acquired", {
      workItemId, expectedRevision: revisionOf(workItemId),
      ref: "main", paths: ["server/**"], expiresAt: new Date(Date.now() + 2 * HOUR).toISOString(), ...claim
    });
  };
  const boardActions = claimId => store.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence").all()
    .map(row => JSON.parse(row.body))
    .filter(event => event.type === "work_claim.updated" && event.data?.workClaim === claimId)
    .map(event => event.data.action);
  return { store, drive, boardActions };
}

for (const [label, repository] of [
  ["full URL", "https://github.com/Uuriko/project-room"],
  ["ssh form", "git@github.com:Uuriko/project-room.git"],
  ["space in name", "Uuriko/project room"],
  ["201 chars", "a".repeat(201)],
  ["tilde path", "~/project-room"]
]) {
  test(`sync door: a claim carrying a poisoned repository is never stored (${label})`, t => {
    const { store, drive, boardActions } = syncSetup(t);
    drive("task-sync-poison", { repository });
    // The claim itself is recorded in the projection (the sync's rejection
    // is board-side only, exactly like the backfill's) ...
    assert.equal(store.room("commons").state.workItems["task-sync-poison"].claim.repository, repository);
    // ... but the poisoned mapped row is NOT stored over the valid
    // unclaimed card the accept step wrote: no claimed card, no repo, and
    // no "claimed" board event.
    const card = store.workClaims.get("commons", "task-sync-poison");
    assert.equal(card.state, "unclaimed");
    assert.equal(card.repo, null);
    assert.equal(card.owner, null);
    assert.deepEqual(boardActions("task-sync-poison"), ["created"]);
    // Parity with the backfill door: the same room's backfill names the
    // row as an error and still does not store it.
    const report = store.backfillRoomWorkItemClaims("commons");
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /task-sync-poison/);
    assert.match(report.errors[0], REPO_ERROR);
    assert.equal(store.workClaims.get("commons", "task-sync-poison").state, "unclaimed");
    assert.equal(store.workClaims.get("commons", "task-sync-poison").repo, null);
  });
}

test("sync door: a poisoned claim does not block a valid sibling in the same room", t => {
  const { store, drive, boardActions } = syncSetup(t);
  drive("task-sync-url", { repository: "https://github.com/Uuriko/project-room" });
  drive("task-sync-ok", { repository: "Uuriko/project-room" });
  const ok = store.workClaims.get("commons", "task-sync-ok");
  assert.equal(ok.state, "claimed", "the valid sibling's row is stored by the sync");
  assert.equal(ok.repo, "Uuriko/project-room");
  assert.deepEqual(boardActions("task-sync-ok"), ["created", "claimed"]);
  assert.equal(store.workClaims.get("commons", "task-sync-url").repo, null);
  assert.equal(store.workClaims.get("commons", "task-sync-url").state, "unclaimed");
});

for (const [label, ref] of [
  ["full URL", "https://github.com/Uuriko/project-room/tree/main"],
  ["colon", "feat:main"],
  ["201 chars", "b".repeat(201)]
]) {
  test(`sync door: a claim carrying a poisoned ref (branch) is never stored (${label})`, t => {
    const { store, drive } = syncSetup(t);
    drive("task-sync-branch", { repository: "Uuriko/project-room", ref });
    const card = store.workClaims.get("commons", "task-sync-branch");
    assert.equal(card.state, "unclaimed");
    assert.equal(card.branch, null);
    const report = store.backfillRoomWorkItemClaims("commons");
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /branch must be 1\.\.200 characters/);
  });
}

// Shapes live admission (claim-scopes) refuses at the command door today —
// a non-string repository, absolute/escaping claim paths, an over-cap tag
// list — still reach the sync from legacy/replayed projections, so they are
// driven through syncWorkItemClaim directly with the same state shapes the
// reducer produces. A store without a room() method makes
// emitWorkClaimEvent a no-op, so every registry.set below is the sync's own.
const T0 = "2026-10-01T00:00:00.000Z";
const atIso = hours => new Date(Date.parse(T0) + hours * HOUR).toISOString();

function directSyncSetup() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (room_id TEXT, sequence INTEGER, id TEXT, body TEXT)");
  const rows = new Map();
  const setCalls = [];
  const registry = {
    get: (roomId, id) => rows.get(id) ?? null,
    set: (roomId, row) => { setCalls.push(row.id); rows.set(row.id, row); },
    list: () => [...rows.values()],
    configFor: () => roomWorkClaimConfig({ workClaims: {} })
  };
  const item = (id, claimOverrides = {}, itemOverrides = {}) => ({
    id, title: `Task ${id}`, state: "accepted", proposedById: "owner",
    accountableMemberId: "worker", verifierMemberId: null, humanDecisionMakerId: null,
    ownerDecisionRequired: false, independentVerificationRequired: false,
    definitionOfDone: "done", labels: [], mode: "write", sourceMessageId: null,
    createdAt: T0, updatedAt: T0, revision: 1,
    receipt: null, receiptHistory: [], verification: null, verificationHistory: [],
    decision: null, decisionHistory: [], blocker: null, supersededBy: null,
    claim: {
      holderId: "worker", repository: "Uuriko/project-room", ref: "main",
      paths: ["server/**"], status: "active", acquiredAt: atIso(2), expiresAt: atIso(30),
      ...claimOverrides
    },
    ...itemOverrides
  });
  const run = (items, workItemId) => syncWorkItemClaim(
    { db, workClaims: registry }, "room-1", "worker",
    { type: "claim.acquired", at: atIso(3), data: { workItemId } },
    { workItems: Object.fromEntries(items.map(entry => [entry.id, entry])) });
  return { registry, rows, setCalls, item, run };
}

for (const [label, claimOverrides, itemOverrides] of [
  ["non-string repository", { repository: 123 }, {}],
  ["absolute claim path", { paths: ["/abs/path.js"] }, {}],
  ["escaping claim path", { paths: ["../escape.js"] }, {}],
  ["over-cap tag list (11 labels)", {}, { labels: Array.from({ length: 11 }, (_, i) => `tag${i}`) }]
]) {
  test(`sync door (direct): a mapped row the guard rejects is never stored (${label})`, () => {
    const { rows, setCalls, item, run } = directSyncSetup();
    const result = run([item("task-direct", claimOverrides, itemOverrides)], "task-direct");
    assert.equal(result, null, "no primary row is returned for a rejected mapping");
    assert.deepEqual(setCalls, [], "registry.set is never called");
    assert.equal(rows.size, 0);
  });
}

test("sync door (direct): valid sibling in the same plan is stored, poisoned primary is not", () => {
  const { rows, item, run } = directSyncSetup();
  run([
    item("task-direct-ok"),
    item("task-direct-poison", { repository: "https://github.com/Uuriko/project-room" })
  ], "task-direct-poison");
  assert.equal(rows.get("task-direct-ok")?.state, "claimed", "the valid planned row is written");
  assert.equal(rows.get("task-direct-ok")?.repo, "Uuriko/project-room");
  assert.equal(rows.has("task-direct-poison"), false, "the poisoned row is not written");
});

test("sync door (direct): a clean claim still syncs (control)", () => {
  const { rows, item, run } = directSyncSetup();
  const result = run([item("task-direct-clean")], "task-direct-clean");
  assert.equal(result?.id, "task-direct-clean");
  assert.equal(rows.get("task-direct-clean")?.state, "claimed");
  assert.equal(rows.get("task-direct-clean")?.repo, "Uuriko/project-room");
  assert.equal(rows.get("task-direct-clean")?.branch, "main");
});
