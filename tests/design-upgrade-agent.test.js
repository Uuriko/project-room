import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ServiceError } from "../server/service-error.mjs";
import {
  acknowledge, callDesignUpgradeTool, collectNeedsYou, putResult, readAck, readFlag, readResult, readTaskStatus, validDesignUpgradeArgs, writeFlag,
} from "../server/design-upgrade.mjs";
import { getNeedsYou, getTaskStatus, postDesignUpgrade, postTaskAck, postTaskResult } from "../server/routes/design-upgrade.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { mcpRoomToolScope } from "../server/mcp-room-profile.mjs";

const NOW = Date.parse("2026-10-25T03:00:00.000Z");

function member(id, permissions = []) {
  return { id, active: true, kind: "agent", displayName: id, permissions };
}

function createStore({ roomId = "muse-room", ownerId = "owner", viewerId = "viewer", claims = [], workItems = {}, replyRequests = {}, now = NOW } = {}) {
  const db = new DatabaseSync(":memory:");
  const viewer = member(viewerId);
  const owner = member(ownerId);
  const state = { room: { ownerId }, members: { [viewerId]: viewer, [ownerId]: owner }, workItems, replyRequests };
  let clock = now;
  const store = {
    db,
    now: () => clock,
    setNow(value) { clock = value; },
    room() { return { state }; },
    roomAuthority() { return { members: state.members }; },
    workClaims: { list: () => claims },
    authenticate(secret, id) {
      const found = secret === `secret:${viewerId}` ? viewer : secret === `secret:${ownerId}` ? owner : null;
      if (!found || id !== roomId) throw new ServiceError(401, "unauthenticated", "Room membership required");
      return { member: found };
    },
  };
  return { store, viewer, owner, state, claims };
}

function ctxFor(store, { roomId, member, url = "http://room.test/api", body = null, method = "GET" }) {
  return {
    params: { roomId },
    store,
    req: { method },
    url: new URL(url),
    res: {},
    roomCredentials: () => ({ mode: "room", bearer: true, token: `secret:${member.id}` }),
    accountBinding: () => null,
    expectedBinding: () => null,
    roomAuth: () => ({ member, kind: "identity", credentialHash: member.id, credentialScope: "room" }),
    rate() {},
    protectWrite() {},
    json(_res, status, payload) { return { status, body: payload }; },
    reject(status, code, message) { throw new ServiceError(status, code, message); },
    body: async () => body,
  };
}

test("muse-room defaults on and only the owner can change another room", () => {
  const muse = createStore({ roomId: "muse-room" });
  assert.equal(readFlag(muse.store, "muse-room").enabled, true);
  assert.equal(readFlag(muse.store, "muse-room").flag, "designUpgrade");
  const other = createStore({ roomId: "other-room" });
  assert.equal(readFlag(other.store, "other-room").enabled, false);
  assert.throws(() => writeFlag(other.store, other.viewer, "other-room", true), error => error.status === 403 && error.code === "not_owner");
  assert.equal(writeFlag(other.store, other.owner, "other-room", true).enabled, true);
  assert.equal(writeFlag(other.store, other.owner, "other-room", false).enabled, false);
});

test("flag off tells the caller how to turn designUpgrade on", () => {
  const { store, viewer } = createStore({ roomId: "other-room" });
  assert.throws(() => readTaskStatus(store, viewer, "other-room", { kind: "claim", id: "c1" }), error => {
    assert.equal(error.code, "design_upgrade_off");
    assert.equal(error.next.method, "POST");
    assert.equal(error.next.path, "/api/rooms/other-room/design-upgrade");
    assert.deepEqual(error.next.body, { enabled: true });
    assert.match(error.next.hint, /muse-room/);
    return true;
  });
});

test("needs you is one list for this member, paged, with the full count", () => {
  const claims = [{
    id: "c1", state: "delivered", owner: "holder", title: "Review the patch",
    tags: ["rev-viewer"], reviews: [], claimedAt: "2026-10-25T02:00:00.000Z",
  }, {
    id: "c2", state: "blocked", owner: "viewer", title: "Blocked work", claimedAt: "2026-10-25T02:00:00.000Z", history: [],
  }];
  const { store, viewer } = createStore({
    claims,
    workItems: {
      w1: { id: "w1", title: "Draft the note", state: "proposed", revision: 1, accountableMemberId: "viewer" },
      w2: { id: "w2", title: "Someone else", state: "proposed", revision: 1, accountableMemberId: "owner" },
    },
    replyRequests: {
      a1: { id: "a1", status: "open", recipientId: "viewer", createdAt: "2026-10-25T01:00:00.000Z", title: "Need a look" },
      a2: { id: "a2", status: "open", recipientId: "owner", createdAt: "2026-10-25T01:00:01.000Z", title: "Not yours" },
      a3: { id: "a3", status: "open", recipientId: "viewer", createdAt: "2026-10-25T01:00:02.000Z" },
    },
  });
  store.db.exec(`CREATE TABLE access_requests (
    request_id TEXT PRIMARY KEY, room_id TEXT, display_name TEXT, status TEXT, created_at INTEGER
  )`);
  store.db.prepare("INSERT INTO access_requests (request_id, room_id, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("j1", "muse-room", "Ada", "pending", NOW);
  const page = collectNeedsYou(store, viewer, "muse-room", { limit: 2 });
  assert.equal(page.count, 4);
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  const ids = [];
  let cursor = null;
  do {
    const next = collectNeedsYou(store, viewer, "muse-room", { limit: 2, cursor });
    assert.equal(next.count, 4);
    ids.push(...next.items.map(item => item.id));
    cursor = next.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, ["ask:a1", "ask:a3", "task:c1", "task:w1"]);
  assert.equal(new Set(ids).size, ids.length);
  const ownerPage = collectNeedsYou(store, store.room("muse-room").state.members.owner, "muse-room", { limit: 20 });
  assert.ok(ownerPage.items.some(item => item.id === "approval:j1"));
  assert.ok(ownerPage.items.every(item => item.id !== "ask:a1"));
  assert.ok(page.items.every(item => item.status === "needs_you" && item.label === "Needs you"));
  assert.equal(page.items.find(item => item.id === "ask:a3")?.title, "Reply requested");
  assert.throws(() => collectNeedsYou(store, viewer, "muse-room", { cursor: "ask:missing" }), error => error.code === "invalid_cursor" && error.next.method === "GET");
});

test("acknowledgement is explicit, late, and refused for someone else", () => {
  const claims = [{
    id: "c1", state: "claimed", owner: "viewer", title: "Mine", claimedAt: new Date(NOW - 10_000).toISOString(),
    history: [{ action: "reassigned:viewer", agentId: "owner" }],
  }];
  const { store, viewer, owner } = createStore({ claims });
  const waiting = readAck(store, viewer, "muse-room", "claim", "c1");
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.canAck, true);
  const acked = acknowledge(store, "secret:viewer", viewer, "muse-room", "claim", "c1");
  assert.equal(acked.state, "acknowledged");
  assert.equal(acked.canAck, false);
  store.setNow(NOW + 60_000);
  const again = acknowledge(store, "secret:viewer", viewer, "muse-room", "claim", "c1");
  assert.equal(again.at, acked.at);
  assert.throws(() => acknowledge(store, "secret:owner", owner, "muse-room", "claim", "c1"), error => error.code === "not_assignee");
  claims[0] = {
    id: "c2", state: "claimed", owner: "viewer", title: "Late", claimedAt: new Date(NOW - 180_000).toISOString(),
    history: [{ action: "reassigned:viewer", agentId: "owner" }],
  };
  const quiet = readAck(store, viewer, "muse-room", "claim", "c2");
  assert.equal(quiet.state, "not_responding");
  assert.equal(acknowledge(store, "secret:viewer", viewer, "muse-room", "claim", "c2").state, "acknowledged");
});

test("a self-claimed task is acknowledged before any explicit ack", () => {
  const { store, viewer } = createStore({
    claims: [{
      id: "c1", state: "claimed", owner: "viewer", title: "Picked up", claimedAt: new Date(NOW).toISOString(),
      history: [{ action: "claimed", agentId: "viewer" }],
    }],
  });
  const ack = readAck(store, viewer, "muse-room", "claim", "c1");
  assert.equal(ack.state, "acknowledged");
  assert.equal(ack.canAck, false);
  assert.throws(() => readAck(store, viewer, "muse-room", "claim", "missing"), error => error.status === 404 && error.code === "unknown_task" && Boolean(error.next.hint));
});

test("result attach and read stay compact", () => {
  const { store, viewer, owner } = createStore({
    workItems: { w1: { id: "w1", title: "Draft", state: "working", revision: 1, accountableMemberId: "viewer" } },
  });
  assert.deepEqual(readResult(store, viewer, "muse-room", "work", "w1").result, null);
  const stored = putResult(store, viewer, "muse-room", "work", "w1", {
    summary: "Shipped the note",
    links: [{ href: "https://example.com/note", label: "Note" }, { href: "/rooms/muse-room", label: "Room" }],
  });
  assert.equal(stored.result.summary, "Shipped the note");
  assert.equal(stored.result.links.length, 2);
  assert.equal(readResult(store, owner, "muse-room", "work", "w1").result.summary, "Shipped the note");
  const replaced = putResult(store, owner, "muse-room", "work", "w1", { summary: "Owner copy" });
  assert.equal(replaced.result.summary, "Owner copy");
  assert.deepEqual(replaced.result.links, []);
  assert.throws(() => putResult(store, viewer, "muse-room", "work", "w1", { summary: "Bad", links: [{ href: "http://example.com", label: "No" }] }), error => error.code === "invalid_result" && /https/.test(error.next.hint));
  assert.throws(() => readResult(store, viewer, "muse-room", "work", "missing"), error => error.status === 404);
});

test("REST and MCP return the same task status body", async () => {
  const { store, viewer } = createStore({
    claims: [{
      id: "c1", state: "claimed", owner: "viewer", title: "Mine", claimedAt: new Date(NOW).toISOString(),
      history: [{ action: "reassigned:viewer", agentId: "owner" }],
    }],
  });
  const viaTool = callDesignUpgradeTool(store, "secret:viewer", "room_task_status", { roomId: "muse-room", kind: "claim", id: "c1" });
  const viaRoute = await getTaskStatus(ctxFor(store, { roomId: "muse-room", member: viewer, url: "http://room.test/api/rooms/muse-room/task-status?kind=claim&id=c1" }));
  assert.equal(viaRoute.status, 200);
  assert.deepEqual(viaRoute.body, viaTool);
  assert.equal(viaTool.status, "claimed");
  assert.equal(viaTool.ack.state, "waiting");
  assert.equal(mcpRoomToolScope("room_ack_task"), "rooms:write");
  assert.equal(mcpRoomToolScope("room_put_task_result"), "rooms:write");
  assert.equal(mcpRoomToolScope("room_needs_you"), "rooms:read");
  assert.equal(validDesignUpgradeArgs("room_needs_you", { roomId: "muse-room", limit: 20 }), true);
  assert.equal(validDesignUpgradeArgs("room_ack_task", { roomId: "muse-room", kind: "claim" }), false);
});

test("MCP surfaces design_upgrade_off with the same next step", async () => {
  const { store } = createStore({ roomId: "other-room" });
  const secret = `pri_${"a".repeat(43)}`;
  store.authenticate = (token, id) => {
    if (token !== secret || id !== "other-room") throw new ServiceError(401, "unauthenticated", "Room membership required");
    return { member: member("viewer") };
  };
  store.identities = {
    resolveGlobalIdentitySecret(token) { return token === secret ? { identityId: "id1", displayName: "Ada" } : null; },
    noteMcpUse() {},
  };
  const mcp = createHostedRoomMcp(store, { agentRooms: {} });
  const response = await mcp({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "room_needs_you", arguments: { roomId: "other-room" } },
  }, { authorization: `Bearer ${secret}` });
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.code, "design_upgrade_off");
  assert.equal(response.result.structuredContent.next.body.enabled, true);
  const route = await postDesignUpgrade(ctxFor(store, {
    roomId: "other-room", member: store.room().state.members.owner, method: "POST", body: { enabled: true },
  }));
  assert.equal(route.body.enabled, true);
  const inbox = await getNeedsYou(ctxFor(store, { roomId: "other-room", member: member("viewer"), url: "http://room.test/needs-you" }));
  const toolInbox = callDesignUpgradeTool(store, secret, "room_needs_you", { roomId: "other-room" });
  assert.deepEqual(inbox.body, toolInbox);
  assert.equal(inbox.body.count, 0);
});

test("REST ack and result match the tool", async () => {
  const { store, viewer } = createStore({
    claims: [{
      id: "c1", state: "claimed", owner: "viewer", title: "Mine", claimedAt: new Date(NOW).toISOString(),
      history: [{ action: "reassigned:viewer", agentId: "owner" }],
    }],
  });
  const routeAck = await postTaskAck(ctxFor(store, {
    roomId: "muse-room", member: viewer, method: "POST", body: { kind: "claim", id: "c1" },
  }));
  const toolAck = callDesignUpgradeTool(store, "secret:viewer", "room_ack_task", { roomId: "muse-room", kind: "claim", id: "c1" });
  assert.equal(routeAck.body.state, "acknowledged");
  assert.equal(toolAck.at, routeAck.body.at);
  const routeResult = await postTaskResult(ctxFor(store, {
    roomId: "muse-room", member: viewer, method: "POST",
    body: { kind: "claim", id: "c1", summary: "Done", links: [] },
  }));
  const toolResult = callDesignUpgradeTool(store, "secret:viewer", "room_read_task_result", { roomId: "muse-room", kind: "claim", id: "c1" });
  assert.deepEqual(routeResult.body, toolResult);
  assert.equal(toolResult.result.summary, "Done");
});
