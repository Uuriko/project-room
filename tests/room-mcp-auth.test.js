import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { HOSTED_ROOM_MCP_TOOLS } from "../src/room-mcp-join.js";

const JOIN_TOOLS = ["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-auth-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

function rpc(origin, method, params, secret) {
  return fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) })
  });
}

async function call(origin, name, args, secret) {
  const response = await rpc(origin, "tools/call", { name, arguments: args }, secret);
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent };
}

test("unauthenticated hosted MCP stays the four join tools", async t => {
  const { origin } = await serve(t);
  const listed = await rpc(origin, "tools/list");
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.deepEqual(body.result.tools.map(tool => tool.name), JOIN_TOOLS);
  const denied = await call(origin, "room_check_access", {});
  assert.equal(denied.status, 200);
  assert.equal(denied.body.error.code, -32602);
  const board = await call(origin, "room_read_board", { roomId: "mcp-den" });
  assert.equal(board.body.error.code, -32602);
  const inbox = await call(origin, "room_read_inbox", { roomId: "mcp-den" });
  assert.equal(inbox.body.error.code, -32602);
  const onShortPath = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  assert.deepEqual((await onShortPath.json()).result.tools.map(tool => tool.name), JOIN_TOOLS);
});

test("Bearer pri_ exposes room tools and keeps command receipts", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("MCP owner");
  const peer = store.identities.create("MCP peer");
  const stranger = store.identities.create("MCP stranger");
  const created = rooms.create(owner.secret, {
    roomId: "mcp-den", title: "MCP den", purpose: "Hosted MCP room tools", kind: "personal", displayName: "MCP owner"
  });
  const linked = store.identities.link(owner.secret, created.roomId, {
    identityId: stranger.identityId, displayName: "MCP stranger", permissions: []
  });
  assert.equal(linked.memberId, stranger.identityId);

  const bad = await rpc(origin, "tools/list", undefined, "pri_" + "x".repeat(43));
  assert.equal(bad.status, 401);
  const badBody = await bad.json();
  assert.equal(badBody.error.code, -32001);
  assert.equal(badBody.result, undefined);

  const roomKey = store.issueAccessKey(created.roomId, created.ownerMemberId);
  const keyList = await rpc(origin, "tools/list", undefined, roomKey);
  assert.equal(keyList.status, 401);
  assert.equal((await keyList.json()).result, undefined);
  const viaHttp = await fetch(`${origin}/api/rooms/${created.roomId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${roomKey}` },
    body: JSON.stringify({ id: "http-post", type: "message.posted", data: { messageId: "http-msg", body: "still on the command path" } })
  });
  assert.equal(viaHttp.status, 201);

  const listed = await rpc(origin, "tools/list", undefined, owner.secret);
  assert.equal(listed.status, 200);
  const names = (await listed.json()).result.tools.map(tool => tool.name);
  assert.deepEqual(names.slice(0, HOSTED_ROOM_MCP_TOOLS.length), [...HOSTED_ROOM_MCP_TOOLS]);
  assert.deepEqual(names.slice(HOSTED_ROOM_MCP_TOOLS.length), JOIN_TOOLS);

  const access = await call(origin, "room_check_access", { roomId: created.roomId }, owner.secret);
  assert.equal(access.status, 200);
  assert.equal(access.value.status, "credential_accepted");
  assert.equal(access.value.roomId, created.roomId);
  assert.equal(access.value.memberId, created.ownerMemberId);
  assert.equal(JSON.stringify(access.body).includes(owner.secret), false);

  const roomsOnly = await call(origin, "room_check_access", {}, owner.secret);
  assert.equal(roomsOnly.value.rooms[0].roomId, created.roomId);

  const pack = await call(origin, "room_activation_pack", { roomId: created.roomId }, owner.secret);
  assert.equal(pack.value.room.slug, created.roomId);
  assert.equal(pack.value.room.title, "MCP den");

  const context = await call(origin, "get_room_context", { roomId: created.roomId }, owner.secret);
  assert.equal(context.value.roomId, created.roomId);
  assert.match(context.value.context_version, /^[a-f0-9]{64}$/);
  const unchanged = await call(origin, "get_room_context", { roomId: created.roomId, since_version: context.value.context_version }, owner.secret);
  assert.equal(unchanged.value.not_modified, true);

  store.command(owner.secret, created.roomId, {
    id: "propose-agenda", type: "work.proposed",
    data: { workItemId: "agenda", title: "Draft the agenda", definitionOfDone: "Named next step", accountableMemberId: created.ownerMemberId, mode: "read" }
  });
  const work = await call(origin, "room_list_work", { roomId: created.roomId, focus: "needs_me" }, owner.secret);
  assert.equal(work.value.work[0].id, "agenda");
  assert.equal(work.value.focus, "needs_me");

  const posted = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-1", messageId: "msg-1", body: "hello from hosted MCP"
  }, owner.secret);
  assert.equal(posted.value.status, "posted");
  assert.equal(posted.value.duplicate, false);
  assert.equal(posted.value.command.type, "message.posted");
  assert.deepEqual(posted.value.command.data, { messageId: "msg-1", body: "hello from hosted MCP" });
  assert.equal(posted.value.event.type, "message.posted");
  const receipt = store.db.prepare("SELECT fingerprint, sequence FROM commands WHERE room_id=? AND id=?").get(created.roomId, "chat-1");
  assert.equal(receipt.sequence, posted.value.sequence);

  const again = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-1", messageId: "msg-1", body: "hello from hosted MCP"
  }, owner.secret);
  assert.equal(again.value.status, "duplicate");
  assert.equal(again.value.duplicate, true);
  assert.equal(again.value.sequence, posted.value.sequence);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM commands WHERE room_id=? AND id=?").get(created.roomId, "chat-1").n, 1);

  const conflict = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-1", messageId: "msg-1", body: "a different body"
  }, owner.secret);
  assert.equal(conflict.value.isError ?? conflict.body.result.isError, true);
  assert.equal(conflict.value.code, "idempotency_conflict");
  const stored = store.room(created.roomId).state.messages.find(message => message.id === "msg-1");
  assert.equal(stored.body, "hello from hosted MCP");

  const events = await call(origin, "room_list_events", { roomId: created.roomId, after: 0, limit: 50 }, owner.secret);
  assert.equal(events.value.events.some(entry => entry.event?.type === "message.posted" && entry.event.data.body === "hello from hosted MCP"), true);

  const proposed = await call(origin, "bond.propose", {
    roomId: created.roomId, id: "bond-1", to: peer.identityId
  }, owner.secret);
  assert.equal(proposed.value.status, "proposed");
  assert.equal(proposed.value.command.type, "bond.propose");
  assert.deepEqual(proposed.value.command.data, { to: peer.identityId });
  assert.equal(proposed.value.event.type, "bond.proposed");
  const bondRetry = await call(origin, "bond.propose", {
    roomId: created.roomId, id: "bond-1", to: peer.identityId
  }, owner.secret);
  assert.equal(bondRetry.value.duplicate, true);
  assert.equal(bondRetry.value.sequence, proposed.value.sequence);

  const hidden = await call(origin, "room_list_events", { roomId: created.roomId, after: 0, limit: 100 }, stranger.secret);
  assert.equal(hidden.value.events.some(entry => entry.event?.type === "bond.proposed"), false);
  assert.equal(hidden.value.events.some(entry => entry.event?.data?.body === "hello from hosted MCP"), true);
  assert.equal(JSON.stringify(hidden.body).includes(owner.secret), false);

  const outsider = await call(origin, "room_list_events", { roomId: created.roomId }, peer.secret);
  assert.equal(outsider.body.result.isError, true);
  assert.equal(JSON.stringify(outsider.body).includes("hello from hosted MCP"), false);

  const shaped = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-2", messageId: "msg-2", body: "no", workItemId: "agenda"
  }, owner.secret);
  assert.equal(shaped.body.error.code, -32602);

  const get = await fetch(`${origin}/room/mcp`, { headers: { Authorization: `Bearer ${owner.secret}` } });
  const page = await get.text();
  assert.match(page, /four public join tools/);
  assert.match(page, /room_read_board/);
  assert.match(page, /room_read_inbox/);
  assert.match(page, /Bearer <saved-identity-secret>/);
  assert.doesNotMatch(page, /hello from hosted MCP/);
  assert.equal(page.includes(owner.secret), false);

  const board = await call(origin, "room_read_board", { roomId: created.roomId }, owner.secret);
  assert.equal(board.status, 200);
  assert.equal(board.body.error, undefined);
  assert.equal(board.value.columns.proposed.some(card => card.id === "agenda"), true);
  assert.equal(board.value.roomId, created.roomId);

  const mentioned = await call(origin, "room_post_message", {
    roomId: created.roomId, id: "chat-mention", messageId: "msg-mention", body: "@MCP stranger what is on the board?"
  }, owner.secret);
  assert.equal(mentioned.value.status, "posted");
  const strangerInbox = await call(origin, "room_read_inbox", { roomId: created.roomId }, stranger.secret);
  assert.equal(strangerInbox.value.directMentions[0].replyToId, "msg-mention");
  assert.equal(strangerInbox.value.directMentions[0].body, "@MCP stranger what is on the board?");
  const messages = await call(origin, "room_read_messages", { roomId: created.roomId, after: 0, limit: 100 }, stranger.secret);
  const asked = messages.value.messages.find(message => message.messageId === "msg-mention");
  assert.equal(asked.body, "@MCP stranger what is on the board?");
  assert.deepEqual(asked.mentions.map(mention => mention.memberId), [stranger.identityId]);

  const answered = await call(origin, "room_reply", {
    roomId: created.roomId, requestId: "reply-mention", replyToId: "msg-mention", body: "The agenda card is in proposed."
  }, stranger.secret);
  assert.equal(answered.value.status, "recorded");
  assert.equal(answered.value.workStateChanged, false);
  assert.equal(answered.body.result.isError, undefined);
  const cleared = await call(origin, "room_read_inbox", { roomId: created.roomId }, stranger.secret);
  assert.deepEqual(cleared.value.directMentions, []);

  const drafted = await call(origin, "room_post_draft", {
    roomId: created.roomId, requestId: "draft-agenda", workItemId: "agenda", packetId: "agenda-draft",
    basisRevision: 0, body: "Hosted draft of the agenda"
  }, owner.secret);
  assert.equal(drafted.value.status, "draft_posted");
  assert.equal(drafted.value.duplicate, false);
  const draftAgain = await call(origin, "room_post_draft", {
    roomId: created.roomId, requestId: "draft-agenda", workItemId: "agenda", packetId: "agenda-draft",
    basisRevision: 0, body: "Hosted draft of the agenda"
  }, owner.secret);
  assert.equal(draftAgain.value.duplicate, true);
  assert.equal(draftAgain.value.sequence, drafted.value.sequence);

  const proposedWork = await call(origin, "room_propose_work", {
    roomId: created.roomId, requestId: "propose-notes", workItemId: "notes",
    title: "Write the notes", definitionOfDone: "Notes posted", accountableMemberId: created.ownerMemberId,
    mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false
  }, owner.secret);
  assert.equal(proposedWork.value.status, "recorded");
  assert.equal(proposedWork.value.action, "room_propose_work");
  assert.equal(proposedWork.value.next.arguments.roomId, created.roomId);
  const boardAfter = await call(origin, "room_read_board", { roomId: created.roomId }, owner.secret);
  assert.equal(boardAfter.value.columns.proposed.some(card => card.id === "notes"), true);

  const hiddenBoard = await call(origin, "room_read_board", { roomId: created.roomId }, peer.secret);
  assert.equal(hiddenBoard.body.result.isError, true);
  assert.equal(JSON.stringify(hiddenBoard.body).includes("Hosted draft of the agenda"), false);
  assert.equal(JSON.stringify(hiddenBoard.body).includes("@MCP stranger"), false);
  const missingRoom = await call(origin, "room_read_inbox", {}, owner.secret);
  assert.equal(missingRoom.body.error.code, -32602);
});

const BOND_DM_TOOLS = ["bond.accept", "bond.decline", "bond.revoke", "bond.list", "dm.posted", "room_list_peer_dms"];

test("bond accept decline revoke and peer DM require the identity bearer and call through", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Bond owner");
  const peer = store.identities.create("Bond peer");
  const stranger = store.identities.create("Bond stranger");
  const created = rooms.create(owner.secret, {
    roomId: "bond-den", title: "Bond den", purpose: "Hosted bond tools", kind: "personal", displayName: "Bond owner"
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: peer.identityId, displayName: "Bond peer", permissions: []
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: stranger.identityId, displayName: "Bond stranger", permissions: []
  });

  const openList = await rpc(origin, "tools/list");
  const openNames = (await openList.json()).result.tools.map(tool => tool.name);
  for (const name of BOND_DM_TOOLS) assert.equal(openNames.includes(name), false, name);

  for (const name of BOND_DM_TOOLS) {
    assert.equal(HOSTED_ROOM_MCP_TOOLS.includes(name), true, name);
    const open = await call(origin, name, { roomId: created.roomId, id: "nope", bondId: "bond-x", to: peer.identityId, body: "no", messageId: "m" });
    assert.equal(open.status, 200, name);
    assert.equal(open.body.error.code, -32602, name);
    const bad = await call(origin, name, { roomId: created.roomId }, "pri_" + "z".repeat(43));
    assert.equal(bad.status, 401, name);
    assert.equal(bad.body.result, undefined, name);
    const roomKey = store.issueAccessKey(created.roomId, created.ownerMemberId);
    const keyed = await call(origin, name, { roomId: created.roomId, id: "key", bondId: "bond-x" }, roomKey);
    assert.equal(keyed.status, 401, name);
    assert.equal(keyed.body.result, undefined, name);
  }

  const proposed = await call(origin, "bond.propose", {
    roomId: created.roomId, id: "bond-propose-1", to: peer.identityId
  }, owner.secret);
  const firstBond = proposed.value.event.data.bondId;
  const selfAccept = await call(origin, "bond.accept", {
    roomId: created.roomId, id: "bond-accept-self", bondId: firstBond
  }, owner.secret);
  assert.equal(selfAccept.body.result.isError, true);
  assert.equal(selfAccept.value.code, "bond_not_recipient");

  const declined = await call(origin, "bond.decline", {
    roomId: created.roomId, id: "bond-decline-1", bondId: firstBond
  }, peer.secret);
  assert.equal(declined.value.status, "declined");
  assert.equal(declined.value.command.type, "bond.decline");
  assert.deepEqual(declined.value.command.data, { bondId: firstBond });
  assert.equal(declined.value.event.type, "bond.revoked");
  assert.equal(declined.value.event.data.reason, "declined");
  const declineRetry = await call(origin, "bond.decline", {
    roomId: created.roomId, id: "bond-decline-1", bondId: firstBond
  }, peer.secret);
  assert.equal(declineRetry.value.duplicate, true);
  assert.equal(declineRetry.value.sequence, declined.value.sequence);

  const again = await call(origin, "bond.propose", {
    roomId: created.roomId, id: "bond-propose-2", to: peer.identityId
  }, owner.secret);
  const bondId = again.value.event.data.bondId;
  assert.notEqual(bondId, firstBond);
  const shaped = await call(origin, "bond.accept", {
    roomId: created.roomId, id: "bond-accept-1", bondId, scopes: ["peer.dm"], note: "no"
  }, peer.secret);
  assert.equal(shaped.body.error.code, -32602);

  const accepted = await call(origin, "bond.accept", {
    roomId: created.roomId, id: "bond-accept-1", bondId, scopes: ["peer.dm"]
  }, peer.secret);
  assert.equal(accepted.value.status, "accepted");
  assert.equal(accepted.value.command.type, "bond.accept");
  assert.deepEqual(accepted.value.command.data, { bondId, scopes: ["peer.dm"] });
  assert.equal(accepted.value.event.type, "bond.activated");
  assert.deepEqual(accepted.value.event.data.acceptedScopes, ["peer.dm"]);
  const acceptRetry = await call(origin, "bond.accept", {
    roomId: created.roomId, id: "bond-accept-1", bondId, scopes: ["peer.dm"]
  }, peer.secret);
  assert.equal(acceptRetry.value.status, "duplicate");
  assert.equal(acceptRetry.value.duplicate, true);
  assert.equal(acceptRetry.value.sequence, accepted.value.sequence);

  const listed = await call(origin, "bond.list", { roomId: created.roomId, id: "bond-list-1" }, peer.secret);
  assert.equal(listed.value.status, "listed");
  assert.equal(listed.value.command.type, "bond.list");
  assert.deepEqual(listed.value.command.data, {});
  assert.equal(listed.value.event, null);
  assert.equal(listed.value.bonds.find(bond => bond.id === bondId).state, "active");

  const sent = await call(origin, "dm.posted", {
    roomId: created.roomId, id: "dm-1", to: peer.identityId, messageId: "dm-msg-1", body: "peer hello"
  }, owner.secret);
  assert.equal(sent.value.status, "posted");
  assert.equal(sent.value.command.type, "dm.posted");
  assert.deepEqual(sent.value.command.data, { to: peer.identityId, body: "peer hello", messageId: "dm-msg-1" });
  assert.equal(sent.value.event.type, "dm.posted");
  assert.equal(sent.value.event.data.body, "peer hello");
  const dmRetry = await call(origin, "dm.posted", {
    roomId: created.roomId, id: "dm-1", to: peer.identityId, messageId: "dm-msg-1", body: "peer hello"
  }, owner.secret);
  assert.equal(dmRetry.value.duplicate, true);
  assert.equal(dmRetry.value.sequence, sent.value.sequence);
  const dmConflict = await call(origin, "dm.posted", {
    roomId: created.roomId, id: "dm-1", to: peer.identityId, messageId: "dm-msg-1", body: "different"
  }, owner.secret);
  assert.equal(dmConflict.body.result.isError, true);
  assert.equal(dmConflict.value.code, "idempotency_conflict");

  const inbox = await call(origin, "room_read_inbox", { roomId: created.roomId }, peer.secret);
  assert.equal(inbox.value.peerMessages[0].body, "peer hello");
  assert.equal(inbox.value.peerMessages[0].fromIdentityId, owner.identityId);

  const threads = await call(origin, "room_list_peer_dms", { roomId: created.roomId }, peer.secret);
  assert.equal(threads.value.threads.length, 1);
  const threadId = threads.value.threads[0].threadId;
  const history = await call(origin, "room_list_peer_dms", { roomId: created.roomId, threadId }, owner.secret);
  assert.equal(history.value.threadId, threadId);
  assert.equal(history.value.messages[0].body, "peer hello");
  assert.equal(history.value.untrusted, true);

  const hiddenList = await call(origin, "room_list_peer_dms", { roomId: created.roomId }, stranger.secret);
  assert.deepEqual(hiddenList.value.threads, []);
  const hiddenThread = await call(origin, "room_list_peer_dms", { roomId: created.roomId, threadId }, stranger.secret);
  assert.equal(hiddenThread.body.result.isError, true);
  assert.equal(hiddenThread.value.code, "thread_not_found");
  assert.equal(JSON.stringify(hiddenThread.body).includes("peer hello"), false);
  assert.equal(JSON.stringify(history.body).includes(owner.secret), false);

  const revoked = await call(origin, "bond.revoke", {
    roomId: created.roomId, id: "bond-revoke-1", bondId
  }, owner.secret);
  assert.equal(revoked.value.status, "revoked");
  assert.equal(revoked.value.command.type, "bond.revoke");
  assert.equal(revoked.value.event.type, "bond.revoked");
  const after = await call(origin, "dm.posted", {
    roomId: created.roomId, id: "dm-2", to: owner.identityId, messageId: "dm-msg-2", body: "too late"
  }, peer.secret);
  assert.equal(after.body.result.isError, true);
  assert.equal(after.value.code, "bond_revoked");
  const still = await call(origin, "room_list_peer_dms", { roomId: created.roomId, threadId }, peer.secret);
  assert.equal(still.value.messages[0].body, "peer hello");
  assert.equal(JSON.stringify(still.body).includes("too late"), false);

  const page = await (await fetch(`${origin}/room/mcp`)).text();
  assert.match(page, /bond\.accept submits/);
  assert.match(page, /dm\.posted submits/);
  assert.match(page, /room_list_peer_dms lists/);
  assert.match(page, /room_put_file, room_list_files, room_get_file, and room_discard_file/);
  assert.match(page, /room_commit_file commits/);
  assert.doesNotMatch(page, /committing a staged room file onto a message/);
  assert.match(page, /inbox attachment bytes/);
  assert.match(page, /wake\.register reports/);
  assert.match(page, /webhook\.subscribe, webhook\.list, and webhook\.unsubscribe/);
  assert.doesNotMatch(page, /wake, heartbeats, and webhook delivery/);
  assert.doesNotMatch(page, /Bond beyond/);
});
