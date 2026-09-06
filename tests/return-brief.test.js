import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Return-brief wiring acceptance cases (disposition 5557850637, "next handoff" list):
// fixed-H pagination beyond 100 events, H+1 after ack, N-versus-H boundary labeling,
// unresolved work surviving catch-up, verification/decision inclusion, proposer replay,
// and cross-user cursor isolation.

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-returnbrief-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const [id, kind] of [["human", "human"], ["agent", "agent"]]) store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind, permissions: ["accept_work", "complete_work", "verify"] }));
  const human = store.issueAccessKey("commons", "human");
  const agent = store.issueAccessKey("commons", "agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, human, agent };
}
const postMessages = (store, token, n, prefix = "m") => { for (let i = 1; i <= n; i++) store.command(token, "commons", command(T.MESSAGE_POSTED, { body: `${prefix}${i}` })); };
// Full lifecycle: owner proposes (independent verification + owner decision), human accepts,
// starts, completes; agent verifies pass; owner approves. Returns the completion event id.
function completeLifecycle(store, owner, human, agent, workItemId) {
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId, title: `title-${workItemId}`, definitionOfDone: "done", accountableMemberId: "human", verifierMemberId: "agent", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" }));
  store.command(human, "commons", command(T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 }));
  store.command(human, "commons", command(T.WORK_STARTED, { workItemId, expectedRevision: 1 }));
  const done = store.command(human, "commons", command(T.WORK_COMPLETED, { workItemId, expectedRevision: 2, summary: "s", evidenceUrl: "https://example.com/e", evidenceVersion: "v1", nextAction: "verify" }));
  store.command(agent, "commons", command(T.VERIFICATION_RECORDED, { workItemId, expectedRevision: 3, result: "pass", completionEventId: done.event.id, evidenceVersion: "v1", summary: "checked" }));
  store.command(owner, "commons", command(T.OWNER_DECISION_RECORDED, { workItemId, expectedRevision: 4, decision: "approved", completionEventId: done.event.id, evidenceVersion: "v1", reason: "good" }));
}

test("history pages keep the frozen horizon beyond 100 events; mid-pagination arrivals never leak in", t => {
  const { store, human } = fixture(t);
  postMessages(store, human, 120); // sequences 4..123 (room.created, 2x member.added are 1..3)
  const page1 = store.returnBrief(human, "commons", { limit: 50 });
  const H = page1.history.evaluatedThrough;
  assert.equal(page1.history.cursor, 0);
  assert.equal(page1.history.items.length, 50);
  assert.equal(page1.history.hasMore, true);
  assert.deepEqual(page1.history.continuation, { horizon: H, after: page1.history.items.at(-1).sequence, cursor: 0 }); // the frozen cursor travels with the horizon
  postMessages(store, human, 5, "late-"); // 5 events arrive AFTER the horizon froze
  const page2 = store.returnBrief(human, "commons", { ...page1.history.continuation, limit: 50 });
  assert.equal(page2.history.evaluatedThrough, H); // frozen, not the new N
  assert.equal(page2.history.items.at(-1).sequence <= H, true);
  const page3 = store.returnBrief(human, "commons", { horizon: H, after: page2.history.items.at(-1).sequence, cursor: 0, limit: 50 });
  assert.equal(page3.history.hasMore, false);
  assert.equal(page3.history.continuation, null);
  const seen = [...page1.history.items, ...page2.history.items, ...page3.history.items];
  assert.equal(seen.length, H); // every event in (C, H] exactly once: sequences 1..H
  assert.equal(new Set(seen.map(i => i.sequence)).size, H);
  assert.deepEqual(seen.map(i => i.sequence), Array.from({ length: H }, (_, i) => i + 1)); // no gaps, no duplicates
  assert.equal(seen.every(i => i.sequence > 0 && i.sequence <= H), true); // late arrivals excluded
});

test("fetching never acknowledges; the explicit action acknowledges exactly H and H+1 stays new", t => {
  const { store, human } = fixture(t);
  postMessages(store, human, 10);
  const before = store.returnBrief(human, "commons", {});
  store.returnBrief(human, "commons", {}); // more reads
  assert.equal(store.snapshot(human, "commons").cursor, 0); // reads moved nothing
  store.markCaughtUp(human, "commons", before.history.evaluatedThrough); // ack exactly H
  assert.equal(store.snapshot(human, "commons").cursor, before.history.evaluatedThrough);
  postMessages(store, human, 1, "new-");
  const after = store.returnBrief(human, "commons", {});
  assert.equal(after.history.cursor, before.history.evaluatedThrough);
  assert.equal(after.history.items.length, 1); // H+1 is the only new event
  assert.equal(after.history.items[0].event.data.body, "new-1");
});

test("history stops at H while current stays live through N, both labeled", t => {
  const { store, owner, human } = fixture(t);
  postMessages(store, human, 5);
  const page1 = store.returnBrief(human, "commons", { limit: 50 });
  const H = page1.history.evaluatedThrough;
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId: "w-late", title: "late work", definitionOfDone: "done", accountableMemberId: "human" }));
  const page2 = store.returnBrief(human, "commons", { horizon: H, after: page1.history.items.at(-1).sequence, cursor: page1.history.cursor, limit: 50 });
  assert.equal(page2.history.evaluatedThrough, H);
  assert.equal(page2.history.items.some(i => i.event.type === T.WORK_PROPOSED), false); // the proposal is past H
  assert.equal(page2.current.evaluatedThrough, H + 1); // N moved
  assert.deepEqual(page2.current.needsAttention.map(i => i.workItemId), ["w-late"]); // live projection sees it
  assert.deepEqual(page2.current.workInvolvingMe.map(i => i.workItemId), ["w-late"]);
});

test("older unresolved work survives catch-up", t => {
  const { store, owner, human } = fixture(t);
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId: "w-open", title: "still open", definitionOfDone: "done", accountableMemberId: "human" }));
  store.markCaughtUp(human, "commons", store.snapshot(human, "commons").sequence); // acknowledge everything
  const brief = store.returnBrief(human, "commons", {});
  assert.equal(brief.history.items.length, 0); // nothing new
  assert.deepEqual(brief.current.needsAttention.map(i => [i.workItemId, i.step]), [["w-open", "accept"]]); // still owed
  assert.deepEqual(brief.current.workInvolvingMe.map(i => i.workItemId), ["w-open"]); // still context
});

test("verification and owner decisions are first-class history items and close the loop", t => {
  const { store, owner, human, agent } = fixture(t);
  completeLifecycle(store, owner, human, agent, "w-full");
  const brief = store.returnBrief(agent, "commons", {});
  const types = brief.history.items.map(i => i.event.type);
  assert.equal(types.includes(T.VERIFICATION_RECORDED), true);
  assert.equal(types.includes(T.OWNER_DECISION_RECORDED), true);
  assert.deepEqual(store.returnBrief(owner, "commons", {}).current.needsAttention, []); // approved: terminal, no attention
  assert.deepEqual(store.returnBrief(owner, "commons", {}).current.workInvolvingMe, []); // terminal is not ongoing involvement
});

test("the proposer is drillable from history and the projection after replay; forged provenance never enters", t => {
  const { store, owner, human } = fixture(t);
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId: "w-prop", title: "provenance", definitionOfDone: "done", accountableMemberId: "human" }));
  const brief = store.returnBrief(human, "commons", {});
  const proposed = brief.history.items.find(i => i.event.type === T.WORK_PROPOSED && i.event.data.workItemId === "w-prop");
  assert.equal(proposed.event.actorId, "owner"); // envelope carries the proposer in history
  const projection = store.snapshot(human, "commons").state.workItems["w-prop"];
  assert.equal(projection.proposedById, "owner"); // projection recovered it from the envelope
  assert.equal(projection.proposedById !== projection.accountableMemberId, true); // it is the proposer, not the accountable member
});

test("cursors are isolated per member", t => {
  const { store, human, agent } = fixture(t);
  postMessages(store, human, 10);
  store.markCaughtUp(human, "commons", 8);
  assert.equal(store.returnBrief(human, "commons", {}).history.cursor, 8);
  assert.equal(store.returnBrief(agent, "commons", {}).history.cursor, 0); // untouched by the other member's ack
  assert.equal(store.returnBrief(agent, "commons", {}).history.items.length > 8 - 3, true); // agent still sees what human acknowledged
});

test("continuation and limit validation rejects forged windows without reading", t => {
  const { store, human } = fixture(t);
  postMessages(store, human, 3);
  const N = store.snapshot(human, "commons").sequence;
  assert.throws(() => store.returnBrief(human, "commons", { limit: 0 }), /Invalid return-brief limit/);
  assert.throws(() => store.returnBrief(human, "commons", { limit: 101 }), /Invalid return-brief limit/);
  assert.throws(() => store.returnBrief(human, "commons", { horizon: N + 1, after: 0 }), /Horizon exceeds room history/);
  assert.throws(() => store.returnBrief(human, "commons", { horizon: 2, after: 5 }), /Invalid continuation cursor/);
  assert.throws(() => store.returnBrief(human, "commons", { horizon: 2, after: null }), /Invalid continuation cursor/);
});

test("HTTP: query parsing, auth, and response shape over the wire", async t => {
  const { store, human } = fixture(t);
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token) => fetch(`${origin}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  postMessages(store, human, 3);
  const ok = await get("/api/rooms/commons/return-brief?limit=2", human);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.history.items.length, 2);
  assert.equal(body.history.hasMore, true);
  assert.equal(typeof body.current.evaluatedThrough, "number");
  const cont = await get(`/api/rooms/commons/return-brief?horizon=${body.history.continuation.horizon}&after=${body.history.continuation.after}&cursor=${body.history.continuation.cursor}&limit=50`, human);
  assert.equal(cont.status, 200);
  const bad = await get("/api/rooms/commons/return-brief?limit=abc", human);
  assert.equal(bad.status, 422); // NaN limit fails safe-integer validation
  const anon = await get("/api/rooms/commons/return-brief");
  assert.equal([401, 403].includes(anon.status), true);
});

test("a cursor moved by another tab rejects the continuation with 409 cursor_changed", t => {
  const { store, human } = fixture(t);
  postMessages(store, human, 10);
  const page1 = store.returnBrief(human, "commons", { limit: 5 }); // tab A freezes H and C=0
  store.markCaughtUp(human, "commons", 5); // tab B acknowledges while A is still paging
  assert.throws(() => store.returnBrief(human, "commons", { ...page1.history.continuation, limit: 5 }),
    error => error.status === 409 && error.code === "cursor_changed");
  // The same continuation with the cursor still in place succeeds and reports the frozen C.
  const { store: s2, human: h2 } = fixture(t);
  postMessages(s2, h2, 10);
  const first = s2.returnBrief(h2, "commons", { limit: 5 });
  const second = s2.returnBrief(h2, "commons", { ...first.history.continuation, limit: 5 });
  assert.equal(second.history.cursor, 0); // frozen C reported on every page, not reread
  assert.equal(second.history.evaluatedThrough, first.history.evaluatedThrough);
});
