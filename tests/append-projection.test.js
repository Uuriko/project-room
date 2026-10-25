// A message.posted that only appends messages keeps the stored projection
// equal to a full rewrite, including after an edit and a reply request
// (those change more than the message list and must not splice).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { appendMessagesToProjection, projectAppendedMessages, projectionAllowsAppend } from "../server/append-projection.mjs";

function open(t, options) {
  const directory = mkdtempSync(join(tmpdir(), "append-projection-"));
  const store = new RoomStore(join(directory, "room.sqlite"), options);
  store.initialize(initialRoom());
  store.roomFlood = { consume() {} };
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (body, extra = {}, id = crypto.randomUUID()) => store.command(owner, "commons", { id, type: T.MESSAGE_POSTED, data: { messageId: id, body, ...extra } });
  return { store, owner, post };
}

function projection(store) {
  return store.db.prepare("SELECT projection FROM rooms WHERE id=?").get("commons").projection;
}

function assertMatchesStore(store) {
  const text = projection(store);
  const state = store.room("commons").state;
  assert.equal(text, store.storedProjection("commons", state));
  assert.deepEqual(JSON.parse(text).messages.map(message => message.id), state.messages.map(message => message.id));
}

test("the scanner splices only the top-level messages array", () => {
  const added = [{ id: "m", body: 'he said "messages": [1,2] {ok}', note: "line\nsep" }];
  const nested = JSON.stringify({ room: { messages: [1, 2, 3] }, title: 'messages":[', messages: [{ id: "old", body: "keep" }], tail: ["]"] });
  const spliced = appendMessagesToProjection(nested, added);
  const parsed = JSON.parse(spliced);
  assert.deepEqual(parsed.room.messages, [1, 2, 3]);
  assert.deepEqual(parsed.messages, [{ id: "old", body: "keep" }, added[0]]);
  assert.equal(parsed.title, 'messages":[');
  assert.equal(appendMessagesToProjection(nested, []), null);
  assert.equal(appendMessagesToProjection('{"messages": [ ]}', [{ id: "m" }]), null);
  assert.equal(projectionAllowsAppend('{"messages":[],"bodyRef":"abc"}'), false);
  assert.equal(projectionAllowsAppend('{"messages":[],"_nul":1}'), false);
  assert.equal(projectionAllowsAppend('{"messages":[{"_entity":1}]}'), false);
  const empty = appendMessagesToProjection('{"messages":[],"ok":true}', [{ id: "m", tags: ["a", "b"] }]);
  assert.deepEqual(JSON.parse(empty), { messages: [{ id: "m", tags: ["a", "b"] }], ok: true });
  const unicode = appendMessagesToProjection('{"messages":[{"body":"café \\u0000"}]}', [{ body: "snowman \u2603" }]);
  assert.equal(JSON.parse(unicode).messages[1].body, "snowman \u2603");
  const hinted = projectAppendedMessages(nested, added);
  const again = projectAppendedMessages(hinted.text, [{ id: "next", body: "more" }], hinted.messagesEnd);
  assert.equal(again.text, appendMessagesToProjection(hinted.text, [{ id: "next", body: "more" }]));
  assert.equal(again.messagesEnd, hinted.messagesEnd + 1 + JSON.stringify({ id: "next", body: "more" }).length);
  assert.equal(projectAppendedMessages(nested, added, 4).text, hinted.text);
});

test("appended posts, an edit, and a reply request round-trip the stored projection", t => {
  const { store, owner, post } = open(t);
  post("first");
  post("second");
  const threaded = post('third, with "quotes" and messages:[1]');
  assertMatchesStore(store);
  post("channel copy", { replyToId: threaded.event.data.messageId, alsoSendToChannel: true });
  assertMatchesStore(store);
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_EDITED, data: { messageId: threaded.event.data.messageId, body: "edited body", expectedMessageRevision: 0 } });
  assertMatchesStore(store);
  store.command(owner, "commons", { id: "add-human", type: T.MEMBER_ADDED, data: { memberId: "human", displayName: "Human", kind: "human", permissions: [] } });
  const human = store.issueAccessKey("commons", "human");
  store.command(owner, "commons", { id: "ask", type: T.MESSAGE_POSTED, data: { messageId: "ask", body: "Please reply", toMemberId: "human", requestKind: "reply" } });
  assertMatchesStore(store);
  store.command(human, "commons", { id: "follow", type: T.MESSAGE_POSTED, data: { messageId: "follow", body: "Following up", replyToId: "ask" } });
  assertMatchesStore(store);
  const messages = store.room("commons").state.messages;
  assert.ok(messages.some(message => message.body === "edited body"));
  assert.ok(messages.some(message => message.id === "follow"));
  assert.equal(store.room("commons").state.replyRequests.ask.status, "open");
});

test("bodies at rest stay referenced instead of splicing the text back inline", t => {
  const { store, post } = open(t, { bodiesAtRest: true });
  const body = "x".repeat(300);
  post(body);
  post(`${body} again`);
  const text = projection(store);
  assert.equal(text.includes(body), false);
  const messages = store.room("commons").state.messages;
  assert.equal(messages.at(-1).body, `${body} again`);
  assert.equal(messages.at(-2).body, body);
});
