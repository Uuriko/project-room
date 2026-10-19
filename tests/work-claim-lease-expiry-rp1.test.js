// RP-1 (Fix Programme v2 §1C, cures RC-1): work-claim lease expiry is
// state maintenance and never rides a read. The stored sweep runs at
// store open and on write requests; GETs present the pure released form
// and persist nothing, emit no event, and fire no wake.
//
// Contracts pinned here:
//  1. Store open materialises leases that lapsed while the store was
//     closed — registry row, one lease_expired event, one wake — and a
//     second open is a no-op.
//  2. A board GET on a mid-session lapse presents the claim released and
//     reports it in `swept`, while the stored row, the journal, and the
//     wake tables are byte-for-byte untouched by the read.
//  3. The next board write converges the stored row and announces the
//     lapse exactly once; a later GET reports nothing left to sweep.
//  4. The presentation helper is pure: inputs are never mutated and
//     non-lapsed items pass through by identity.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createWork, claimWork } from "../server/work-claims.mjs";
import { presentWithLapsedLeases } from "../server/work-claim-expiry.mjs";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3600_000;

function stageClaimedLease(store, roomId, { id, owner, at, leaseHours }) {
  let item = createWork({ id, title: id }, { agentId: "owner", now: at });
  item = claimWork(item, owner, { now: at, leaseHours });
  store.workClaims.set(roomId, item);
  return item;
}

function linkAgent(store, ownerKey, roomId, memberId) {
  const identity = store.identities.create(`Agent ${memberId}`);
  store.identities.link(ownerKey, roomId, {
    identityId: identity.identityId, memberId, displayName: `Agent ${memberId}`,
    permissions: ["accept_work", "complete_work"],
  });
  return identity;
}

const leaseEvents = (store, roomId) => store.db.prepare(
  "SELECT body FROM events WHERE room_id=?").all(roomId)
  .map(row => JSON.parse(row.body))
  .filter(entry => entry.data?.action === "lease_expired");

test("store open materialises lapsed leases exactly once", async t => {
  const dir = mkdtempSync(join(tmpdir(), "rp1-open-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "room.sqlite");
  {
    const store = new RoomStore(file, { now: () => T0 });
    store.initialize(initialRoom("commons"));
    const ownerKey = store.issueAccessKey("commons", "owner");
    linkAgent(store, ownerKey, "commons", "agent");
    stageClaimedLease(store, "commons", { id: "lapsed", owner: "agent", at: T0, leaseHours: 1 });
    stageClaimedLease(store, "commons", { id: "live", owner: "agent", at: T0, leaseHours: 72 });
    store.close();
  }
  const store = new RoomStore(file, { now: () => T0 + 2 * HOUR });
  t.after(() => store.close());
  assert.deepEqual(store.workClaimLeaseSweep.releasedIds, ["lapsed"]);
  assert.equal(store.workClaimLeaseSweep.errors.length, 0);
  const stored = store.workClaims.get("commons", "lapsed");
  assert.equal(stored.state, "unclaimed");
  assert.equal(stored.owner, null);
  assert.equal(stored.history.at(-1).action, "lease_expired");
  assert.equal(store.workClaims.get("commons", "live").state, "claimed");
  assert.equal(leaseEvents(store, "commons").length, 1);
  const signals = store.db.prepare(
    "SELECT message_id FROM agent_wake_signals").all().map(row => row.message_id);
  assert.deepEqual(signals, ["work-claim:lapsed:lease_expired:2026-10-01T01:00:00.000Z"]);
  store.close();
  const again = new RoomStore(file, { now: () => T0 + 3 * HOUR });
  assert.deepEqual(again.workClaimLeaseSweep.releasedIds, [], "a converged store releases nothing at open");
  assert.equal(leaseEvents(again, "commons").length, 1, "no second event on reopen");
  again.close();
});

test("a board GET presents a mid-session lapse and writes nothing; the next write converges it", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const agent = linkAgent(store, ownerKey, "commons", "agent");
  let at = T0;
  store.now = () => at;
  stageClaimedLease(store, "commons", { id: "mid", owner: "agent", at: T0, leaseHours: 1 });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(origin + path, {
      method, headers: { Origin: origin, Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  };
  at = T0 + 2 * HOUR;
  const storedBefore = JSON.stringify(store.workClaims.get("commons", "mid"));
  const eventsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  const list = await call("GET", "/api/rooms/commons/work-claims");
  assert.equal(list.status, 200);
  assert.deepEqual(list.value.swept, ["mid"], "the read reports the lapse it presents");
  assert.equal(list.value.claims.find(claim => claim.id === "mid").state, "unclaimed");
  const single = await call("GET", "/api/rooms/commons/work-claims/mid");
  assert.equal(single.value.state, "unclaimed");
  assert.equal(JSON.stringify(store.workClaims.get("commons", "mid")), storedBefore,
    "the read persisted nothing — the stored row is untouched");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, eventsBefore,
    "the read emitted no event");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals").get().n, 0,
    "the read fired no wake");

  const created = await call("POST", "/api/rooms/commons/work-claims", { id: "other", title: "Other" });
  assert.equal(created.status, 201);
  const converged = store.workClaims.get("commons", "mid");
  assert.equal(converged.state, "unclaimed", "the next write materialised the release");
  assert.equal(converged.history.at(-1).action, "lease_expired");
  assert.equal(leaseEvents(store, "commons").length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=?").get(agent.identityId).n, 1,
    "the lapse woke the former owner exactly once");
  const after = await call("GET", "/api/rooms/commons/work-claims");
  assert.deepEqual(after.value.swept, [], "nothing left to present as swept after convergence");
});

test("presentWithLapsedLeases is pure and passes non-lapsed items through by identity", () => {
  const live = { id: "live", state: "claimed", owner: "agent", leaseExpiresAt: "2026-10-04T00:00:00.000Z", history: [] };
  const lapsed = { id: "old", state: "claimed", owner: "agent", leaseStartAt: "2026-09-30T00:00:00.000Z",
    leaseExpiresAt: "2026-10-01T01:00:00.000Z", claimedAt: "2026-09-30T00:00:00.000Z",
    files: [], fileBlocks: {}, attestations: [], reviews: [], tags: [], history: [] };
  const done = { id: "done", state: "done", owner: null, leaseExpiresAt: null, history: [] };
  const items = [live, lapsed, done];
  const frozen = JSON.stringify(items);
  const view = presentWithLapsedLeases(items, T0 + 2 * HOUR);
  assert.deepEqual(view.releasedIds, ["old"]);
  assert.equal(view.items[0], live, "non-lapsed items are the stored objects themselves");
  assert.equal(view.items[2], done);
  assert.equal(view.items[1].state, "unclaimed");
  assert.equal(view.items[1].owner, null);
  assert.equal(view.items[1].history.at(-1).action, "lease_expired");
  assert.equal(JSON.stringify(items), frozen, "inputs are never mutated");
  const again = presentWithLapsedLeases(view.items, T0 + 2 * HOUR);
  assert.deepEqual(again.releasedIds, [], "the presented form is a fixed point");
});
