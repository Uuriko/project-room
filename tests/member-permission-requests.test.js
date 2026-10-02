import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

// These real HTTP/store cases own the room-authenticated member contract.
// The existing upgrade tests retain identity-secret and recovery coverage.
async function setup(t, kind = "agent") {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner");
  let identity = null, memberId = "requesting-human";
  if (kind === "agent") {
    identity = store.identities.create("Member Requester");
    memberId = identity.identityId;
    store.identities.link(owner, "commons", { identityId: memberId, permissions: [] });
  } else {
    store.command(owner, "commons", { id: randomUUID(), type: "member.added",
      data: { memberId, displayName: "Human Requester", kind: "human", permissions: [] } });
  }
  const token = identity?.secret ?? store.issueAccessKey("commons", memberId);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, token, data) => {
    const response = await fetch(`${origin}${path}`, { method: data ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { store, owner, token, identity, memberId, request,
    ask: (data, own = true) => request(own ? "/api/rooms/commons/members/me/permission-requests" : "/api/rooms/commons/access-requests", token, data),
    decide: (id, data, reviewer = owner) => request(`/api/rooms/commons/access-requests/${id}/decide`, reviewer, data),
    feed: credential => request("/api/rooms/commons/notifications", credential),
  };
}

for (const kind of ["agent", "human"]) test(`${kind} requests permissions and receives an audited approval`, async t => {
  const f = await setup(t, kind);
  const input = { permissions: ["accept_work", "complete_work"], requestId: `request_${kind}` };
  const asked = await f.ask(input);
  assert.equal(asked.status, 201);
  assert.equal(asked.body.kind, "permissions");
  assert.equal(asked.body.memberId, f.memberId);
  assert.equal(asked.body.identityId, f.identity?.identityId ?? null);
  const sequence = f.store.room("commons").sequence;
  assert.equal((await f.ask(input)).status, 201);
  assert.equal(f.store.room("commons").sequence, sequence);
  const queue = await f.request("/api/rooms/commons/access-requests", f.owner);
  assert.equal(queue.body.requests[0].kind, "permissions");
  assert.ok((await f.feed(f.owner)).body.notifications.some(item => item.requestId === input.requestId && item.requestKind === "permissions"));
  const approved = await f.decide(input.requestId, { decision: "approve" });
  assert.equal(approved.status, 200);
  assert.deepEqual(f.store.roomAuthority("commons").members[f.memberId].permissions, input.permissions);
  const outcome = (await f.feed(f.token)).body.notifications.find(item => item.requestId === input.requestId && item.kind === "access_decision");
  assert.equal(outcome.outcome, "approved");
  const after = f.store.room("commons").sequence;
  assert.equal((await f.decide(input.requestId, { decision: "approve" })).status, 409);
  assert.equal(f.store.room("commons").sequence, after);
  assert.equal((await f.ask({ permissions: ["accept_work"], requestId: "no_op" })).body.error.code, "nothing_to_request");
});

test("partial approval and decline preserve current permissions", async t => {
  const f = await setup(t);
  await f.ask({ requestedPermissions: ["accept_work", "complete_work"], requestId: "partial" }, false);
  assert.equal((await f.decide("partial", { decision: "approve", permissions: ["accept_work"] })).status, 200);
  await f.ask({ permissions: ["complete_work"], requestId: "declined" });
  assert.equal((await f.decide("declined", { decision: "deny", note: "Not this time" })).status, 200);
  assert.deepEqual(f.store.roomAuthority("commons").members[f.memberId].permissions, ["accept_work"]);
  assert.equal((await f.feed(f.token)).body.notifications.find(item => item.requestId === "declined").outcome, "denied");
});

test("an administrator receives the request but cannot grant a permission they lack", async t => {
  const f = await setup(t);
  f.store.command(f.owner, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "reviewer", displayName: "Permission Reviewer", kind: "human", permissions: ["manage_members", "accept_work"] } });
  const reviewer = f.store.issueAccessKey("commons", "reviewer");
  await f.ask({ permissions: ["complete_work"], requestId: "missing_permission" });
  assert.ok((await f.feed(reviewer)).body.notifications.some(item => item.requestId === "missing_permission"));
  const refused = await f.decide("missing_permission", { decision: "approve" }, reviewer);
  assert.equal(refused.status, 403);
  assert.match(JSON.stringify(refused.body), /complete_work/);
  assert.deepEqual(f.store.roomAuthority("commons").members[f.memberId].permissions, []);
});
