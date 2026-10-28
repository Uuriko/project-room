// MCP-ROOM-DISCOVERY (Option B — parity with the anonymous public face).
//
// A non-member identity calling room_check_access with an exact roomId:
//  (a) public-page room -> exactly the identity fields the anonymous
//      /r/<slug>.json document serves (field-by-field parity, asserted
//      against publicRoomView of the same room), no names/tasks/receipts;
//  (b) existing non-public room -> existence + joinability only;
//  (c) nonexistent id -> the distinct room_not_found answer.
// Member and own-rooms legs are unchanged. Probing is rate-limited per
// identity. The tool is listed in a non-member identity's default catalog.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { publicRoomView } from "../server/public-rooms.mjs";

function setup(t) {
  // In-memory store: an established fixture pattern in this tree, and the
  // only store that opens while the VM's on-disk WAL fault episode lasts.
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  t.after(() => { store.close(); });
  const mcp = createHostedRoomMcp(store);
  const call = (name, args, secret) => mcp(
    { jsonrpc: "2.0", id: "d", method: "tools/call", params: { name, arguments: args } },
    { authorization: `Bearer ${secret}` });
  const list = secret => mcp(
    { jsonrpc: "2.0", id: "l", method: "tools/list", params: {} },
    { authorization: `Bearer ${secret}` });
  return { store, rooms, call, list };
}

function makeRoom(store, rooms, owner, { title, purpose, page = false, joinLink = false }) {
  const created = rooms.create(owner.secret, { title, purpose, displayName: "Owner" });
  if (page) store.command(owner.secret, created.roomId, { id: `page-${created.roomId}`, type: "room.public_page_set", data: { enabled: true } });
  if (joinLink) store.command(owner.secret, created.roomId, { id: `join-${created.roomId}`, type: "room.join_link_set", data: { enabled: true } });
  return created.roomId;
}

const value = response => response.result.structuredContent;

test("non-member gets field parity with the anonymous /r/ document for a public-page room", async t => {
  const { store, rooms, call } = setup(t);
  const owner = store.identities.create("Owen");
  const stranger = store.identities.create("Stranger");
  const roomId = makeRoom(store, rooms, owner, { title: "Discovery Public", purpose: "A room with a public page", page: true, joinLink: true });

  const doc = publicRoomView(store, roomId).document;
  const got = value(await call("room_check_access", { roomId }, stranger.secret));
  assert.equal(got.status, "room_discovered");
  assert.equal(got.exists, true);
  assert.equal(got.member, false);
  // Field-by-field parity with the anonymous face of the same room.
  assert.equal(got.slug, doc.slug);
  assert.equal(got.title, doc.title);
  assert.equal(got.purpose, doc.purpose);
  assert.deepEqual(got.counts, doc.counts);
  assert.deepEqual(got.join, doc.join);
  assert.equal(got.admission, doc.agentJoin.admission);
  assert.equal(got.untrusted, true);
  assert.ok(got.contentTrust, "member-authored text carries the trust marker");
  // Room content never rides the discovery answer.
  for (const key of ["names", "tasks", "receipts", "proofHref", "agentJoin", "messages", "history"]) {
    assert.equal(Object.hasOwn(got, key), false, `discovery answer must not carry ${key}`);
  }
  assert.equal(got.next[0].action, "join-with-invite");
  assert.equal(got.next[0].tool, "room_join");
});

test("public-page room without a join link names the request-access next action", async t => {
  const { store, rooms, call } = setup(t);
  const owner = store.identities.create("Owen");
  const stranger = store.identities.create("Stranger");
  const roomId = makeRoom(store, rooms, owner, { title: "Discovery Request", purpose: "Public page, approval entry", page: true });

  const doc = publicRoomView(store, roomId).document;
  assert.equal(doc.join.mode, "request");
  const got = value(await call("room_check_access", { roomId }, stranger.secret));
  assert.equal(got.status, "room_discovered");
  assert.deepEqual(got.join, doc.join);
  assert.equal(got.admission, "approval_required");
  assert.equal(got.next[0].action, "request-access");
  assert.equal(got.next[0].path, "/api/access-requests");
});

test("non-public room answers existence and joinability only", async t => {
  const { store, rooms, call } = setup(t);
  const owner = store.identities.create("Owen");
  const stranger = store.identities.create("Stranger");
  const roomId = makeRoom(store, rooms, owner, { title: "Discovery Private", purpose: "No public page here" });
  assert.equal(publicRoomView(store, roomId), null, "fixture room must have no public face");

  const got = value(await call("room_check_access", { roomId }, stranger.secret));
  assert.equal(got.status, "room_exists");
  assert.equal(got.exists, true);
  assert.equal(got.member, false);
  assert.equal(got.public, false);
  assert.equal(got.joinability, "invite-or-request");
  for (const key of ["title", "purpose", "counts", "join", "slug", "admission", "names", "tasks", "receipts"]) {
    assert.equal(Object.hasOwn(got, key), false, `existence answer must not carry ${key}`);
  }
  assert.deepEqual(got.next.map(step => step.action), ["join-with-invite", "request-access"]);
});

test("nonexistent room answers the distinct room_not_found shape", async t => {
  const { store, call } = setup(t);
  const stranger = store.identities.create("Stranger");
  const got = value(await call("room_check_access", { roomId: "no-such-room-xyz" }, stranger.secret));
  assert.equal(got.status, "room_not_found");
  assert.equal(got.exists, false);
  assert.equal(got.member, false);
  for (const key of ["title", "purpose", "counts", "join", "joinability"]) {
    assert.equal(Object.hasOwn(got, key), false, `not-found answer must not carry ${key}`);
  }
});

test("member leg and own-rooms leg are unchanged", async t => {
  const { store, rooms, call } = setup(t);
  const owner = store.identities.create("Owen");
  const roomId = makeRoom(store, rooms, owner, { title: "Discovery Member", purpose: "Owner view", page: true });

  const member = value(await call("room_check_access", { roomId }, owner.secret));
  assert.equal(member.status, "credential_accepted");
  assert.equal(member.roomId, roomId);
  assert.ok(member.memberId, "member leg carries memberId");
  assert.ok(Array.isArray(member.permissions), "member leg carries permissions");
  assert.equal(Object.hasOwn(member, "exists"), false, "member leg shape is the pre-discovery shape");

  const own = value(await call("room_check_access", {}, owner.secret));
  assert.equal(own.status, "credential_accepted");
  assert.equal(own.scope, "identity");
  assert.deepEqual(own.rooms.map(row => row.roomId), [roomId]);
});

test("room_check_access is listed in a non-member identity's default catalog", async t => {
  const { store, list } = setup(t);
  const stranger = store.identities.create("Stranger");
  const listed = await list(stranger.secret);
  const names = listed.result.tools.map(tool => tool.name);
  assert.ok(names.includes("room_check_access"), `outside catalog must list room_check_access, got: ${names.join(",")}`);
});

test("probing random roomIds leaks no public fields and trips the rate limit", async t => {
  const { store, rooms, call } = setup(t);
  const owner = store.identities.create("Owen");
  const prober = store.identities.create("Prober");
  makeRoom(store, rooms, owner, { title: "Discovery Guarded", purpose: "Private purpose text" });

  let limited = null;
  for (let i = 0; i < 50; i++) {
    const response = await call("room_check_access", { roomId: `probe-${i}-zzzz` }, prober.secret);
    const got = value(response);
    if (response.result.isError) { limited = got; break; }
    assert.equal(got.status, "room_not_found");
    assert.equal(Object.hasOwn(got, "title"), false);
    assert.equal(Object.hasOwn(got, "purpose"), false);
  }
  assert.ok(limited, "50 probes must trip the rate limit");
  assert.equal(limited.status, 429);
  assert.equal(limited.code, "rate_limited");
});
