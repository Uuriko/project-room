// Regression: needs-me delivered-state exclusion + queue completion
// (B-SURFACES F1/F2; UT-MIXED X3 cell 5 / register rows 1/6/30 family).
// A delivered item awaiting review must appear in its named reviewer's
// needs-me, and the queue must keep suggesting actions until the review
// actually completes — a recorded verdict alone must not clear the ask
// while the claim still sits in `delivered`.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { collectNeedsMe } from "../server/needs-me.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createWork, claimWork, updateWork, recordReview } from "../server/work-claims.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const WRITER = ["steer", "accept_work", "complete_work", "verify"];

function setup(t) {
  // Pin the store clock to the scenario date: the fixtures claim at
  // 2026-10-01 with default 24h leases, and the needs-me sections derive
  // lease liveness from store.now() (same pin as needs-me-open-work).
  const store = new RoomStore(":memory:", { now: () => Date.parse("2026-10-01T00:00:00Z") });
  t.after(() => store.close());
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Owen");
  const worker = store.identities.create("Wanda");
  const reviewer = store.identities.create("Rita");
  rooms.create(owner.secret, { roomId: "board", title: "board", purpose: "delivered review asks", kind: "personal" });
  linkWithProof(store, owner.secret, "board", worker, { displayName: "Wanda", permissions: WRITER });
  linkWithProof(store, owner.secret, "board", reviewer, { displayName: "Rita", permissions: WRITER });
  const memberOf = identityId => store.db.prepare("SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?").get(identityId, "board").m;
  const ids = { owner: memberOf(owner.identityId), worker: memberOf(worker.identityId), reviewer: memberOf(reviewer.identityId) };
  const now = Date.parse("2026-10-01T01:00:00Z");
  const deliver = id => {
    let item = createWork({ id, title: `Task ${id}`, tags: [`rev-${ids.reviewer}`] }, { now, agentId: ids.owner });
    item = claimWork(item, ids.worker, { now });
    item = updateWork(item, ids.worker, { state: "in_progress", now });
    store.workClaims.set("board", item);
    return item;
  };
  const askFor = (secret, id) => collectNeedsMe(store, secret, {})?.reviewAsks?.[0]?.top.find(row => row.id === id);
  return { store, owner, worker, reviewer, ids, now, deliver, askFor };
}

test("delivered (no PR) item appears in the named reviewer's needs-me", t => {
  const { store, reviewer, ids, now, deliver, askFor } = setup(t);
  let item = deliver("task-a");
  assert.equal(askFor(reviewer.secret, "task-a")?.phase, "review", "in_progress already asks");
  item = updateWork(item, ids.worker, { state: "delivered", now });
  store.workClaims.set("board", item);
  const ask = askFor(reviewer.secret, "task-a");
  assert.ok(ask, "delivered item must not vanish from the reviewer's queue");
  assert.equal(ask.state, "delivered");
  assert.equal(ask.phase, "review");
  assert.match(ask.next, /\/work-claims\/task-a\/review$/);
});

test("queue completion: an approve verdict keeps the ask, pointing at the done call, until the claim is done", t => {
  const { store, reviewer, ids, now, deliver, askFor } = setup(t);
  let item = deliver("task-a");
  item = updateWork(item, ids.worker, { state: "delivered", now });
  item = recordReview(item, ids.reviewer, { verdict: "approve", summary: "looks good", now });
  store.workClaims.set("board", item);
  const ask = askFor(reviewer.secret, "task-a");
  assert.ok(ask, "a recorded verdict alone must not clear the queue while the claim is still delivered");
  assert.equal(ask.phase, "complete");
  assert.match(ask.next, /\/work-claims\/task-a\/update$/);
  assert.deepEqual(ask.nextBody, { state: "done" });
  // The reviewer's delivered -> done transition is a route-level permission
  // (#3546, covered by the server test below); here the resulting state is
  // set directly, as in needs-me-open-work's ground-truth fixtures.
  store.workClaims.set("board", { ...item, state: "done" });
  assert.equal(askFor(reviewer.secret, "task-a"), undefined, "the ask retires when the work actually completes");
});

test("queue send-back: a changes_requested verdict keeps the ask, pointing at the in_progress call", t => {
  const { store, reviewer, ids, now, deliver, askFor } = setup(t);
  let item = deliver("task-b");
  item = updateWork(item, ids.worker, { state: "delivered", now });
  item = recordReview(item, ids.reviewer, { verdict: "changes_requested", summary: "criterion missing", now });
  store.workClaims.set("board", item);
  const ask = askFor(reviewer.secret, "task-b");
  assert.ok(ask, "a send-back verdict alone must not clear the queue while the claim is still delivered");
  assert.equal(ask.phase, "send_back");
  assert.match(ask.next, /\/work-claims\/task-b\/update$/);
  assert.deepEqual(ask.nextBody, { state: "in_progress" });
  store.workClaims.set("board", { ...item, state: "in_progress" });
  assert.equal(askFor(reviewer.secret, "task-b"), undefined, "after send-back the reviewer owes nothing until a new delivery");
});

test("audit sequence over the real HTTP and MCP faces", { timeout: 120000 }, async t => {
  const store = new RoomStore(":memory:");
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Owen");
  const worker = store.identities.create("Wanda");
  const reviewer = store.identities.create("Rita");
  rooms.create(owner.secret, { roomId: "board", title: "board", purpose: "needs-me audit", kind: "personal" });
  linkWithProof(store, owner.secret, "board", worker, { displayName: "Wanda", permissions: WRITER });
  linkWithProof(store, owner.secret, "board", reviewer, { displayName: "Rita", permissions: WRITER });
  const reviewerMember = store.db.prepare("SELECT member_id AS m FROM identity_links WHERE identity_id=? AND room_id=?").get(reviewer.identityId, "board").m;
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams?.(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (secret, method, path, body) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const mcpAsk = async id => {
    const res = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${reviewer.secret}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_needs_me", arguments: { roomId: "board" } } }) });
    const json = await res.json();
    const page = json?.result?.structuredContent ?? {};
    return page?.reviewAsks?.[0]?.top.find(row => row.id === id);
  };
  const httpAsk = async id => (await api(reviewer.secret, "GET", "/api/needs-me?roomId=board")).json?.reviewAsks?.[0]?.top.find(row => row.id === id);

  assert.equal((await api(owner.secret, "POST", "/api/rooms/board/work-claims", { id: "task-a", title: "Task A", tags: [`rev-${reviewerMember}`] })).status, 201);
  await api(worker.secret, "POST", "/api/rooms/board/work-claims/task-a/claim", {});
  await api(worker.secret, "POST", "/api/rooms/board/work-claims/task-a/update", { state: "in_progress" });
  assert.ok(await httpAsk("task-a"), "in_progress asks on HTTP");
  assert.ok(await mcpAsk("task-a"), "in_progress asks on MCP");
  await api(worker.secret, "POST", "/api/rooms/board/work-claims/task-a/update", { state: "delivered", note: "delivered for review" });
  assert.equal((await httpAsk("task-a"))?.phase, "review", "delivered asks on HTTP (F1)");
  assert.equal((await mcpAsk("task-a"))?.phase, "review", "delivered asks on MCP (F1)");
  // Follow the queue's suggested action, then the queue's completion action.
  await api(reviewer.secret, "POST", "/api/rooms/board/work-claims/task-a/review", { verdict: "approve", summary: "looks good" });
  const completion = await httpAsk("task-a");
  assert.equal(completion?.phase, "complete", "queue still owns the review after the verdict (F2)");
  assert.deepEqual(completion?.nextBody, { state: "done" });
  assert.equal((await mcpAsk("task-a"))?.phase, "complete", "completion phase agrees on MCP");
  const done = await api(reviewer.secret, "POST", completion.next.replace(/^POST /, ""), completion.nextBody);
  assert.equal(done.status, 200);
  assert.equal(done.json.state, "done", "the queue-suggested action completes the review end-to-end");
  assert.equal(await httpAsk("task-a"), undefined, "queue empties once the work is done");
});
