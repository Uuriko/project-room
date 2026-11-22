import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { agentHeartbeatSchema, wakeListenerLeaseSchema, wakeRoomActivitySchema } from "../server/agent-heartbeats.mjs";
import { workClaimSchema, workClaimInboxIndexSchema } from "../server/work-claim-sqlite.mjs";
import { memberIdleFacts, roomIdleStates, roomMembersForIdle, coarseIdleEntry } from "../server/agent-idle-facts.mjs";

const NOW = Date.parse("2026-11-21T20:00:00Z");
const MIN = 60_000;
const ROOM = "commons";

// A fixture store with the real table DDL the gatherer reads, and a legacy
// (projection) room. No server, no network.
function fixture(t, { members = {}, replyRequests = {} } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, projection TEXT)");
  db.exec("CREATE TABLE identity_links (room_id TEXT NOT NULL, identity_id TEXT NOT NULL, member_id TEXT NOT NULL, linked_at INTEGER NOT NULL, PRIMARY KEY(room_id, identity_id))");
  db.exec("CREATE TABLE current_room_head (room_id TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE wake_queue_pause (room_id TEXT NOT NULL, member_id TEXT NOT NULL, paused_at INTEGER NOT NULL, reason TEXT, PRIMARY KEY(room_id, member_id))");
  db.exec(agentHeartbeatSchema + wakeListenerLeaseSchema + wakeRoomActivitySchema + workClaimSchema + workClaimInboxIndexSchema);
  db.prepare("INSERT INTO rooms VALUES (?, ?)").run(ROOM, JSON.stringify({ members, replyRequests }));
  t.after(() => db.close());
  const link = (memberId, identityId = `ai_${memberId}`) =>
    db.prepare("INSERT INTO identity_links VALUES (?,?,?,?)").run(ROOM, identityId, memberId, NOW - 86_400_000);
  return { db, link };
}

const host = (db, agentId, { hostId = "h", wakeUrl = null, seenAt = NOW - MIN } = {}) =>
  db.prepare("INSERT INTO agent_hosts VALUES (?,?,?,?,?,?,?)").run(agentId, hostId, wakeUrl ? "wakeable" : "pull-only", wakeUrl, seenAt, seenAt, seenAt);
const push = (db, agentId, { url = "https://bot.example/push", suspended = 0, cadence = null } = {}) =>
  db.prepare("INSERT INTO agent_push_configs (agent_id, host_id, cadence_seconds, push_url, push_token, push_suspended, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(agentId, "h", cadence, url, "fixture-not-a-secret", suspended, NOW - MIN);
const lease = (db, agentId, expiresAt, roomKey = "") =>
  db.prepare("INSERT INTO agent_wake_listener_leases (agent_id, room_key, listener_id, fencing_token, lease_expires_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(agentId, roomKey, "l1", "f1", expiresAt, NOW - MIN);
const claim = (db, owner, state, leaseExpiresAt) =>
  db.prepare("INSERT INTO work_claims VALUES (?,?,?,?)").run(ROOM, `c_${owner}_${state}`,
    JSON.stringify({ v: 1, data: { id: `c_${owner}`, owner, state, leaseExpiresAt: leaseExpiresAt && new Date(leaseExpiresAt).toISOString() } }), NOW - 30 * MIN);

test("every agent kind is gathered from existing tables and classified", t => {
  const { db, link } = fixture(t, { members: { potter: { kind: "human" }, muse: { kind: "agent" } } });
  for (const m of ["acp", "hook", "muse", "poller", "silent"]) link(m);
  lease(db, "ai_acp", NOW + 30_000, ROOM);                              // ACP bridge holding a room lease
  host(db, "ai_hook", { wakeUrl: "https://bot.example/wake" }); push(db, "ai_hook"); // webhook bot
  db.prepare("INSERT INTO agent_wake_room_activity VALUES (?,?,?)").run("ai_muse", ROOM, NOW - MIN); // stream handoff reader
  db.prepare("INSERT INTO agent_wake_polls VALUES (?,?)").run("ai_poller", NOW - MIN);             // poller
  const byMember = Object.fromEntries(roomIdleStates(db, ROOM, NOW).map(e => [e.memberId, e]));
  assert.deepEqual(Object.keys(byMember).sort(), ["acp", "hook", "muse", "poller", "potter", "silent"]);
  assert.deepEqual([byMember.acp.kind, byMember.acp.state, byMember.acp.delivery.channel], ["acp", "idle_reachable", "ready_work_wake"]);
  assert.deepEqual([byMember.hook.kind, byMember.hook.state, byMember.hook.delivery.channel], ["webhook", "idle_reachable", "wake_signal_webhook"]);
  assert.deepEqual([byMember.muse.kind, byMember.muse.state, byMember.muse.delivery.channel], ["stream", "idle_reachable", "formal_request"]);
  assert.deepEqual([byMember.poller.kind, byMember.poller.state, byMember.poller.delivery.channel], ["poller", "idle_reachable", "wake_signal"]);
  assert.deepEqual([byMember.potter.kind, byMember.potter.state, byMember.potter.delivery.channel], ["human", "human", null]);
  assert.deepEqual([byMember.silent.state, byMember.silent.reasons[0]], ["idle_unreachable", "no_live_channel"]);
  // The gatherer never returns URL or token values, only booleans.
  const facts = memberIdleFacts(db, ROOM, { memberId: "hook", identityId: "ai_hook", kind: "agent" });
  assert.equal(facts.wakeUrl, true);
  assert.equal(facts.pushUrl, true);
  assert.ok(!JSON.stringify(facts).includes("example"), "no URL leaves the gatherer");
  assert.ok(!JSON.stringify(facts).includes("fixture-not-a-secret"), "push token is never read");
});

test("cloud agents: no table records a launcher yet, so the classifier owns that case", t => {
  const { db, link } = fixture(t);
  link("cloud");
  const facts = memberIdleFacts(db, ROOM, { memberId: "cloud", identityId: "ai_cloud", kind: "agent" });
  assert.equal(facts.cloudLauncher, undefined, "gatherer does not invent a launcher fact");
  const entry = roomIdleStates(db, ROOM, NOW)[0];
  assert.equal(entry.state, "idle_unreachable");
});

test("unreachable reasons: webhook_suspended, listener_expired, no_live_channel", t => {
  const { db, link } = fixture(t);
  for (const m of ["suspended", "expired", "stale"]) link(m);
  host(db, "ai_suspended", { seenAt: NOW - 3_600_000 }); push(db, "ai_suspended", { suspended: 1 });
  lease(db, "ai_expired", NOW - MIN);
  db.prepare("INSERT INTO agent_wake_polls VALUES (?,?)").run("ai_stale", NOW - 3_600_000);
  const byMember = Object.fromEntries(roomIdleStates(db, ROOM, NOW).map(e => [e.memberId, e]));
  assert.deepEqual(byMember.suspended.reasons, ["webhook_suspended"]);
  assert.deepEqual(byMember.expired.reasons, ["listener_expired"]);
  assert.deepEqual(byMember.stale.reasons, ["no_live_channel"]);
  for (const e of Object.values(byMember)) assert.equal(e.delivery.ownerLine, true);
  assert.deepEqual(coarseIdleEntry(byMember.suspended), { state: "idle_unreachable", kind: "webhook", needsOwner: "webhook_suspended" });
});

test("working and sleeping come from claims, open requests, unacked wakes and pauses", t => {
  const { db, link } = fixture(t, { replyRequests: {
    r1: { recipientId: "asked", status: "open" }, r2: { recipientId: "done", status: "answered" } } });
  for (const m of ["claimer", "lapsed", "asked", "done", "woken", "paused"]) { link(m); db.prepare("INSERT INTO agent_wake_polls VALUES (?,?)").run(`ai_${m}`, NOW - MIN); }
  claim(db, "claimer", "in_progress", NOW + 10 * MIN);
  claim(db, "lapsed", "claimed", NOW - MIN);
  claim(db, "lapsed", "done", null);
  db.prepare("INSERT INTO agent_wake_signals VALUES (?,?,?,?,?,?,?)").run("s1", "ai_woken", "mention", ROOM, "m1", NOW - MIN, null);
  db.prepare("INSERT INTO agent_wake_signals VALUES (?,?,?,?,?,?,?)").run("s2", "ai_woken", "mention", "elsewhere", "m2", NOW - MIN, null);
  db.prepare("INSERT INTO wake_queue_pause VALUES (?,?,?,?)").run(ROOM, "paused", NOW - MIN, "owner");
  const byMember = Object.fromEntries(roomIdleStates(db, ROOM, NOW).map(e => [e.memberId, e]));
  assert.deepEqual([byMember.claimer.state, byMember.claimer.reasons], ["working", ["open_claim"]]);
  assert.equal(byMember.lapsed.state, "idle_reachable", "an expired claim lease is not in-flight work");
  assert.deepEqual([byMember.asked.state, byMember.asked.reasons], ["working", ["open_request"]]);
  assert.equal(byMember.done.state, "idle_reachable", "answered requests do not count");
  assert.deepEqual([byMember.woken.state, byMember.woken.reasons], ["working", ["unacked_wake"]]);
  assert.equal(memberIdleFacts(db, ROOM, { memberId: "woken", identityId: "ai_woken", kind: "agent" }).unackedWakes, 1, "other rooms' wakes are not counted");
  assert.equal(byMember.paused.state, "sleeping");
  assert.equal(coarseIdleEntry(byMember.claimer).needsOwner, undefined);
});

test("missing optional tables read as no facts, never an error", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, projection TEXT); CREATE TABLE current_room_head (room_id TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE identity_links (room_id TEXT, identity_id TEXT, member_id TEXT, linked_at INTEGER)");
  db.prepare("INSERT INTO rooms VALUES (?, '{}')").run(ROOM);
  db.prepare("INSERT INTO identity_links VALUES (?,?,?,?)").run(ROOM, "ai_x", "x", NOW);
  assert.deepEqual(roomMembersForIdle(db, ROOM).map(m => m.memberId), ["x"]);
  const [entry] = roomIdleStates(db, ROOM, NOW);
  assert.deepEqual([entry.state, entry.reasons[0]], ["idle_unreachable", "no_live_channel"]);
});

test("current-format rooms read open requests and human members from current_room_records", t => {
  const { db, link } = fixture(t);
  db.prepare("INSERT INTO current_room_head VALUES (?)").run(ROOM);
  db.exec("CREATE TABLE current_room_records (room_id TEXT, domain TEXT, record_key TEXT, payload TEXT, PRIMARY KEY(room_id, domain, record_key))");
  const record = (domain, key, payload) => db.prepare("INSERT INTO current_room_records VALUES (?,?,?,?)").run(ROOM, domain, key, JSON.stringify(payload));
  record("members", "ann", { kind: "human" });
  record("members", "gone", { kind: "human", active: false });
  record("replyRequests", "r1", { recipientId: "asked", status: "open" });
  link("asked");
  db.prepare("INSERT INTO agent_wake_polls VALUES (?,?)").run("ai_asked", NOW - MIN);
  const byMember = Object.fromEntries(roomIdleStates(db, ROOM, NOW).map(e => [e.memberId, e]));
  assert.deepEqual(Object.keys(byMember).sort(), ["ann", "asked"]);
  assert.equal(byMember.ann.state, "human");
  assert.deepEqual(byMember.asked.reasons, ["open_request"]);
});
