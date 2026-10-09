// Work-claim board: CI on a linked pull, review records, deploy closure,
// the land-queue compatibility view, the retired board, and a contribute
// agent that can claim without write_external.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { migrateLandQueueClaims } from "../server/land-queue.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { flushClaimDigestWindow } from "../server/work-claim-events.mjs";
import { SOURCE_REVISION } from "../server/version.mjs";
// SEC-2: claim reads carry content-trust markers; compare the claim itself.
const stripTrust = value => JSON.parse(JSON.stringify(value, (key, entry) => (key === "untrusted" || key === "contentTrust" ? undefined : entry)));

const SHA = "a".repeat(40);
const MAIN = "b".repeat(40);

function githubResponse(body, { status = 200, etag = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === "etag" ? etag : null) },
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

function fakeGitHub(phase) {
  return async url => {
    const target = String(url);
    if (target.includes("/pulls/")) {
      return githubResponse({ state: "open", merged: false, head: { sha: phase.headSha ?? SHA } }, { etag: "\"pull\"" });
    }
    if (target.endsWith("/status")) {
      const failure = phase.failure === true;
      return githubResponse({
        state: failure ? "failure" : "pending",
        total_count: 1,
        statuses: [{ state: failure ? "failure" : "pending", target_url: "https://example.com/ci" }]
      });
    }
    if (target.endsWith("/check-runs")) {
      return githubResponse({
        check_runs: phase.failure === true
          ? [{ conclusion: "failure" }]
          : [{ status: "in_progress", conclusion: null }]
      });
    }
    if (target.endsWith("/commits/main")) return githubResponse({ sha: MAIN });
    throw new Error(`unexpected GitHub url ${target}`);
  };
}

async function fixture(t, { phase = { failure: false }, databasePath = ":memory:" } = {}) {
  const store = new RoomStore(databasePath);
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, kind, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName, kind, permissions }
  });
  add("coord", "Coord", "agent", ["accept_work", "complete_work"]);
  add("chat", "Chat", "agent", []);
  add("verifier", "Verifier", "human", ["verify"]);
  const coordKey = store.issueAccessKey("commons", "coord");
  const chatKey = store.issueAccessKey("commons", "chat");
  const verifierKey = store.issueAccessKey("commons", "verifier");
  const server = createRoomServer({
    store,
    fetchPullRequest: fakeGitHub(phase),
    githubToken: "test-token"
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = token => new RoomAgentClient({ origin, roomId: "commons", token });
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { store, origin, ownerKey, coordKey, chatKey, verifierKey, owner: client(ownerKey), coord: client(coordKey), chat: client(chatKey), call };
}

async function startReviewedClaim(f, id, reviewPolicy, extra = {}) {
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id, reviewPolicy, ...extra })).status, 201);
  assert.equal((await f.call(f.ownerKey, `/work-claims/${id}/claim`, {})).status, 200);
  const started = await f.call(f.ownerKey, `/work-claims/${id}/update`, { state: "in_progress" });
  assert.equal(started.status, 200);
  return started.value;
}

async function refusedCompletion(f, id, reviewedBy) {
  const before = f.store.workClaims.get("commons", id);
  const sequence = f.store.room("commons").sequence;
  const response = await f.call(f.ownerKey, `/work-claims/${id}/update`, { state: "done", reviewedBy });
  assert.equal(response.status, 403);
  assert.equal(response.value.error.code, "work_review_rejected");
  assert.deepEqual(f.store.workClaims.get("commons", id), before, "a rejected completion preserves the claim");
  assert.equal(f.store.room("commons").sequence, sequence, "a rejected completion adds no event");
}

test("a contribute-profile agent creates, renews, and releases a claim without write_external", async t => {
  const { coord, call, coordKey } = await fixture(t);
  const created = await coord.workClaimCreate({ id: "coord-1", title: "Coord lane" });
  assert.equal(created.state, "unclaimed");
  assert.equal(created.owner, null);
  const claimed = await coord.claimWorkItem("coord-1", { leaseHours: 2 });
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.owner, "coord");
  await new Promise(resolve => setTimeout(resolve, 5));
  const progress = (await coord.say("Coord lane is moving")).event.data.messageId;
  const renewed = await coord.renewWorkItem("coord-1", { progressMessageId: progress, leaseHours: 3 });
  assert.equal(renewed.state, "claimed");
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(claimed.leaseExpiresAt));
  const released = await coord.releaseWorkItem("coord-1", { reason: "parked" });
  assert.equal(released.state, "unclaimed");
  assert.equal(released.owner, null);
  const refused = await call(coordKey, "/work-claims", { id: "chat-cannot" });
  assert.equal(refused.status, 201);
  const chat = await fixture(t);
  const denied = await chat.call(chat.chatKey, "/work-claims", { id: "nope" });
  assert.equal(denied.status, 403);
  assert.equal(denied.value.error.code, "work_claims_not_permitted");
});

test("the room owner sets the per-member claim cap and a second claim is refused", async t => {
  const { call, ownerKey, coordKey, coord } = await fixture(t);
  const saved = await call(ownerKey, "/work-claims/config", { maxMemberOpenClaims: 1 });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.maxMemberOpenClaims, 1);
  const denied = await call(coordKey, "/work-claims/config", { maxMemberOpenClaims: 4 });
  assert.equal(denied.status, 403);
  assert.equal(denied.value.error.code, "work_claims_not_permitted");
  await coord.workClaimCreate({ id: "cap-1", title: "First" });
  await coord.claimWorkItem("cap-1", {});
  await coord.workClaimCreate({ id: "cap-2", title: "Second" });
  const second = await call(coordKey, "/work-claims/cap-2/claim", {});
  assert.equal(second.status, 409);
  assert.equal(second.value.error.code, "too_many_open_claims");
  const read = await call(ownerKey, "/work-claims/config");
  assert.equal(read.status, 200);
  assert.equal(read.value.maxMemberOpenClaims, 1);
});

test("an ownerless room refuses a non-member and a member without a claim profile", async t => {
  const { store, call, coordKey, chatKey } = await fixture(t);
  const row = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("commons");
  const projection = JSON.parse(row.projection);
  projection.room.ownerId = "";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), "commons");
  const chat = await call(chatKey, "/work-claims", { id: "chat-no" });
  assert.equal(chat.status, 403);
  assert.equal(chat.value.error.code, "work_claims_not_permitted");
  const stranger = await handleWorkClaims({
    req: { method: "POST", body: { id: "stranger-no" } },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons",
    auth: { member: { id: "stranger", kind: "agent", permissions: ["accept_work", "complete_work"] } },
    workClaimRoute: "create",
    helpers: {
      json: (_res, status, value) => ({ status, value }),
      reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
      body: async req => req.body,
    },
    registry: store.workClaims,
  });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.value.error.code, "work_claims_not_permitted");
  assert.equal(store.workClaims.get("commons", "stranger-no"), null);
  const allowed = await call(coordKey, "/work-claims", { id: "coord-yes" });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.value.owner, null);
});

test("CI state changes are stored, receipted, and wake the owner on failure", async t => {
  const phase = { failure: false };
  const { store, call, coordKey } = await fixture(t, { phase });
  const created = await call(coordKey, "/work-claims", {
    id: "ci-1", pullRequest: "https://github.com/acme/demo/pull/7"
  });
  assert.equal(created.status, 201);
  const claimed = await call(coordKey, "/work-claims/ci-1/claim", {});
  assert.equal(claimed.status, 200);
  const pending = await call(coordKey, "/work-claims/sweep", {});
  assert.equal(pending.status, 200);
  const pendingItem = store.workClaims.get("commons", "ci-1");
  assert.equal(pendingItem.ci.state, "pending");
  assert.equal(pendingItem.ci.headSha, SHA);
  // FIX-69: ci_changed is routine — it rides the digest, not a per-transition event.
  const digests = () => store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons")
    .map(row => JSON.parse(row.body))
    .filter(entry => entry.type === "work_claim.digest");
  const ciChanges = () => digests().flatMap(digest => digest.data.digestClaims)
    .filter(entry => entry.workClaim === "ci-1" && entry.action === "ci_changed");
  flushClaimDigestWindow(store, "commons", {});
  assert.ok(ciChanges().some(entry => entry.claimState === pendingItem.state));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=?").get("coord").n, 0);
  phase.failure = true;
  store.workClaims.set("commons", {
    ...pendingItem,
    pullRequest: { ...pendingItem.pullRequest, nextPollAt: null, ciCursor: "done" }
  });
  const failed = await call(coordKey, "/work-claims/sweep", {});
  assert.equal(failed.status, 200);
  const failedItem = store.workClaims.get("commons", "ci-1");
  assert.equal(failedItem.ci.state, "failure");
  assert.equal(failedItem.ci.url, "https://example.com/ci");
  flushClaimDigestWindow(store, "commons", {});
  assert.ok(ciChanges().length >= 2, "both the pending and failure polls surface in digests");
  const wake = store.db.prepare("SELECT kind, message_id FROM agent_wake_signals WHERE agent_id=?").get("coord");
  assert.equal(wake.kind, "mention");
  assert.match(wake.message_id, /ci-1:ci:failure/);
});

test("review records refuse the owner and a chat agent, and a changes request wakes the owner", async t => {
  const { call, ownerKey, coordKey, chatKey, store } = await fixture(t);
  assert.equal((await call(ownerKey, "/work-claims", { id: "rev-1", title: "Review me" })).status, 201);
  assert.equal((await call(ownerKey, "/work-claims/rev-1/claim", {})).status, 200);
  const ownerReview = await call(ownerKey, "/work-claims/rev-1/review", { verdict: "approve", summary: "ship it" });
  assert.equal(ownerReview.status, 403);
  assert.equal(ownerReview.value.error.code, "work_review_rejected");
  const chatReview = await call(chatKey, "/work-claims/rev-1/review", { verdict: "comment", summary: "from chat" });
  assert.equal(chatReview.status, 403);
  assert.equal(chatReview.value.error.code, "work_claims_not_permitted");
  const review = await call(coordKey, "/work-claims/rev-1/review", {
    verdict: "changes_requested", summary: "rename the helper", url: "https://example.com/notes"
  });
  assert.equal(review.status, 200);
  assert.equal(review.value.reviews.length, 1);
  assert.equal(review.value.reviews[0].verdict, "changes_requested");
  assert.equal(review.value.reviews[0].memberId, "coord");
  const event = store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons")
    .map(row => JSON.parse(row.body))
    .find(entry => entry.data?.workClaim === "rev-1" && entry.data?.verdict === "changes_requested");
  assert.equal(event.data.reason, "reviewed");
  const wake = store.db.prepare("SELECT kind FROM agent_wake_signals WHERE agent_id=?").get("owner");
  assert.equal(wake.kind, "mention");
  assert.match(store.db.prepare("SELECT message_id FROM agent_wake_signals WHERE agent_id=?").get("owner").message_id, /^work-claim:rev-1:review:/);
});

test("reviewed completion requires the named reviewer's latest explicit approval", async t => {
  for (const policy of ["distinct_member", "independent_principal"]) {
    await t.test(policy, async t => {
      const f = await fixture(t);
      const reviewer = policy === "distinct_member" ? "coord" : "verifier";
      const key = reviewer === "coord" ? f.coordKey : f.verifierKey;
      for (const [index, negative] of [
        { verdict: "comment", summary: "Still reading" },
        { verdict: "changes_requested", summary: "Fix the edge case" },
        { note: "Legacy review note" },
      ].entries()) {
        const id = `latest-${index}`;
        await startReviewedClaim(f, id, policy);
        const review = body => f.call(key, `/work-claims/${id}/review`, body);
        if (negative.note && reviewer === "coord") {
          // SEC-2: review notes come from verify holders, the owner, or claim managers.
          const refused = await review(negative);
          assert.equal(refused.status, 403);
          assert.equal(refused.value.error.code, "work_claims_not_permitted");
          continue;
        }
        await refusedCompletion(f, id, reviewer);
        assert.equal((await review(negative)).status, 200);
        await refusedCompletion(f, id, reviewer);
        const approved = await review({ verdict: "approve", summary: "Checked the current work" });
        assert.equal(approved.status, 200);
        assert.equal(approved.value.reviews.find(entry => entry.memberId === reviewer).verdict, "approve");
        assert.equal((await review(negative)).status, 200);
        await refusedCompletion(f, id, reviewer);
        const after = (await f.call(f.ownerKey, `/work-claims/${id}`)).value;
        assert.ok(after.history.length > approved.value.history.length, "supersession retains the review history");
        if (negative.note) {
          assert.equal(after.reviews.some(entry => entry.memberId === reviewer && entry.verdict === "approve"), false);
          assert.equal(after.attestations.find(entry => entry.memberId === reviewer).note, negative.note);
        }
        assert.equal((await review({ verdict: "approve", summary: "Rechecked after the latest feedback" })).status, 200);
        const done = await f.call(f.ownerKey, `/work-claims/${id}/update`, { state: "done", reviewedBy: reviewer });
        assert.equal(done.status, 200);
        assert.equal(done.value.state, "done");
        assert.equal(done.value.reviewedBy, reviewer);
      }
    });
  }
});

test("manual completion uses the named reviewer's approval, not another member's verdict", async t => {
  const f = await fixture(t);
  await startReviewedClaim(f, "named-reviewer", "distinct_member");
  const path = "/work-claims/named-reviewer/review";
  assert.equal((await f.call(f.coordKey, path, { verdict: "comment", summary: "Still reviewing" })).status, 200);
  assert.equal((await f.call(f.verifierKey, path, { verdict: "approve", summary: "Verified this result" })).status, 200);
  await refusedCompletion(f, "named-reviewer", "coord");
  const done = await f.call(f.ownerKey, "/work-claims/named-reviewer/update", { state: "done", reviewedBy: "verifier" });
  assert.equal(done.status, 200);
  assert.equal(done.value.reviewedBy, "verifier");
  assert.equal(done.value.reviews.find(entry => entry.memberId === "coord").verdict, "comment");
});

test("human verify permits review without granting Board writes, and self-attested closure is unchanged", async t => {
  const f = await fixture(t);
  await startReviewedClaim(f, "human-review", "independent_principal");
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "open-for-claim" })).status, 201);
  for (const [path, body] of [
    ["/work-claims", { id: "verifier-cannot-create" }],
    ["/work-claims/open-for-claim/claim", {}],
  ]) {
    const denied = await f.call(f.verifierKey, path, body);
    assert.equal(denied.status, 403);
    assert.equal(denied.value.error.code, "work_claims_not_permitted");
  }
  const approved = await f.call(f.verifierKey, "/work-claims/human-review/review", { verdict: "approve", summary: "Verified" });
  assert.equal(approved.status, 200);
  assert.deepEqual(f.store.roomAuthority("commons").members.verifier.permissions, ["verify"]);
  const done = await f.call(f.ownerKey, "/work-claims/human-review/update", { state: "done", reviewedBy: "verifier" });
  assert.equal(done.status, 200);
  await startReviewedClaim(f, "self-review", "self_attested");
  await refusedCompletion(f, "self-review", "verifier");
  const self = await f.call(f.ownerKey, "/work-claims/self-review/update", { state: "done" });
  assert.equal(self.status, 200);
  assert.equal(self.value.state, "done");
});

test("completion rechecks a reviewer's active membership and current review authority", async t => {
  for (const scenario of [
    { policy: "distinct_member", reviewer: "coord", permissions: [], active: true },
    { policy: "distinct_member", reviewer: "coord", permissions: ["accept_work", "complete_work"], active: false },
    { policy: "independent_principal", reviewer: "verifier", permissions: ["accept_work", "complete_work"], active: true },
    { policy: "independent_principal", reviewer: "verifier", permissions: ["verify"], active: false },
  ]) {
    await t.test(`${scenario.policy}: ${scenario.active ? "permission revoked" : "inactive"}`, async t => {
      const f = await fixture(t);
      await startReviewedClaim(f, "authority", scenario.policy);
      const key = scenario.reviewer === "coord" ? f.coordKey : f.verifierKey;
      assert.equal((await f.call(key, "/work-claims/authority/review", { verdict: "approve", summary: "Approved while authorized" })).status, 200);
      f.store.command(f.ownerKey, "commons", { id: "change-reviewer-access", type: "member.access_changed", data: {
        memberId: scenario.reviewer,
        expectedMemberRevision: f.store.roomAuthority("commons").members[scenario.reviewer].revision,
        permissions: scenario.permissions, active: scenario.active,
      } });
      await refusedCompletion(f, "authority", scenario.reviewer);
    });
  }
});

test("an unchanged latest review retry preserves its timestamp, basis, events, and wakes", async t => {
  const f = await fixture(t);
  await startReviewedClaim(f, "retry-review", "distinct_member", { revision: "reviewed-revision" });
  const body = { verdict: "changes_requested", summary: "Add the missing validation", url: "https://example.com/review" };
  const first = await f.call(f.coordKey, "/work-claims/retry-review/review", body);
  assert.equal(first.status, 200);
  const sequence = f.store.room("commons").sequence;
  const wakes = f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=?").get("owner").n;
  assert.equal(wakes, 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  const retry = await f.call(f.coordKey, "/work-claims/retry-review/review", body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.value, first.value);
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=?").get("owner").n, wakes);
  assert.deepEqual(stripTrust((await f.call(f.ownerKey, "/work-claims/retry-review")).value.reviews), first.value.reviews);
});

test("approval remains bound to the reviewed revision and observed pull-request head", async t => {
  for (const changed of ["revision", "headSha"]) {
    await t.test(changed, async t => {
      const phase = { headSha: SHA };
      const f = await fixture(t, { phase });
      const id = `basis-${changed}`;
      const claim = await startReviewedClaim(f, id, "distinct_member", { revision: "revision-one", pullRequest: "https://github.com/acme/demo/pull/7" });
      assert.equal((await f.call(f.ownerKey, "/work-claims/sweep", {})).status, 200);
      const body = { verdict: "approve", summary: "Reviewed revision one" };
      const review = await f.call(f.coordKey, `/work-claims/${id}/review`, body);
      assert.equal(review.status, 200);
      const basis = review.value.reviews[0].basis;
      assert.ok(basis, "explicit review records the current claim basis");
      assert.equal(basis.version, 1);
      assert.equal(basis.owner, "owner");
      assert.equal(basis.claimedAt, claim.claimedAt);
      assert.equal(basis.revision, "revision-one");
      assert.equal(basis.headSha, SHA);
      const current = f.store.workClaims.get("commons", id);
      if (changed === "revision") {
        f.store.workClaims.set("commons", { ...current, revision: "revision-two" });
      } else {
        phase.headSha = MAIN;
        f.store.workClaims.set("commons", { ...current, pullRequest: { ...current.pullRequest, nextPollAt: null, ciCursor: "done" } });
        assert.equal((await f.call(f.ownerKey, "/work-claims/sweep", {})).status, 200);
        assert.equal(f.store.workClaims.get("commons", id).ci.headSha, MAIN);
      }
      await refusedCompletion(f, id, "coord");
      const sequence = f.store.room("commons").sequence;
      const retry = await f.call(f.coordKey, `/work-claims/${id}/review`, body);
      assert.equal(retry.status, 200);
      assert.deepEqual(retry.value.reviews[0], review.value.reviews[0], "a retry cannot silently approve changed work");
      assert.equal(f.store.room("commons").sequence, sequence);
      await refusedCompletion(f, id, "coord");
      const fresh = await f.call(f.coordKey, `/work-claims/${id}/review`, { verdict: "approve", summary: "Reviewed the updated work" });
      assert.equal(fresh.status, 200);
      assert.notDeepEqual(fresh.value.reviews[0].basis, basis);
      assert.equal((await f.call(f.ownerKey, `/work-claims/${id}/update`, { state: "done", reviewedBy: "coord" })).status, 200);
    });
  }
});

test("persisted approvals retain their basis while older unbound records need a fresh review", async t => {
  const directory = await mkdtemp(join(tmpdir(), "board-review-"));
  const databasePath = join(directory, "room.sqlite");
  const f = await fixture(t, { databasePath });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await startReviewedClaim(f, "persisted-review", "distinct_member", { revision: "persisted-revision" });
  const approved = await f.call(f.coordKey, "/work-claims/persisted-review/review", { verdict: "approve", summary: "Reviewed persisted work" });
  assert.equal(approved.status, 200);
  const reopened = new RoomStore(databasePath);
  try {
    assert.deepEqual(reopened.workClaims.get("commons", "persisted-review").reviews, approved.value.reviews);
    assert.ok(reopened.workClaims.get("commons", "persisted-review").reviews[0].basis);
  } finally { reopened.close(); }
  const current = f.store.workClaims.get("commons", "persisted-review");
  // Older stored rows predate the versioned review context.
  f.store.workClaims.set("commons", { ...current, reviews: current.reviews.map(({ basis: _basis, ...review }) => review) });
  assert.equal((await f.call(f.ownerKey, "/work-claims/persisted-review")).status, 200);
  await refusedCompletion(f, "persisted-review", "coord");
  assert.equal((await f.call(f.coordKey, "/work-claims/persisted-review/review", { verdict: "approve", summary: "Fresh review with the current context" })).status, 200);
  assert.equal((await f.call(f.ownerKey, "/work-claims/persisted-review/update", { state: "done", reviewedBy: "coord" })).status, 200);
});

test("a superseded claim cannot be manually completed with an otherwise valid approval", async t => {
  const f = await fixture(t);
  await startReviewedClaim(f, "superseded-review", "distinct_member");
  assert.equal((await f.call(f.coordKey, "/work-claims/superseded-review/review", { verdict: "approve", summary: "Approved before replacement" })).status, 200);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "replacement" })).status, 201);
  const current = f.store.workClaims.get("commons", "superseded-review");
  f.store.workClaims.set("commons", { ...current, supersededBy: "replacement" });
  await refusedCompletion(f, "superseded-review", "coord");
});

test("a deploy claim closes when the live revision matches, and status reports main", async t => {
  const { call, coordKey } = await fixture(t);
  const created = await call(coordKey, "/work-claims", { id: "ship", kind: "deploy", revision: SOURCE_REVISION, title: "Ship" });
  assert.equal(created.status, 201);
  assert.equal(created.value.kind, "deploy");
  const read = await call(coordKey, "/work-claims/ship");
  assert.equal(read.status, 200);
  assert.equal(read.value.state, "done");
  assert.equal(read.value.deliveryMode, "production");
  const status = await call(coordKey, "/work-claims/status");
  assert.equal(status.status, 200);
  assert.equal(status.value.live, SOURCE_REVISION);
  assert.equal(status.value.main, MAIN);
  assert.equal(status.value.behind, null);
  assert.equal(typeof status.value.checkedAt, "string");
  const open = await call(coordKey, "/work-claims", { id: "later", kind: "deploy", revision: "not-live-yet" });
  assert.equal(open.status, 201);
  const still = await call(coordKey, "/work-claims/later");
  assert.equal(still.value.state, "unclaimed");
});

test("land queue rows copy into land claims once and the list stays the same shape", async t => {
  const { store, call, ownerKey } = await fixture(t);
  store.db.prepare(`INSERT INTO land_queue
    (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, title, mergeable, behind, checks_state, observed, created_at, updated_at)
    VALUES ('commons', 'lq_existing', 'acme/demo', 15, 'owner', 'owner', 'Existing', 'unknown', 0, 'pending', 0, 5, 5)`).run();
  const first = migrateLandQueueClaims(store);
  const second = migrateLandQueueClaims(store);
  assert.equal(first.copied, 1);
  assert.equal(second.copied, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM land_queue WHERE item_id=?").get("lq_existing").n, 1);
  const claim = store.workClaims.get("commons", "lq_existing");
  assert.equal(claim.kind, "land");
  assert.equal(claim.pullRequest.url, "https://github.com/acme/demo/pull/15");
  const listed = await call(ownerKey, "/list_land_queue");
  assert.equal(listed.status, 200);
  assert.equal(listed.value.items.length, 1);
  assert.equal(listed.value.items[0].itemId, "lq_existing");
  assert.equal(listed.value.items[0].prNumber, 15);
  assert.equal(listed.value.items[0].repo, "acme/demo");
});

test("board v2 routes answer 410 and point at work claims", async t => {
  const { origin, ownerKey } = await fixture(t);
  const response = await fetch(`${origin}/api/rooms/commons/board/v2/claims`, {
    headers: { authorization: `Bearer ${ownerKey}` }
  });
  const body = await response.json();
  assert.equal(response.status, 410);
  assert.equal(body.error.code, "board_v2_retired");
  assert.equal(body.next[0].href, "/api/rooms/commons/work-claims");
  const tables = ["board_vtwo_claims", "board_vtwo_events", "board_vtwo_mirror", "board_vtwo_idempotency"];
  const { store } = await fixture(t);
  for (const name of tables) {
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name).name, name);
  }
});

test("hard work defaults to a distinct reviewer at create; an explicit policy still wins", async t => {
  const { call, coordKey } = await fixture(t);
  const hard = await call(coordKey, "/work-claims", { id: "hard-1", title: "Hard one", tags: ["hard", "H3"] });
  assert.equal(hard.status, 201);
  assert.equal(hard.value.reviewPolicy, "distinct_member");
  const seed = await call(coordKey, "/work-claims", { id: "seed-1", title: "Seed", tags: ["Hard-Problem"] });
  assert.equal(seed.value.reviewPolicy, "distinct_member");
  const explicit = await call(coordKey, "/work-claims", { id: "hard-2", title: "Hard, self", tags: ["hard"], reviewPolicy: "self_attested" });
  assert.equal(explicit.value.reviewPolicy, "self_attested");
  const plain = await call(coordKey, "/work-claims", { id: "plain-1", title: "Plain", tags: ["wk41"] });
  assert.equal(plain.value.reviewPolicy, null);
});

test("reassign honors the room's per-member open-claim cap", async t => {
  const f = await fixture(t);
  await f.call(f.ownerKey, "/work-claims/config", { maxMemberOpenClaims: 1 });
  assert.equal((await f.call(f.coordKey, "/work-claims", { id: "reassign-cap-1" })).status, 201);
  assert.equal((await f.call(f.coordKey, "/work-claims/reassign-cap-1/claim", {})).status, 200);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "reassign-cap-2" })).status, 201);
  assert.equal((await f.call(f.ownerKey, "/work-claims/reassign-cap-2/claim", {})).status, 200);
  const sequence = f.store.room("commons").sequence;
  const result = await f.call(f.ownerKey, "/work-claims/reassign-cap-2/reassign", { newOwner: "coord" });
  assert.equal(result.status, 409);
  assert.equal(result.value.error.code, "too_many_open_claims");
  assert.equal(f.store.room("commons").sequence, sequence, "a refused handoff writes nothing");
  assert.equal(f.store.workClaims.get("commons", "reassign-cap-2").owner, "owner");
});
