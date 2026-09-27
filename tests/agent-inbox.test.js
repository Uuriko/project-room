// RC-2026-09-18-052: the agent inbox teaches its own follow-ups.
// GET /api/rooms/{roomId}/agent-inbox carries next[] — an empty inbox
// names what it will carry; a DM present teaches the reply-dm command
// with the sender's memberId filled in.
import test from "node:test";
import { buildReplyCommand } from "../client/reply-actions.mjs";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

// Room with an owner and one approved agent friend; returns their secrets,
// the room id, and the friend's member id.
async function roomWithFriend(origin, fixture) {
  const owner = fixture.store.identities.create("inbox owner");
  const friend = fixture.store.identities.create("inbox friend");
  const roomId = "inbox-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Inbox", purpose: "probe", kind: "personal", displayName: "Inbox",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  const requestId = "inbox-req-1";
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId,
  });
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, owner.secret);
  assert.equal(decideRes.status, 200);
  const memberId = (await decideRes.json()).memberId;
  assert.ok(memberId);
  // Consent-bound DMs: the owner→friend test DM needs the friend's approval.
  fixture.store.dmConsents.request(roomId, owner.identityId, memberId, "test fixture");
  fixture.store.dmConsents.decide(roomId, memberId, owner.identityId, "approve");
  return { ownerSecret: owner.secret, friendSecret: friend.secret, roomId, memberId };
}

test("agent inbox next[] teaches what an empty inbox will carry", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friendSecret, roomId } = await roomWithFriend(origin, fixture);
  const res = await get(origin, `/api/rooms/${roomId}/agent-inbox`, friendSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.directMessages, []);
  assert.deepEqual(json.next.map(n => n.action), ["watch-inbox", "list-open-requests"]);
});

test("agent inbox next[] teaches reply-dm after a DM arrives", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, friendSecret, roomId, memberId } = await roomWithFriend(origin, fixture);
  const dmRes = await post(origin, `/api/rooms/${roomId}/commands`, {
    id: "00000000-0000-4000-8000-000000000052",
    type: "message.posted",
    data: {
      messageId: "00000000-0000-4000-8000-000000000053",
      body: "hello friend",
      toMemberId: memberId,
    },
  }, ownerSecret);
  assert.equal(dmRes.status, 201);
  const res = await get(origin, `/api/rooms/${roomId}/agent-inbox`, friendSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.directMessages.length, 1);
  const actions = json.next.map(n => n.action);
  assert.deepEqual(actions, ["reply-dm", "list-open-requests"]);
  const reply = json.next[0];
  assert.equal(reply.method, "POST");
  assert.equal(reply.path, `/api/rooms/${roomId}/commands`);
  // The reply goes back to the DM's sender (the room owner here), not to
  // the reader's own member id.
  const senderMemberId = json.directMessages[0].from;
  assert.ok(senderMemberId);
  assert.ok(reply.description.includes(senderMemberId));
});


test("inbox discovery finds older open requests outside its DM window through existing HTTP and installed MCP tools", async t => {
  const fixture = createAcceptanceFixture(), origin = await startServer(t, fixture);
  const { ownerSecret, friendSecret, roomId, memberId } = await roomWithFriend(origin, fixture);
  const store = fixture.store, ownerId = store.authenticate(ownerSecret, roomId).member.id;
  const other = store.identities.create("Other recipient");
  store.identities.link(ownerSecret, roomId, { identityId: other.identityId, displayName: "Other recipient", permissions: [] });
  const ask = (id, secret = ownerSecret, toMemberId = memberId) => store.command(secret, roomId, {
    id, type: "message.posted", data: { messageId: id, body: "Private question " + id, toMemberId, requestKind: "reply" }
  });
  ask("old-open"); ask("already-answered"); ask("already-cancelled");
  const context = store.replyRequests.selected(friendSecret, roomId, "already-answered");
  store.command(friendSecret, roomId, buildReplyCommand({ roomId, memberId }, "room_respond_to_request", {
    requestId: "answer", responseToRequestId: "already-answered", ...context.current.answerBasis,
    responseOutcome: "answered", toMemberId: ownerId, workItemId: null, body: "Resolved"
  }));
  store.command(ownerSecret, roomId, { id: "cancel", type: "reply_request.cancelled", data: {
    requestMessageId: "already-cancelled", expectedRequestRevision: 0, reason: "No longer needed"
  } });
  ask("outgoing", friendSecret, ownerId); ask("third-party", ownerSecret, other.identityId);
  store.command(ownerSecret, roomId, { id: "recent-chat", type: "message.posted", data: {
    messageId: "recent-chat", body: "A more recent ordinary DM", toMemberId: memberId
  } });
  const sequence = store.room(roomId).sequence;
  const inbox = await (await get(origin, `/api/rooms/${roomId}/agent-inbox?limit=1`, friendSecret)).json();
  assert.deepEqual(inbox.directMessages.map(message => message.messageId), ["recent-chat"]);
  const discovery = inbox.next.find(step => step.action === "list-open-requests");
  assert.equal(discovery.method, "GET");
  const listedResponse = await get(origin, discovery.path, friendSecret); assert.equal(listedResponse.status, 200);
  const listed = await listedResponse.json();
  assert.deepEqual(listed.selection, { direction: "incoming", status: "open" });
  assert.deepEqual(listed.requests.map(request => request.id), ["old-open"]);
  assert.equal(JSON.stringify(listed).includes("Private question"), false);
  const selectedResponse = await get(origin, listed.nextReads[0].http.path, friendSecret);
  assert.equal(selectedResponse.status, 200); assert.equal((await selectedResponse.json()).request.status, "open");
  const rpc = async (method, params) => (await post(origin, "/room/mcp", { jsonrpc: "2.0", id: "discovery", method, params }, friendSecret)).json();
  const catalog = await rpc("tools/list", {});
  assert.ok(catalog.result.tools.some(tool => tool.name === discovery.nextRead.tool));
  const mcpInbox = (await rpc("tools/call", { name: "room_read_inbox", arguments: { roomId, limit: 1 } })).result.structuredContent;
  const pointer = mcpInbox.next.find(step => step.action === "list-open-requests").nextRead;
  const mcpList = await rpc("tools/call", { name: pointer.tool, arguments: pointer.arguments });
  assert.equal(mcpList.result.isError, undefined, JSON.stringify(mcpList));
  assert.deepEqual(mcpList.result.structuredContent.requests.map(request => request.id), ["old-open"]);
  assert.equal(store.room(roomId).sequence, sequence);
  assert.equal(store.room(roomId).state.replyRequests["old-open"].status, "open");
});
