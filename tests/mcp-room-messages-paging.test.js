// QA7-04 / user-testing m4: MCP room_read_messages paging contract.
//   1. limit counts MESSAGES, not scanned events: a first page must contain
//      messages when they exist beyond the first `limit` scanned events
//      (m4: one message at seq 8, {limit:5} returned {messages:[],next:5,hasMore:true}).
//   2. latest:true returns the latest N messages in chronological order,
//      equal to GET /conversation?limit=N (REST parity).
//   3. Default after/next paging walks the full history in order (unchanged).
// Both dispatch paths are covered: the hosted MCP tool (server) and the
// local stdio client's roomMessages (HTTP /events), mirroring
// reply-requests.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { readConversation } from "../server/conversation-sync.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, command) => store.command(keys[actor], "commons", command);
  // Sparsity like the m4 repro: joins push the first message past seq 5.
  for (let i = 0; i < 7; i++) {
    send("owner", { id: `join-${i}`, type: "member.added",
      data: { memberId: `mate-${i}`, displayName: `Mate ${i}`, kind: "agent", permissions: [] } });
  }
  // The HTTP client path requires an agent-kind member for checkConnection.
  send("owner", { id: "join-worker1", type: "member.added",
    data: { memberId: "worker1", displayName: "Worker 1", kind: "agent", permissions: [] } });
  keys.worker1 = store.issueAccessKey("commons", "worker1");
  const post = (messageId, body) => send("owner", { id: `post-${messageId}`, type: "message.posted",
    data: { messageId, body: body ?? messageId } });
  const react = (messageId, n) => {
    for (let i = 0; i < n; i++) {
      send("owner", { id: `react-${messageId}-${i}`, type: "message.reaction_set",
        data: { messageId, reaction: "👍", active: true } });
    }
  };
  const server = createRoomServer({ store });
  const ready = new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const clientFor = (memberId = "worker1") => new RoomAgentClient({
    origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId, token: keys[memberId] ?? keys.owner,
  });
  const hosted = (args, member = "owner") =>
    callHostedStdioTool(store, keys[member], "room_read_messages", { roomId: "commons", ...args })
      .then(result => result.value);
  return { store, keys, send, post, react, ready, clientFor, hosted };
}

test("m4: first page contains the message even when it sits past the first limit scanned events", async t => {
  const f = fixture(t);
  await f.ready;
  f.post("m4-only", "hello from the worker");
  for (const read of [args => f.hosted(args), args => f.clientFor("worker1").roomMessages(args)]) {
    const page = await read({ limit: 5 });
    assert.equal(page.messages.length, 1, "limit counts messages: the one message is on the first page");
    assert.equal(page.messages[0].messageId, "m4-only");
    assert.equal(page.hasMore, false);
  }
});

test("limit counts messages across sparse pages; after/next still walks everything in order", async t => {
  const f = fixture(t);
  await f.ready;
  f.post("sparse-a", "a"); f.react("sparse-a", 3);
  f.post("sparse-b", "b"); f.react("sparse-b", 3);
  f.post("sparse-c", "c");
  for (const read of [args => f.hosted(args), args => f.clientFor("worker1").roomMessages(args)]) {
    const first = await read({ limit: 2 });
    assert.deepEqual(first.messages.map(m => m.messageId), ["sparse-a", "sparse-b"]);
    assert.equal(first.hasMore, true);
    const second = await read({ after: first.next, limit: 2 });
    assert.deepEqual(second.messages.map(m => m.messageId), ["sparse-c"]);
    assert.equal(second.hasMore, false);
  }
});

test("latest:true returns the latest N messages in chronological order, matching GET /conversation", async t => {
  const f = fixture(t);
  await f.ready;
  for (const id of ["l1", "l2", "l3", "l4", "l5"]) { f.post(id, id); f.react(id, 2); }
  const expected = readConversation(f.store, f.keys.owner, "commons", { limit: 3 }).messages.map(m => m.id);
  assert.deepEqual(expected, ["l3", "l4", "l5"]);
  for (const read of [args => f.hosted(args), args => f.clientFor("worker1").roomMessages(args)]) {
    const page = await read({ latest: true, limit: 3 });
    assert.deepEqual(page.messages.map(m => m.messageId), ["l3", "l4", "l5"],
      "latest:true matches /conversation?limit=3 message ids in order");
    assert.equal(page.hasMore, true, "older messages remain below the latest page");
  }
});

test("latest:true includes the head event when the head itself is a message", async t => {
  const f = fixture(t);
  await f.ready;
  // No trailing non-message events: the newest message sits at the log head.
  // (Cross-lane review on #1610: the exclusive scan bound used to drop it.)
  for (const id of ["h1", "h2", "h3"]) f.post(id, id);
  for (const read of [args => f.hosted(args), args => f.clientFor("worker1").roomMessages(args)]) {
    const page = await read({ latest: true, limit: 1 });
    assert.deepEqual(page.messages.map(m => m.messageId), ["h3"]);
    const full = await read({ latest: true, limit: 10 });
    assert.deepEqual(full.messages.map(m => m.messageId), ["h1", "h2", "h3"]);
    assert.equal(full.hasMore, false);
  }
});

test("default mode still pages dense history oldest-first with after/next", async t => {
  const f = fixture(t);
  await f.ready;
  for (let i = 0; i < 6; i++) f.post(`dense-${i}`, `dense-${i}`);
  for (const read of [args => f.hosted(args), args => f.clientFor("worker1").roomMessages(args)]) {
    const seen = [];
    let after = 0, guard = 0;
    for (;;) {
      const page = await read({ after, limit: 2 });
      seen.push(...page.messages.map(m => m.messageId));
      if (!page.hasMore || ++guard > 10) break;
      after = page.next;
    }
    assert.deepEqual(seen, ["dense-0", "dense-1", "dense-2", "dense-3", "dense-4", "dense-5"]);
  }
});
