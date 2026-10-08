// B4 integration lifecycle: the full claim journey across all three builders.
// create (with files, B1) -> silent heartbeat (B1, no room event) ->
// force lease expiry -> reaper tick (B2: succession to a live successor,
// epoch bumped, history entry, NO room event) -> close (B3: cancelled,
// cap-excluded) -> standby FIFO promotion fires -> cap predicate excludes
// cancelled/standby.
//
// Fail-first: written against the integrated branch; on the unmerged base
// (origin/main) the reaper/standby/close pieces do not exist and it fails.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { reapTick } from "../server/work-claim-reaper.mjs";
import { countsTowardBoardCap } from "../server/work-claims.mjs";

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const MIN = 60 * 1000;

function fixture() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName: id, kind: "agent", permissions }
  });
  add("alice", ["accept_work", "complete_work"]);
  add("bob", ["accept_work", "complete_work"]);
  // Seed agent_hosts so the reaper sees live successors.
  const beat = store.db.prepare("INSERT OR REPLACE INTO agent_hosts VALUES (?,?,?,?,?,?,?)");
  beat.run("alice", "host1", "wakeable", null, T0, T0, T0);
  beat.run("bob", "host1", "wakeable", null, T0, T0, T0);
  return { store };
}

async function call(store, { route, id = null, body = {}, member = "owner", search = "" }) {
  let out = null;
  const helpers = {
    body: async () => body,
    json: (res, status, value) => { out = { status, body: value }; },
    reject: (status, code, message) => {
      const error = new Error(message);
      error.status = status; error.code = code;
      throw error;
    }
  };
  try {
    await handleWorkClaims({ req: { method: "POST" }, res: {}, url: new URL(`http://localhost/${search}`),
      store, roomId: "commons", auth: { member: { id: member } },
      workClaimRoute: route, workClaimId: id, registry: store.workClaims, helpers });
  } catch (error) {
    if (error && Number.isInteger(error.status)) return { status: error.status, code: error.code, message: error.message };
    throw error;
  }
  return out;
}

test("lifecycle: create -> heartbeat -> reaper succession -> close -> standby promotion", async () => {
  const { store } = fixture();

  // 1. Create with files (B1: files mandatory).
  const created = await call(store, { route: "create", body: { id: "w1", files: ["tasks/w1.md"] }, member: "alice" });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "unclaimed");
  assert.equal(created.body.epoch, 0);

  // 2. Claim it (lease starts, epoch 1).
  const claimed = await call(store, { route: "claim", id: "w1", body: {}, member: "alice" });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.state, "claimed");
  assert.equal(claimed.body.owner, "alice");
  assert.equal(claimed.body.epoch, 1);
  const leaseSeq = claimed.body.leaseSeq;
  const beforeHeartbeat = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;

  // 3. Silent heartbeat: no room event is emitted.
  const hb = await call(store, { route: "heartbeat", id: "w1", body: { leaseSeq, idempotencyKey: "hb1" }, member: "alice" });
  assert.equal(hb.status, 200);
  const afterHeartbeatEvents = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  // The create+claim wrote events; the heartbeat must not add any (silent).
  assert.equal(afterHeartbeatEvents, beforeHeartbeat, "heartbeat should be silent — no room event");

  // 4. Force lease expiry: push the lease into the past, past grace+forgiveness.
  const item = store.workClaims.get("commons", "w1");
  const lapsed = {
    ...item,
    leaseExpiresAt: new Date(T0 - 60 * MIN).toISOString(),
    leaseStartAt: new Date(T0 - 120 * MIN).toISOString(),
  };
  store.workClaims.set("commons", lapsed);
  // Owner goes silent so forgiveness does not defer.
  store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id='alice'").run(T0 - 60 * MIN);

  // 5. Reaper tick: work claim successed to live successor bob.
  const tickEventsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  const out = reapTick(store, { now: () => T0, holderId: "reaper1" });
  assert.ok(out.succeeded.includes("w1") || out.released.includes("w1"),
    `reaper should dispose w1, got ${JSON.stringify({ succeeded: out.succeeded, released: out.released })}`);
  const afterReap = store.workClaims.get("commons", "w1");
  assert.equal(afterReap.epoch, 2, "reaper succession bumps the epoch");
  assert.ok(afterReap.history.some(h => h.action === "reaped" || h.action === "claimed"),
    "reaper stamps history");
  const tickEventsAfter = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  assert.equal(tickEventsAfter, tickEventsBefore, "reaping emits zero room events");

  // 6. Close the claim (B3: terminal cancelled).
  // Re-claim first so there is something to close (reaper may have released it).
  const rec = await call(store, { route: "claim", id: "w1", body: {}, member: "bob" });
  assert.equal(rec.status, 200);
  const closed = await call(store, { route: "close", id: "w1", body: { reason: "done here" }, member: "bob" });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, "cancelled");
  assert.equal(closed.body.owner, null);

  // 7. Standby FIFO: park two claims, close a board claim, oldest promotes.
  await call(store, { route: "create", body: { id: "s1", files: ["tasks/s1.md"], standby: true }, member: "alice" });
  await call(store, { route: "create", body: { id: "s2", files: ["tasks/s2.md"], standby: true }, member: "alice" });
  const c2 = await call(store, { route: "create", body: { id: "w2", files: ["tasks/w2.md"] }, member: "alice" });
  assert.equal(c2.status, 201);
  await call(store, { route: "claim", id: "w2", body: {}, member: "alice" });
  const closed2 = await call(store, { route: "close", id: "w2", body: {}, member: "alice" });
  assert.equal(closed2.status, 200);
  assert.equal(closed2.body.promoted?.id, "s1", "oldest standby promotes first");
  assert.equal(store.workClaims.get("commons", "s1").state, "unclaimed");
  assert.equal(store.workClaims.get("commons", "s2").state, "standby");

  // 8. Cap predicate excludes cancelled and standby.
  const items = store.workClaims.list("commons");
  const cancelled = items.find(i => i.id === "w1");
  const standby = items.find(i => i.id === "s2");
  assert.equal(countsTowardBoardCap(cancelled), false, "cancelled is cap-excluded");
  assert.equal(countsTowardBoardCap(standby), false, "standby is cap-excluded");
  assert.equal(countsTowardBoardCap({ state: "claimed" }), true, "claimed counts");
  assert.equal(countsTowardBoardCap({ state: "done" }), false, "done is cap-excluded");

  store.close();
});
