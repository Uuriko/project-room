// Expression index for the work-item history scan (SPEED-PLAN rank 4,
// cluster-05 LANE-05-04 index gap #1).
//
// workItemHistory ran
//   SELECT body FROM events
//   WHERE room_id=? AND json_extract(body,'$.data.workItemId')=? ORDER BY sequence
// with no index on the expression: the planner could only SEARCH events by
// room (the (room_id, sequence) PK) and json_extract every body in the room
// — 6–21 ms per 1,061 events locally, an estimated 0.6–2 s at 100k events on
// the single-threaded Durable Object. The additive expression index
// events_room_work_item (room_id, json_extract(body,'$.data.workItemId'))
// follows the events_room_type precedent (ensureEventTypeIndex): created by
// repairProjectionProvenance on eager opens and lazily by workItemHistory
// itself before its read transaction. This suite pins:
//   1. a fresh store carries the index with the exact expression;
//   2. the exact history query plans as a SEARCH over the new index (with a
//      dropped-index negative control proving the assertion can fail);
//   3. a pre-index store converges through workItemHistory itself, and the
//      history it returns is the index-independent truth.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, WORK_ITEM_HISTORY_EVENT_SQL } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// The exact workItemHistory statement (server/store.mjs), and the same scan
// unpinned, which is how it ran before this index existed.
const HISTORY_SQL = WORK_ITEM_HISTORY_EVENT_SQL;
const UNPINNED_SQL = "SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.data.workItemId')=? ORDER BY sequence";
const INDEX_SQL = "CREATE INDEX events_room_work_item ON events(room_id, json_extract(body,'$.data.workItemId'))";

const indexSql = db => db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='index' AND name='events_room_work_item'").get()?.sql;
const planOf = db => db.prepare(`EXPLAIN QUERY PLAN ${HISTORY_SQL}`)
  .all("commons", "task-a").map(row => row.detail).join("\n");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "workitem-history-index-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-worker", type: "member.added",
    data: { memberId: "worker", displayName: "worker", kind: "human", permissions: ["accept_work", "complete_work", "write_external"] },
  });
  const workerKey = store.issueAccessKey("commons", "worker");
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  send(ownerKey, "propose-a", "work.proposed", {
    workItemId: "task-a", title: "Task A", definitionOfDone: "Ship it",
    accountableMemberId: "worker", verifierMemberId: "owner", mode: "write",
  });
  const revision = () => store.room("commons").state.workItems["task-a"].revision;
  const mutate = (id, type, data = {}) =>
    send(workerKey, id, type, { workItemId: "task-a", expectedRevision: revision(), ...data });
  mutate("accept-a", "work.accepted");
  mutate("claim-a", "claim.acquired", {
    repository: "Uuriko/project-room", ref: "main", paths: ["server/**"],
    expiresAt: new Date(Date.now() + 2 * 3600e3).toISOString(),
  });
  mutate("start-a", "work.started");
  // Unrelated room traffic the history scan must step over.
  for (let i = 0; i < 10; i++)
    send(ownerKey, `noise-${i}`, "message.posted", { messageId: `noise-${i}`, body: `noise ${i}` });
  return { store, ownerKey };
}

test("a fresh store carries the work-item expression index", t => {
  const { store } = fixture(t);
  assert.equal(indexSql(store.db), INDEX_SQL);
});

test("the history query plans as a SEARCH over events_room_work_item", t => {
  const { store } = fixture(t);
  const withIndex = planOf(store.db);
  assert.match(withIndex, /SEARCH events USING INDEX events_room_work_item \(room_id=\? AND <expr>=\?\)/,
    `expected the work-item index to serve the history scan, plan was: ${withIndex}`);
  // Negative controls: the unpinned scan (the pre-index statement) is NOT
  // served by the expression index — with no ANALYZE statistics the planner
  // prefers the primary key and its free ordering — and once the index is
  // dropped the pinned statement cannot run at all.
  const unpinned = store.db.prepare(`EXPLAIN QUERY PLAN ${UNPINNED_SQL}`)
    .all("commons", "task-a").map(row => row.detail).join("\n");
  assert.match(unpinned, /SEARCH events USING INDEX sqlite_autoindex_events_2 \(room_id=\?\)/,
    `expected the pre-index room scan for the unpinned statement, plan was: ${unpinned}`);
  store.db.exec("DROP INDEX events_room_work_item");
  assert.throws(() => planOf(store.db), /no such index/);
});

test("a pre-index store converges through workItemHistory, history unchanged", t => {
  const { store, ownerKey } = fixture(t);
  const before = store.workItemHistory(ownerKey, "commons", "task-a");
  assert.deepEqual(before.changes.map(change => change.type),
    ["work.proposed", "work.accepted", "claim.acquired", "work.started"]);
  store.db.exec("DROP INDEX events_room_work_item");
  assert.equal(indexSql(store.db), undefined);
  // The lazy ensure inside workItemHistory recreates the index and the
  // returned history is identical to the indexed read.
  const after = store.workItemHistory(ownerKey, "commons", "task-a");
  assert.ok(indexSql(store.db), "workItemHistory recreated the index");
  assert.deepEqual(after, before);
  assert.match(planOf(store.db), /events_room_work_item/);
});
