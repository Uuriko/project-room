import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient, redeemAgentInvite, listAgentRooms } from "../client/room-agent.mjs";

// Independent protocol clients, not claims of execution by model vendors.
test("two people and two enrolled agents share a persistent room without a task", async t => {
  const directory = mkdtempSync(join(tmpdir(), "mixed-room-arrival-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "person-two", displayName: "Second person", kind: "human", permissions: [] } });
  const personKey = store.issueAccessKey("commons", "person-two");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = (token, memberId) => new RoomAgentClient({ origin, roomId: "commons", token, memberId });
  const owner = client(ownerKey), person = client(personKey);
  const enroll = async name => {
    const invite = await owner.createAgentInvite({ profile: "collaborate", displayName: name });
    const identity = await redeemAgentInvite(origin, invite.code, name);
    await assert.rejects(redeemAgentInvite(origin, invite.code, name));
    return identity;
  };
  const a = await enroll("First agent"), b = await enroll("Second agent");
  assert.notEqual(a.identityId, b.identityId);
  // Consent-bound DMs: the first agent's DM to the second needs approval.
  store.dmConsents.request("commons", a.memberId, b.memberId, "test fixture");
  store.dmConsents.decide("commons", b.memberId, a.memberId, "approve");
  const first = client(a.secret, a.memberId), second = client(b.secret, b.memberId);
  for (const [participant, body] of [[owner, "Welcome everyone"], [person, "An idea to discuss"],
    [first, "First perspective"], [second, "Second perspective"]]) await participant.say(body);
  await first.say("Only the second agent should see this", { toMemberId: b.memberId });
  const publicBodies = ["Welcome everyone", "An idea to discuss", "First perspective", "Second perspective"];
  for (const participant of [owner, person]) {
    const snapshot = await participant.snapshot();
    assert.deepEqual(snapshot.state.messages.map(m => m.body), publicBodies);
    assert.equal(Object.keys(snapshot.state.workItems).length, 0);
  }
  const recovered = await listAgentRooms(origin, b.secret);
  assert.deepEqual(recovered.rooms.map(room => room.roomId), ["commons"]);
  const resumed = client(b.secret, b.memberId);
  assert.equal((await resumed.snapshot()).state.messages.at(-1).body, "Only the second agent should see this");
  await resumed.say("Back in the same room");
  assert.equal((await first.snapshot()).state.messages.at(-1).body, "Back in the same room");
  await owner.unlinkIdentity(b.identityId);
  assert.deepEqual((await listAgentRooms(origin, b.secret)).rooms, []);
  await assert.rejects(resumed.snapshot());
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM rooms").get().n, 1);
});
