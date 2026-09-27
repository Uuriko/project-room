import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { guestCapabilities } from "../server/guest-capability-scopes.mjs";

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "room-guest-capability-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = "GET", data, token = owner } = {}) => {
    const res = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`,
      Origin: origin, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: res.status, body: await res.json() };
  };
  const rpc = async (name, args, token) => {
    const res = await fetch(`${origin}/room/mcp`, { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "cap-test", method: "tools/call", params: { name, arguments: args } }) });
    return (await res.json()).result;
  };
  const guest = async (name, scope) => {
    const mint = await request("/api/rooms/commons/guest-invites", { method: "POST",
      data: { requestId: randomUUID(), guestLabel: name, scope, expectedOwnerRevision: 0 } });
    assert.equal(mint.status, 201);
    const identity = store.identities.create(name);
    const keys = generateKeyPair();
    const body = { name, description: "external agent", capabilities: ["chat"] };
    const card = { ...body, publicKey: keys.publicKey,
      signature: signCard({ agentId: identity.identityId, card: body, privateKey: keys.privateKey }) };
    const redeemed = await request("/api/guest-invites/redeem", { method: "POST", token: identity.secret,
      data: { inviteCode: mint.body.code, card } });
    assert.equal(redeemed.status, 201);
    return { ...redeemed.body, identity };
  };
  return { store, request, rpc, guest, owner };
}

const denied = result => { assert.equal(result.status, 403); assert.equal(result.body.error.code, "guest_scope_denied"); };

test("read-only GX guest reads but cannot mutate through HTTP, store or MCP", async t => {
  const { store, guest, request, rpc } = await setup(t);
  const read = await guest("Reader", "read_only");
  assert.deepEqual(read.scopes, [...guestCapabilities.read_only]);
  assert.equal((await request("/api/rooms/commons", { token: read.token })).status, 200);
  assert.equal((await request("/api/rooms/commons/events", { token: read.token })).status, 200);
  denied(await request("/api/rooms/commons/commands", { method: "POST", token: read.token,
    data: { id: "reader-message", type: "message.posted", data: { messageId: "reader-message", body: "no" } } }));
  assert.throws(() => store.command(read.token, "commons", { id: "reader-direct", type: "message.posted",
    data: { messageId: "reader-direct", body: "no" } }), e => e.code === "guest_scope_denied");
  denied(await request("/api/rooms/commons/remove_land_item", { method: "POST", token: read.token, data: { itemId: "dummy" } }));
  denied(await request("/api/rooms/commons/files", { method: "POST", token: read.token,
    data: { id: "r-file", filename: "r.txt", mediaType: "text/plain", data: "YQ==" } }));
  const posted = await rpc("room_post_message", { roomId: "commons", body: "no" }, read.identity.secret);
  assert.equal(posted.isError, true);
  assert.equal(posted.structuredContent.code, "unauthenticated"); // GX seat has a ga1. token, not an MCP pri_ identity link.
});

test("chat-only GX guest sees only chat projection across HTTP, store, MCP, files and SSE", async t => {
  const { store, guest, request, rpc } = await setup(t);
  const chat = await guest("Chatter", "chat_only");
  assert.deepEqual(chat.scopes, [...guestCapabilities.chat_only]);
  for (const path of ["", "/events", "/context", "/activation-pack", "/agent-inbox", "/files", "/stream", "/search?q=x"]) {
    const res = await request(`/api/rooms/commons${path}`, { token: chat.token });
    denied(res);
  }
  assert.throws(() => store.snapshot(chat.token, "commons"), e => e.code === "guest_scope_denied");
  assert.throws(() => store.eventsAfter(chat.token, "commons"), e => e.code === "guest_scope_denied");
  assert.throws(() => store.roomAttachments.list(chat.token, "commons"), e => e.code === "guest_scope_denied");
  assert.throws(() => store.roomAttachments.get(chat.token, "commons", "unknown"), e => e.code === "guest_scope_denied");
  const posted = await request("/api/rooms/commons/commands", { method: "POST", token: chat.token,
    data: { id: "chat-message", type: "message.posted", data: { messageId: "chat-message", body: "hi" } } });
  assert.equal(posted.status, 201);
  const page = await request("/api/rooms/commons/chat", { token: chat.token });
  assert.equal(page.status, 200);
  assert.equal(page.body.messages.some(m => m.body === "hi"), true);
  assert.equal(page.body.messages.some(m => m.kind === "member.added"), false);

  const mcp = await rpc("room_read_messages", { roomId: "commons" }, chat.identity.secret);
  assert.equal(mcp.isError, true);
  assert.equal(mcp.structuredContent.code, "unauthenticated"); // Hosted MCP cannot use GX ga1. credentials.
  for (const tool of ["room_list_events", "room_activation_pack", "room_list_files", "room_read_board", "room_read_inbox"]) {
    const value = await rpc(tool, { roomId: "commons" }, chat.identity.secret);
    assert.equal(value.isError, true, tool);
    assert.equal(value.structuredContent.code, "unauthenticated", tool);
  }
  denied(await request("/api/rooms/commons/list_land_queue", { token: chat.token }));
  denied(await request("/api/rooms/commons/files", { method: "POST", token: chat.token,
    data: { id: "c-file", filename: "c.txt", mediaType: "text/plain", data: "YQ==" } }));
});

test("owner changes a live guest capability and re-redeem does not widen it", async t => {
  const { guest, request, store } = await setup(t);
  const chat = await guest("Changeable", "chat_only");
  assert.equal((await request("/api/rooms/commons", { token: chat.token })).status, 403);
  const change = await request("/api/rooms/commons/guest-invites-upgrade", { method: "POST",
    data: { memberId: chat.member.id, tier: "read_only" } });
  assert.equal(change.status, 200);
  assert.equal((await request("/api/rooms/commons", { token: chat.token })).status, 200);
  denied(await request("/api/rooms/commons/commands", { method: "POST", token: chat.token,
    data: { id: "after-downgrade", type: "message.posted", data: { messageId: "after-downgrade", body: "no" } } }));
  assert.equal(store.guestInvites.guestTierOf(chat.member.id), "read_only");
});


test("chat projection hides work drafts, other people's DMs, deleted bodies and their reactions", async t => {
  const { guest, request, store, owner } = await setup(t);
  const chat = await guest("Privacy", "chat_only");
  const post = (id, data) => store.command(owner, "commons", {
    id: `post-${id}`, type: "message.posted", data: { messageId: id, ...data }
  });
  post("ordinary", { body: "PUBLIC-CANARY" });
  store.command(owner, "commons", { id: "draft-work", type: "work.proposed", data: {
    workItemId: "w-draft", title: "Draft work", definitionOfDone: "draft", accountableMemberId: "owner", mode: "read" } });
  post("draft-hidden", { body: "DRAFT-CANARY", workItemId: "w-draft" });
  post("private", { body: "PRIVATE-CANARY", toMemberId: "owner" });
  post("erase-me", { body: "DELETED-CANARY" });
  post("reply-to-private", { body: "REPLY-CANARY", replyToId: "private" });
  store.command(owner, "commons", { id: "erase-event", type: "message.deleted",
    data: { messageId: "erase-me", expectedMessageRevision: 0, reason: "cleanup" } });
  store.command(owner, "commons", { id: "reaction-private", type: "message.reaction_set",
    data: { messageId: "private", reaction: "👍", active: true } });
  const page = await request("/api/rooms/commons/chat", { token: chat.token });
  assert.equal(page.status, 200);
  assert(page.body.messages.some(m => m.body === "PUBLIC-CANARY"));
  for (const marker of ["PRIVATE-CANARY", "DELETED-CANARY", "REPLY-CANARY", "DRAFT-CANARY", "private", "erase-me", "reply-to-private", "draft-hidden"]) {
    assert.equal(JSON.stringify(page.body.messages).includes(marker), false, marker);
  }
  assert.equal(page.body.messages.some(m => m.kind === "reaction"), false);
  denied(await request("/api/rooms/commons/commands", { method: "POST", token: chat.token,
    data: { id: "reply-private", type: "message.posted", data: { messageId: "reply-private", body: "bad", replyToId: "private" } } }));
  denied(await request("/api/rooms/commons/commands", { method: "POST", token: chat.token,
    data: { id: "react-private", type: "message.reaction_set", data: { messageId: "private", reaction: "👍", active: true } } }));
  for (const messageId of ["reply-to-private", "erase-me", "draft-hidden"]) {
    denied(await request("/api/rooms/commons/commands", { method: "POST", token: chat.token,
      data: { id: `react-${messageId}`, type: "message.reaction_set", data: { messageId, reaction: "👍", active: true } } }));
  }
});
