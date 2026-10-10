// FIX-67 (WAVE-300 ranked-fixes): presence-online derived server-side from
// recent authenticated activity.
//
// API agents never open SSE (watching:false) and heartbeat_set is opt-in, so
// a hostless agent doing real work used to read presence:null on /presence
// even seconds after acting. Every authenticated command is server-journaled
// with actorId = the acting member and a server timestamp, so recent activity
// is a server-side liveness proof — no client-reported heartbeat is trusted.
// The derivation decays on the default host reachability window
// (HEARTBEAT_STALE_AFTER_MS = 180s): the same schedule as a host that stops
// heartbeating. (Hosts with a declared cadence decay at max(180s,
// cadence*1.5) — e.g. ~3.5 min for a 140s cadence, the QA sample.)
//
// Pinned here:
// - an agent with a recent authenticated command reads
//   presence:{status:"online"} with no SSE watcher and no registered host;
// - the derivation decays at the 180s TTL (online at +180s, null past it);
// - a work-claim renew (the FIX-2 heartbeat path) also counts as activity;
// - state semantics are untouched: no live connection still reads "idle",
//   and humans keep presence:null (the field stays agent-only).
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
import { HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-presence-activity-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  // Hostless agent: no identity link, no host heartbeat, never opens SSE.
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent",
      permissions: ["accept_work", "complete_work"] } });
  const agentKey = store.issueAccessKey("commons", "agent");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, token) => fetch(`${origin}/api/rooms/commons/${path}`, {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10000),
  });
  const presenceOf = memberId =>
    store.presence(ownerKey, "commons", []).members.find(m => m.memberId === memberId);
  return { store, post, ownerKey, agentKey, presenceOf };
}

test("agent with a recent authenticated command reads presence online with no SSE watcher and no host", async t => {
  const { post, agentKey, presenceOf } = await serve(t);
  // Baseline: enrollment is not activity — fresh hostless agent stays null.
  const before = presenceOf("agent");
  assert.equal(before.presence, null);
  assert.equal(before.watching, false);
  assert.equal(before.state, "unknown");

  const said = await post("commands",
    { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: "still here" } },
    agentKey);
  assert.equal(said.status, 201);

  const agent = presenceOf("agent");
  assert.equal(agent.watching, false, "API agents never open SSE");
  assert.ok(agent.presence, "recent authenticated activity must derive presence");
  assert.equal(agent.presence.status, "online");
  assert.ok(typeof agent.presence.lastSeenAt === "number" && agent.presence.lastSeenAt > 0);
  // State semantics are untouched: no live host/SSE connection still reads
  // "idle" (recent activity without a live connection), not "listening".
  assert.equal(agent.state, "idle");

  // Humans keep presence:null — the field stays agent-only.
  assert.equal(presenceOf("owner").presence, null);
});

test("activity-derived online decays at the host heartbeat TTL (180s)", async t => {
  const { store, post, agentKey, presenceOf } = await serve(t);
  const said = await post("commands",
    { id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: "ping" } },
    agentKey);
  assert.equal(said.status, 201);
  assert.equal(HEARTBEAT_STALE_AFTER_MS, 180_000, "TTL under test is the host decay default");
  // Pin the boundary to the server-recorded activity timestamp (the event's
  // own `at`), not the test's wall clock: the TTL is exact on that axis.
  const activityAt = presenceOf("agent").presence.lastSeenAt;
  assert.ok(typeof activityAt === "number" && activityAt > 0);

  store.now = () => activityAt + HEARTBEAT_STALE_AFTER_MS;
  assert.equal(presenceOf("agent").presence?.status, "online", "online at exactly the TTL boundary");

  store.now = () => activityAt + HEARTBEAT_STALE_AFTER_MS + 1;
  const stale = presenceOf("agent");
  assert.equal(stale.presence, null, "past the TTL the agent reads offline again");
  assert.notEqual(stale.state, "listening");
});

test("a work-claim renew (the heartbeat path) counts as authenticated activity", async t => {
  const { post, agentKey, presenceOf } = await serve(t);
  assert.equal(presenceOf("agent").presence, null);

  const made = await post("work-claims", { id: "fix67-hb" }, agentKey);
  assert.equal(made.status, 201);
  const claimed = await post("work-claims/fix67-hb/claim", { leaseHours: 1 }, agentKey);
  assert.equal(claimed.status, 200);
  const renewed = await post("work-claims/fix67-hb/renew", {}, agentKey);
  assert.equal(renewed.status, 200);

  const agent = presenceOf("agent");
  assert.equal(agent.presence?.status, "online", "renew is server-timestamped activity");
});
