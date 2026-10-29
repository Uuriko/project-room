// room_join starts and polls a pair; a non-member is told to pair; merge is a tool.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { PAIR_POLL_INTERVAL_MS } from "../server/pairing.mjs";

function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-pair-"));
  let now = 1_800_000_000_000;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({
      store, rooms, origin: `http://127.0.0.1:${server.address().port}`,
      advance(ms) { now += ms; }
    });
  }));
}

async function call(origin, name, args, secret) {
  const response = await fetch(origin + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  const text = body.result?.content?.[0]?.text ?? "";
  return { body, value: body.result?.structuredContent, text, isError: body.result?.isError === true };
}

test("room_join pairs, a stranger is not_member, and the owner can merge", async t => {
  const { origin, store, rooms, advance } = await boot(t);
  const owner = store.identities.create("Rowan Hale");
  const room = rooms.create(owner.secret, { roomId: "pair-den", title: "Pair den", purpose: "Pair agents", displayName: "Rowan Hale" });
  const stranger = store.identities.create("Kit Arden");
  const blocked = await call(origin, "room_post_message", { roomId: room.roomId, body: "hello" }, stranger.secret);
  assert.equal(blocked.isError, true);
  assert.equal(blocked.value.code, "not_member");
  assert.equal(blocked.value.next.action, "pair");
  assert.equal(blocked.value.next.roomId, room.roomId);

  const started = await call(origin, "room_join", { roomId: room.roomId, displayName: "Kit Arden" }, stranger.secret);
  assert.equal(started.isError, false, JSON.stringify(started.body));
  assert.match(started.value.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(started.value.deviceSecret, undefined);
  assert.equal(started.text.includes(started.value.userCode), false);
  advance(PAIR_POLL_INTERVAL_MS);
  const waiting = await call(origin, "room_join", { pairId: started.value.pairId }, stranger.secret);
  assert.equal(waiting.isError, true);
  assert.equal(waiting.value.code, "authorization_pending");

  const decided = store.pairing.decide(owner.secret, room.roomId, { pairId: started.value.pairId, decision: "approve", profile: "chat" });
  advance(PAIR_POLL_INTERVAL_MS);
  const joined = await call(origin, "room_join", { pairId: started.value.pairId }, stranger.secret);
  assert.equal(joined.isError, false, JSON.stringify(joined.body));
  assert.equal(joined.value.memberId, decided.memberId);
  assert.equal(typeof joined.value.token, "string");
  assert.equal(joined.text.includes(joined.value.token), false);
  if (joined.value.identitySecret) assert.equal(joined.text.includes(joined.value.identitySecret), false);

  const extra = store.identities.create("Cleo Park");
  const link = store.invites.create(owner.secret, room.roomId, { profile: "contribute" });
  const redeemed = store.invites.redeem(link.code, { displayName: "Cleo Park", identitySecret: extra.secret });
  const merged = await call(origin, "room_merge_members", {
    roomId: room.roomId, keepMemberId: decided.memberId, retireMemberId: redeemed.memberId
  }, owner.secret);
  assert.equal(merged.isError, false, JSON.stringify(merged.body));
  assert.equal(merged.value.retired, true);
  assert.equal(store.room(room.roomId).state.members[redeemed.memberId].active, false);
});
