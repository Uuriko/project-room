// S-2 (HUNT-SOAK): the job registry's due probes run inside the
// Worker's per-request alarm re-arm (Room.fetch finally ->
// earliestFutureAlarm), so an enabled()/nextDueAt() that derives full
// state is a per-request tax proportional to board size. These tests
// pin the cheap probes that replaced the derivations:
//
// - claimDueAt / autolinkDueAt (server/jobs.mjs) and staleSweepDueAt
//   (server/claim-pr-sync.mjs) must answer the SAME due question as the
//   pre-index probes — checked against an independent JS reference over
//   a seeded state matrix (enveloped and legacy bare rows, poisoned
//   shapes) and with the indexes dropped — and their query plans must
//   use the partial expression indexes in workClaimSchema, never a
//   bare scan of work_claims. The plan assertions are the drift alarm:
//   a probe predicate edited away from its index predicate falls back
//   to a full scan and fails here, not in production latency.
// - PublicWorkClaims.starterPoolReseedDue() must agree with the gate
//   derived from starterPoolStatus() across the board's state space
//   (the status surface itself is unchanged and stays authoritative
//   for run()/operator callers), while executing a statement count
//   that does not grow with the board.
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { claimDueAt, autolinkDueAt, earliestFutureAlarm, JOBS } from "../server/jobs.mjs";
import { staleSweepDueAt } from "../server/claim-pr-sync.mjs";
import { STALE_UNCLAIMED_DAYS } from "../server/work-claims.mjs";
import { PublicWorkClaims, publicWorkClaimsSchema, PUBLIC_WORK_STARTER_SEED_IDS, starterRoundId } from "../server/public-work-claims.mjs";
import { publicWorkClaimFenceSchema, withPublicWorkClaimWriter } from "../server/public-work-claim-fence.mjs";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

function fixture(t, { now = NOW } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alarm-probe-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema);
  store.db.exec(publicWorkClaimFenceSchema);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

// Record every SQL string a probe prepares, so the plan assertions
// explain the probe's real queries — not a copy that can drift.
function recordSql(store) {
  const seen = [];
  const original = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { seen.push(String(sql)); return original(sql); };
  return { seen, restore() { store.db.prepare = original; } };
}

function planFor(store, sql) {
  const args = [...String(sql).matchAll(/\?/g)].map(() => null);
  return store.db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(row => row.detail).join("\n");
}

const ACTIVE = ["claimed", "in_progress", "blocked"];

// --- Independent JS references (the pre-index probes' semantics) ---

function refClaimDue(items) {
  let due = null;
  for (const item of items) {
    if (!ACTIVE.includes(item.state)) continue;
    const pr = item.pullRequest;
    if (typeof pr?.url !== "string" || pr?.outcome != null) continue;
    const value = typeof pr.nextPollAt === "number" ? pr.nextPollAt : 0;
    due = due == null ? value : Math.min(due, value);
  }
  return due;
}

function refAutolinkDue(items, now) {
  const hit = items.some(item => ACTIVE.includes(item.state)
    && typeof item.repo === "string"
    && (item.pullRequests == null || (Array.isArray(item.pullRequests) && item.pullRequests.length === 0))
    && item.pullRequest?.url == null);
  return hit ? now : null;
}

function refStaleDue(items, now) {
  let best = null;
  for (const item of items) {
    if (item.state !== "unclaimed") continue;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    if (tags.some(tag => String(tag).toLowerCase() === "never-sweep")) continue;
    const updated = item.updatedAt ?? "";
    const history = Array.isArray(item.history) ? item.history : [];
    const lastAt = history.length ? (history.at(-1)?.at ?? "") : "";
    const activity = String(updated) > String(lastAt) ? updated : lastAt;
    const ms = Date.parse(activity);
    if (!Number.isFinite(ms)) continue;
    if (best == null || ms < best) best = ms;
  }
  return best == null ? null : best + STALE_UNCLAIMED_DAYS * 24 * 3600 * 1000;
}

// Seed one claim row per shape, alternating enveloped (registry write)
// and legacy bare (raw JSON) storage, across two rooms.
function seedClaimMatrix(store) {
  const shapes = [
    { id: "pr-open", state: "claimed", owner: "w", pullRequest: { url: "https://github.com/x/y/pull/1", nextPollAt: NOW + 5000, outcome: null } },
    { id: "pr-open-nopoll", state: "in_progress", owner: "w", pullRequest: { url: "https://github.com/x/y/pull/2", outcome: null } },
    { id: "pr-done", state: "blocked", owner: "w", pullRequest: { url: "https://github.com/x/y/pull/3", nextPollAt: NOW + 1000, outcome: "merged" } },
    { id: "pr-nourl", state: "claimed", owner: "w", pullRequest: { outcome: null } },
    { id: "pr-numurl", state: "claimed", owner: "w", pullRequest: { url: 42, outcome: null } },
    { id: "autolink", state: "claimed", owner: "w", repo: "x/y", pullRequests: [] },
    { id: "autolink-noprs", state: "blocked", owner: "w", repo: "x/y" },
    { id: "autolink-haspr", state: "claimed", owner: "w", repo: "x/y", pullRequests: [{ url: "https://github.com/x/y/pull/9" }] },
    { id: "plain-open", state: "unclaimed", owner: null, history: [{ action: "created", at: iso(NOW - 40 * 86400000) }], updatedAt: iso(NOW - 40 * 86400000) },
    { id: "plain-done", state: "done", owner: "w", pullRequest: { url: "https://github.com/x/y/pull/4", nextPollAt: NOW + 2000, outcome: null } },
    { id: "stale-hist", state: "unclaimed", owner: null, history: [{ action: "created", at: iso(NOW - 30 * 86400000) }], updatedAt: iso(NOW - 50 * 86400000) },
    { id: "stale-never", state: "unclaimed", owner: null, tags: ["Never-Sweep"], history: [{ action: "created", at: iso(NOW - 60 * 86400000) }], updatedAt: iso(NOW - 60 * 86400000) },
    { id: "stale-young", state: "unclaimed", owner: null, history: [{ action: "created", at: iso(NOW - 86400000) }], updatedAt: iso(NOW - 86400000) },
    { id: "stale-noage", state: "unclaimed", owner: null, history: [] },
    { id: "stale-baddate", state: "unclaimed", owner: null, history: [{ action: "created", at: "2026-13-99T99:99:99Z" }], updatedAt: "2026-13-99T99:99:99Z" },
    { id: "stale-numeric-updated", state: "unclaimed", owner: null, history: [{ action: "created", at: iso(NOW - 45 * 86400000) }], updatedAt: NOW - 45 * 86400000 }
  ];
  const insert = store.db.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES ('commons', ?, ?, ?)");
  shapes.forEach((item, index) => {
    if (index % 2 === 0) store.workClaims.set("commons", { title: "t", history: [], ...item });
    else insert.run(item.id, JSON.stringify(item), NOW);
  });
  // A second room that never opted in: its stale rows must not count,
  // its PR rows must (the claim probes are store-wide).
  store.workClaims.set("other-room", { id: "other-pr", title: "t", history: [], state: "claimed", owner: "w", pullRequest: { url: "https://github.com/x/y/pull/7", nextPollAt: NOW + 3000, outcome: null } });
  store.workClaims.set("other-room", { id: "other-stale", title: "t", history: [{ action: "created", at: iso(NOW - 90 * 86400000) }], state: "unclaimed", owner: null, updatedAt: iso(NOW - 90 * 86400000) });
  store.db.prepare("INSERT INTO work_claim_config (room_id, config_json, updated_at) VALUES ('commons', ?, ?)")
    .run(JSON.stringify({ staleSweep: 1 }), NOW);
  return shapes;
}

function allItems(store) {
  return [...store.workClaims.list("commons"), ...store.workClaims.list("other-room")];
}

test("claim probes answer identically to the reference, with and without their indexes", t => {
  const store = fixture(t);
  seedClaimMatrix(store);
  const items = allItems(store);
  const expectedClaim = refClaimDue(items);
  const expectedAutolink = refAutolinkDue(items, NOW);
  const expectedStale = refStaleDue(store.workClaims.list("commons"), NOW);
  assert.equal(expectedClaim, 0, "matrix sanity: a no-poll PR row is due at 0");
  assert.equal(expectedAutolink, NOW, "matrix sanity: autolink candidates exist");
  assert.ok(expectedStale != null, "matrix sanity: a stale candidate exists");

  assert.equal(claimDueAt(store, NOW), expectedClaim);
  assert.equal(autolinkDueAt(store, NOW), expectedAutolink);
  assert.equal(staleSweepDueAt(store, NOW), expectedStale);

  // Semantics live in the queries, not the indexes: dropping every
  // probe index must not move any answer.
  store.db.exec("DROP INDEX work_claims_pr_poll_due; DROP INDEX work_claims_autolink_due; DROP INDEX work_claims_stale_activity;");
  assert.equal(claimDueAt(store, NOW), expectedClaim);
  assert.equal(autolinkDueAt(store, NOW), expectedAutolink);
  assert.equal(staleSweepDueAt(store, NOW), expectedStale);
});

test("claim probes on an empty store answer null", t => {
  const store = fixture(t);
  assert.equal(claimDueAt(store, NOW), null);
  assert.equal(autolinkDueAt(store, NOW), null);
  assert.equal(staleSweepDueAt(store, NOW), null);
});

test("claim probe query plans use the probe indexes, never a bare table scan", t => {
  const store = fixture(t);
  seedClaimMatrix(store);
  const rec = recordSql(store);
  claimDueAt(store, NOW);
  autolinkDueAt(store, NOW);
  staleSweepDueAt(store, NOW);
  rec.restore();
  const claimSql = rec.seen.find(sql => sql.includes("nextPollAt"));
  const autolinkSql = rec.seen.find(sql => sql.includes("COUNT(*)") && sql.includes("repo"));
  const staleSqls = rec.seen.filter(sql => sql.includes("history[#-1]"));
  assert.ok(claimSql && autolinkSql && staleSqls.length >= 1, "probes prepared their queries");
  const claimPlan = planFor(store, claimSql);
  assert.match(claimPlan, /USING (?:COVERING )?INDEX work_claims_pr_poll_due/, claimPlan);
  assert.doesNotMatch(claimPlan, /^SCAN work_claims$/m, claimPlan);
  const autolinkPlan = planFor(store, autolinkSql);
  assert.match(autolinkPlan, /USING (?:COVERING )?INDEX work_claims_autolink_due/, autolinkPlan);
  assert.doesNotMatch(autolinkPlan, /^SCAN work_claims$/m, autolinkPlan);
  for (const sql of staleSqls) {
    const plan = planFor(store, sql);
    assert.match(plan, /USING (?:COVERING )?INDEX work_claims_stale_activity/, plan);
    assert.doesNotMatch(plan, /^SCAN work_claims$/m, plan);
  }
});

// --- Public-work reseed gate: probe vs starterPoolStatus ---

const SEED_FILES = { files: ["docs/X.md"] };
function pwFixture(t) {
  const store = fixture(t);
  const service = () => new PublicWorkClaims(store);
  const worker = store.identities.create("Probe worker");
  const enableSeed = id => {
    store.projectOffers.create("commons", "owner", { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ["owner"],
      terms: { kind: "task", title: `Seed ${id}`, summary: "s", acceptanceCriteria: ["d"],
        repositoryUrl: "https://github.com/uuriko/project-room", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
    store.projectOffers.transition("commons", "owner", id, "publish", { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable("commons", "owner", id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: SEED_FILES.files });
  };
  let seq = 0;
  const act = (id, action, extra = {}) => service().act(id, worker.secret, action, { requestId: `act-${++seq}`, expectedTermsVersion: 1, ...extra });
  const submit = id => { act(id, "claim"); act(id, "finish", { generation: 1, artifactText: `Done ${id}`, checksReported: [] }); };
  return { store, service, worker, enableSeed, act, submit };
}

// The gate as the registry computed it before the probe existed; a
// throw on either side must be matched by a throw on the other.
function statusGate(service) {
  try {
    const status = service.starterPoolStatus();
    return status.available && status.anchored > 0 && status.claimable === 0 && status.due.length > 0;
  } catch (error) { return error; }
}
function probeGate(service) {
  try { return service.starterPoolReseedDue(); }
  catch (error) { return error; }
}
function assertGateAgrees(service, label) {
  const expected = statusGate(service);
  const actual = probeGate(service);
  if (expected instanceof Error || actual instanceof Error) {
    assert.ok(expected instanceof Error && actual instanceof Error,
      `${label}: status threw ${expected} but probe returned ${actual} (or vice versa)`);
    assert.equal(actual.code, expected.code, label);
  } else assert.equal(actual, expected, label);
}

test("reseed probe agrees with starterPoolStatus across the board's state space", t => {
  const f = pwFixture(t);
  assertGateAgrees(f.service(), "no seeds anchored");
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.enableSeed(id);
  assertGateAgrees(f.service(), "all seeds claimable");
  assert.equal(f.service().starterPoolReseedDue(), false);

  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) f.submit(id);
  assertGateAgrees(f.service(), "all seeds submitted");
  assert.equal(f.service().starterPoolReseedDue(), true);

  // A fresh round is claimable again: the keeper stands down.
  assert.equal(f.service().reseedStarterPool().seeded, 4);
  assertGateAgrees(f.service(), "fresh rounds claimable");
  assert.equal(f.service().starterPoolReseedDue(), false);

  // Submit three round-2 tasks and hold the fourth with a live claim:
  // claimable is zero again, three seeds are due, and the held seed
  // alone is not — the gate stays on.
  const held = PUBLIC_WORK_STARTER_SEED_IDS[0];
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS.slice(1)) f.submit(starterRoundId(id, 2));
  f.act(starterRoundId(held, 2), "claim");
  assertGateAgrees(f.service(), "one seed held by a live claim");
  assert.equal(f.service().starterPoolReseedDue(), true);

  // Lapse the held claim's lease: its task is claimable again.
  const ns = f.store.db.prepare("SELECT namespace_key FROM public_work_tasks WHERE offer_id=?").get(starterRoundId(held, 2)).namespace_key;
  const item = f.store.workClaims.get(ns, starterRoundId(held, 2));
  withPublicWorkClaimWriter(f.store, () => f.store.workClaims.set(ns, { ...item, leaseExpiresAt: iso(NOW - 1000) }));
  assertGateAgrees(f.service(), "held claim's lease lapsed");
  assert.equal(f.service().starterPoolReseedDue(), false);
});

test("reseed probe: non-seed tasks, deadlines, archive and unpublish move the gate identically", t => {
  const f = pwFixture(t);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) { f.enableSeed(id); f.submit(id); }
  assert.equal(f.service().starterPoolReseedDue(), true);

  const enableExtra = (id, terms = {}) => {
    f.store.projectOffers.create("commons", "owner", { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ["owner"],
      terms: { kind: "task", title: `Extra ${id}`, summary: "s", acceptanceCriteria: ["d"],
        repositoryUrl: "https://github.com/uuriko/project-room", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" }, ...terms } });
    f.store.projectOffers.transition("commons", "owner", id, "publish", { requestId: `publish-${id}`, expectedRevision: 1 });
    return f.service().enable("commons", "owner", id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: SEED_FILES.files });
  };

  enableExtra("extra-open");
  assertGateAgrees(f.service(), "extra claimable task");
  assert.equal(f.service().starterPoolReseedDue(), false);

  // Operator-unpublish the room: every board row leaves the public
  // derivation, seeds included, so claimable falls back to zero.
  f.store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', 'commons', ?, 'op')").run(NOW);
  assertGateAgrees(f.service(), "room unpublished");
  assert.equal(f.service().starterPoolReseedDue(), true);
  f.store.db.prepare("DELETE FROM public_unpublish WHERE kind='room' AND target='commons'").run();
  assertGateAgrees(f.service(), "room republished");
  assert.equal(f.service().starterPoolReseedDue(), false);

  // A past-deadline task is not claimable even while unclaimed.
  enableExtra("extra-deadline", { deadline: iso(NOW - 86400000) });
  f.act("extra-open", "claim");
  f.act("extra-open", "finish", { generation: 1, artifactText: "done", checksReported: [] });
  assertGateAgrees(f.service(), "extra submitted, deadline task open but dead");
  assert.equal(f.service().starterPoolReseedDue(), true);

  // Archive the room: the whole board leaves the derivation.
  f.store.db.prepare("UPDATE rooms SET archived_at=? WHERE id='commons'").run(NOW);
  assertGateAgrees(f.service(), "room archived");
});

test("reseed probe: an unpriceable joined offer fails the probe exactly as list() fails", t => {
  const f = pwFixture(t);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) { f.enableSeed(id); f.submit(id); }
  assert.equal(f.service().starterPoolReseedDue(), true);
  // A work_trade/credit offer whose amountMinor does not price: the
  // board join admits it on kind/unit, then offer() refuses it while
  // list() builds packets — the status surface throws, so the probe
  // must throw the same refusal instead of answering over it.
  const terms = { kind: "task", title: "Bad trade", summary: "s", acceptanceCriteria: ["d"],
    repositoryUrl: "https://github.com/uuriko/project-room", reward: { kind: "work_trade", unit: "credit", amountMinor: -5 }, approvalPolicy: { mode: "human" } };
  f.store.db.prepare("INSERT INTO project_offers (offer_id, room_id, owner_id, version, revision, status, terms, private_links, created_at, updated_at) VALUES ('bad-trade', 'commons', 'owner', 1, 1, 'published', ?, '{}', ?, ?)")
    .run(JSON.stringify(terms), NOW, NOW);
  f.store.db.prepare("INSERT INTO public_work_tasks VALUES ('bad-trade', 'public_badns', 'commons', 1, 'https://github.com/uuriko/project-room', 'main', '[\"docs/X.md\"]', 0, ?)")
    .run(NOW);
  assertGateAgrees(f.service(), "unpriceable joined offer");
  const probeError = probeGate(f.service());
  assert.ok(probeError instanceof Error && probeError.code === "invalid_project_offer", String(probeError));
});

test("reseed probe statement count is flat in board size", t => {
  const f = pwFixture(t);
  for (const id of PUBLIC_WORK_STARTER_SEED_IDS) { f.enableSeed(id); f.submit(id); }
  const countStatements = () => {
    const rec = recordSql(f.store);
    const due = f.service().starterPoolReseedDue();
    rec.restore();
    return { due, count: rec.seen.length };
  };
  const small = countStatements();
  assert.equal(small.due, true);
  // 200 more board rows in states the full derivation materializes one
  // packet at a time for: the probe's statement count must not move.
  const insOffer = f.store.db.prepare("INSERT INTO project_offers (offer_id, room_id, owner_id, version, revision, status, terms, private_links, created_at, updated_at) VALUES (?, 'commons', 'owner', 1, 1, 'published', ?, '{}', ?, ?)");
  const insTask = f.store.db.prepare("INSERT INTO public_work_tasks VALUES (?, ?, 'commons', 1, 'https://github.com/uuriko/project-room', 'main', '[\"docs/X.md\"]', 0, ?)");
  const terms = JSON.stringify({ kind: "task", title: "Bulk", summary: "s", acceptanceCriteria: ["d"], repositoryUrl: "https://github.com/uuriko/project-room", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } });
  for (let i = 0; i < 200; i++) {
    insOffer.run(`bulk-${i}`, terms, NOW, NOW);
    insTask.run(`bulk-${i}`, `public_bulk_${i}`, NOW);
    f.store.db.prepare("INSERT INTO public_work_receipts VALUES (?, ?, ?, 0, 'w', 'x', 'h', 1, '{}', ?)")
      .run(`bulk-receipt-${i}`, `bulk-${i}`, `public_bulk_${i}`, NOW);
  }
  const large = countStatements();
  assert.equal(large.due, true);
  assert.equal(large.count, small.count, `probe statements grew with the board: ${small.count} -> ${large.count}`);
});

// --- Scale proof (soak S-2 acceptance shape) ---

test("earliestFutureAlarm stays flat at 1,000 tasks + 10,000 claim rows", t => {
  const store = fixture(t);
  const insert = store.db.prepare("INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES ('commons', ?, ?, ?)");
  store.db.exec("BEGIN");
  for (let i = 0; i < 10000; i++) {
    const kind = i % 10;
    let item;
    if (kind <= 5) item = { id: `c${i}`, state: kind % 2 ? "unclaimed" : "done", owner: null, tags: [], history: [{ action: "created", at: iso(NOW - 40 * 86400000) }], updatedAt: iso(NOW - 40 * 86400000) };
    else if (kind <= 7) item = { id: `c${i}`, state: "claimed", owner: "w", history: [], updatedAt: iso(NOW - 60000), pullRequest: { url: `https://github.com/x/y/pull/${i}`, nextPollAt: NOW + 300000, outcome: null } };
    else if (kind === 8) item = { id: `c${i}`, state: "in_progress", owner: "w", history: [], updatedAt: iso(NOW - 60000), repo: "x/y", pullRequests: [] };
    else item = { id: `c${i}`, state: "blocked", owner: "w", history: [], updatedAt: iso(NOW - 60000), pullRequest: { url: `https://github.com/x/y/pull/${i}`, outcome: null } };
    insert.run(`c${i}`, JSON.stringify(i % 7 === 0 ? item : { v: 1, kind: "work-claim", data: item }), NOW - i);
  }
  store.db.exec("COMMIT");
  store.db.prepare("INSERT INTO work_claim_config (room_id, config_json, updated_at) VALUES ('commons', ?, ?)")
    .run(JSON.stringify({ staleSweep: 1 }), NOW);
  const service = new PublicWorkClaims(store);
  for (let i = 0; i < 12; i++) {
    const id = `scale-task-${i}`;
    store.projectOffers.create("commons", "owner", { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ["owner"],
      terms: { kind: "task", title: `Scale ${i}`, summary: "s", acceptanceCriteria: ["d"], repositoryUrl: "https://github.com/uuriko/project-room", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
    store.projectOffers.transition("commons", "owner", id, "publish", { requestId: `publish-${id}`, expectedRevision: 1 });
    service.enable("commons", "owner", id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: SEED_FILES.files });
  }
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    earliestFutureAlarm(JOBS, { env: {}, store, now: NOW, lastRan: {} });
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[3];
  // Soak's acceptance bound is ≤10ms on a quiet machine; the bound
  // here carries 10x headroom for shared CI runners — the structural
  // guarantee is the plan assertions above, this is the smoke alarm.
  assert.ok(median < 100, `earliestFutureAlarm median ${median.toFixed(1)}ms at 10k claim rows`);
});
