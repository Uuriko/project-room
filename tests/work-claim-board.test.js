// Work-claim board: CI on a linked pull, review records, deploy closure,
// the land-queue compatibility view, the retired board, and a contribute
// agent that can claim without write_external.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { migrateLandQueueClaims } from "../server/land-queue.mjs";
import { SOURCE_REVISION } from "../server/version.mjs";

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
      return githubResponse({ state: "open", merged: false, head: { sha: SHA } }, { etag: "\"pull\"" });
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

async function fixture(t, { phase = { failure: false } } = {}) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, kind, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName, kind, permissions }
  });
  add("coord", "Coord", "agent", ["accept_work", "complete_work"]);
  add("chat", "Chat", "agent", []);
  const coordKey = store.issueAccessKey("commons", "coord");
  const chatKey = store.issueAccessKey("commons", "chat");
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
  return { store, origin, ownerKey, coordKey, chatKey, owner: client(ownerKey), coord: client(coordKey), chat: client(chatKey), call };
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
  const events = () => store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons")
    .map(row => JSON.parse(row.body))
    .filter(entry => entry.type === "work_claim.updated" && entry.data.workClaim === "ci-1");
  assert.ok(events().some(entry => entry.data.reason === "ci_changed" && entry.data.ciState === "pending"));
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
  assert.ok(events().some(entry => entry.data.reason === "ci_changed" && entry.data.ciState === "failure"));
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
