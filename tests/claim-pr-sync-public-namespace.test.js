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
import { syncClaimPullRequests, sweepStaleUnclaimedClaims, applyPullRequestWebhook } from "../server/claim-pr-sync.mjs";
import { autoLinkPullRequest, linkDeployToSettledClaims } from "../server/claim-autolink.mjs";
import { withPublicWorkClaimWriter, verifyPublicWorkClaimFence } from "../server/public-work-claim-fence.mjs";
import { SOURCE_REVISION } from "../server/version.mjs";

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
  const privLand = claimWork(
    createWork({ id: "sync-land-private", kind: "land", revision: SOURCE_REVISION }, { now: Date.now() }),
    "owner", { leaseHours: 6, now: Date.now() });
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

test("the fence still bites: a bare registry write to a namespace aborts, and exclusion changed no writer's admission", async t => {
  const { store, offerId, namespace } = fixture(t);
  const item = store.workClaims.get(namespace, offerId);
  assert.throws(() => store.workClaims.set(namespace, { ...item, title: "No permit" }), /unsupported public claim writer/);
  assert.throws(() => store.workClaims.configure(namespace, { defaultLeaseHours: 9 }), /unsupported public claim writer/);
  assert.equal(verifyPublicWorkClaimFence(store.db), true);
});
