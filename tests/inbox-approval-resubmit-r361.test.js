// R36-1 acceptance tests: resubmit/version-bound approval bug.
//
// Room state: server/inbox-approval.mjs resubmit() stores move()'s pending v1
// record in the in-memory queue but returns an unstored v2 copy, so get(),
// list() and the next approve() see the stale v1 draft while the SQLite
// journal row (and the call response) carry v2. Tab owns the fix; these are
// the independent fail-first acceptance tests for Dot's criteria. They must
// FAIL on unfixed main and PASS with the fix:
//
//   (a) response = get = list = SQLite all show the v2/new body after resubmit
//   (b) v2 survives a journal reopen (restart replay) and the next approve
//   (c) a second requestEdits/resubmit cycle reaches v3
//   (d) legacy pending + terminal journals reopen without changing the
//       historical record (pending: fail-first; terminal: guard the fix must keep)
//
// In-process only: the pure journal plus a real RoomStore over a temp SQLite
// file, closed and reopened to exercise the replay path. No HTTP, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalQueue } from "../server/inbox-approval.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOM = "commons";
const AGENT = Object.freeze({ kind: "agent", id: "r361-agent" });
const HUMAN = Object.freeze({ kind: "human", id: "r361-human" });
const THREAD = n => `r361-thread-${n}`;
const V1 = Object.freeze({ subject: "R36-1 v1 subject", body: "r361-body-v1-original" });
const V2 = Object.freeze({ subject: "R36-1 v2 subject", body: "r361-body-v2-resubmitted" });
const V3 = Object.freeze({ subject: "R36-1 v3 subject", body: "r361-body-v3-second-resubmit" });

// ---- pure journal harness: deterministic clock + ids ----
function makeQueue() {
  let now = 1_700_000_000_000;
  let seq = 0;
  return createApprovalQueue({ clock: () => now++, id: () => `r361-id-${++seq}` });
}
function resubmitOnce(queue, threadId, first, second) {
  const proposed = queue.propose(threadId, { draft: first, byAgent: AGENT, channel: "room" });
  queue.requestEdits(proposed.proposalId, { by: HUMAN, edits: "please revise" });
  return queue.resubmit(proposed.proposalId, { draft: second, byAgent: AGENT });
}

// ---- store harness: real RoomStore over a temp SQLite file ----
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-r361-"));
  const dbFile = join(directory, "room.sqlite");
  const state = { directory, dbFile, store: null };
  state.store = new RoomStore(dbFile);
  state.store.initialize(initialRoom(ROOM));
  // Restart: close and open a fresh RoomStore over the same file. The new
  // InboxCollabStore replays every collab journal from SQLite on first room
  // access, exactly like a production restart.
  state.reopen = () => {
    state.store.close();
    state.store = new RoomStore(dbFile);
    return state.store;
  };
  state.persisted = proposalId => JSON.parse(state.store.db.prepare(
    "SELECT record_json FROM collab_approvals WHERE room_id=? AND proposal_id=?")
    .get(ROOM, proposalId).record_json);
  t.after(() => {
    state.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return state;
}
const listedById = (store, proposalId) =>
  store.collab.listApprovals(ROOM).find(p => p.proposalId === proposalId);
function resubmitOnceStore(store, threadId, first, second) {
  const proposed = store.collab.proposeDraft(ROOM, threadId,
    { draft: first, byAgent: AGENT, channel: "room" });
  store.collab.decideApproval(ROOM, proposed.proposalId,
    { decision: "edit", by: HUMAN, editedBody: "please revise" });
  return store.collab.resubmitApproval(ROOM, proposed.proposalId,
    { draft: second, byAgent: AGENT });
}

test("R36-1(a) journal: resubmit response, get() and list() all carry the v2 draft", () => {
  const queue = makeQueue();
  const response = resubmitOnce(queue, THREAD("a"), V1, V2);
  // The response already carries v2 on unfixed main; the queue does not.
  assert.equal(response.draft.body, V2.body);
  assert.equal(response.version, 2);
  assert.equal(response.status, "pending");
  assert.equal(response.requestedEdits, null);

  const got = queue.get(response.proposalId);
  assert.equal(got.draft.body, V2.body, "get() after resubmit shows the stale v1 draft");
  assert.equal(got.version, 2, "get() after resubmit shows the stale v1 version");
  assert.equal(got.requestedEdits, null, "get() after resubmit keeps the cleared edit request");

  const listed = queue.list().find(p => p.proposalId === response.proposalId);
  assert.equal(listed.draft.body, V2.body, "list() after resubmit shows the stale v1 draft");
  assert.equal(listed.version, 2, "list() after resubmit shows the stale v1 version");
});

test("R36-1(a) store: resubmit response, list() and SQLite all carry the v2 draft", t => {
  const f = setup(t);
  const response = resubmitOnceStore(f.store, THREAD("b"), V1, V2);
  assert.equal(response.draft.body, V2.body);
  assert.equal(response.version, 2);
  assert.equal(response.status, "pending");

  const listed = listedById(f.store, response.proposalId);
  assert.equal(listed.draft.body, V2.body, "store list() after resubmit shows the stale v1 draft");
  assert.equal(listed.version, 2, "store list() after resubmit shows the stale v1 version");
  assert.equal(listed.status, "pending");

  const persisted = f.persisted(response.proposalId);
  assert.equal(persisted.draft.body, V2.body);
  assert.equal(persisted.version, 2);
  assert.equal(persisted.status, "pending");
});

test("R36-1(b) store: v2 survives a journal reopen and the next approve finalizes v2", t => {
  const f = setup(t);
  const response = resubmitOnceStore(f.store, THREAD("c"), V1, V2);
  f.reopen();

  const approved = f.store.collab.decideApproval(ROOM, response.proposalId,
    { decision: "approve", by: HUMAN });
  assert.equal(approved.status, "approved");
  assert.equal(approved.draft.body, V2.body, "approve after resubmit finalizes the stale v1 draft");
  assert.equal(approved.version, 2);

  const persisted = f.persisted(response.proposalId);
  assert.equal(persisted.status, "approved");
  assert.equal(persisted.draft.body, V2.body, "SQLite holds the stale v1 draft after approve");
  assert.equal(persisted.version, 2);
});

test("R36-1(c) store: a second requestEdits/resubmit cycle reaches v3", t => {
  const f = setup(t);
  const first = resubmitOnceStore(f.store, THREAD("d"), V1, V2);
  f.store.collab.decideApproval(ROOM, first.proposalId,
    { decision: "edit", by: HUMAN, editedBody: "revise twice" });
  const response = f.store.collab.resubmitApproval(ROOM, first.proposalId,
    { draft: V3, byAgent: AGENT });

  assert.equal(response.draft.body, V3.body);
  assert.equal(response.version, 3, "second resubmit never advances past v2");

  const listed = listedById(f.store, first.proposalId);
  assert.equal(listed.draft.body, V3.body, "store list() after the second resubmit shows a stale draft");
  assert.equal(listed.version, 3);
  assert.equal(listed.status, "pending");

  const persisted = f.persisted(first.proposalId);
  assert.equal(persisted.draft.body, V3.body);
  assert.equal(persisted.version, 3);
});

test("R36-1(d) store: a legacy pending journal reopens as its historical record", t => {
  const f = setup(t);
  const response = resubmitOnceStore(f.store, THREAD("e"), V1, V2);
  // What the journal actually persisted before the restart.
  const historical = f.persisted(response.proposalId);
  assert.equal(historical.status, "pending");
  assert.equal(historical.draft.body, V2.body);
  assert.equal(historical.version, 2);

  f.reopen(); // replay must succeed; memory must match the historical row.

  const listed = listedById(f.store, response.proposalId);
  assert.equal(listed.status, "pending");
  assert.equal(listed.draft.body, historical.draft.body,
    "reopened pending journal shows the stale v1 draft instead of its historical record");
  assert.equal(listed.version, historical.version,
    "reopened pending journal shows the stale v1 version instead of its historical record");
});

test("R36-1(d) guard: a legacy terminal journal reopens with its historical approved body intact", t => {
  const f = setup(t);
  const proposed = f.store.collab.proposeDraft(ROOM, THREAD("f"),
    { draft: V1, byAgent: AGENT, channel: "room" });
  f.store.collab.decideApproval(ROOM, proposed.proposalId,
    { decision: "approve", by: HUMAN, note: "looks good" });
  const historical = f.persisted(proposed.proposalId);
  assert.equal(historical.status, "approved");
  assert.equal(historical.draft.body, V1.body);

  f.reopen(); // must not throw and must not rewrite history.

  const listed = listedById(f.store, proposed.proposalId);
  assert.equal(listed.status, "approved");
  assert.equal(listed.draft.body, V1.body, "reopen changed the historical approved body");
  assert.equal(listed.version, 1);
});
