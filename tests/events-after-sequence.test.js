import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { agentErrorBody, validAgentNext } from "../src/agent-error.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-after-sequence-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // cursor tests exercise it as a posting member.
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, token = agentKey) => fetch(origin + path, {
    headers: { Origin: origin, Authorization: `Bearer ${token}` }
  });
  const post = (body, token = agentKey) => store.command(token, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: body });
  return { request, post, agentKey };
}

test("events?afterSequence= is refused and names after", async t => {
  const { request, post } = await serve(t);
  post({ messageId: "m1", body: "first" });
  const marked = post({ messageId: "m2", body: "second" });
  post({ messageId: "m3", body: "third" });

  const refused = await request(`/api/rooms/commons/events?afterSequence=${marked.sequence}`);
  const body = await refused.json();
  assert.equal(refused.status, 422);
  assert.equal(body.error.code, "invalid_event_cursor");
  assert.match(body.error.message, /query parameter after/);
  assert.match(body.error.message, /not afterSequence/);
  assert.match(body.hint, /after, not afterSequence/);
  assert.match(body.hint, /not caught up/);
  assert.equal(body.reason, "invalid_event_cursor");
  assert.ok(validAgentNext(body.next));
  assert.ok(body.next.some(step => step.path === "/api/rooms/commons/events?after=0&limit=100"));
  assert.equal(JSON.stringify(body).includes("first"), false, "a refused cursor does not return the log");

  const both = await request(`/api/rooms/commons/events?after=${marked.sequence}&afterSequence=${marked.sequence}`);
  assert.equal(both.status, 422);
  assert.equal((await both.json()).error.code, "invalid_event_cursor");

  const page = await (await request(`/api/rooms/commons/events?after=${marked.sequence}&limit=100`)).json();
  assert.ok(page.events.every(row => row.sequence > marked.sequence));
  assert.ok(page.events.some(row => row.event.data.messageId === "m3"));
  assert.equal(page.events.some(row => row.event.data.messageId === "m1"), false);
});

test("invalid_event_cursor hint stays short and followable", () => {
  const body = agentErrorBody({
    httpStatus: 422, code: "invalid_event_cursor", roomId: "commons",
    message: "events uses the query parameter after (a sequence number), not afterSequence."
  });
  assert.equal(body.reason, "invalid_event_cursor");
  assert.ok(body.hint.length < 160);
  assert.match(body.hint, /not afterSequence/);
  assert.ok(validAgentNext(body.next));
});
