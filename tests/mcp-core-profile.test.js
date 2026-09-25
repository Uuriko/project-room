// Core MCP profile, legal tool names, hidden aliases, and cross-room room_needs_me.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import {
  CORE_MCP_TOOLS, CORE_MCP_BLURBS, HOSTED_ROOM_MCP_TOOLS, MCP_TOOL_NAME_RE
} from "../src/room-mcp-join.js";

const JOIN_TOOLS = ["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-core-"));
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

function rpc(origin, method, params, secret, query = "") {
  return fetch(`${origin}/room/mcp${query}`, {
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

function namesOf(body) {
  return body.result.tools.map(tool => tool.name);
}

test("default tools/list is the short core profile and every listed name is legal", async t => {
  const { origin, store, rooms } = await serve(t);
  const ada = store.identities.create("Ada");
  const carol = store.identities.create("Carol");
  rooms.create(ada.secret, {
    roomId: "ada-den", title: "Ada den", purpose: "Core profile", kind: "personal", displayName: "Ada"
  });

  const listed = await rpc(origin, "tools/list", undefined, ada.secret);
  const body = await listed.json();
  const names = namesOf(body);
  assert.equal(body.result.profile, "core");
  assert.deepEqual(names, [...CORE_MCP_TOOLS, ...JOIN_TOOLS]);
  assert.ok(names.every(name => MCP_TOOL_NAME_RE.test(name)));
  assert.equal(names.includes("bond.list"), false);
  assert.equal(names.includes("room_read_board"), false);
  assert.equal(body.result.tools.every(tool => tool.aliases === undefined), true);
  assert.equal(body.result.tools.find(tool => tool.name === "room_needs_me").description, CORE_MCP_BLURBS.room_needs_me);
  const coreBytes = Buffer.byteLength(JSON.stringify(body));
  const coreResultBytes = Buffer.byteLength(JSON.stringify(body.result));
  console.log(`core tools/list JSON-RPC bytes=${coreBytes} result bytes=${coreResultBytes}`);
  assert.ok(coreBytes < 16 * 1024, `core tools/list is ${coreBytes} bytes`);

  const aliased = await rpc(origin, "tools/list", { aliases: 1 }, ada.secret);
  const aliasBody = await aliased.json();
  assert.ok(namesOf(aliasBody).every(name => MCP_TOOL_NAME_RE.test(name)));
  assert.equal(aliasBody.result.tools.find(tool => tool.name === "bond_propose").aliases[0], "bond.propose");
  assert.equal(aliasBody.result.tools.find(tool => tool.name === "wake_pause").aliases[0], "wake.pause");
  assert.equal(aliasBody.result.tools.some(tool => tool.name === "bond.list"), false);

  const queried = await rpc(origin, "tools/list", undefined, ada.secret, "?aliases=1&profile=full");
  const queryBody = await queried.json();
  assert.equal(queryBody.result.profile, "full");
  assert.ok(namesOf(queryBody).every(name => MCP_TOOL_NAME_RE.test(name)));
  assert.deepEqual(namesOf(queryBody).slice(0, HOSTED_ROOM_MCP_TOOLS.length), [...HOSTED_ROOM_MCP_TOOLS]);
  assert.equal(queryBody.result.tools.find(tool => tool.name === "bond_list").aliases[0], "bond.list");
  assert.equal(queryBody.result.tools.find(tool => tool.name === "wake_pause").aliases[0], "wake.pause");
  assert.equal(queryBody.result.tools.some(tool => tool.name.includes(".")), false);

  const full = await rpc(origin, "tools/list", { profile: "full" }, ada.secret);
  const fullBody = await full.json();
  assert.ok(namesOf(fullBody).every(name => MCP_TOOL_NAME_RE.test(name)));
  assert.equal(namesOf(fullBody).includes("room_read_board"), true);
  assert.equal(fullBody.result.tools.every(tool => tool.aliases === undefined), true);
  assert.ok(Buffer.byteLength(JSON.stringify(fullBody)) > coreBytes);

  const unknownProfile = await rpc(origin, "tools/list", { profile: "wide" }, ada.secret);
  const unknownProfileBody = await unknownProfile.json();
  assert.equal(unknownProfileBody.error.data.reason, "invalid_arguments");

  const typo = await call(origin, "room_read_bord", { roomId: "ada-den" }, ada.secret);
  assert.equal(typo.body.error.data.reason, "unknown_tool");
  assert.equal(typo.body.error.data.suggestion, "room_read_board");
  const board = await call(origin, "room_read_board", { roomId: "ada-den" }, ada.secret);
  assert.equal(board.body.error, undefined);
  assert.equal(board.body.result.isError, undefined);

  const bonds = await call(origin, "bond.list", { roomId: "ada-den" }, ada.secret);
  assert.equal(bonds.body.error, undefined);
  assert.equal(bonds.value.command.type, "bond.list");
  const paused = await call(origin, "wake.pause", { roomId: "ada-den" }, ada.secret);
  assert.equal(paused.body.result.isError, undefined);
  assert.equal(paused.value.receipt.state, "paused");

  const created = await call(origin, "room_create", {
    roomId: "ada-west", title: "Ada west", purpose: "Created from MCP"
  }, ada.secret);
  assert.equal(created.value.roomId, "ada-west");
  assert.equal(created.value.duplicate, false);

  const ownerKey = store.issueAccessKey("ada-den", ada.identityId);
  const invite = store.invites.create(ownerKey, "ada-den", { profile: "chat" });
  const joined = await call(origin, "room_join", { inviteCode: invite.code }, carol.secret);
  assert.equal(joined.body.result.isError, undefined);
  assert.equal(joined.value.roomId, "ada-den");
  assert.equal(joined.value.identityId, carol.identityId);
  assert.equal(Object.hasOwn(joined.value, "secret"), false);
  const access = await call(origin, "room_check_access", {}, carol.secret);
  assert.equal(access.value.rooms.some(room => room.roomId === "ada-den"), true);
});

test("room_needs_me and GET /api/needs-me list what changed across rooms", async t => {
  const { origin, store, rooms } = await serve(t);
  const ada = store.identities.create("Ada");
  const bob = store.identities.create("Bob");
  const roomA = rooms.create(ada.secret, {
    roomId: "ada-den", title: "Ada den", purpose: "Needs me", kind: "personal", displayName: "Ada"
  }).roomId;
  const roomB = rooms.create(ada.secret, {
    roomId: "ada-east", title: "Ada east", purpose: "Needs me too", kind: "personal", displayName: "Ada"
  }).roomId;
  for (const roomId of [roomA, roomB]) {
    store.identities.link(ada.secret, roomId, { identityId: bob.identityId, displayName: "Bob", permissions: [] });
    setTier(store.db, roomId, bob.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  const post = (secret, roomId, id, data) => store.command(secret, roomId, {
    id, type: "message.posted", data: { messageId: id, ...data }
  });
  post(bob.secret, roomA, "mention-a", { body: "@Ada the board moved" });
  post(bob.secret, roomB, "mention-b", { body: "@Ada the other board moved" });
  post(bob.secret, roomA, "ask-a", {
    body: "Please reply about the adapter",
    toMemberId: ada.identityId,
    requestKind: "reply"
  });
  post(bob.secret, roomA, "dm-room-a", { body: "room ping for Ada", toMemberId: ada.identityId });
  store.command(ada.secret, roomA, { id: "propose-1", type: "work.proposed", data: {
    workItemId: "feed-parse", title: "Parse feeds", definitionOfDone: "Feeds parsed",
    accountableMemberId: ada.identityId, mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false
  } });
  store.command(ada.secret, roomA, { id: "accept-1", type: "work.accepted", data: {
    workItemId: "feed-parse", expectedRevision: 0
  } });
  store.command(ada.secret, roomA, { id: "start-1", type: "work.started", data: {
    workItemId: "feed-parse", expectedRevision: 1
  } });
  store.command(ada.secret, roomA, { id: "handoff-1", type: "work.handoff_recorded", data: {
    workItemId: "feed-parse", expectedRevision: 2,
    doneSummary: "3 of 5 feeds parsed", nextAction: "Reassign the adapter", limitReason: "context window"
  } });
  const now = Date.now();
  store.db.prepare(`INSERT INTO land_queue(
    room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, title, head_sha,
    mergeable, behind, checks_state, merged_sha, tip_source_revision, tip_build_id, last_error,
    observed, closed, next_poll_at, backoff_ms, poll_etag, rate_limited_until, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    roomA, "quiet-pr", "uuriko/project-room", 1, ada.identityId, ada.identityId, "Quiet", null,
    "unknown", 0, "pending", null, null, null, null,
    0, 0, null, 60000, null, null, now, now
  );
  store.db.prepare(`INSERT INTO land_queue(
    room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, title, head_sha,
    mergeable, behind, checks_state, merged_sha, tip_source_revision, tip_build_id, last_error,
    observed, closed, next_poll_at, backoff_ms, poll_etag, rate_limited_until, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    roomA, "changed-pr", "uuriko/project-room", 2, ada.identityId, ada.identityId, "Changed PR", null,
    "unknown", 0, "success", null, null, null, null,
    1, 0, null, 60000, null, null, now, now + 50
  );
  const proposed = await call(origin, "bond_propose", {
    roomId: roomA, id: "bond-1", to: ada.identityId
  }, bob.secret);
  assert.equal(proposed.body.result.isError, undefined);
  const bondId = proposed.value.event.data.bondId;

  const first = await call(origin, "room_needs_me", {}, ada.secret);
  assert.equal(first.body.result.isError, undefined);
  const items = first.value.items;
  const kinds = (kind, roomId) => items.filter(item => item.kind === kind && (!roomId || item.roomId === roomId));
  assert.equal(kinds("mention", roomA).length, 1);
  assert.equal(kinds("mention", roomB).length, 1);
  assert.equal(kinds("direct_ask", roomA)[0].next.tool, "room_read_request");
  assert.equal(kinds("direct_ask", roomA)[0].next.arguments.requestMessageId, "ask-a");
  assert.equal(kinds("handoff", roomA)[0].id, "feed-parse");
  assert.equal(kinds("handoff", roomA)[0].next.tool, "room_read_work");
  assert.equal(kinds("dm").some(item => item.channel === "room" && item.id === "dm-room-a"), true);
  assert.equal(kinds("dm").some(item => item.channel === "room" && item.next.tool === "room_reply"), true);
  assert.equal(kinds("bond_request", roomA)[0].id, bondId);
  assert.equal(kinds("bond_request", roomA)[0].next.tool, "bond_accept");
  assert.deepEqual(kinds("land_queue").map(item => item.id), ["changed-pr"]);
  assert.equal(kinds("land_queue")[0].next.tool, "list_land_queue");
  for (const item of items) {
    assert.equal(typeof item.roomId, "string");
    assert.equal(Number.isSafeInteger(item.seq), true);
    assert.equal(typeof item.next.tool, "string");
    assert.equal(typeof item.next.arguments, "object");
    assert.equal(MCP_TOOL_NAME_RE.test(item.next.tool), true);
  }
  assert.equal(new Set(items.map(item => item.roomId)).has(roomB), true);
  const bobView = await call(origin, "room_needs_me", {}, bob.secret);
  assert.equal(bobView.value.items.some(item => item.kind === "handoff" || item.kind === "land_queue" || item.kind === "bond_request"), false);

  const onlyLand = await call(origin, "room_needs_me", { since: 1_000_000_000 }, ada.secret);
  assert.deepEqual(onlyLand.value.items.map(item => item.kind), ["land_queue"]);

  const accepted = await call(origin, "bond_accept", {
    roomId: roomA, id: "bond-accept-1", bondId, scopes: ["peer.dm"]
  }, ada.secret);
  assert.equal(accepted.value.status, "accepted");
  const sent = await call(origin, "dm_posted", {
    roomId: roomA, id: "peer-dm-1", to: ada.identityId, messageId: "peer-msg-1", body: "peer hello ada"
  }, bob.secret);
  assert.equal(sent.value.status, "posted");

  const second = await call(origin, "room_needs_me", {}, ada.secret);
  assert.equal(second.value.items.some(item => item.kind === "bond_request"), false);
  const peer = second.value.items.find(item => item.kind === "dm" && item.channel === "peer");
  assert.equal(peer.id, "peer-msg-1");
  assert.equal(peer.next.tool, "room_list_peer_dms");
  assert.equal(peer.roomId, roomA);

  const caughtUp = await call(origin, "room_needs_me", { since: second.value.cursor }, ada.secret);
  assert.deepEqual(caughtUp.value.items, []);
  post(bob.secret, roomB, "mention-b2", { body: "@Ada one more thing" });
  const later = await call(origin, "room_needs_me", { since: second.value.cursor }, ada.secret);
  assert.deepEqual(later.value.items.map(item => item.id), ["mention-b2"]);
  assert.equal(later.value.items[0].roomId, roomB);
  assert.equal(later.value.items[0].seq > second.value.cursor.rooms[roomB], true);

  const http = await fetch(`${origin}/api/needs-me?since=${encodeURIComponent(JSON.stringify(second.value.cursor))}`, {
    headers: { Authorization: `Bearer ${ada.secret}` }
  });
  assert.equal(http.status, 200);
  const httpBody = await http.json();
  assert.deepEqual(httpBody.items.map(item => item.id), ["mention-b2"]);
  assert.equal(httpBody.identityId, ada.identityId);
  assert.equal(httpBody.untrusted, true);

  const missing = await fetch(`${origin}/api/needs-me`);
  assert.equal(missing.status, 401);
  const badCursor = await fetch(`${origin}/api/needs-me?since=nope`, {
    headers: { Authorization: `Bearer ${ada.secret}` }
  });
  assert.equal(badCursor.status, 422);
  assert.equal((await badCursor.json()).error.code, "invalid_cursor");
  const badMcp = await call(origin, "room_needs_me", { since: { rooms: { "ada-den": -1 } } }, ada.secret);
  assert.equal(badMcp.body.result.isError, true);
  assert.equal(badMcp.value.code, "invalid_cursor");
});
