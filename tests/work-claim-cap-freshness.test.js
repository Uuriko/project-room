// FIX-70: the per-member open-claim cap must read the live board, never a
// stale counter.
// guild-hb (2026-10-07) measured 3 phantom 409 too_many_open_claims ~70 s
// after releases: board-verified true held count was 16 while the server
// refused as if 20 were held. Fail-first history: the first version of this
// test asserted the buggy 409 on the release -> immediate re-claim sequence.
// It FAILED on both registry implementations (in-memory and durable SQLite):
// the re-claims returned 200. Every too_many_open_claims site
// (work-claim-routes.mjs claim/create-with-assignee/reassign,
// work-claim-mirror.mjs, land-queue.mjs) computes the held count live from
// registry.list() on each request — there is no cached counter to go stale,
// and releaseWork clears owner + state in the same write. These tests pin
// that live-read behavior so a future cached counter cannot reintroduce
// phantom 409s.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";

// Mirrors ACTIVE_CLAIM_STATES in server/work-claims.mjs (not exported there).
const ACTIVE_CLAIM_STATES = ["claimed", "in_progress", "blocked"];

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body, query = "") => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

const CAP = 5;
const heldBy = (registry, memberId) =>
  registry.list("room1").filter(entry => entry.owner === memberId && ACTIVE_CLAIM_STATES.includes(entry.state)).length;

async function releaseItem(registry, memberId, id) {
  const item = registry.get("room1", id);
  const released = await call(registry, memberId, "release", id, {
    expectedClaimedAt: item.claimedAt,
    expectedHistoryLength: item.history.length,
  });
  assert.equal(released.status, 200);
  return released;
}

async function assertCapFreesImmediately(registry) {
  registry.configure("room1", { maxMemberOpenClaims: CAP });
  for (let index = 0; index < CAP; index += 1) {
    const id = `cap-${index}`;
    assert.equal((await call(registry, "holder", "create", null, { id })).status, 201);
    assert.equal((await call(registry, "holder", "claim", id, {})).status, 200);
  }
  assert.equal(heldBy(registry, "holder"), CAP);
  // Sanity: the cap is really enforced at CAP.
  assert.equal((await call(registry, "holder", "create", null, { id: "cap-over" })).status, 201);
  const refused = await call(registry, "holder", "claim", "cap-over", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.value.error.code, "too_many_open_claims");

  // Release 3 of 5 (true held: 5 -> 2), then immediately claim 3 more.
  // A stale counter would 409 here as if 5 were still held; the live
  // count admits all three.
  await releaseItem(registry, "holder", "cap-0");
  await releaseItem(registry, "holder", "cap-1");
  await releaseItem(registry, "holder", "cap-2");
  assert.equal(heldBy(registry, "holder"), 2);
  for (let index = 0; index < 3; index += 1) {
    const id = `reclaim-${index}`;
    assert.equal((await call(registry, "holder", "create", null, { id })).status, 201);
    const reclaimed = await call(registry, "holder", "claim", id, {});
    assert.equal(reclaimed.status, 200);
    assert.equal(reclaimed.value.owner, "holder");
  }
  assert.equal(heldBy(registry, "holder"), CAP);
  // And the freed-then-refilled member is refused again exactly at cap.
  assert.equal((await call(registry, "holder", "create", null, { id: "cap-over-2" })).status, 201);
  const refusedAgain = await call(registry, "holder", "claim", "cap-over-2", {});
  assert.equal(refusedAgain.status, 409);
  assert.equal(refusedAgain.value.error.code, "too_many_open_claims");
}

test("FIX-70: a release frees the per-member cap slot immediately (in-memory registry)", async () => {
  await assertCapFreesImmediately(createWorkClaimRegistry());
});

test("FIX-70: a release frees the per-member cap slot immediately (durable SQLite registry)", async t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fix70-cap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "room.sqlite"));
  db.exec(workClaimSchema);
  t.after(() => db.close());
  await assertCapFreesImmediately(createDurableWorkClaimRegistry(db));
});
