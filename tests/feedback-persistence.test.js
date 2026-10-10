// Durable /feedback persistence: the store must survive a restart.
// Before this, a filing debited the filer's Mark and then vanished on
// restart if it had not yet been triaged onto the claims board.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPersistentFeedbackStore, loadSnapshot, ensureFeedbackSchema, saveSnapshot }
  from "../server/feedback-persistence.mjs";

const filing = (path = "/api/rooms/{id}/work-claims", severity = "bug") => ({
  agent: { lane: "lane-a", card_uri: "https://room.example/agents/lane-a.json" },
  endpoint: { method: "POST", path },
  attempt: {
    goal: "claim an open work item",
    request: { method: "POST", path },
    response: { status: 500, body: "boom" },
  },
  observed: "500 with no code",
  expected: "201 with the claim",
  severity,
});

const open = (db, roomId = "room-1") => createPersistentFeedbackStore({ db, roomId });

test("a filing survives a restart", () => {
  const db = new DatabaseSync(":memory:");
  const first = open(db);
  const submitted = first.submit(filing()).item;
  assert.equal(first.size(), 1);

  const afterRestart = open(db); // same database, brand new process-level store
  assert.equal(afterRestart.size(), 1);
  assert.equal(afterRestart.get(submitted.id).id, submitted.id);
  assert.equal(afterRestart.triageQueue().length, 1);
});

test("the Mark ledger survives a restart, so a filer is not charged twice", () => {
  const db = new DatabaseSync(":memory:");
  const first = open(db);
  first.submit(filing());
  const balance = first.mark("lane-a").balance;

  assert.equal(open(db).mark("lane-a").balance, balance);
});

test("ids do not collide after a restart", () => {
  const db = new DatabaseSync(":memory:");
  const a = open(db).submit(filing("/api/rooms/{id}/a")).item;
  const b = open(db).submit(filing("/api/rooms/{id}/b")).item;
  assert.notEqual(a.id, b.id);
});

test("a triage verdict survives a restart", () => {
  const db = new DatabaseSync(":memory:");
  const first = open(db);
  const { id } = first.submit(filing()).item;
  first.triage(id, "real", "lane-reviewer");

  const item = open(db).get(id);
  assert.equal(item.status, first.get(id).status);
  assert.notEqual(item.status, "new");
});

test("drained notifications are not redelivered after a restart", () => {
  const db = new DatabaseSync(":memory:");
  const first = open(db);
  const { id } = first.submit(filing()).item;
  first.triage(id, "real", "lane-reviewer");
  const drained = first.drainNotifications("lane-a");
  assert.ok(drained.length >= 1);

  assert.equal(open(db).drainNotifications("lane-a").length, 0);
});

test("rooms cannot see each other's filings", () => {
  const db = new DatabaseSync(":memory:");
  createPersistentFeedbackStore({ db, roomId: "room-1" }).submit(filing());
  assert.equal(createPersistentFeedbackStore({ db, roomId: "room-2" }).size(), 0);
});

test("a corrupt row starts empty instead of taking the endpoint down", () => {
  const db = new DatabaseSync(":memory:");
  ensureFeedbackSchema(db);
  db.prepare("INSERT INTO feedback_state (room_id, version, snapshot, updated_at) VALUES (?,?,?,?)")
    .run("room-1", 1, "{not json", Date.now());
  assert.equal(loadSnapshot(db, "room-1"), null);
  const store = open(db);
  assert.equal(store.size(), 0);
  assert.ok(store.submit(filing()).item.id); // and still serves
});

test("a snapshot from a newer server is left alone, not misread", () => {
  const db = new DatabaseSync(":memory:");
  ensureFeedbackSchema(db);
  saveSnapshot(db, "room-1", { v: 99 }, Date.now());
  db.prepare("UPDATE feedback_state SET version=99 WHERE room_id=?").run("room-1");
  assert.equal(loadSnapshot(db, "room-1"), null);
});

test("a failing write degrades to in-memory instead of failing the filing", () => {
  const db = new DatabaseSync(":memory:");
  const errors = [];
  const store = createPersistentFeedbackStore({
    db, roomId: "room-1", onError: e => errors.push(e),
  });
  db.exec("DROP TABLE feedback_state");
  const submitted = store.submit(filing()).item;
  assert.ok(submitted.id);       // the agent's filing still succeeded
  assert.equal(errors.length, 1); // and the failure was reported, not swallowed
});

// REL-25 rebase: main added H-2 authority gates (isReviewer /
// isReleaseAuthority). The durable wrapper must pass them through, or a
// restart would silently drop back to "any lane can triage".
test("authority gates pass through the durable store and survive a restart", () => {
  const db = new DatabaseSync(":memory:");
  const gated = () => createPersistentFeedbackStore({ db, roomId: "room-1",
    isReviewer: ["reviewer-a"], isReleaseAuthority: ["owner"] });
  const denied = /not authorized to triage/;
  const first = gated();
  const id = first.submit(filing()).item.id;
  assert.throws(() => first.triage(id, "real", "reviewer-b"), denied);
  const afterRestart = gated();
  assert.throws(() => afterRestart.triage(id, "real", "reviewer-b"), denied);
  afterRestart.triage(id, "real", "reviewer-a");
  const triaged = afterRestart.get(id).status;
  assert.notEqual(triaged, "new");
  assert.equal(gated().get(id).status, triaged); // the authorized triage persisted
});
