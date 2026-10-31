// claim-prs vs public-work namespaces (CP-DIAG diagnosis, CP-CENSUS G1–G5,
// CP-ADVERSARY verdict). Production claim-prs failed 307 consecutive ticks
// with "unsupported public claim writer: SQLITE_CONSTRAINT_TRIGGER": the
// sync's whole-registry phases selected rows whose room_id is a public-work
// namespace key and wrote to them, and the writer fence
// (server/public-work-claim-fence.mjs) aborts any non-permit write to a
// namespace row. In the lease sweep the aborting write was the release
// itself, so the lapsed public claim re-tripped every tick.
//
// The fix is jurisdiction, not admission: namespace partitions are the
// public-work door's sole lifecycle authority (generation-fenced,
// receipt-based, settled by escrow attach — never by PR outcome or board
// housekeeping), so the sync family never selects them for any transition.
// Every test below pairs a namespace row with a private-room control: the
// control takes the transition, the namespace row is not touched, and no
// fence abort is produced (or misreported as a skipped invalid row).
//
// Fixture: a real RoomStore over an injected in-memory database — the
// seam under test (registry upsert -> guard trigger) is storage-medium
// independent, and the suite stays hermetic.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork, claimWork, appendWorkPullRequest, claimHistoryLength } from "../server/work-claims.mjs";
import { recordPullOutcome } from "../server/claim-coordination.mjs";
import * as claimSync from "../server/claim-pr-sync.mjs";
const { syncClaimPullRequests, sweepStaleUnclaimedClaims, applyPullRequestWebhook, isPublicClaimNamespace, publicNamespaceSqlExclusion } = claimSync;
import { autoLinkPullRequest, linkDeployToSettledClaims } from "../server/claim-autolink.mjs";
import { withPublicWorkClaimWriter, verifyPublicWorkClaimFence } from "../server/public-work-claim-fence.mjs";
import { createDurableWorkClaimRegistry } from "../server/work-claim-sqlite.mjs";
import { SOURCE_REVISION } from "../server/version.mjs";
import { jobByName } from '../server/jobs.mjs';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const PR_URL = "https://github.com/Uuriko/project-room/pull/2479";
const MERGED_BODY = { state: "closed", merged: true, head: { sha: "a".repeat(40) }, merge_commit_sha: "b".repeat(40) };
const mergedFetch = async () => ({
  status: 200, ok: true, headers: { get: () => null },
  text: async () => JSON.stringify(MERGED_BODY), json: async () => MERGED_BODY
});
const neverFetch = async () => { throw new Error("network must not be used"); };

function fixture(t, offerId = "sync-public-task") {
  const store = new RoomStore("unused-injected-database.sqlite", { database: new DatabaseSync(":memory:") });
  store.initialize(initialRoom());
  t.after(() => store.close());
  store.projectOffers.create("commons", "owner", { requestId: "create", offerId, reviewerMemberIds: ["owner"],
    terms: { repositoryUrl: "https://github.com/Uuriko/project-room", kind: "project", title: "Sync public task",
      summary: "Disposable sync task", acceptanceCriteria: ["Return an artifact"], reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", offerId, "publish", { requestId: "publish", expectedRevision: 1 });
  const task = store.publicWorkClaims.enable("commons", "owner", offerId, {
    requestId: "enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["src/sync-proof.js"] });
  return { store, offerId, namespace: task.namespaceId };
}

function claimPublic(store, offerId, { leaseHours = 1 } = {}) {
  const identity = store.identities.create("Outside sync agent");
  store.publicWorkClaims.act(offerId, identity.secret, "claim", { requestId: "claim-1", expectedTermsVersion: 1, leaseHours });
  return identity;
}

// Persist a namespace row the way a permitted writer does.
function permitSet(store, namespace, item) {
  withPublicWorkClaimWriter(store, () => store.workClaims.set(namespace, item));
}

function linkItem(item, agentId) {
  return appendWorkPullRequest(item, agentId, {
    pullRequest: PR_URL,
    expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: claimHistoryLength(item),
    now: Date.now()
  });
}

test("G1: the tick releases a lapsed private claim and never selects the lapsed public claim", async t => {
  const { store, offerId, namespace } = fixture(t);
  const identity = claimPublic(store, offerId, { leaseHours: 1 });
  const claimed = store.workClaims.get(namespace, offerId);
  assert.equal(claimed.state, "in_progress");
  assert.equal(claimed.owner, identity.identityId);
  // Private control: a lapsed claim in a real room, same tick.
  const control = claimWork(createWork({ id: "sync-private-control", title: "Private control" }),
    "owner", { leaseHours: 1, now: Date.now() });
  store.workClaims.set("commons", control);

  let fetchCalls = 0;
  const countingFetch = async () => { fetchCalls += 1; throw new Error("network must not be used"); };
  const tickAt = Date.now() + 2 * HOUR;
  // Pre-fix this await throws 'unsupported public claim writer' out of the
  // lease sweep — the production failure — and no release persists.
  await syncClaimPullRequests(store, { env: {}, fetchImpl: countingFetch, nowMs: tickAt, token: null });

  const releasedPrivate = store.workClaims.get("commons", "sync-private-control");
  assert.equal(releasedPrivate.state, "unclaimed", "the private control releases in the same tick");
  assert.equal(releasedPrivate.owner, null);
  // The namespace row is the door's jurisdiction: the sync leaves it
  // exactly as it was; its release happens inside the door's next act().
  const publicAfter = store.workClaims.get(namespace, offerId);
  assert.equal(publicAfter.state, "in_progress", "the public claim is not the sync's to release");
  assert.equal(publicAfter.owner, identity.identityId);
  assert.equal(publicAfter.leaseExpiresAt, claimed.leaseExpiresAt);
  assert.equal(fetchCalls, 0);
  // No wedge: the next tick is clean too, and the permit rests closed.
  await syncClaimPullRequests(store, { env: {}, fetchImpl: countingFetch, nowMs: tickAt + HOUR, token: null });
  assert.equal(verifyPublicWorkClaimFence(store.db), true);
});

test("G5: the poll settles a private claim's merged PR and never selects a linked public claim", async t => {
  const { store, offerId, namespace } = fixture(t);
  const identity = claimPublic(store, offerId, { leaseHours: 6 });
  permitSet(store, namespace, linkItem(store.workClaims.get(namespace, offerId), identity.identityId));
  const privClaimed = claimWork(createWork({ id: "sync-poll-private" }), "owner", { leaseHours: 6, now: Date.now() });
  store.workClaims.set("commons", linkItem(privClaimed, "owner"));

  const out = await syncClaimPullRequests(store, { env: {}, fetchImpl: mergedFetch, nowMs: Date.now(), token: "t" });
  // Pre-fix the public claim IS selected; its commit set aborts inside the
  // batch transaction and is misrecorded as a skipped invalid row.
  assert.equal(out.updated, 1, "the private claim settles");
  assert.equal(out.skippedInvalid, undefined, "no row is misreported as invalid");
  const privAfter = store.workClaims.get("commons", "sync-poll-private");
  assert.equal(privAfter.state, "done");
  assert.equal(privAfter.pullRequest.outcome, "merged");
  const pubAfter = store.workClaims.get(namespace, offerId);
  assert.equal(pubAfter.state, "in_progress", "a door claim never settles by PR outcome");
  assert.equal(pubAfter.pullRequest.outcome, null);
  assert.equal(verifyPublicWorkClaimFence(store.db), true);
});

test("G5 sibling: a merged-PR webhook settles the private room and skips the namespace", async t => {
  const { store, offerId, namespace } = fixture(t);
  const identity = claimPublic(store, offerId, { leaseHours: 6 });
  permitSet(store, namespace, linkItem(store.workClaims.get(namespace, offerId), identity.identityId));
  const privClaimed = claimWork(createWork({ id: "sync-webhook-private" }), "owner", { leaseHours: 6, now: Date.now() });
  store.workClaims.set("commons", linkItem(privClaimed, "owner"));

  const out = applyPullRequestWebhook(store, {
    action: "closed",
    pull_request: { html_url: PR_URL, merged: true, state: "closed" },
    repository: { full_name: "Uuriko/project-room" }
  }, { nowMs: Date.now() });
  assert.deepEqual(out.applied, [{ roomId: "commons", claimId: "sync-webhook-private", outcome: "merged" }]);
  assert.equal(store.workClaims.get("commons", "sync-webhook-private").state, "done");
  const pubAfter = store.workClaims.get(namespace, offerId);
  assert.equal(pubAfter.state, "in_progress");
  assert.equal(pubAfter.pullRequest.outcome, null);
});

test("G3: the deployed-close phase closes a private land claim and never selects a namespace row", async t => {
  const { store, namespace } = fixture(t);
  // Production-impossible today (door items carry no revision), one
  // data-shape change away per the census: a namespace row shaped like a
  // land claim at the live revision. Exclusion is explicit, not emergent.
  const landShaped = claimWork(
    createWork({ id: "sync-land-shaped", kind: "land", revision: SOURCE_REVISION }, { now: Date.now() }),
    "owner", { leaseHours: 6, now: Date.now() });
  permitSet(store, namespace, landShaped);
  // L04-C4: the private control must be legitimately closable — held with
  // its pull recorded merged — not merely at the live revision.
  const privLand = recordPullOutcome(claimWork(
    createWork({ id: "sync-land-private", kind: "land", revision: SOURCE_REVISION, pullRequest: PR_URL }, { now: Date.now() }),
    "owner", { leaseHours: 6, now: Date.now() }), PR_URL, "merged", Date.now());
  store.workClaims.set("commons", privLand);

  assert.equal(landShaped.state, "claimed");
  const out = await syncClaimPullRequests(store, { env: {}, fetchImpl: neverFetch, nowMs: Date.now(), token: null });
  // Pre-fix the namespace row's close aborts and is masked as a skipped
  // invalid row.
  assert.equal(out.skippedInvalid, undefined);
  assert.equal(store.workClaims.get("commons", "sync-land-private").state, "done",
    "the private land claim at the live revision closes");
  assert.equal(store.workClaims.get(namespace, "sync-land-shaped").state, "claimed",
    "the namespace row is exactly as seeded");
});

test("G4: autolink refuses a public namespace claim and links a private one", async t => {
  const { store, offerId, namespace } = fixture(t);
  claimPublic(store, offerId, { leaseHours: 6 });
  // Pre-fix this call reaches a bare set and aborts with the production
  // error (the webhook path's availability incident in CP-ADVERSARY H-3).
  const refused = autoLinkPullRequest(store, namespace, offerId, { url: PR_URL, source: "test" }, { nowMs: Date.now() });
  assert.deepEqual(refused, { linked: false, reason: "public_namespace" });
  assert.equal(store.workClaims.get(namespace, offerId).pullRequest ?? null, null, "a door claim never gains a pull link");

  const privClaimed = claimWork(createWork({ id: "sync-link-private" }), "owner", { leaseHours: 6, now: Date.now() });
  store.workClaims.set("commons", privClaimed);
  const linked = autoLinkPullRequest(store, "commons", "sync-link-private", { url: PR_URL, source: "test" }, { nowMs: Date.now() });
  assert.equal(linked.linked, true);
  assert.equal(store.workClaims.get("commons", "sync-link-private").pullRequest.url, PR_URL);
  assert.equal(verifyPublicWorkClaimFence(store.db), true);
});

test("G4: deploy linking stamps a settled private claim and never a namespace row", async t => {
  const { store, namespace } = fixture(t);
  const sha = "c".repeat(40);
  const now = Date.now();
  permitSet(store, namespace, { ...createWork({ id: "sync-deploy-public" }, { now }), state: "done", revision: sha });
  store.workClaims.set("commons", { ...createWork({ id: "sync-deploy-private" }, { now }), state: "done", revision: sha });

  // Pre-fix the single whole-registry transaction aborts on the namespace
  // row and NEITHER claim is stamped.
  const out = linkDeployToSettledClaims(store, { revision: sha, nowMs: now });
  assert.equal(out.linked, 1, "only the private claim is stamped");
  assert.equal(store.workClaims.get("commons", "sync-deploy-private").deploy.revision, sha);
  assert.equal(store.workClaims.get(namespace, "sync-deploy-public").deploy ?? null, null);
  assert.equal(verifyPublicWorkClaimFence(store.db), true);
});

test("G2: the stale-unclaimed sweep retires a private room's dormant claim and never a namespace row", async t => {
  const { store, namespace } = fixture(t);
  const old = Date.now() - 40 * DAY;
  store.workClaims.set("commons", createWork({ id: "sync-stale-private" }, { now: old }));
  store.workClaims.configure("commons", { staleSweep: true });
  // The hazard, seeded the only way it can exist: a namespace config row
  // opting the namespace in (written under the permit), plus a dormant
  // unclaimed namespace row.
  permitSet(store, namespace, createWork({ id: "sync-stale-public" }, { now: old }));
  withPublicWorkClaimWriter(store, () => store.workClaims.configure(namespace, { staleSweep: true }));

  // Pre-fix the sweep reaches the namespace close and its set aborts,
  // failing the whole pass.
  const closed = sweepStaleUnclaimedClaims(store, Date.now(), { force: true });
  assert.equal(closed, 1, "only the private control retires");
  assert.equal(store.workClaims.get("commons", "sync-stale-private").state, "closed");
  assert.equal(store.workClaims.get(namespace, "sync-stale-public").state, "unclaimed",
    "namespace rows belong to the public-work module's lifecycle, not the board stale sweep");
});

// ADMISSION (Codex review, muse-room 15734; the same defect DELTA
// QA-4246-ADMISSION-1019 found on #4246's original head): the two poll
// loaders skipped namespace rows only AFTER the SQL LIMIT. Seed the
// registry so all 32 candidate slots (PULL_CANDIDATE_CAP) are earlier-due
// public rows and the private claim, though due, is cut by LIMIT before
// the JS backstop ever sees it: private reconciliation starves silently,
// tick after tick. Both loader shapes must exclude public namespaces in
// SQL, before ORDER BY/LIMIT, keeping the JS filter as the mid-run
// backstop. Ported from #4246's corrected regression cases.
const STARVE_NOW = Date.UTC(2026, 9, 19, 10, 43, 0);
const STARVE_PR = "https://github.com/Uuriko/project-room/pull/4999";
const STARVE_REV = "86fc24a18a8c2e207a2a2b1de37eb31213f67215";

function starvationFixture(t, shape) {
  const store = new RoomStore("unused-injected-database.sqlite", { database: new DatabaseSync(":memory:") });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const offerId = "sync-starve-task";
  store.projectOffers.create("commons", "owner", { requestId: "create", offerId, reviewerMemberIds: ["owner"],
    terms: { repositoryUrl: "https://github.com/Uuriko/project-room", kind: "project", title: "Sync starve task",
      summary: "Disposable starvation task", acceptanceCriteria: ["Return an artifact"], reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", offerId, "publish", { requestId: "publish", expectedRevision: 1 });
  const task = store.publicWorkClaims.enable("commons", "owner", offerId, {
    requestId: "enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["src/sync-proof.js"] });
  const ns = task.namespaceId;
  const registry = createDurableWorkClaimRegistry(store.db);
  const makeClaim = (id, at, number) => {
    const base = claimWork(createWork({ id, title: `Claim ${id}` }, { now: STARVE_NOW - 4 * HOUR, agentId: "alice" }),
      "alice", { now: STARVE_NOW - 4 * HOUR, leaseHours: 6 });
    const item = shape === "live" ? base : { ...base, state: "done", deliveryMode: "merged", revision: STARVE_REV };
    // The loaders' SQL reads the singular $.data.pullRequest envelope;
    // pullRequestDue/pullVerificationDue read the singular JS field. Set both.
    const url = STARVE_PR.replace('4999', String(number));
    return { ...item, pullRequest: { url, repo: "Uuriko/project-room", number, nextPollAt: at }, pullRequests: [{ url, nextPollAt: at }] };
  };
  withPublicWorkClaimWriter(store, () => {
    for (let i = 0; i < 32; i++) registry.set(ns, makeClaim(`pub-${String(i).padStart(2, "0")}`, STARVE_NOW - 10 * HOUR, 1000 + i));
  });
  store.workClaims.set("commons", makeClaim("priv-starved", STARVE_NOW - HOUR, 4999));
  return { store, ns };
}

function countingFetch() {
  const calls = [];
  const impl = async url => { calls.push(String(url)); return { ok: false, status: 404, headers: { get: () => null } }; };
  impl.calls = calls;
  return impl;
}

test("admission: 32 earlier-due public claims do not starve a due private claim from live settlement", async t => {
  const { store } = starvationFixture(t, "live");
  const fetchImpl = countingFetch();
  await syncClaimPullRequests(store, { env: {}, token: null, fetchImpl, nowMs: STARVE_NOW });
  assert.deepEqual(fetchImpl.calls, ['https://api.github.com/repos/Uuriko/project-room/pulls/4999']);
});

test("admission: 32 earlier-due public claims do not starve a private done/merged verification", async t => {
  const { store } = starvationFixture(t, "done");
  const fetchImpl = countingFetch();
  await syncClaimPullRequests(store, { env: {}, token: null, fetchImpl, nowMs: STARVE_NOW });
  assert.deepEqual(fetchImpl.calls, ['https://api.github.com/repos/Uuriko/project-room/pulls/4999']);
});

test("the fence still bites: a bare registry write to a namespace aborts, and exclusion changed no writer's admission", async t => {
  const { store, offerId, namespace } = fixture(t);
  const item = store.workClaims.get(namespace, offerId);
  assert.throws(() => store.workClaims.set(namespace, { ...item, title: "No permit" }), /unsupported public claim writer/);
  assert.throws(() => store.workClaims.configure(namespace, { defaultLeaseHours: 9 }), /unsupported public claim writer/);
  assert.equal(verifyPublicWorkClaimFence(store.db), true);
});

test('namespace detection tolerates an absent legacy table but propagates storage faults', () => {
  const db = new DatabaseSync(':memory:');
  try { assert.equal(isPublicClaimNamespace({ db }, 'commons'), false); } finally { db.close(); }
  const fault = new Error('database disk image is malformed');
  assert.throws(() => isPublicClaimNamespace({ db: { prepare() { throw fault; } } }, 'commons'), error => error === fault);
  const dependency = new Error('no such table: unrelated_dependency');
  assert.throws(() => publicNamespaceSqlExclusion({ db: { prepare() { throw dependency; } } }), error => error === dependency);
});

for (const kind of ['lease', 'deploy']) test(`housekeeping excludes public ${kind} rows before materializing candidates`, async t => {
  const { store, namespace } = fixture(t);
  const now = Date.now();
  // The lease branch needs a lapsed lease; the deploy branch needs the
  // L04-C4 legitimate live-close shape: a live lease and a merged pull.
  const make = id => {
    const base = claimWork(createWork({ id, ...(kind === 'deploy' ? { kind: 'land', revision: SOURCE_REVISION, pullRequest: PR_URL } : {}) }, { now: now - 3 * HOUR }),
      'owner', { now: now - 3 * HOUR, leaseHours: kind === 'deploy' ? 6 : 1 });
    return kind === 'deploy' ? recordPullOutcome(base, PR_URL, 'merged', now - 3 * HOUR) : base;
  };
  withPublicWorkClaimWriter(store, () => {
    for (let i = 0; i < 300; i++) store.workClaims.set(namespace, make(`public-${i}`));
  });
  store.workClaims.set('commons', make('private-candidate'));
  const prepare = store.db.prepare.bind(store.db); const selected = [];
  store.db.prepare = sql => {
    const statement = prepare(sql);
    const target = sql.includes('SELECT room_id AS roomId, claim_id AS claimId FROM work_claims')
      && sql.includes(kind === 'lease' ? 'leaseExpiresAt' : "IN ('land', 'deploy')");
    if (!target) return statement;
    return new Proxy(statement, { get(object, key) {
      if (key === 'all') return (...args) => { const rows = object.all(...args); selected.push(...rows); return rows; };
      const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
    } });
  };
  try { await syncClaimPullRequests(store, { env: {}, token: null, fetchImpl: neverFetch, nowMs: now }); }
  finally { store.db.prepare = prepare; }
  assert.deepEqual(selected.map(row => ({ ...row })), [{ roomId: 'commons', claimId: 'private-candidate' }]);
  assert.equal(store.workClaims.get('commons', 'private-candidate').state, kind === 'lease' ? 'unclaimed' : 'done');
  assert.equal(store.workClaims.get(namespace, 'public-0').state, 'claimed');
});

for (const kind of ['pull', 'autolink', 'stale']) test(`public-only ${kind} candidates do not wake the private claim job`, t => {
  const { store, namespace } = fixture(t);
  const now = Date.now();
  let item = createWork({ id: 'wake-candidate', title: 'Candidate', repo: 'Uuriko/project-room' }, { now: now - 40 * DAY });
  if (kind !== 'stale') item = claimWork(item, 'owner', { now, leaseHours: 6 });
  if (kind === 'pull') item = linkItem(item, 'owner');
  if (kind === 'stale') withPublicWorkClaimWriter(store, () => store.workClaims.configure(namespace, { staleSweep: true }));
  permitSet(store, namespace, item);
  const job = jobByName('claim-prs');
  assert.equal(job.enabled({}, store), false);
  assert.equal(job.nextDueAt(store, now), null);
  store.workClaims.set('commons', item);
  if (kind === 'stale') store.workClaims.configure('commons', { staleSweep: true });
  assert.equal(job.enabled({}, store), true);
  assert.notEqual(job.nextDueAt(store, now), null);
});
