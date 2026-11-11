// room_read_messages query: a keyword filter over the already-authorized
// page. Hidden or private history must not change anything the searcher sees.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { validRoomToolArguments } from "../client/mcp-stdio.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event, EVENT_TYPES as T } from "../src/events.js";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";

function room(t, hiddenBody) {
  const events = initialRoom(), add = (type, data, actorId = "owner") => events.push(event({ roomId: "commons", actorId, type, data }));
  add(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  for (const id of ["reader", "alice", "bob"]) add(T.MEMBER_ADDED, { memberId: id, displayName: id, kind: "agent", permissions: [] });
  add(T.MESSAGE_POSTED, { messageId: "pre-join", body: "deploy notes from before late joined" });
  add(T.MEMBER_ADDED, { memberId: "late", displayName: "late", kind: "agent", permissions: [] });
  add(T.MESSAGE_POSTED, { messageId: "p1", body: "Plan the Deploy for Friday" }, "alice");
  add(T.MESSAGE_POSTED, { messageId: "secret", body: hiddenBody, toMemberId: "bob" }, "alice");
  add(T.MESSAGE_POSTED, { messageId: "p2", body: "unrelated lunch chat" }, "bob");
  add(T.MESSAGE_POSTED, { messageId: "p3", body: "deploy done, see <@reader>" }, "bob");
  add(T.MESSAGE_POSTED, { messageId: "dm", body: "private deploy checklist for you", toMemberId: "reader" }, "alice");
  const store = new RoomStore(":memory:");
  store.initialize(events, { representation: "normalized-current-v1" });
  t.after(() => store.close());
  const key = who => store.issueAccessKey("commons", who);
  const keys = { reader: key("reader"), late: key("late") };
  const hosted = (who, args) => callHostedStdioTool(store, keys[who], "room_read_messages", { roomId: "commons", ...args }).then(r => r.value);
  return { store, keys, hosted };
}

test("search returns only matching visible messages, case-insensitive, with honest scan counts", async t => {
  const { hosted } = room(t, "nothing here");
  const page = await hosted("reader", { after: 0, limit: 100, query: "DEPLOY" });
  assert.deepEqual(page.messages.map(m => m.messageId), ["pre-join", "p1", "p3", "dm"]);
  const full = await hosted("reader", { after: 0, limit: 100 });
  assert.equal(page.query.scanned, full.messages.length);
  assert.equal(page.query.matched, 4);
  assert.equal(page.next, full.next); assert.equal(page.hasMore, full.hasMore);
});

test("a hidden private message between others never changes the searcher's result, even when it matches", async t => {
  const matchingHidden = room(t, "secret deploy keys");
  const plainHidden = room(t, "nothing here");
  for (const args of [{ after: 0, limit: 100, query: "deploy" }, { after: 0, limit: 100, query: "secret" }, { after: 0, limit: 3, query: "deploy" }, { after: 0, limit: 100, query: "deploy", view: "digest" }]) {
    const a = await matchingHidden.hosted("reader", args), b = await plainHidden.hosted("reader", args);
    const strip = v => JSON.parse(JSON.stringify(v, (k, x) => (k === "eventId" || k === "at") ? undefined : x));
    assert.deepEqual(strip(a), strip(b), `indistinguishable for ${JSON.stringify(args)}`);
    assert.ok(!JSON.stringify(a).includes("secret deploy keys"));
  }
});

test("the history floor holds: a late joiner cannot match messages from before it joined", async t => {
  const { hosted } = room(t, "nothing here");
  const page = await hosted("late", { after: 0, limit: 100, query: "deploy" });
  assert.equal(page.messages.some(m => m.messageId === "pre-join"), false);
  assert.ok(page.messages.some(m => m.messageId === "p1"));
});

test("query composes with digest and leaves the default read unchanged", async t => {
  const { hosted } = room(t, "nothing here");
  const digest = await hosted("reader", { after: 0, limit: 100, query: "deploy", view: "digest" });
  assert.deepEqual([...digest.addressed.map(m => m.messageId), ...digest.others.flatMap(g => g.items.map(i => i[2]))].sort(), ["dm", "p1", "p3", "pre-join"]);
  assert.equal(digest.query.matched, 4);
  const plain = await hosted("reader", { after: 0, limit: 100 });
  assert.equal(plain.query, undefined);
  assert.ok(plain.messages.some(m => m.messageId === "p2"));
});

test("query is validated: 1 to 80 characters, not blank", () => {
  const ok = args => validRoomToolArguments("room_read_messages", args);
  assert.equal(ok({ query: "deploy" }), true);
  assert.equal(ok({ query: "x".repeat(80) }), true);
  for (const bad of ["", "   ", "x".repeat(81), 7]) assert.equal(ok({ query: bad }), false, JSON.stringify(bad));
});

test("the stdio client returns the same search page as the hosted tool", async t => {
  const { store, keys, hosted } = room(t, "secret deploy keys");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "reader", token: keys.reader });
  const local = await client.roomMessages({ after: 0, limit: 100, query: "deploy" });
  const remote = await hosted("reader", { after: 0, limit: 100, query: "deploy" });
  assert.deepEqual(local.messages.map(m => m.messageId), remote.messages.map(m => m.messageId));
  assert.deepEqual(local.query, remote.query);
});
