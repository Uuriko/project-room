// STRAT-1: the account create path and the agent room-create path seed the
// same connect card and the same first task. The agent tool cannot take an
// intent, so the shared seed runs on the room it already created.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { seedStarter } from "../server/starter-room.mjs";
import { ROOM_MCP_PUBLIC_URL } from "../src/room-mcp-join.js";
import { CONNECT_HARNESS_LINES, FIRST_TASK_ID, MCP_URL, connectAgentCard, firstTaskAcceptance, firstTaskCard } from "../src/first-room-copy.js";

function signIn(store, accountId) {
  store.createAccount(accountId);
  const key = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  return { token: slot.token, binding: session.sessionBinding, csrf: session.csrf };
}

function cards(store, roomId) {
  const state = store.room(roomId).state;
  const connect = state.messages.find(message => message.id === `mc-${roomId}`);
  const task = state.messages.find(message => message.id === `mt-${roomId}`);
  const claim = store.workClaims.get(roomId, FIRST_TASK_ID);
  return {
    connect: connect?.body ?? null,
    task: task?.body ?? null,
    title: claim?.title ?? null,
    acceptance: claim?.acceptanceCriteria ?? null,
    guide: state.members["room-guide"]?.id ?? null
  };
}

test("a human room and an agent room get the same first-room seed", async t => {
  assert.equal(MCP_URL, ROOM_MCP_PUBLIC_URL);
  assert.deepEqual(CONNECT_HARNESS_LINES.map(line => line[0]), ["Claude Code", "Codex", "Cursor", "Grok"]);
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const answer = "Ship the login fix";
  const session = signIn(fixture.store, "human");
  const response = await fetch(`${origin}/api/account-rooms`, {
    method: "POST",
    headers: {
      Cookie: `account_session=${session.token}`,
      "X-Session-Binding": session.binding,
      "X-CSRF-Token": session.csrf,
      Origin: origin,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      roomId: "human-first", title: answer, purpose: answer, kind: "personal", displayName: "Ada", intent: answer
    })
  });
  const created = await response.json();
  assert.equal(response.status, 201, JSON.stringify(created));
  const identity = fixture.store.identities.create("Room Agent");
  const agent = new AgentRooms(fixture.store).create(identity.secret, {
    roomId: "agent-first", title: answer, purpose: answer, kind: "personal", displayName: "Room Agent", starter: false
  });
  assert.equal(fixture.store.workClaims.list(agent.roomId).length, 0);
  seedStarter(fixture.store, agent.roomId, { intent: answer, ownerMemberId: agent.ownerMemberId });
  const human = cards(fixture.store, "human-first");
  const seeded = cards(fixture.store, agent.roomId);
  assert.deepEqual(seeded, human);
  assert.equal(human.connect, connectAgentCard());
  assert.equal(human.task, firstTaskCard(answer));
  assert.deepEqual(human.acceptance, [firstTaskAcceptance(answer)]);
  assert.equal(human.title, answer);
  assert.equal(human.guide, null);
  assert.equal(human.connect.split(MCP_URL).length - 1, 4);
  assert.deepEqual([...new Set(human.connect.match(/https:\/\/[^\s"]+/g))], [MCP_URL]);
  const before = fixture.store.room(agent.roomId).state.messages.length;
  seedStarter(fixture.store, agent.roomId, { intent: answer, ownerMemberId: agent.ownerMemberId });
  assert.equal(fixture.store.room(agent.roomId).state.messages.length, before);
  assert.equal(fixture.store.workClaims.list(agent.roomId).length, 1);
});
