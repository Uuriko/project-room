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
import { RoomAgentClient } from "../client/room-agent.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";
import {
  CORE_MCP_TOOLS, PUBLIC_WORK_MCP_TOOLS, CORE_MCP_BLURBS, HOSTED_ROOM_MCP_TOOLS, MCP_TOOL_NAME_RE
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
  // Core still names bond_propose; the rest of the bond lifecycle is
  // advertised from the conversation focus (see the focus test below).
  assert.ok(names.every(name => MCP_TOOL_NAME_RE.test(name)));
  assert.equal(names.includes("bond.list"), false);
  assert.equal(names.includes("room_read_board"), false);
  assert.equal(body.result.tools.every(tool => tool.aliases === undefined), true);
  assert.equal(body.result.tools.find(tool => tool.name === "room_needs_me").description, CORE_MCP_BLURBS.room_needs_me);
  // The core blurb must match the read contract: oldest first from `after`
  // (default 0), not "recent". A cold agent trusting "recent" reads the room's
  // first page and misses the current conversation.
  const readMessages = body.result.tools.find(tool => tool.name === "room_read_messages");
  assert.equal(readMessages.description, CORE_MCP_BLURBS.room_read_messages);
  assert.match(readMessages.description, /oldest first/);
  assert.doesNotMatch(readMessages.description, /\brecent\b/i);
  assert.equal(readMessages.inputSchema.properties.after.default, 0);
  const coreBytes = Buffer.byteLength(JSON.stringify(body));
  const coreResultBytes = Buffer.byteLength(JSON.stringify(body.result));
  console.log(`core tools/list JSON-RPC bytes=${coreBytes} result bytes=${coreResultBytes}`);
  // QA7-04 added the latest flag to room_read_messages' schema: the core
  // profile stays small for cold agents, with headroom for one more flag.
  assert.ok(coreBytes < 17 * 1024, `core tools/list is ${coreBytes} bytes`);

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
  assert.ok(PUBLIC_WORK_MCP_TOOLS.every(name => namesOf(fullBody).includes(name)));

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
  assert.equal(kinds("land_queue")[0].next.tool, "room_list_land_queue");
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
  const sent = await call(origin, "dm_send", {
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


test("a fresh default-profile client can discover, answer and verify a formal request using only advertised tools", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Requester"), recipient = store.identities.create("Responder");
  const room = rooms.create(owner.secret, { roomId: "core-requests", title: "Core requests", purpose: "Answer in context", kind: "personal", displayName: "Requester" });
  store.identities.link(owner.secret, room.roomId, { identityId: recipient.identityId, displayName: "Responder", permissions: [] });
  store.command(owner.secret, room.roomId, { id: "core-question", type: "message.posted", data: {
    messageId: "core-question", body: "Which result should we use?", toMemberId: recipient.identityId, requestKind: "reply"
  } });
  const catalog = await (await rpc(origin, "tools/list", undefined, recipient.secret)).json();
  const advertised = new Set(namesOf(catalog));
  const invoke = async (name, args) => {
    assert.ok(advertised.has(name), `Fresh client cannot invoke unadvertised tool ${name}`);
    return call(origin, name, args, recipient.secret);
  };
  const needs = await invoke("room_needs_me", {});
  const pointer = needs.value.items.find(item => item.kind === "direct_ask" && item.id === "core-question").next;
  const initial = await invoke(pointer.tool, pointer.arguments);
  const stale = initial.value.responseActions.find(action => action.arguments.responseOutcome === "answered");
  assert.ok(advertised.has(stale.tool), "the discovered response must also be advertised");
  await invoke("room_reply", { roomId: room.roomId, requestId: "core-clarification", replyToId: "core-question", body: "One clarification first." });
  assert.equal(store.room(room.roomId).state.replyRequests["core-question"].status, "open", "ordinary chat does not answer the formal request");
  const refused = await invoke(stale.tool, { ...stale.arguments, requestId: "core-stale-answer", body: "Stale answer" });
  assert.equal(refused.body.result.isError, true);
  let selected = await invoke(pointer.tool, { ...pointer.arguments, limit: 1 });
  assert.equal(selected.value.page.hasMore, true); assert.deepEqual(selected.value.responseActions, []);
  while (selected.value.page.hasMore) selected = await invoke(pointer.tool, { ...pointer.arguments, limit: 1, cursor: selected.value.page.nextCursor });
  const action = selected.value.responseActions.find(action => action.arguments.responseOutcome === "answered");
  const sent = await invoke(action.tool, { ...action.arguments, requestId: "core-current-answer", body: "Use the verified result." });
  assert.equal(sent.value.status, "recorded");
  const final = await invoke(sent.value.next.tool, sent.value.next.arguments);
  assert.equal(final.value.request.status, "answered"); assert.deepEqual(final.value.responseActions, []);
  assert.equal(final.value.page.items.at(-1).message.body, "Use the verified result.");
});


test("tools/list focus is explicit, stateless discovery with full-catalog escape and unchanged authorization", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Owen"), reader = store.identities.create("Reader");
  const roomId = rooms.create(owner.secret, {
    roomId: "focused-tools", title: "Focused tools", purpose: "Discover appropriate actions", kind: "personal"
  }).roomId;
  store.identities.link(owner.secret, roomId, { identityId: reader.identityId, displayName: "Reader", permissions: [] });
  setTier(store.db, roomId, reader.identityId, "t1_readonly", { updatedBy: "owner", nowMs: Date.now() });
  const before = JSON.stringify(store.room(roomId).state);
  const review = await (await rpc(origin, "tools/list", { focus: "review" }, owner.secret)).json();
  assert.equal(review.result.focus, "review");
  assert.equal(review.result._meta.focus.permissionsChanged, false);
  assert.match(review.result._meta.focus.reset, /profile=full/);
  for (const name of ["room_check_access", "room_needs_me", "get_room_context", "room_read_request", "room_request_reply", "room_post_message", "room_read_result", "room_record_verification"]) {
    assert.ok(namesOf(review).includes(name), `Review needs ${name}`);
  }
  for (const name of ["room_propose_work", "wake_register", "room_put_file"]) assert.ok(!namesOf(review).includes(name));
  const work = await (await rpc(origin, "tools/list", undefined, owner.secret, "?focus=work")).json();
  assert.equal(work.result.focus, "work");
  for (const name of ["room_begin_work", "room_record_handoff", "room_acquire_claim", "room_link_work_claim_pr"]) assert.ok(namesOf(work).includes(name));
  const conversation = await (await rpc(origin, "tools/list", { focus: "conversation" }, owner.secret)).json();
  assert.ok(namesOf(conversation).includes("room_read_messages"));
  assert.ok(!namesOf(conversation).includes("room_record_verification"));
  // The full bond lifecycle is advertised through the conversation focus.
  // bond_accept, bond_decline, and bond_revoke are callable on tools/call
  // but were invisible in every discovery view except profile=full —
  // Fo (2026-10-01) found 15 of 17 bonds stuck in "proposed" for exactly
  // this reason. The conversation focus already carried bond_list and
  // dm_send; the three missing lifecycle tools now join it.
  for (const name of ["bond_accept", "bond_decline", "bond_revoke", "bond_list"]) {
    assert.ok(namesOf(conversation).includes(name), `conversation focus advertises ${name}`);
  }
  const automation = await (await rpc(origin, "tools/list", { focus: "automation", aliases: 1 }, owner.secret)).json();
  assert.ok(namesOf(automation).includes("webhook_subscribe"));
  assert.equal(automation.result.tools.find(tool => tool.name === "wake_pause").aliases[0], "wake.pause");
  const precedence = await (await rpc(origin, "tools/list", { focus: "review" }, owner.secret, "?focus=work")).json();
  assert.equal(precedence.result.focus, "review");
  for (const params of [{ focus: "unknown" }, { focus: "" }, { focus: null }, { focus: [] }, { focus: "toString" }, { profile: "full", focus: "review" }]) {
    const body = await (await rpc(origin, "tools/list", params, owner.secret)).json();
    assert.equal(body.error.data.reason, "invalid_arguments");
  }
  const invalidQuery = await (await rpc(origin, "tools/list", undefined, owner.secret, "?focus=unknown")).json();
  assert.equal(invalidQuery.error.data.reason, "invalid_arguments");
  const defaultAgain = await (await rpc(origin, "tools/list", undefined, owner.secret)).json();
  assert.equal(defaultAgain.result.focus, undefined);
  assert.deepEqual(namesOf(defaultAgain), [...CORE_MCP_TOOLS, ...JOIN_TOOLS]);
  const full = await (await rpc(origin, "tools/list", { profile: "full" }, owner.secret)).json();
  assert.equal(full.result.focus, undefined);
  assert.ok(namesOf(full).includes("room_propose_work"));
  // Discovery must not issue commands, set tiers, or persist a selected mode.
  assert.equal(JSON.stringify(store.room(roomId).state), before);
  const readonly = await (await rpc(origin, "tools/list", { focus: "review" }, reader.secret)).json();
  assert.ok(namesOf(readonly).includes("room_read_result"));
  assert.ok(!namesOf(readonly).includes("room_record_verification"));
  const denied = await call(origin, "room_post_message", { roomId, body: "Not authorized by discovery" }, reader.secret);
  assert.equal(denied.body.result.isError, true);
  assert.equal(denied.value.code, "agent_readonly");
  // A tool omitted by a focus is still callable under the existing policy.
  const posted = await call(origin, "room_propose_work", { roomId, workItemId: "off-focus-work", title: "Still available outside review focus", definitionOfDone: "Demonstrate direct invocation", accountableMemberId: owner.identityId, mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false }, owner.secret);
  assert.equal(posted.body.result.isError, undefined);
});

async function claimLinkFixture(t) {
  const fixture = await serve(t), { origin, store, rooms } = fixture;
  const owner = store.identities.create("Claim room owner"), writer = store.identities.create("Claim writer");
  const roomId = rooms.create(owner.secret, { roomId: "claim-links", title: "Claim links", purpose: "Append PR from hosted MCP", kind: "personal" }).roomId;
  store.identities.link(owner.secret, roomId, { identityId: writer.identityId, displayName: "Claim writer", permissions: ["accept_work", "complete_work"] });
  setTier(store.db, roomId, writer.identityId, "t2_standard", { updatedBy: owner.identityId, nowMs: Date.now() });
  const client = new RoomAgentClient({ origin, roomId, token: writer.secret });
  await client.workClaim("hosted-pr", { leaseHours: 6 });
  // HTTP reads carry the Board content-trust stamp; saved records do not.
  const claimed = stripTrust(await client.workClaimGet("hosted-pr"));
  const args = { roomId, claimId: claimed.id, pullRequest: "https://github.com/Uuriko/project-room/pull/19",
    expectedClaimedAt: claimed.claimedAt, expectedHistoryLength: claimed.history.length };
  return { ...fixture, owner, writer, roomId, client, claimed, args };
}

const stripTrust = ({ contentTrust, ...rest }) => rest;

// Hosted dispatch bypasses HTTP work-claim routing. This journey owns its
// independent API-key scope, argument validation and saved-record parity.
test("hosted claim PR tool preserves API-key scope and current-owner authorization", async t => {
  const { origin, store, owner, writer, roomId, client, claimed, args } = await claimLinkFixture(t);
  const catalog = await (await rpc(origin, "tools/list", { profile: "full" }, writer.secret)).json();
  const definition = catalog.result.tools.find(tool => tool.name === "room_link_work_claim_pr");
  assert.match(definition.description, /historyOmitted/);
  assert.match(definition.inputSchema.properties.expectedHistoryLength.description, /historyOmitted/);
  const issue = scopes => API_KEY_PREFIX + store.agentPlugin.issueApiKey({ identityId: writer.identityId, scopes }).secret;
  for (const [secret, code] of [[issue(["rooms:read"]), "insufficient_scope"],
    [issue(["rooms:write", "mcp:room:another-room"]), "insufficient_scope"], [owner.secret, "work_not_owner"]]) {
    const denied = await call(origin, "room_link_work_claim_pr", args, secret);
    assert.equal(denied.body.result.isError, true);
    assert.equal(denied.value.status, 403);
    assert.equal(denied.value.code, code);
    if (code === "work_not_owner") assert.ok(denied.value.next.some(step => step.path === `/api/rooms/${roomId}/work-claims/${claimed.id}`));
    assert.deepEqual(stripTrust(await client.workClaimGet(claimed.id)), claimed);
  }
  const invalid = await call(origin, "room_link_work_claim_pr", { ...args, pullRequest: { url: args.pullRequest } }, writer.secret);
  assert.equal(invalid.body.error.data.reason, "invalid_arguments");
  const linked = await call(origin, "room_link_work_claim_pr", args, issue(["rooms:write"]));
  assert.equal(linked.body.result.isError, undefined);
  assert.equal(linked.value.pullRequests[0].url, args.pullRequest);
  assert.deepEqual(stripTrust(await client.workClaimGet(claimed.id)), linked.value);
  store.command(owner.secret, roomId, { id: "archive-linked-room", type: "room.archived", data: { reason: "Complete" } });
  const archivedSequence = store.snapshot(owner.secret, roomId).sequence;
  const archived = await call(origin, "room_link_work_claim_pr", { ...args,
    pullRequest: "https://github.com/Uuriko/project-room/pull/20", expectedHistoryLength: linked.value.history.length }, writer.secret);
  assert.equal(archived.body.result.isError, true);
  assert.equal(archived.value.status, 409);
  assert.equal(archived.value.code, "room_archived");
  assert.deepEqual(store.workClaims.get(roomId, claimed.id), linked.value);
  assert.equal(store.snapshot(owner.secret, roomId).sequence, archivedSequence);
});

test("hosted claim PR calls honor target-room tier, write profile and membership rechecked at mutation time", async t => {
  const { origin, store, rooms, owner, writer, roomId, claimed, args } = await claimLinkFixture(t);
  const tool = "room_link_work_claim_pr";
  setTier(store.db, roomId, writer.identityId, "t1_readonly", { updatedBy: owner.identityId, nowMs: Date.now() });
  const withheld = await (await rpc(origin, "tools/list", { focus: "work" }, writer.secret)).json();
  assert.ok(!namesOf(withheld).includes(tool));
  let denied = await call(origin, tool, args, writer.secret);
  assert.equal(denied.value.code, "agent_readonly");
  // A full membership elsewhere makes the tool visible without granting this
  // target room any more write authority.
  rooms.create(writer.secret, { roomId: "writer-home", title: "Writer home", purpose: "Separate room authority", kind: "personal" });
  const visible = await (await rpc(origin, "tools/list", { focus: "work" }, writer.secret)).json();
  assert.ok(namesOf(visible).includes(tool));
  denied = await call(origin, tool, args, writer.secret);
  assert.equal(denied.value.code, "agent_readonly");
  assert.deepEqual(store.workClaims.get(roomId, claimed.id), claimed);
  setTier(store.db, roomId, writer.identityId, "t2_standard", { updatedBy: owner.identityId, nowMs: Date.now() });
  const changePermissions = permissions => {
    const member = store.roomAuthority(roomId).members[writer.identityId];
    store.command(owner.secret, roomId, { id: `permissions-${member.revision}`, type: "member.access_changed",
      data: { memberId: writer.identityId, expectedMemberRevision: member.revision, permissions, active: true } });
  };
  changePermissions([]);
  denied = await call(origin, tool, args, writer.secret);
  assert.equal(denied.value.code, "work_claims_not_permitted");
  assert.deepEqual(store.workClaims.get(roomId, claimed.id), claimed);
  changePermissions(["accept_work", "complete_work"]);
  // Inject the real membership removal after initial hosted authentication but
  // before the registry transaction, rather than faking an authorization result.
  const transaction = store.workClaims.transaction;
  let removed = false;
  store.workClaims.transaction = run => {
    store.workClaims.transaction = transaction;
    store.identities.unlink(owner.secret, roomId, writer.identityId);
    removed = true;
    return transaction(run);
  };
  t.after(() => { store.workClaims.transaction = transaction; });
  denied = await call(origin, tool, args, writer.secret);
  assert.equal(removed, true);
  assert.equal(denied.value.status, 401);
  assert.equal(denied.value.code, "unauthenticated");
  assert.deepEqual(store.workClaims.get(roomId, claimed.id), claimed);
});
