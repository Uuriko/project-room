import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { accessCommand, parseAccessArgs } from "../cli/commands/access.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body),
});

async function roomWithRequest(t) {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const owner = fixture.store.identities.create("cli owner");
  const roomId = "cli-access";
  assert.equal((await post(origin, "/api/agent-rooms", { roomId, title: "CLI access", purpose: "probe", kind: "personal", displayName: "Owner" }, owner.secret)).status, 201);
  const friend = fixture.store.identities.create("cli friend");
  assert.equal((await post(origin, "/api/access-requests", { roomId, identityId: friend.identityId, displayName: "Friend", requestedPermissions: ["accept_work"], note: null, requestId: "cli-req-1" }, friend.secret)).status, 201);
  return { fixture, env: { ROOM_ORIGIN: origin, ROOM_ID: roomId, PROJECT_ROOM_SECRET: owner.secret }, roomId };
}

test("parseAccessArgs", () => {
  assert.deepEqual(parseAccessArgs([]), { verb: "list", requestId: null, permissions: [], note: null });
  assert.deepEqual(parseAccessArgs(["approve", "r1", "--perm", "accept_work", "--note", "ok"]), { verb: "approve", requestId: "r1", permissions: ["accept_work"], note: "ok" });
  assert.throws(() => parseAccessArgs(["approve"]), /needs a requestId/);
  assert.throws(() => parseAccessArgs(["deny", "r1", "--perm", "x"]), /only applies to approve/);
  assert.throws(() => parseAccessArgs(["grant"]), /room access/);
});

test("room access lists then approves a pending request in one line", async t => {
  const { fixture, env, roomId } = await roomWithRequest(t);
  const lines = [];
  assert.equal(await accessCommand([], { env, out: l => lines.push(l) }), 0);
  assert.match(lines[0], /^cli-req-1  Friend  wants: accept_work/);
  assert.equal(lines.some(l => l.includes(env.PROJECT_ROOM_SECRET)), false, "never prints the secret");
  const done = [];
  assert.equal(await accessCommand(["approve", "cli-req-1"], { env, out: l => done.push(l) }), 0);
  assert.match(done[0], /^Approved /);
  const after = [];
  await accessCommand(["list"], { env, out: l => after.push(l) });
  assert.deepEqual(after, ["No pending access requests."]);
  assert.ok(Object.values(fixture.store.room(roomId).state.members).some(m => m.displayName === "Friend"), "the requester joined");
});

test("room access deny refuses the request", async t => {
  const { env } = await roomWithRequest(t);
  const lines = [];
  assert.equal(await accessCommand(["deny", "cli-req-1", "--note", "not now"], { env, out: l => lines.push(l) }), 0);
  assert.match(lines[0], /^Denied /);
});
