import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AccessRequests } from "../server/access-requests.mjs";
import { MemberPermissionRequests } from "../server/member-permission-requests.mjs";
import { MEMBER_PERMISSION_ROUTES } from "../server/routes/member-permissions.mjs";

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
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json" } : {}) },
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
  const identitiesBefore = f.store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
  assert.equal((await f.request("/api/rooms/commons/work-claims", f.owner, { id: `board_${kind}`, title: "Ready work" })).status, 201);
  assert.equal((await f.request(`/api/rooms/commons/work-claims/board_${kind}/claim`, f.token, {})).status, 403);
  const asked = await f.ask(input);
  assert.equal(asked.status, 201);
  assert.equal(asked.body.kind, "permissions");
  assert.equal(asked.body.memberId, f.memberId);
  assert.equal(asked.body.identityId, f.identity?.identityId ?? null);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n, identitiesBefore, "requesting never mints an agent identity");
  const sequence = f.store.room("commons").sequence;
  assert.equal((await f.ask(input)).status, 201);
  assert.equal(f.store.room("commons").sequence, sequence);
  const queue = await f.request("/api/rooms/commons/access-requests", f.owner);
  assert.equal(queue.body.requests[0].kind, "permissions");
  assert.ok((await f.feed(f.owner)).body.notifications.some(item => item.requestId === input.requestId && item.requestKind === "permissions"));
  const approved = await f.decide(input.requestId, { decision: "approve" });
  assert.equal(approved.status, 200);
  assert.deepEqual(f.store.roomAuthority("commons").members[f.memberId].permissions, input.permissions);
  assert.equal((await f.request(`/api/rooms/commons/work-claims/board_${kind}/claim`, f.token, {})).status, 200);
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
  const sequence = f.store.room("commons").sequence;
  assert.equal((await f.decide("partial", { decision: "approve", permissions: null })).status, 422);
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.deepEqual(f.store.roomAuthority("commons").members[f.memberId].permissions, []);
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

test("member requests retain their rate limit, and retries do not spend it", async t => {
  const f = await setup(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.ask({ permissions: ["accept_work"], requestId: `limited_${i}` })).status, 201);
  }
  const retry = await f.ask({ permissions: ["accept_work"], requestId: "limited_0" });
  assert.equal(retry.status, 201);
  const limited = await f.ask({ permissions: ["accept_work"], requestId: "limited_6" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "rate_limited");
  assert.equal((await f.request("/api/rooms/commons/access-requests", f.owner)).body.requests.length, 5);
});

test("ordinary public admission still returns a join request", async t => {
  const f = await setup(t);
  const identity = f.store.identities.create("New Joiner");
  const joined = await f.request("/api/access-requests", null, { roomId: "commons", identityId: identity.identityId,
    displayName: "New Joiner", requestedPermissions: ["accept_work"], requestId: "ordinary_join" });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.kind, "join");
  assert.equal(joined.body.status, "pending");
  assert.equal((await f.decide("ordinary_join", { decision: "approve" })).status, 200);
  assert.equal(f.store.authenticate(identity.secret, "commons").member.active, true);
});

test("decision notifications use current message text and respect deletion", async t => {
  const f = await setup(t);
  await f.ask({ permissions: ["accept_work"], requestId: "decision_text" });
  const denied = await f.decide("decision_text", { decision: "deny", note: "Original explanation" });
  const messageId = denied.body.decisionMessageId;
  f.store.command(f.owner, "commons", { id: randomUUID(), type: "message.edited",
    data: { messageId, expectedMessageRevision: 0, body: "Updated decision explanation" } });
  const updated = (await f.feed(f.token)).body.notifications.find(item => item.requestId === "decision_text");
  assert.equal(updated.note, "Updated decision explanation");
  f.store.command(f.owner, "commons", { id: randomUUID(), type: "message.deleted",
    data: { messageId, expectedMessageRevision: 1, reason: "Removed" } });
  assert.equal((await f.feed(f.token)).body.notifications.some(item => item.requestId === "decision_text"), false);
});

test("private decision notes stay in the request record, not public outcome receipts", async t => {
  const f = await setup(t);
  const requests = new AccessRequests(f.store);
  const memberRequests = new MemberPermissionRequests(requests);
  memberRequests.request(f.token, "commons", { permissions: ["accept_work"], requestId: "private_note" });
  const note = "Private review detail";
  const declined = requests.decide(f.owner, "commons", "private_note", { decision: "deny", note });
  assert.equal(declined.decisionNote, note);
  const ownStatus = await f.request(`/api/access-requests/private_note?identityId=${f.identity.identityId}`, f.token);
  assert.equal(ownStatus.body.decisionNote, note);
  const message = f.store.room("commons").state.messages.find(item => item.id === declined.decisionMessageId);
  assert.match(message.body, /^Declined permission request/);
  assert.ok(!message.body.includes(note));
  assert.ok(!JSON.stringify([...f.store.exportEvents(f.owner, "commons")]).includes(note));
  const outcome = (await f.feed(f.token)).body.notifications.find(item => item.requestId === "private_note");
  assert.equal(outcome.outcome, "denied");
  assert.ok(!outcome.note.includes(note));
});

test("RT handler rows preserve the GET queue and share quota across both POST aliases", async t => {
  const f = await setup(t);
  const accessRequests = new AccessRequests(f.store);
  const invoke = async (method, path, input, token = f.token) => {
    const row = MEMBER_PERMISSION_ROUTES.find(route => route.method === method && route.path.replace("{roomId}", "commons") === path);
    assert.ok(row, `no handler for ${method} ${path}`);
    const req = { method }, res = {};
    let result;
    await row.handler({ req, res, url: new URL(`http://localhost${path}`), params: { roomId: "commons" }, route: row,
      store: f.store, accessRequests,
      roomCredentials: () => ({ token, bearer: true, mode: "room" }),
      expectedBinding: () => null,
      accountBinding: () => { throw new Error("This fixture does not provide an account session"); },
      roomAuth: (selected, roomId, binding) => f.store.authenticate(selected.token, roomId, binding),
      protectWrite: (_req, auth, bearer) => { assert.equal(bearer, true); assert.equal(auth.credentialScope, "room"); },
      rate: (key, limit) => { assert.equal(typeof key, "string"); assert.ok(limit > 0); },
      body: async () => input,
      reject: (status, code, message) => { throw Object.assign(new Error(message), { status, code }); },
      json: (_res, status, body) => { result = { status, body }; },
    });
    return result;
  };
  for (let i = 0; i < 5; i++) {
    const own = i % 2 === 0;
    const result = await invoke("POST", own ? "/api/rooms/commons/members/me/permission-requests" : "/api/rooms/commons/access-requests",
      { [own ? "permissions" : "requestedPermissions"]: ["accept_work"], requestId: `rt_${i}` });
    assert.equal(result.status, 201);
    assert.equal(result.body.kind, "permissions");
  }
  const queue = await invoke("GET", "/api/rooms/commons/access-requests", null, f.owner);
  assert.equal(queue.status, 200);
  assert.equal(queue.body.requests.length, 5);
  await assert.rejects(invoke("POST", "/api/rooms/commons/access-requests", { requestedPermissions: ["accept_work"], requestId: "rt_over" }),
    error => error.status === 429 && error.code === "rate_limited");
  await assert.rejects(invoke("GET", "/api/rooms/commons/access-requests", null), error => error.status === 403);
});
