import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { claimWork, createWork } from "../server/work-claims.mjs";
import { activityOf, harnessLabel, sessionMatches, sessionsEnabled } from "../server/agent-sessions.mjs";

test("harness, activity, and search stay coarse and case-insensitive", () => {
  assert.equal(harnessLabel("claude-code", "raw-ua-should-not-win"), "Claude Code");
  assert.equal(harnessLabel(null, "Cursor/9 secret-marker-ua"), "Cursor");
  assert.equal(harnessLabel("cline", null), "Cline");
  assert.equal(harnessLabel(null, "unknown-tool/1"), null);
  const hour = 3_600_000;
  const now = 1_700_000_000_000;
  assert.equal(activityOf({ hostStatus: "online", lastActivityAt: now - hour, now }), "active");
  assert.equal(activityOf({ hostStatus: "offline", lastActivityAt: now - 60_000, now }), "active");
  assert.equal(activityOf({ hostStatus: null, lastActivityAt: now - 10 * 60_000, now }), "idle");
  const row = { displayName: "Ada", owner: { displayName: "Room owner" }, harness: "Cursor", claim: { claimId: "door", title: "Fix the door" }, task: { title: "Write the spec" } };
  assert.equal(sessionMatches(row, "CURSOR"), true);
  assert.equal(sessionMatches(row, "door"), true);
  assert.equal(sessionMatches(row, "spec"), true);
  assert.equal(sessionMatches(row, "room owner"), true);
  assert.equal(sessionMatches(row, "zzzz"), false);
  assert.equal(sessionMatches(row, ""), true);
  assert.equal(sessionsEnabled({ featureEnv: {} }, "commons"), false);
  assert.equal(sessionsEnabled({ featureEnv: { ROOM_AGENT_SESSIONS: "off" } }, "commons"), false);
  assert.equal(sessionsEnabled({ featureEnv: { ROOM_AGENT_SESSIONS: "on" } }, "commons"), true);
  assert.equal(sessionsEnabled({ featureEnv: { ROOM_AGENT_SESSIONS: "commons, other" } }, "commons"), true);
  assert.equal(sessionsEnabled({ featureEnv: { ROOM_AGENT_SESSIONS: "other" } }, "commons"), false);
});

async function serve(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  store.featureEnv = { ROOM_AGENT_SESSIONS: "off" };
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const get = async (path, token) => {
    const response = await fetch(origin + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { store, ownerKey, get };
}

function link(store, ownerKey, name, memberId) {
  const identity = store.identities.create(name);
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId, displayName: name, permissions: ["accept_work", "complete_work"],
  });
  setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: store.now() });
  return identity;
}

test("room members and agents read sessions only when the flag is on", async t => {
  const { store, ownerKey, get } = await serve(t);
  const ada = link(store, ownerKey, "Ada", "ada");
  link(store, ownerKey, "Bea", "bea");
  const cara = link(store, ownerKey, "Cara", "cara");
  link(store, ownerKey, "Dee", "dee");
  const removed = store.room("commons").state.members.dee;
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: {
    memberId: "dee", expectedMemberRevision: removed.revision, permissions: [], active: false,
  } });
  store.identities.noteMcpUse(ada.identityId, { ua: "Cursor/9 secret-marker-ua" });
  store.agentHeartbeats.heartbeat({ agentId: ada.identityId, hostId: "ada-host-secret", wakeUrl: "https://hooks.example.test/secret-wake-path" });
  store.agentHeartbeats.heartbeat({ agentId: cara.identityId, hostId: "cara-host-secret", wakeUrl: "https://hooks.example.test/secret-wake-path" });
  store.workClaims.set("commons", claimWork(createWork({ id: "door", title: "Fix the door" }, { now: new Date(), agentId: "owner" }), "ada", { now: new Date() }));
  const workItemId = "spec-1";
  const adaKey = store.issueAccessKey("commons", "ada");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId, title: "Write the spec", definitionOfDone: "Spec posted.", accountableMemberId: "ada", mode: "read",
  } });
  store.command(adaKey, "commons", { id: randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 0 } });
  store.command(adaKey, "commons", { id: randomUUID(), type: T.SESSION_STARTED, data: { workItemId, expectedRevision: 1 } });
  const stranger = store.identities.create("Stranger");

  const off = await get("/api/rooms/commons/agent-sessions", ownerKey);
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.deepEqual(off.body.sessions, []);
  assert.equal(JSON.stringify(off.body).includes("Ada"), false);
  const tooLong = "a".repeat(81);
  const invalid = await get(`/api/rooms/commons/agent-sessions?q=${tooLong}`, ownerKey);
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, "invalid_search");
  const anon = await get("/api/rooms/commons/agent-sessions");
  assert.equal(anon.status, 401);

  store.featureEnv = { ROOM_AGENT_SESSIONS: "on" };
  const denied = await get("/api/rooms/commons/agent-sessions", stranger.secret);
  assert.equal(denied.status, 401);
  const listed = await get("/api/rooms/commons/agent-sessions", ada.secret);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.enabled, true);
  assert.equal(listed.body.truncated, false);
  assert.deepEqual(listed.body.sessions.map(row => row.displayName), ["Ada", "Bea", "Cara"]);
  const byName = Object.fromEntries(listed.body.sessions.map(row => [row.displayName, row]));
  assert.equal(byName.Ada.activity, "active");
  assert.equal(byName.Ada.harness, "Cursor");
  assert.equal(byName.Ada.owner.displayName, "Room owner");
  assert.equal(byName.Ada.owner.memberId, "owner");
  assert.equal(byName.Ada.claim.title, "Fix the door");
  assert.equal(byName.Ada.claim.claimId, "door");
  assert.equal(byName.Ada.task.title, "Write the spec");
  assert.equal(byName.Bea.activity, "idle");
  assert.equal(byName.Bea.harness, null);
  assert.equal(byName.Bea.claim, null);
  assert.equal(byName.Bea.task, null);
  assert.equal(byName.Cara.activity, "active");
  assert.equal(byName.Cara.harness, null);
  assert.equal(byName.Cara.claim, null);
  const text = JSON.stringify(listed.body);
  assert.equal(text.includes("secret-marker-ua"), false);
  assert.equal(text.includes("secret-wake-path"), false);
  assert.equal(text.includes("ada-host-secret"), false);
  assert.equal(text.includes("Dee"), false);
  const cursor = await get("/api/rooms/commons/agent-sessions?q=cursor", ownerKey);
  assert.deepEqual(cursor.body.sessions.map(row => row.memberId), ["ada"]);
  const none = await get("/api/rooms/commons/agent-sessions?q=zzzz", ada.secret);
  assert.deepEqual(none.body.sessions, []);
  const blank = await get("/api/rooms/commons/agent-sessions?q=", ownerKey);
  assert.equal(blank.status, 422);
});
