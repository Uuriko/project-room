// Cursor past the room head is an empty page at the head (#26a).
// work.accepted revisions follow the per-item counter even when the stored
// expectedRevision is missing or disagrees (#26b). A zone-less since/until
// is 400 invalid_time_zone on the REST route and the MCP tool (#27).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { auditWorkHelp } from "../server/work-help.mjs";
import { timeZoneMessage, zoneLessTime, zonedTimestampMillis } from "../server/iso-time.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const EXAMPLE = "2026-10-24T20:30:00Z";
const ZONE_LESS = "2026-10-25T10:00:00";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "cursor-revision-time-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const owner = store.identities.create("Cursor reader");
  const created = rooms.create(owner.secret, { title: "Cursor", purpose: "Read the room", roomId: "cursor-room" });
  const key = store.issueAccessKey(created.roomId, created.ownerMemberId);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const roomId = created.roomId;
  const get = (path, token = key) => fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const call = async (name, args) => {
    const response = await fetch(`${origin}/room/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: { roomId, ...args } } })
    });
    const body = await response.json();
    return { status: response.status, body, value: body.result?.structuredContent, isError: body.result?.isError === true };
  };
  const send = (type, data) => store.command(owner.secret, roomId, { id: randomUUID(), type, data });
  const item = () => store.room(roomId).state.workItems["w-cursor"];
  return { origin, store, roomId, key, owner, get, call, send, item };
}

test("a zone-less timestamp is not an instant, and a zoned one keeps its offset", () => {
  assert.equal(zoneLessTime(ZONE_LESS), true);
  assert.equal(zoneLessTime("2026-10-25"), true);
  assert.equal(zoneLessTime(`${ZONE_LESS}Z`), false);
  assert.equal(zoneLessTime("2026-10-25T10:00:00+00:00"), false);
  assert.match(timeZoneMessage("until"), /until/);
  assert.match(timeZoneMessage("until"), new RegExp(EXAMPLE));
  assert.equal(zonedTimestampMillis("2026-02-31T00:00:00Z"), null);
  assert.equal(zonedTimestampMillis("2026-10-24T20:30:00-07:00"), Date.parse("2026-10-25T03:30:00Z"));
});

test("a cursor past the room head is an empty page at the head", async t => {
  const { store, roomId, get, call, send } = await serve(t);
  send(T.MESSAGE_POSTED, { messageId: "m-cursor", body: "one note" });
  const head = store.room(roomId).sequence;

  const rest = await get(`/api/rooms/${roomId}/events?after=${head + 1}`);
  assert.equal(rest.status, 200);
  const page = await rest.json();
  assert.deepEqual(page.events, []);
  assert.equal(page.next, head);
  assert.equal(page.hasMore, false);

  const atHead = await (await get(`/api/rooms/${roomId}/events?after=${head}`)).json();
  assert.deepEqual(atHead.events, []);
  assert.equal(atHead.next, head);

  const mcp = await call("room_list_events", { after: head + 1, limit: 10 });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.isError, false);
  assert.deepEqual(mcp.value.events, []);
  assert.equal(mcp.value.next, head);
  assert.equal(mcp.value.hasMore, false);

  const brief = await get(`/api/rooms/${roomId}/return-brief?horizon=${head + 1}&after=0`);
  assert.equal(brief.status, 200);
  const body = await brief.json();
  assert.equal(body.history.evaluatedThrough, head);
  assert.deepEqual(body.history.items, []);
  assert.equal(body.history.hasMore, false);
  assert.equal(body.history.continuation, null);
});

test("a zone-less since is invalid_time_zone on REST and MCP", async t => {
  const { origin, roomId, get, call } = await serve(t);
  const events = await get(`/api/rooms/${roomId}/events?since=${ZONE_LESS}`);
  assert.equal(events.status, 400);
  const eventsBody = await events.json();
  assert.equal(eventsBody.error.code, "invalid_time_zone");
  assert.match(eventsBody.error.message, /since/);
  assert.match(eventsBody.error.message, new RegExp(EXAMPLE));

  const mcp = await call("room_list_events", { since: ZONE_LESS });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.isError, true);
  assert.equal(mcp.value.status, 400);
  assert.equal(mcp.value.code, "invalid_time_zone");
  assert.match(mcp.value.message, /since/);

  const feed = await fetch(`${origin}/api/opportunities.json?since=${ZONE_LESS}`);
  assert.equal(feed.status, 400);
  const feedBody = await feed.json();
  assert.equal(feedBody.error.code, "invalid_time_zone");
  assert.match(feedBody.error.message, /since/);
  const zoned = await fetch(`${origin}/api/opportunities.json?since=2026-10-25T10:00:00Z`);
  assert.equal(zoned.status, 200);

  const history = await call("bounty_read_history", { since: ZONE_LESS });
  assert.equal(history.status, 200);
  assert.equal(history.isError, true);
  assert.equal(history.value.status, 400);
  assert.equal(history.value.code, "invalid_time_zone");
  assert.match(history.value.message, /since/);
});

test("work.accepted revisions follow the per-item counter when expectedRevision is missing or tampered", async t => {
  const { store, roomId, owner, get, call, send, item } = await serve(t);
  send(T.WORK_PROPOSED, {
    workItemId: "w-cursor", title: "Read the counter", definitionOfDone: "Revisions stay monotonic",
    accountableMemberId: owner.identityId, mode: "read"
  });
  send(T.WORK_ACCEPTED, { workItemId: "w-cursor" });
  assert.equal(item().revision, 1);
  const posted = send(T.MESSAGE_POSTED, {
    messageId: "draft-1", body: "first draft", workItemId: "w-cursor", packetId: "packet-1", basisRevision: 1
  });

  const rest = await get(`/api/rooms/${roomId}/work-result?workItemId=w-cursor&draftMessageId=${posted.event.data.messageId}`);
  assert.equal(rest.status, 200);
  const draft = await rest.json();
  assert.equal(draft.result.text.proposal.submittedAtRevision, 1);

  const mcp = await call("room_read_result", { workItemId: "w-cursor", draftMessageId: posted.event.data.messageId });
  assert.equal(mcp.isError, false);
  assert.equal(mcp.value.result.text.proposal.submittedAtRevision, item().revision);

  send(T.WORK_HELP_UPDATED, {
    workItemId: "w-cursor", expectedRevision: item().revision, expectedHelpRevision: 0,
    status: "open", scope: "Suggest one item", expiresAt: new Date(Date.now() + 3600000).toISOString()
  });
  send(T.SESSION_STARTED, { workItemId: "w-cursor", expectedRevision: item().revision });
  send(T.SESSION_STOPPED, { workItemId: "w-cursor", expectedRevision: item().revision, status: "failed" });
  assert.equal(item().state, "proposed");
  send(T.WORK_ACCEPTED, { workItemId: "w-cursor", expectedRevision: item().revision });
  assert.equal(item().revision, 4);

  const accepts = () => {
    const history = store.workItemHistory(owner.secret, roomId, "w-cursor");
    return history.changes.filter(change => change.type === T.WORK_ACCEPTED).map(change => change.revision);
  };
  assert.deepEqual(accepts(), [1, 4]);

  const second = store.db.prepare(
    "SELECT sequence, body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? ORDER BY sequence"
  ).all(roomId, T.WORK_ACCEPTED)[1];
  const tampered = JSON.parse(second.body);
  tampered.data.expectedRevision = 0;
  store.db.prepare("UPDATE events SET body=? WHERE room_id=? AND sequence=?").run(JSON.stringify(tampered), roomId, second.sequence);

  assert.deepEqual(accepts(), [1, 4]);
  const changes = await get(`/api/rooms/${roomId}/work-changes?workItemId=w-cursor`);
  assert.equal(changes.status, 200);
  const listed = (await changes.json()).changes.filter(change => change.type === T.WORK_ACCEPTED).map(change => change.revision);
  assert.deepEqual(listed, [1, 4]);

  const rows = store.db.prepare("SELECT sequence, body FROM events WHERE room_id=? ORDER BY sequence").all(roomId);
  assert.doesNotThrow(() => auditWorkHelp(store.room(roomId).state, rows));

  const later = send(T.MESSAGE_POSTED, {
    messageId: "draft-2", body: "second draft", workItemId: "w-cursor", packetId: "packet-2", basisRevision: item().revision
  });
  const again = await get(`/api/rooms/${roomId}/work-result?workItemId=w-cursor&draftMessageId=${later.event.data.messageId}`);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).result.text.proposal.submittedAtRevision, 4);
  const mcpAgain = await call("room_read_result", { workItemId: "w-cursor", draftMessageId: later.event.data.messageId });
  assert.equal(mcpAgain.isError, false);
  assert.equal(mcpAgain.value.result.text.proposal.submittedAtRevision, 4);
});
