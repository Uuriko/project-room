// Presence timestamps: event times are ISO strings, host heartbeats are epoch
// ms. presenceState() must treat both the same, or an agent with a registered
// host reads "unreachable" seconds after it posted, and a human who just
// acted never reads "listening".
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presenceState } from "../src/presence-state.js";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const NOW = 1_000_000_000_000;
const min = 60_000;
const iso = ms => new Date(ms).toISOString();

test("presenceState: ISO-string timestamps behave like epoch ms", () => {
  assert.equal(presenceState({
    kind: "agent", hostStatus: "offline", hostLastSeenAt: NOW - 20 * min,
    lastSeenAt: iso(NOW - 1 * min), unreachableAfterMs: 9 * min, now: NOW,
  }), "idle");
  assert.equal(presenceState({
    kind: "agent", hostStatus: "offline", hostLastSeenAt: NOW - 20 * min,
    lastSeenAt: iso(NOW - 20 * min), unreachableAfterMs: 9 * min, now: NOW,
  }), "unreachable");
  assert.equal(presenceState({ kind: "human", lastCommandAt: iso(NOW - 1 * min), now: NOW }), "listening");
  assert.equal(presenceState({
    kind: "agent", hostStatus: "online", hostLastSeenAt: NOW - 1 * min,
    lastCommandAt: iso(NOW - 1 * min), lastSeenAt: iso(NOW - 1 * min), now: NOW,
  }), "working");
  assert.equal(presenceState({ kind: "agent", hostStatus: "offline", lastSeenAt: "not a date", now: NOW }), "unreachable");
});

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-presence-iso-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey: store.issueAccessKey("commons", "owner") };
}

function addHostedAgent(store, ownerKey, { memberId, hostSeenMs, eventAt = null }) {
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work"] },
  });
  if (eventAt) {
    store.db.prepare("UPDATE events SET body=json_set(body,'$.at',?) WHERE room_id=? AND json_extract(body,'$.data.memberId')=?")
      .run(eventAt, "commons", memberId);
  }
  const identityId = `identity-${memberId}`;
  const now = Date.now();
  store.db.prepare("INSERT INTO agent_identities(identity_id, secret_hash, display_name, created_at) VALUES(?,?,?,?)")
    .run(identityId, "hash-placeholder", memberId, now);
  store.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run("commons", identityId, memberId, now);
  store.db.prepare("INSERT INTO agent_hosts(agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(identityId, "host-1", "pull-only", null, hostSeenMs, hostSeenMs, hostSeenMs);
}

test("presence: an agent with a stale host but a fresh event is not unreachable", t => {
  const { store, ownerKey } = serve(t);
  addHostedAgent(store, ownerKey, { memberId: "hosted", hostSeenMs: Date.now() - 20 * min });
  const agent = store.presence(ownerKey, "commons", []).members.find(m => m.memberId === "hosted");
  assert.equal(agent.presence?.status, "offline");
  assert.equal(typeof agent.lastSeenAt, "string", "the API keeps lastSeenAt as an ISO string");
  assert.equal(agent.state, "idle", "member.added just now is a fresh signal");
});

test("presence: an agent whose host and events are both old is unreachable", t => {
  const { store, ownerKey } = serve(t);
  const old = Date.now() - 3 * 60 * min;
  addHostedAgent(store, ownerKey, { memberId: "gone", hostSeenMs: old, eventAt: iso(old) });
  const agent = store.presence(ownerKey, "commons", []).members.find(m => m.memberId === "gone");
  assert.equal(agent.state, "unreachable");
});
