// Phase 2 idle nudge: one wake, no duplicate, backoff, room cap, dry, paused.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import {
  IDLE_NUDGE_REASON,
  IDLE_NUDGE_WINDOW_MS,
  IDLE_NUDGE_ROOM_CAP_PER_HOUR,
  idleNudgeMessageId,
  idleNudgeMeasures,
  maybeIdleNudge,
  noteIdleActivity
} from "../server/idle-nudge.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  let at = Date.now();
  store.now = () => at;
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerKey });
  const call = async (method, path, token, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, value: await response.json() };
  };
  const enroll = async name => {
    const identity = store.identities.create(name);
    const memberId = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
    linkWithProof(store, ownerKey, "commons", identity, { memberId, displayName: name, permissions: ["accept_work", "complete_work"] });
    const beat = await call("POST", "/api/agent-heartbeats", identity.secret, { hostId: "host-1", mode: "pull-only" });
    assert.equal(beat.status, 200);
    const key = store.issueAccessKey("commons", memberId);
    return { ...identity, memberId, key, client: new RoomAgentClient({ origin, roomId: "commons", token: key }) };
  };
  const idleNudges = async agent => {
    const polled = await call("GET", "/api/agent-wakes/poll?hostId=host-1&waitMs=0", agent.secret);
    assert.equal(polled.status, 200);
    return polled.value.pendingWakes.filter(wake => wake.reason === IDLE_NUDGE_REASON);
  };
  const keepOnline = identityId => {
    store.db.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE agent_id=?").run(at, identityId);
  };
  return {
    store, owner, ownerKey, call, enroll, idleNudges, keepOnline,
    now: () => at,
    advance: ms => { at += ms; }
  };
}

function consider(store, roomId, memberId, lastActivityAt) {
  return maybeIdleNudge(store, roomId, memberId, { now: store.now(), lastActivityAt });
}

test("one idle agent with fitting ready work gets one idle_nudge wake", async t => {
  const { store, owner, enroll, idleNudges, now, advance } = await fixture(t);
  const agent = await enroll("Idle Agent");
  await owner.workClaimCreate({ id: "ready-1", title: "Ready one" });
  const lastActivityAt = now() - (IDLE_NUDGE_WINDOW_MS + 60 * 1000);
  noteIdleActivity(store, "commons", agent.memberId, lastActivityAt);
  const result = consider(store, "commons", agent.memberId, lastActivityAt);
  assert.equal(result.nudged, true);
  assert.equal(result.workItemId, "ready-1");
  assert.equal(result.messageId, idleNudgeMessageId(agent.memberId, "ready-1", Math.floor(now() / IDLE_NUDGE_WINDOW_MS) * IDLE_NUDGE_WINDOW_MS));
  const wakes = await idleNudges(agent);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].reason, IDLE_NUDGE_REASON);
  assert.equal(wakes[0].workClaim, "ready-1");
  assert.equal(wakes[0].messageId, result.messageId);
  const measures = idleNudgeMeasures(store, "commons");
  assert.equal(measures.nudgeCount, 1);
  assert.ok(measures.totalIdleMinutes >= 20);
});

test("the same agent is not nudged twice in the same window", async t => {
  const { store, owner, enroll, idleNudges, now } = await fixture(t);
  const agent = await enroll("Once Agent");
  await owner.workClaimCreate({ id: "ready-dup", title: "Ready dup" });
  const lastActivityAt = now() - (IDLE_NUDGE_WINDOW_MS + 60 * 1000);
  assert.equal(consider(store, "commons", agent.memberId, lastActivityAt).nudged, true);
  const again = consider(store, "commons", agent.memberId, lastActivityAt);
  assert.equal(again.nudged, false);
  assert.ok(["already", "pending_wake"].includes(again.skipped), again.skipped);
  assert.equal((await idleNudges(agent)).length, 1);
});

test("an ignored nudge applies exponential backoff before the next one", async t => {
  const { store, owner, enroll, idleNudges, keepOnline, now, advance } = await fixture(t);
  const agent = await enroll("Backoff Agent");
  await owner.workClaimCreate({ id: "ready-back", title: "Ready back" });
  const lastActivityAt = now() - (IDLE_NUDGE_WINDOW_MS + 60 * 1000);
  const firstNudge = consider(store, "commons", agent.memberId, lastActivityAt);
  assert.equal(firstNudge.nudged, true);
  const first = await idleNudges(agent);
  assert.equal(first.length, 1);
  store.agentHeartbeats.ackWakes({ agentId: agent.identityId, signalIds: [first[0].signalId] });
  // The first window has elapsed and the item is still unclaimed: ignored.
  advance(IDLE_NUDGE_WINDOW_MS);
  keepOnline(agent.identityId);
  const duringBackoff = consider(store, "commons", agent.memberId, lastActivityAt);
  assert.equal(duringBackoff.nudged, false);
  assert.equal(duringBackoff.skipped, "backoff");
  // Backoff is 2 * window from the first enqueue, so one more window is still held.
  advance(IDLE_NUDGE_WINDOW_MS - 1000);
  keepOnline(agent.identityId);
  assert.equal(consider(store, "commons", agent.memberId, lastActivityAt).skipped, "backoff");
  advance(2000);
  keepOnline(agent.identityId);
  const later = consider(store, "commons", agent.memberId, lastActivityAt);
  assert.equal(later.nudged, true);
  assert.equal(later.workItemId, "ready-back");
  assert.notEqual(later.messageId, firstNudge.messageId);
  assert.equal((await idleNudges(agent)).length, 1);
});

test("a room-wide hourly cap blocks further nudges", async t => {
  const { store, owner, enroll, now } = await fixture(t);
  const agent = await enroll("Capped Agent");
  await owner.workClaimCreate({ id: "ready-cap", title: "Ready cap" });
  store.db.exec(`CREATE TABLE IF NOT EXISTS idle_nudge_log (
    room_id TEXT NOT NULL, member_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
    window_start INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, idle_minutes INTEGER,
    ignored_count INTEGER NOT NULL DEFAULT 0, backoff_until INTEGER,
    PRIMARY KEY (room_id, member_id, work_item_id, window_start)
  );`);
  const insert = store.db.prepare(`INSERT INTO idle_nudge_log
    (room_id, member_id, work_item_id, window_start, enqueued_at, idle_minutes, ignored_count, backoff_until)
    VALUES (?, ?, ?, ?, ?, 30, 0, NULL)`);
  for (let i = 0; i < IDLE_NUDGE_ROOM_CAP_PER_HOUR; i += 1) {
    insert.run("commons", `prior${i}`, `item-${i}`, now() - 1000, now() - 1000);
  }
  const lastActivityAt = now() - (IDLE_NUDGE_WINDOW_MS + 60 * 1000);
  const result = consider(store, "commons", agent.memberId, lastActivityAt);
  assert.equal(result.nudged, false);
  assert.equal(result.skipped, "room_cap");
});

test("a dry ready-work list does not nudge", async t => {
  const { store, enroll, idleNudges, now } = await fixture(t);
  const agent = await enroll("Dry Agent");
  const lastActivityAt = now() - (IDLE_NUDGE_WINDOW_MS + 60 * 1000);
  const result = consider(store, "commons", agent.memberId, lastActivityAt);
  assert.equal(result.nudged, false);
  assert.equal(result.skipped, "dry");
  assert.equal((await idleNudges(agent)).length, 0);
});

test("a paused agent is not nudged", async t => {
  const { store, owner, ownerKey, enroll, idleNudges, now } = await fixture(t);
  const agent = await enroll("Paused Nudge Agent");
  await owner.workClaimCreate({ id: "ready-paused", title: "Ready paused" });
  store.wakeQueue.pause(ownerKey, "commons", { requestId: randomUUID(), reason: "away" }, null, { memberId: agent.memberId });
  const lastActivityAt = now() - (IDLE_NUDGE_WINDOW_MS + 60 * 1000);
  const result = consider(store, "commons", agent.memberId, lastActivityAt);
  assert.equal(result.nudged, false);
  assert.equal(result.skipped, "paused");
  assert.equal((await idleNudges(agent)).length, 0);
});
