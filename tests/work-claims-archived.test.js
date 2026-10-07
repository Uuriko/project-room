// H4 room-lifecycle audit: the work-claims board honors archive.
// Archive closes every write to the room (server/room-lifecycle.mjs,
// src/events.js: "no further event of any type is accepted for that room").
// The board is part of the room, so member-facing claim mutations on an
// archived room are refused with 409 room_archived — the same code the
// event-log commands use. Reads stay available, and read-triggered lease
// sweeps / deploy closures do not mutate the frozen board.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: "add-coord", type: "member.added",
    data: { memberId: "coord", displayName: "Coord", kind: "agent", permissions: ["accept_work", "complete_work"] }
  });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  const archive = async () => {
    const r = await call(ownerKey, "/commands", { id: randomUUID(), type: "room.archived", data: {} });
    assert.equal(r.status, 201);
  };
  return { store, ownerKey, call, archive };
}

test("archived room: every work-claim mutation is refused with 409 room_archived", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "w1", title: "before archive" })).status, 201);
  assert.equal((await f.call(f.ownerKey, "/work-claims/w1/claim", {})).status, 200);
  await f.archive();
  const mutations = [
    ["create", "/work-claims", { id: "w2", title: "after archive" }],
    ["claim", "/work-claims/w1/claim", {}],
    ["update", "/work-claims/w1/update", { state: "in_progress" }],
    ["renew", "/work-claims/w1/renew", { note: "still working" }],
    ["release", "/work-claims/w1/release", {}],
    ["reassign", "/work-claims/w1/reassign", { newOwner: "coord" }],
    ["review-note", "/work-claims/w1/review", { note: "looks good" }],
    ["sweep", "/work-claims/sweep", {}],
  ];
  for (const [name, path, body] of mutations) {
    const r = await f.call(f.ownerKey, path, body);
    assert.equal(r.status, 409, `${name}: expected 409, got ${r.status} ${JSON.stringify(r.value).slice(0, 160)}`);
    assert.equal(r.value?.error?.code, "room_archived", `${name}: expected room_archived code`);
  }
});

test("archived room: reads stay available (list, get, status)", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "w1", title: "before archive" })).status, 201);
  await f.archive();
  assert.equal((await f.call(f.ownerKey, "/work-claims")).status, 200);
  assert.equal((await f.call(f.ownerKey, "/work-claims/w1")).status, 200);
  assert.equal((await f.call(f.ownerKey, "/work-claims/status")).status, 200);
});

test("archived room: the board is frozen — read-triggered lease sweeps do not release", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "w1", title: "expiring claim" })).status, 201);
  assert.equal((await f.call(f.ownerKey, "/work-claims/w1/claim", {})).status, 200);
  await f.archive();
  // Lapse the lease behind the frozen board's back (direct registry write,
  // the way time passing would).
  const item = f.store.workClaims.get("commons", "w1");
  f.store.workClaims.set("commons", { ...item, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const listed = await f.call(f.ownerKey, "/work-claims");
  assert.equal(listed.status, 200);
  const seen = (listed.value.items ?? listed.value.claims ?? []).find(c => c.id === "w1");
  assert.ok(seen, "claim still listed");
  assert.equal(seen.state, "claimed", "expired lease is NOT released on an archived room");
  assert.deepEqual(listed.value.swept, [], "no sweep side effects reported");
});

test("control: on an active room the same lease still sweeps on read", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.ownerKey, "/work-claims", { id: "w1", title: "expiring claim" })).status, 201);
  assert.equal((await f.call(f.ownerKey, "/work-claims/w1/claim", {})).status, 200);
  const item = f.store.workClaims.get("commons", "w1");
  f.store.workClaims.set("commons", { ...item, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const listed = await f.call(f.ownerKey, "/work-claims");
  assert.equal(listed.status, 200);
  const seen = (listed.value.items ?? listed.value.claims ?? []).find(c => c.id === "w1");
  assert.ok(seen, "claim still listed");
  assert.equal(seen.state, "unclaimed", "expired lease releases on an active room");
});
