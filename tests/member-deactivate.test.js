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
import { setTier } from "../server/autonomy-tiers.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "member-deactivate-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (memberId, displayName) => {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    // Graduated autonomy tiers: the fixture agents are operator-promoted so the
    // deactivation tests exercise them as working agents.
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  };
  add("agent", "Test agent");
  add("agent2", "Second agent");
  const agentKey = store.issueAccessKey("commons", "agent");
  const agent2Key = store.issueAccessKey("commons", "agent2");
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
  return { store, request, origin, ownerKey, agentKey, agent2Key };
}

const deactivate = (request, memberId, token) =>
  request(`/api/rooms/commons/members/${encodeURIComponent(memberId)}`, { method: "DELETE", token });

test("an agent deactivates its own membership via DELETE (RC-2026-09-23)", async t => {
  const { store, request, agentKey } = await serve(t);
  const res = await deactivate(request, "agent", agentKey);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.memberId, "agent");
  assert.equal(body.active, false);
  // The membership is inactive in the projection; history is preserved.
  const member = store.roomAuthority("commons").members.agent;
  assert.equal(member.active, false);
  assert.deepEqual(member.permissions, ["accept_work", "complete_work"]);
  // A second DELETE fails: the deactivated credential no longer authenticates.
  const again = await deactivate(request, "agent", agentKey);
  assert.equal(again.status, 401);
});

test("naming another member is 403 (RC-2026-09-23)", async t => {
  const { request, agentKey } = await serve(t);
  const res = await deactivate(request, "agent2", agentKey);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, "access_denied");
});

test("the owner cannot self-deactivate (RC-2026-09-23)", async t => {
  const { request, ownerKey } = await serve(t);
  const res = await deactivate(request, "owner", ownerKey);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, "owner_cannot_deactivate");
});

test("staleMembers lists active members with no heartbeat in the window (RC-2026-09-23)", async t => {
  const { store } = await serve(t);
  // Both agents were just added (member.added counts as a heartbeat), so
  // nobody is stale in a 30-day window.
  const fresh = store.staleMembers("commons", { days: 30 });
  assert.equal(fresh.stale.length, 0);
  assert.equal(fresh.activeCount, 3);
  // With an explicit now far in the future, all three members are stale.
  const now = Date.now();
  const stale = store.staleMembers("commons", { days: 30, now: now + 31 * 86400000 });
  assert.equal(stale.stale.length, 3);
  assert.deepEqual(stale.stale.map(m => m.memberId).sort(), ["agent", "agent2", "owner"]);
  assert.equal(stale.stale[0].daysSinceSeen, 31);
  // Deactivated members are excluded (only active members are listed).
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "agent", expectedMemberRevision: store.roomAuthority("commons").members.agent.revision,
      permissions: ["accept_work", "complete_work"], active: false } });
  const afterDeactivate = store.staleMembers("commons", { days: 30, now: now + 31 * 86400000 });
  assert.deepEqual(afterDeactivate.stale.map(m => m.memberId).sort(), ["agent2", "owner"]);
});
