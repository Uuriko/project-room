// QA2 finding P1-3: the work-claim board admitted share-link guests and
// chat-profile agents, grew without a cap, accepted 720h and null leases from
// anyone, returned the whole board in one response, and refused an owner who
// tried to release someone else's claim. These tests pin the HTTP contract
// for those refusals and for the pages that replaced the unbounded list.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { DEFAULT_MAX_MEMBER_OPEN_CLAIMS, DEFAULT_MAX_OPEN_CLAIMS } from "../server/work-claims.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  guest: { id: "guest", kind: "agent", active: true, permissions: [] },
  chat: { id: "chat", kind: "agent", active: true, permissions: [] },
  contribute: { id: "contribute", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  review: { id: "review", kind: "agent", active: true, permissions: ["verify"] },
  human: { id: "human", kind: "human", active: true, permissions: ["accept_work", "complete_work", "verify"] },
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

const denied = result => {
  assert.equal(result.status, 403);
  assert.equal(result.value.error.code, "work_claims_not_permitted");
  assert.ok(result.value.next.some(step => /contribute invite/i.test(step.command ?? "")));
};

test("guests and chat-profile agents cannot create, claim, renew, or update; contribute can", async () => {
  const registry = createWorkClaimRegistry();
  denied(await call(registry, "guest", "create", null, { id: "guest-item" }));
  denied(await call(registry, "chat", "create", null, { id: "chat-item" }));
  assert.equal(registry.has("room1", "guest-item"), false);
  assert.equal(registry.has("room1", "chat-item"), false);

  const created = await call(registry, "owner", "create", null, { id: "open", files: ["src/open.mjs"] });
  assert.equal(created.status, 201);
  denied(await call(registry, "guest", "claim", "open", {}));
  denied(await call(registry, "chat", "claim", "open", {}));
  assert.equal(registry.get("room1", "open").state, "unclaimed");

  const contribute = await call(registry, "contribute", "create", null, { id: "contrib", files: ["src/contrib.mjs"] });
  assert.equal(contribute.status, 201);
  const claimed = await call(registry, "contribute", "claim", "contrib", {});
  assert.equal(claimed.status, 200);
  assert.equal(claimed.value.state, "claimed");
  assert.equal(claimed.value.owner, "contribute");

  assert.equal((await call(registry, "review", "create", null, { id: "reviewed", files: ["src/reviewed.mjs"] })).status, 201);
  assert.equal((await call(registry, "human", "create", null, { id: "human-item", files: ["src/human-item.mjs"] })).status, 201);

  await call(registry, "owner", "reassign", "contrib", { newOwner: "guest" });
  denied(await call(registry, "guest", "update", "contrib", { state: "in_progress" }));
  denied(await call(registry, "guest", "renew", "contrib", { progressMessageId: "msg-1" }));
  assert.equal(registry.get("room1", "contrib").state, "claimed");

  const listed = await call(registry, "guest", "list");
  assert.equal(listed.status, 200);
  assert.ok(listed.value.claims.some(item => item.id === "open"));
});

test("the room refuses the create past the open-claim cap, and a done claim frees a slot", async () => {
  const registry = createWorkClaimRegistry();
  for (let index = 0; index < DEFAULT_MAX_OPEN_CLAIMS; index += 1) {
    registry.set("room1", { id: `seed-${index}`, state: "unclaimed", owner: null, history: [] });
  }
  const full = await call(registry, "owner", "create", null, { id: "one-over", files: ["src/one-over.mjs"] });
  assert.equal(full.status, 409);
  assert.equal(full.value.error.code, "work_board_full");
  assert.match(full.value.error.message, /close stale claims/i);
  assert.equal(full.value.error.code === "file_lease_conflict", false);
  assert.equal(registry.has("room1", "one-over"), false);

  registry.set("room1", { ...registry.get("room1", "seed-0"), state: "done" });
  const freed = await call(registry, "owner", "create", null, { id: "one-over", files: ["src/one-over.mjs"] });
  assert.equal(freed.status, 201);

  const small = createWorkClaimRegistry();
  small.configure("room1", { maxOpenClaims: 2 });
  assert.equal((await call(small, "owner", "create", null, { id: "a", files: ["src/a.mjs"] })).status, 201);
  assert.equal((await call(small, "owner", "create", null, { id: "b", files: ["src/b.mjs"] })).status, 201);
  const third = await call(small, "owner", "create", null, { id: "c", files: ["src/c.mjs"] });
  assert.equal(third.status, 409);
  assert.equal(third.value.error.code, "work_board_full");
});

test("a member cannot hold more than their open-claim cap", async () => {
  const registry = createWorkClaimRegistry();
  for (let index = 0; index < DEFAULT_MAX_MEMBER_OPEN_CLAIMS + 1; index += 1) {
    assert.equal((await call(registry, "owner", "create", null, { id: `m-${index}`, files: [`src/m-${index}.mjs`] })).status, 201);
  }
  for (let index = 0; index < DEFAULT_MAX_MEMBER_OPEN_CLAIMS; index += 1) {
    const claimed = await call(registry, "holder", "claim", `m-${index}`, {});
    assert.equal(claimed.status, 200, `claim ${index} should be within the cap`);
  }
  const over = await call(registry, "holder", "claim", `m-${DEFAULT_MAX_MEMBER_OPEN_CLAIMS}`, {});
  assert.equal(over.status, 409);
  assert.equal(over.value.error.code, "too_many_open_claims");
  assert.equal(registry.get("room1", `m-${DEFAULT_MAX_MEMBER_OPEN_CLAIMS}`).state, "unclaimed");

  const small = createWorkClaimRegistry();
  small.configure("room1", { maxMemberOpenClaims: 1 });
  await call(small, "owner", "create", null, { id: "first", files: ["src/first.mjs"] });
  await call(small, "owner", "create", null, { id: "second", files: ["src/second.mjs"] });
  assert.equal((await call(small, "holder", "claim", "first", {})).status, 200);
  const second = await call(small, "holder", "claim", "second", {});
  assert.equal(second.status, 409);
  assert.equal(second.value.error.code, "too_many_open_claims");
});

test("over-cap and null leases are refused for everyone; the immortal opt-out is retired", async () => {
  const registry = createWorkClaimRegistry();
  const files = ["src/a.mjs"];
  await call(registry, "owner", "create", null, { id: "hours", files });
  await call(registry, "owner", "create", null, { id: "opt-out", files });
  await call(registry, "owner", "create", null, { id: "owner-opt-out", files });
  await call(registry, "owner", "create", null, { id: "week", files });

  await assert.rejects(call(registry, "contribute", "claim", "hours", { leaseHours: 720 }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "claim_lease_too_long");
    assert.match(error.message, /2h hard cap/);
    return true;
  });
  assert.equal(registry.get("room1", "hours").state, "unclaimed");

  // Null is rejected even for the room owner — no more immortal claims.
  await assert.rejects(call(registry, "contribute", "claim", "opt-out", { leaseHours: null }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "claim_lease_required");
    return true;
  });
  assert.equal(registry.get("room1", "opt-out").state, "unclaimed");
  await assert.rejects(call(registry, "owner", "claim", "owner-opt-out", { leaseHours: null }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "claim_lease_required");
    return true;
  });
  assert.equal(registry.get("room1", "owner-opt-out").state, "unclaimed");

  await assert.rejects(call(registry, "contribute", "claim", "week", { leaseHours: 168 }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "claim_lease_too_long");
    return true;
  });
  assert.equal(registry.get("room1", "week").state, "unclaimed");

  // The 2h cap itself is claimable.
  const capped = await call(registry, "contribute", "claim", "week", { leaseHours: 2 });
  assert.equal(capped.status, 200);
  assert.equal(typeof capped.value.leaseExpiresAt, "string");
});

test("work-claim pages are ordered, stable, and do not overlap", async () => {
  const registry = createWorkClaimRegistry();
  const stamps = [
    ["a", "2026-10-01T00:00:03.000Z"],
    ["b", "2026-10-01T00:00:03.000Z"],
    ["c", "2026-10-01T00:00:02.000Z"],
    ["d", "2026-10-01T00:00:01.000Z"],
    ["e", "2026-10-01T00:00:01.000Z"],
  ];
  for (const [id, at] of stamps) {
    registry.set("room1", {
      id, state: "unclaimed", owner: null, title: id, updatedAt: at,
      history: [{ at, agentId: "owner", action: "created", note: null }],
    });
  }
  const first = await call(registry, "guest", "list", null, null, "?limit=2");
  const second = await call(registry, "guest", "list", null, null, `?limit=2&cursor=${encodeURIComponent(first.value.nextCursor)}`);
  const third = await call(registry, "guest", "list", null, null, `?limit=2&cursor=${encodeURIComponent(second.value.nextCursor)}`);
  const again = await call(registry, "guest", "list", null, null, "?limit=2");
  const pages = [first, second, third].map(page => page.value.claims.map(item => item.id));
  assert.deepEqual(pages, [["a", "b"], ["c", "d"], ["e"]]);
  assert.deepEqual(again.value.claims.map(item => item.id), pages[0]);
  assert.equal(first.value.hasMore, true);
  assert.equal(third.value.hasMore, false);
  assert.equal(third.value.nextCursor, null);
  const flat = pages.flat();
  assert.equal(new Set(flat).size, flat.length);
});

test("the room owner releasing another member's claim is recorded as the actor", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "lane", files: ["src/lane.mjs"] });
  await call(registry, "holder", "claim", "lane", {});
  const released = await call(registry, "owner", "release", "lane", { reason: "stale lane" });
  assert.equal(released.status, 200);
  assert.equal(released.value.state, "unclaimed");
  assert.equal(released.value.owner, null);
  const last = released.value.history.at(-1);
  assert.equal(last.agentId, "owner");
  assert.equal(last.action, "state:unclaimed");
  assert.equal(last.note, "stale lane");
});

test("an illegal transition names the states that are allowed", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "owner", "create", null, { id: "lane", files: ["src/lane.mjs"] });
  await call(registry, "holder", "claim", "lane", {});
  await assert.rejects(call(registry, "holder", "update", "lane", { state: "done" }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "invalid_claim_input");
    assert.match(error.message, /claimed -> in_progress\|blocked\|released/);
    return true;
  });
  assert.equal(registry.get("room1", "lane").state, "claimed");
});

test("a durable claim keeps the updatedAt used for board order", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const out = await handleWorkClaims({
    req: { method: "POST", body: { id: "kept", files: ["src/kept.mjs"] } },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons",
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: "create", helpers, registry: store.workClaims,
  });
  assert.equal(out.status, 201);
  const stored = store.workClaims.get("commons", "kept");
  assert.equal(stored.updatedAt, out.value.updatedAt);
  assert.equal(Number.isFinite(Date.parse(stored.updatedAt)), true);
});

test("close and cancel retire open items over HTTP and free open-claim slots", async () => {
  // Route refusals throw through helpers.reject in this harness; read them as {status, code}.
  const outcome = async promise => {
    try { const result = await promise; return { status: result.status, code: result.value?.error?.code, value: result.value }; }
    catch (error) { if (!Number.isInteger(error?.status)) throw error; return { status: error.status, code: error.code }; }
  };
  const registry = createWorkClaimRegistry();
  registry.configure("room1", { maxOpenClaims: 2 });
  assert.equal((await call(registry, "contribute", "create", null, { id: "mine" })).status, 201);
  assert.equal((await call(registry, "owner", "create", null, { id: "theirs" })).status, 201);
  assert.equal((await call(registry, "owner", "create", null, { id: "over" })).value.error.code, "work_board_full");

  // A non-manager cannot close or cancel an unclaimed item someone else opened.
  assert.deepEqual(await outcome(call(registry, "contribute", "cancel", "theirs", {})), { status: 403, code: "work_not_owner" });
  assert.deepEqual(await outcome(call(registry, "contribute", "close", "mine", {})), { status: 403, code: "work_not_owner" });

  // The opener cancels their own unclaimed item; the reason is on the history.
  const cancelled = await call(registry, "contribute", "cancel", "mine", { reason: "duplicate of theirs" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.value.state, "closed");
  assert.deepEqual([cancelled.value.history.at(-1).action, cancelled.value.history.at(-1).note], ["cancelled", "duplicate of theirs"]);
  assert.equal((await call(registry, "owner", "create", null, { id: "over" })).status, 201);

  // A manager closes a held claim; a second close is a 409 conflict.
  await call(registry, "holder", "claim", "theirs", {});
  const closed = await call(registry, "owner", "close", "theirs", { reason: "stale" });
  assert.equal(closed.status, 200);
  assert.deepEqual([closed.value.state, closed.value.owner], ["closed", null]);
  assert.deepEqual(await outcome(call(registry, "owner", "close", "theirs", {})), { status: 409, code: "work_claim_terminal" });
  assert.ok((await outcome(call(registry, "holder", "update", "theirs", { state: "in_progress" }))).status >= 400);
  assert.equal((await outcome(call(registry, "owner", "close", "mine", { extra: 1 }))).status, 422);
  // Closed items are retained but not listed as open work by state filter default.
  const listed = await call(registry, "owner", "list", null, undefined, "?state=closed");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.value.claims.map(item => item.id).sort(), ["mine", "theirs"]);
});
