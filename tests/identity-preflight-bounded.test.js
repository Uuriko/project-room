import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";

function fixture(change = value => value) {
  const calls = [];
  const member = { id: "agent", kind: "agent", active: true, revision: 1, permissions: ["steer"] };
  const client = new RoomAgentClient({ origin: "https://room.example", roomId: "muse", memberId: "agent",
    token: "pri_" + "a".repeat(43), fetchImpl: async url => {
      const path = new URL(url).pathname + new URL(url).search; calls.push(path);
      assert.notEqual(path, "/api/rooms/muse", "identity preflight must not request full room history");
      if (path === "/api/rooms/muse?view=work") return Response.json(change({ roomId: "muse", viewerId: "agent",
        state: { room: { ownerId: "owner" }, members: { agent: member } } }));
      if (path === "/api/rooms/muse/assistant") return Response.json({ contractVersion: 1, roomId: "muse", runs: [] });
      throw new Error("Unexpected route: " + path);
    } });
  return { client, calls };
}

test("assistant read uses bounded identity metadata before endpoint", async () => {
  const { client, calls } = fixture();
  await client.assistant();
  assert.deepEqual(calls, ["/api/rooms/muse?view=work", "/api/rooms/muse/assistant"]);
});

test("bounded identity preflight preserves identity, active and admin checks", async () => {
  for (const change of [
    value => ({ ...value, viewerId: "other" }),
    value => ({ ...value, roomId: "other" }),
    value => { value.state.members.agent.active = false; return value; },
    value => { value.state.members.agent.permissions = ["manage_members"]; return value; },
  ]) {
    const { client, calls } = fixture(change);
    await assert.rejects(client.assistant(), { code: "identity_mismatch" });
    assert.equal(calls.length, 1);
  }
});

test("explicit delegated admin remains accepted", async () => {
  const { client } = fixture(value => {
    Object.assign(value.state.members.agent, { permissions: ["manage_members"], delegatedAdmin: true }); return value;
  });
  assert.equal((await client.checkConnection()).status, "credential_accepted");
});
