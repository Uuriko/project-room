// Who may approve a pair, and which grants a pair can carry.
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

function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-pair-auth-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (memberId, displayName, permissions) => {
    store.command(ownerKey, "commons", {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName, kind: "agent", permissions }
    });
    return store.mintAccessKey("commons", memberId);
  };
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ store, ownerKey, add, origin: `http://127.0.0.1:${server.address().port}` });
  }));
}

async function post(origin, path, body, token) {
  const res = await fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

test("invite_member can approve and a stranger cannot", async t => {
  const { origin, add, store } = await boot(t);
  const inviter = add("inviter", "Invite Agent", ["invite_member"]);
  const started = await post(origin, "/api/pair", { room: "commons", name: "New Agent" });
  const stranger = await post(origin, `/api/rooms/commons/pairs/${started.json.pairId}/decide`, { decision: "approve" });
  assert.equal(stranger.status, 401);
  const approved = await post(origin, `/api/rooms/commons/pairs/${started.json.pairId}/decide`, { decision: "approve", profile: "chat" }, inviter);
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const member = approved.json.memberId;
  assert.ok(member);
  assert.equal(approved.json.connection.permissions, undefined);
  const joined = store.room("commons").state.members[member];
  assert.equal(joined.kind, "agent");
  assert.ok(!joined.permissions.includes("manage_members"));
  assert.ok(!joined.permissions.includes("decide"));
  assert.ok(!joined.permissions.includes("invite_member"));
});

test("a pair cannot be approved with an unknown profile", async t => {
  const { origin, ownerKey } = await boot(t);
  const started = await post(origin, "/api/pair", { room: "commons", name: "Profile Agent" });
  const refused = await post(origin, `/api/rooms/commons/pairs/${started.json.pairId}/decide`, { decision: "approve", profile: "owner" }, ownerKey);
  assert.equal(refused.status, 422);
});
