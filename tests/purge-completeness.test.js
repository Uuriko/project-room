// Purge-completeness regressions from the HUNT-ORPHANS referential-integrity
// census (~/workspace/hunt-2026-10-18/orphans.md, charters C2 + C3):
//
// C2 — public_work_requests (the public-work idempotency journal) was reached
// by no deletion path at all: room purge deleted a room's public_work_tasks
// but left the request rows keyed to those offers behind, carrying
// input/outcome payloads, and the stored outcome stayed replayable through
// request() after the offer was gone. The registry now carries a `via` row
// through public_work_tasks for room purge and an identity match on actor_id
// (actor_id is an identity key: act() authenticates an agent identity; the
// account-deletion executor has no actor key to match).
//
// C3 — operator room purge silently left the room's analytics shadow behind:
// analytics_events (room_id), analytics_room_cursor and claim_bond_shadow had
// no registry rows, so they appeared in no purge plan — neither deleted nor
// retained-with-reason. All three are now declared delete-on-room-purge:
// analytics_events because account deletion already deletes the account's
// analytics events (the retention runner's keep-unexported rule guards
// pre-export loss, not a post-purge retention right); claim_bond_shadow
// because it is derived from the room's events, which the purge deletes, so
// the rows would outlive their own source; analytics_room_cursor because it
// is an inert tail cursor for a room the tail will never visit again. The
// tables are lazy/additive, so the rows are optional: a store that never ran
// the analytics tooling purges cleanly and reports zero rows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PublicWorkClaims, publicWorkClaimsSchema } from "../server/public-work-claims.mjs";
import { publicWorkClaimFenceSchema } from "../server/public-work-claim-fence.mjs";
import { createOperatorPurge } from "../server/operator-purge.mjs";
import { ensureAnalyticsSchema } from "../server/analytics/schema.mjs";
import { ensureShadowSchema } from "../server/analytics/claim-bond-shadow.mjs";

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-purge-completeness-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function purgeTargets(store, targets) {
  const purge = createOperatorPurge(store);
  const plan = purge.plan({ targets, reason: "purge completeness regression" }, "req-plan");
  const executed = purge.execute({ planId: plan.planId, confirmToken: plan.confirmToken }, "req-execute");
  assert.equal(executed.result, "executed");
  return plan;
}

const planRows = (plan, table) => plan.counts.find(row => row.table === table)?.rows;

function enableTask(store, roomId, offerId, files) {
  const input = { requestId: `create-${offerId}`, offerId, reviewerMemberIds: ["owner"],
    terms: { kind: "task", title: offerId, summary: "Public result", acceptanceCriteria: ["Deliver the declared change"],
      repositoryUrl: "https://github.com/Example/Project", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } };
  store.projectOffers.create(roomId, "owner", input);
  store.projectOffers.transition(roomId, "owner", offerId, "publish", { requestId: `publish-${offerId}`, expectedRevision: 1 });
  return new PublicWorkClaims(store).enable(roomId, "owner", offerId,
    { requestId: `enable-${offerId}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files });
}

const requestRows = (store, where, param) =>
  store.db.prepare(`SELECT count(*) AS n FROM public_work_requests WHERE ${where}`).get(param).n;

test("C2: room purge deletes the room's public_work_requests and the stored outcome cannot replay", t => {
  const store = open(t);
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("spare"));
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const service = new PublicWorkClaims(store);
  const worker = store.identities.create("Purge worker");
  enableTask(store, "commons", "purge-task", ["src/a.js"]);
  service.act("purge-task", worker.secret, "claim", { requestId: "claim-1", expectedTermsVersion: 1 });
  enableTask(store, "spare", "spare-task", ["src/b.js"]);
  service.act("spare-task", worker.secret, "claim", { requestId: "claim-2", expectedTermsVersion: 1 });
  assert.equal(requestRows(store, "offer_id=?", "purge-task"), 2, "enable + claim journal rows exist");
  assert.equal(requestRows(store, "offer_id=?", "spare-task"), 2);

  const plan = purgeTargets(store, [{ kind: "room", id: "commons" }]);
  assert.equal(planRows(plan, "public_work_requests"), 2, "the plan accounts for the journal rows by name");
  assert.equal(requestRows(store, "offer_id=?", "purge-task"), 0, "room purge deletes the room's request rows");
  assert.equal(requestRows(store, "offer_id=?", "spare-task"), 2, "the other room's request rows are untouched");

  // The ghost: the same (offer, actor, request) triple must not be answered
  // from the stored outcome once the offer is purged — request() has to run
  // the operation (here a sentinel) instead of replaying outcome_json.
  assert.throws(
    () => service.request({ offer_id: "purge-task" }, worker.identityId, "claim",
      { requestId: "claim-1", expectedTermsVersion: 1 }, () => { throw new Error("operation-ran"); }),
    error => error.message === "operation-ran");
});

test("C2: identity purge deletes the actor's public_work_requests and leaves other actors' rows", t => {
  const store = open(t);
  store.initialize(initialRoom("commons"));
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const service = new PublicWorkClaims(store);
  const [workerA, workerB] = [store.identities.create("Actor A"), store.identities.create("Actor B")];
  enableTask(store, "commons", "task-a", ["src/a.js"]);
  enableTask(store, "commons", "task-b", ["src/b.js"]);
  service.act("task-a", workerA.secret, "claim", { requestId: "claim-a", expectedTermsVersion: 1 });
  service.act("task-b", workerB.secret, "claim", { requestId: "claim-b", expectedTermsVersion: 1 });
  assert.equal(requestRows(store, "actor_id=?", workerA.identityId), 1);
  assert.equal(requestRows(store, "actor_id=?", workerB.identityId), 1);
  assert.equal(requestRows(store, "actor_id=?", "owner:commons:owner"), 2, "the two enable rows");

  const plan = purgeTargets(store, [{ kind: "identity", id: workerA.identityId }]);
  assert.equal(planRows(plan, "public_work_requests"), 1, "the plan counts the actor's rows");
  assert.equal(requestRows(store, "actor_id=?", workerA.identityId), 0, "the purged actor's rows are gone");
  assert.equal(requestRows(store, "actor_id=?", workerB.identityId), 1, "another actor's rows stay");
  assert.equal(requestRows(store, "actor_id=?", "owner:commons:owner"), 2, "the owner's enable rows stay");
});

test("C3: room purge plan accounts for the analytics shadow tables and execute deletes the room's rows", t => {
  const store = open(t);
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("spare"));
  ensureAnalyticsSchema(store.db);
  ensureShadowSchema(store.db);
  const eventRow = store.db.prepare(`INSERT INTO analytics_events
    (id, name, v, at, room_id, account_id, actor_kind, actor_id, source, loop, props)
    VALUES (?, 'room_viewed', 1, 1000, ?, 'acct-1', 'agent', 'actor-1', 'tail', 'core', '{}')`);
  eventRow.run("ae-commons-1", "commons");
  eventRow.run("ae-commons-2", "commons");
  eventRow.run("ae-spare-1", "spare");
  const cursorRow = store.db.prepare("INSERT INTO analytics_room_cursor(room_id, last_seq, updated_at) VALUES (?, 5, 1000)");
  cursorRow.run("commons");
  cursorRow.run("spare");
  const shadowRow = store.db.prepare(`INSERT INTO claim_bond_shadow
    (id, claim_id, kind, owner_id, amount_millis, at, room_id, room_seq) VALUES (?, 'starter', 'bond-posted', 'actor-1', 0, 1000, ?, 5)`);
  shadowRow.run("sb-commons-1", "commons");
  shadowRow.run("sb-commons-2", "commons");
  shadowRow.run("sb-spare-1", "spare");

  const plan = purgeTargets(store, [{ kind: "room", id: "commons" }]);
  assert.equal(planRows(plan, "analytics_events"), 2, "plan names analytics_events");
  assert.equal(planRows(plan, "analytics_room_cursor"), 1, "plan names analytics_room_cursor");
  assert.equal(planRows(plan, "claim_bond_shadow"), 2, "plan names claim_bond_shadow");
  const count = (table, roomId) => store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE room_id=?`).get(roomId).n;
  assert.equal(count("analytics_events", "commons"), 0);
  assert.equal(count("analytics_room_cursor", "commons"), 0);
  assert.equal(count("claim_bond_shadow", "commons"), 0);
  assert.equal(count("analytics_events", "spare"), 1, "the other room's analytics stay");
  assert.equal(count("analytics_room_cursor", "spare"), 1);
  assert.equal(count("claim_bond_shadow", "spare"), 1);
});

test("C3: room purge works on a store where the analytics tables were never created", t => {
  const store = open(t);
  store.initialize(initialRoom("commons"));
  for (const table of ["analytics_events", "analytics_room_cursor", "claim_bond_shadow"]) {
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined,
      `${table} is absent from a fresh store (test premise)`);
  }
  const plan = purgeTargets(store, [{ kind: "room", id: "commons" }]);
  assert.equal(planRows(plan, "analytics_events"), 0, "absent tables report zero rows, by name");
  assert.equal(planRows(plan, "analytics_room_cursor"), 0);
  assert.equal(planRows(plan, "claim_bond_shadow"), 0);
});
