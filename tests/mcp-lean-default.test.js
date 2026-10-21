import test from "node:test";
import assert from "node:assert/strict";
import { listedMcpTools } from "../server/mcp-discovery.mjs";

const LEAN = ["room_needs_me", "room_read_messages", "room_post_message", "room_reply", "room_list_work", "room_acquire_claim", "room_release_claim", "room_read_work", "room_begin_work", "room_submit_text_result", "room_record_handoff", "room_propose_work", "room_search", "room_read_many", "room_who", "room_read_request", "room_respond_to_request", "room_check_access", "room_create", "room_join"];

test("lean default lists the 20 room tools first, then the join helpers", () => {
  const names = listedMcpTools("core").map(tool => tool.name);
  assert.deepEqual(names.slice(0, 20), LEAN);
});

test("default list is byte-identical for members, non-members and anonymous callers", () => {
  const anon = JSON.stringify(listedMcpTools("core"));
  const member = JSON.stringify(listedMcpTools("core", false, { memberships: [{ roomId: "a", active: true }] }));
  const outside = JSON.stringify(listedMcpTools("core", false, { memberships: [] }));
  assert.equal(member, anon);
  assert.equal(outside, anon);
});

test("money tools stay out of the default and remain in the full catalog", () => {
  const core = listedMcpTools("core").map(tool => tool.name);
  assert.ok(!core.some(name => /^bounty_|spend/.test(name)));
  assert.ok(listedMcpTools("full").some(tool => tool.name === "bounty_list"));
});

test("room_read_many is read-only and the default stays under 25 KB", () => {
  const core = listedMcpTools("core");
  assert.equal(core.find(tool => tool.name === "room_read_many").annotations.readOnlyHint, true);
  assert.ok(JSON.stringify(core).length < 25000);
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-lean-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms: new AgentRooms(store) };
}

async function call(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { body, value: body.result?.structuredContent };
}

test("room_search pages past the limit, room_read_many batches without side effects, room_who lists members", async t => {
  const { origin, store, rooms } = await serve(t);
  const ada = store.identities.create("Ada");
  rooms.create(ada.secret, { roomId: "lean-den", title: "Lean den", purpose: "Lean tools", kind: "personal", displayName: "Ada" });
  for (let i = 0; i < 7; i += 1) {
    const posted = await call(origin, "room_post_message", { roomId: "lean-den", id: `m${i}`, body: `needle ${i}` }, ada.secret);
    assert.notEqual(posted.body.result.isError, true);
  }
  const first = await call(origin, "room_search", { roomId: "lean-den", query: "needle", limit: 5 }, ada.secret);
  assert.equal(first.value.messages.length, 5);
  assert.equal(first.value.total, 7);
  const second = await call(origin, "room_search", { roomId: "lean-den", query: "needle", limit: 5, cursor: first.value.nextCursor }, ada.secret);
  assert.equal(second.value.messages.length, 2);

  const before = store.room("lean-den").sequence;
  const many = await call(origin, "room_read_many", { roomId: "lean-den", messageIds: ["m1", "m3", "nope"] }, ada.secret);
  assert.deepEqual(many.value.messages.map(m => m.body), ["needle 1", "needle 3"]);
  assert.deepEqual(many.value.missing.messageIds, ["nope"]);
  assert.equal(store.room("lean-den").sequence, before, "read_many appends no event");

  const who = await call(origin, "room_who", { roomId: "lean-den" }, ada.secret);
  assert.notEqual(who.body.result.isError, true);
  assert.ok(JSON.stringify(who.value).includes("Ada"));

  const bad = await call(origin, "room_read_many", { roomId: "lean-den" }, ada.secret);
  assert.ok(bad.body.error || bad.body.result?.isError);
});
