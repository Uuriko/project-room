// P1 regression: release must free the member's held-count atomically.
// Contract: after POST /release, an immediate re-claim sees the freed slot —
// zero phantom 409 too_many_open_claims. Regression it guards: the ~60s
// stale-counter lag Squad 2 measured on the live room (release 10 →
// re-claim 10 → phantom 409s ~70s post-release). Existing coverage
// (work-claim-guards.test.js) pins the refusal but never release→reclaim
// immediacy. No new production seam: drives handleWorkClaims directly.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

const N = 10;
const files = i => [`src/task-${i}.mjs`];

test("release 10 → immediate re-claim 10: all succeed, zero phantom 409s", async () => {
  const registry = createWorkClaimRegistry();
  for (let i = 0; i < N; i++) {
    const created = await call(registry, "owner", "create", null, { id: `cap-${i}`, files: files(i) });
    assert.equal(created.status, 201, `create cap-${i}`);
  }
  for (let i = 0; i < N; i++) {
    const claimed = await call(registry, "holder", "claim", `cap-${i}`, { files: files(i) });
    assert.equal(claimed.status, 200, `claim cap-${i}`);
  }
  for (let i = 0; i < N; i++) {
    const released = await call(registry, "holder", "release", `cap-${i}`, { note: "done for now" });
    assert.equal(released.status, 200, `release cap-${i}`);
    assert.equal(released.value.state, "unclaimed");
    assert.equal(released.value.owner, null);
  }
  // Immediate re-claims: the held-count must already reflect the releases.
  const results = [];
  for (let i = 0; i < N; i++) {
    results.push(await call(registry, "holder", "claim", `cap-${i}`, { files: files(i) }));
  }
  const phantoms = results.filter(r => r.status === 409 && r.value?.error?.code === "too_many_open_claims");
  assert.equal(phantoms.length, 0, `phantom 409s: ${phantoms.length}/${N}`);
  for (let i = 0; i < N; i++) assert.equal(results[i].status, 200, `re-claim cap-${i} got ${results[i].status}`);
});

test("release from in_progress also frees the slot immediately", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "wip-0", files: ["src/a.mjs"] });
  assert.equal((await call(registry, "holder", "claim", "wip-0", {})).status, 200);
  assert.equal((await call(registry, "holder", "update", "wip-0", { state: "in_progress" })).status, 200);
  assert.equal((await call(registry, "holder", "release", "wip-0", {})).status, 200);
  const item = registry.get("room1", "wip-0");
  assert.equal(item.state, "unclaimed");
  // A fresh claim on another item must not see the released one as held.
  await call(registry, "owner", "create", null, { id: "wip-1", files: ["src/b.mjs"] });
  const reclaimed = await call(registry, "holder", "claim", "wip-1", {});
  assert.equal(reclaimed.status, 200);
  assert.notEqual(reclaimed.value?.error?.code, "too_many_open_claims");
});

test("done frees the member slot: close 10 → claim 10 fresh", async () => {
  const registry = createWorkClaimRegistry();
  registry.configure("room1", { maxMemberOpenClaims: 10 });
  for (let i = 0; i < N; i++) {
    assert.equal((await call(registry, "owner", "create", null, { id: `done-${i}`, files: files(i) })).status, 201);
    assert.equal((await call(registry, "holder", "claim", `done-${i}`, {})).status, 200);
  }
  // At cap: one more claim is refused.
  await call(registry, "owner", "create", null, { id: "done-extra", files: ["src/x.mjs"] });
  const refused = await call(registry, "holder", "claim", "done-extra", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.value.error.code, "too_many_open_claims");
  // Close all 10 via in_progress → done.
  for (let i = 0; i < N; i++) {
    assert.equal((await call(registry, "holder", "update", `done-${i}`, { state: "in_progress" })).status, 200);
    assert.equal((await call(registry, "holder", "update", `done-${i}`, { state: "done" })).status, 200);
  }
  // Immediate reclaim of fresh items: no phantom 409s.
  for (let i = 0; i < N; i++) {
    await call(registry, "owner", "create", null, { id: `fresh-${i}`, files: files(i) });
  }
  for (let i = 0; i < N; i++) {
    const r = await call(registry, "holder", "claim", `fresh-${i}`, {});
    assert.equal(r.status, 200, `fresh claim fresh-${i} got ${r.status} ${r.value?.error?.code ?? ""}`);
  }
});
