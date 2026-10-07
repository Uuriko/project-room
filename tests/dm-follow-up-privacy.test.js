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

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-export-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const importNdjson = (token, body, contentType = "application/x-ndjson") =>
    fetch(origin + "/api/rooms/commons/import", {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": contentType },
      body
    });
  return { request, importNdjson, ownerKey, agentKey, store, origin };
}


// SEC-19: edits, deletes, redactions, reactions and pins of a DM follow the
// DM's own visibility. A member who is not a party (the Room owner included)
// gets none of them on /events or in the JSONL and HTML exports.
test("SEC-19: DM follow-up events stay with the two DM parties", async t => {
  const { request, ownerKey, store } = await serve(t);
  const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  for (const [memberId, displayName] of [["alice", "Alice"], ["bob", "Bob"]]) {
    cmd(ownerKey, T.MEMBER_ADDED, { memberId, displayName, kind: "human", permissions: [] });
  }
  const aliceKey = store.issueAccessKey("commons", "alice");
  const bobKey = store.issueAccessKey("commons", "bob");
  store.dmConsents.request("commons", "alice", "bob", "test fixture");
  store.dmConsents.decide("commons", "bob", "alice", "approve");
  cmd(aliceKey, T.MESSAGE_POSTED, { messageId: "dm-kept", body: "first text", toMemberId: "bob" });
  cmd(aliceKey, T.MESSAGE_EDITED, { messageId: "dm-kept", body: "EDITED_DM_TEXT", expectedMessageRevision: 0 });
  cmd(bobKey, T.MESSAGE_REACTION_SET, { messageId: "dm-kept", reaction: "👍", active: true });
  cmd(bobKey, T.MESSAGE_PINNED, { messageId: "dm-kept" });
  cmd(aliceKey, T.MESSAGE_POSTED, { messageId: "dm-gone", body: "to delete", toMemberId: "bob" });
  cmd(aliceKey, T.MESSAGE_DELETED, { messageId: "dm-gone", expectedMessageRevision: 0 });
  cmd(aliceKey, T.MESSAGE_POSTED, { messageId: "public-1", body: "hello room" });

  const followUps = new Set([T.MESSAGE_EDITED, T.MESSAGE_DELETED, T.MESSAGE_REDACTED, T.MESSAGE_REACTION_SET, T.MESSAGE_PINNED]);
  const dmIds = new Set(["dm-kept", "dm-gone"]);
  const leaks = events => events.filter(e => dmIds.has(e?.data?.messageId) || dmIds.has(e?.id)).map(e => e.type);

  const ownerEvents = (await (await request("/api/rooms/commons/events", { token: ownerKey })).json()).events.map(r => r.event);
  assert.deepEqual(leaks(ownerEvents), [], "the owner's /events page has no DM or DM follow-up event");
  assert.ok(ownerEvents.some(e => e?.data?.messageId === "public-1"), "public messages stay visible");

  const jsonl = await (await request("/api/rooms/commons/export", { token: ownerKey })).text();
  const exported = jsonl.trim().split("\n").map(line => JSON.parse(line).event);
  assert.deepEqual(leaks(exported), [], "the owner's JSONL export has no DM follow-up event");
  assert.ok(!jsonl.includes("EDITED_DM_TEXT"), "an edited DM body never reaches the owner's export");

  const html = await (await request("/api/rooms/commons/export?format=html", { token: ownerKey })).text();
  assert.ok(!html.includes("EDITED_DM_TEXT") && !html.includes("dm-kept"), "the HTML export holds no DM trace");

  // The two parties still see the whole conversation.
  for (const key of [aliceKey, bobKey]) {
    const events = (await (await request("/api/rooms/commons/events", { token: key })).json()).events.map(r => r.event);
    const seen = new Set(events.filter(e => dmIds.has(e?.data?.messageId)).map(e => e.type));
    for (const type of followUps) if (type !== T.MESSAGE_REDACTED || seen.has(type)) assert.ok(seen.has(type), `party sees ${type}`);
  }
});

test("dmEventVisibility: follow-ups of a targeted DM are party-only", async t => {
  const { dmEventVisibility } = await import("../server/dm-event-visibility.mjs");
  const messages = [
    { id: "dm-1", authorId: "alice", toMemberId: "bob", body: "secret" },
    { id: "pub-1", authorId: "alice", body: "hello" },
  ];
  const edit = { type: T.MESSAGE_EDITED, actorId: "alice", data: { messageId: "dm-1", body: "EDITED" } };
  const pubEdit = { type: T.MESSAGE_EDITED, actorId: "alice", data: { messageId: "pub-1", body: "fixed" } };
  for (const party of ["alice", "bob"]) {
    assert.equal(dmEventVisibility(party, messages)(edit), true, `${party} sees own DM follow-up`);
  }
  assert.equal(dmEventVisibility("owner", messages)(edit), false, "non-party is denied the DM follow-up");
  assert.equal(dmEventVisibility("owner", messages)(pubEdit), true, "public follow-ups stay visible");
});

test("dmEventVisibility: messages thunk stays lazy until a follow-up is checked", async t => {
  const { dmEventVisibility } = await import("../server/dm-event-visibility.mjs");
  let calls = 0;
  const thunk = () => { calls++; return [{ id: "dm-1", authorId: "alice", toMemberId: "bob" }]; };
  const visible = dmEventVisibility("owner", thunk);
  // Plain posts and non-follow-up events never resolve the projection.
  assert.equal(visible({ type: T.MESSAGE_POSTED, actorId: "alice", data: { messageId: "pub", body: "hi" } }), true);
  assert.equal(visible({ type: "work.proposed", actorId: "alice", data: {} }), true);
  assert.equal(calls, 0, "no projection decode without a follow-up event");
  // The first follow-up check resolves parties exactly once.
  assert.equal(visible({ type: T.MESSAGE_EDITED, actorId: "alice", data: { messageId: "dm-1" } }), false);
  assert.equal(calls, 1);
  assert.equal(visible({ type: T.MESSAGE_DELETED, actorId: "alice", data: { messageId: "dm-1" } }), false);
  assert.equal(calls, 1, "parties are memoized, not re-decoded");
});

test("dmEventVisibility: rows fallback covers DMs from the same event page", async t => {
  const { dmEventVisibility } = await import("../server/dm-event-visibility.mjs");
  const dmPost = { type: T.MESSAGE_POSTED, actorId: "alice", data: { messageId: "dm-new", toMemberId: "bob" }, id: "ev-1" };
  const edit = { type: T.MESSAGE_EDITED, actorId: "alice", data: { messageId: "dm-new", body: "EDITED" } };
  const visible = dmEventVisibility("owner", [], [{ event: dmPost }]);
  assert.equal(visible(edit), false, "follow-up hidden even when the DM is only in the page rows");
  assert.equal(dmEventVisibility("bob", [], [{ event: dmPost }])(edit), true, "the addressed party still sees it");
});
