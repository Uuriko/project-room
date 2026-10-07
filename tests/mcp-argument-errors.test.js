// F2 audit: tools/call invalid_arguments must name the offending field even
// when the rejection comes from a gate-only constraint the JSON schema cannot
// express (validRoomArgs in server/mcp-room-profile.mjs). The generic
// {"arguments": "does not match the tool input"} tells an agent nothing about
// which field to fix. Owner boundary: the HTTP JSON-RPC reply of
// POST /room/mcp tools/call (server/mcp-room-profile.mjs argumentFailure).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-argument-errors-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms });
  }));
}

function rpc(origin, method, params, secret) {
  return fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) })
  });
}

async function call(origin, name, args, secret) {
  const body = await (await rpc(origin, "tools/call", { name, arguments: args }, secret)).json();
  return body;
}

async function ownerInRoom(t) {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Argument owner");
  rooms.create(owner.secret, {
    roomId: "arg-den", title: "Argument den", purpose: "Argument errors", kind: "personal", displayName: "Argument owner"
  });
  return { origin, secret: owner.secret };
}

test("room_needs_me names since when it is neither an integer nor a cursor object", async t => {
  const { origin, secret } = await ownerInRoom(t);
  for (const since of ["yesterday", -5, 1.5]) {
    const body = await call(origin, "room_needs_me", { since }, secret);
    assert.equal(body.error.code, -32602, `since=${JSON.stringify(since)}`);
    assert.equal(body.error.data.reason, "invalid_arguments");
    assert.ok(body.error.data.invalid.since, `since=${JSON.stringify(since)} names the field: ${JSON.stringify(body.error.data.invalid)}`);
  }
});

test("room_create_agent_invite names the missing scope choice", async t => {
  const { origin, secret } = await ownerInRoom(t);
  const body = await call(origin, "room_create_agent_invite", { roomId: "arg-den" }, secret);
  assert.equal(body.error.code, -32602);
  assert.equal(body.error.data.reason, "invalid_arguments");
  assert.ok(body.error.data.invalid.profile, `names the field: ${JSON.stringify(body.error.data.invalid)}`);
});

test("room_join names the exactly-one-token rule", async t => {
  const { origin, secret } = await ownerInRoom(t);
  for (const args of [{ linkToken: "a", inviteCode: "b" }, {}]) {
    const body = await call(origin, "room_join", args, secret);
    assert.equal(body.error.code, -32602, JSON.stringify(args));
    assert.equal(body.error.data.reason, "invalid_arguments");
    const invalid = body.error.data.invalid;
    assert.ok(invalid.linkToken || invalid.inviteCode, `names a token field: ${JSON.stringify(invalid)}`);
  }
});

test("room_create names blank required text", async t => {
  const { origin, secret } = await ownerInRoom(t);
  const body = await call(origin, "room_create", { title: "   ", purpose: "x" }, secret);
  assert.equal(body.error.code, -32602);
  assert.equal(body.error.data.reason, "invalid_arguments");
  assert.ok(body.error.data.invalid.title, `names the field: ${JSON.stringify(body.error.data.invalid)}`);
});

test("schema-expressible violations keep their existing field reasons", async t => {
  const { origin, secret } = await ownerInRoom(t);
  const wrongType = await call(origin, "room_post_message", { roomId: "arg-den", body: 42 }, secret);
  assert.equal(wrongType.error.data.invalid.body, "wrong type");
  const missing = await call(origin, "room_post_message", { roomId: "arg-den" }, secret);
  assert.deepEqual(missing.error.data.missing, ["body"]);
  const unexpected = await call(origin, "room_react", { roomId: "arg-den", messageId: "m", reaction: "x", zzz: 1 }, secret);
  assert.deepEqual(unexpected.error.data.unexpected, ["zzz"]);
});
