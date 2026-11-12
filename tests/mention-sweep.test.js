// Zero-drop tier 1b: the scheduled sweep. The re-wake (#6147) used to run only
// when someone read the room; the jobs registry now calls
// store.sweepExpiredMentions() on its existing cadence, so a mention nobody
// acknowledged is re-woken even in a room nobody reads. Real wake fabric, no stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { jobByName, jobEnabled, jobNextDue } from "../server/jobs.mjs";
import { createTestClock } from "./helpers/test-clock.mjs";

function setup(t) {
  const f = createAcceptanceFixture(), clock = createTestClock(f.store.now());
  f.store.now = clock.now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "zd-enroll", memberId: "zd-agent", displayName: "Scout", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  setTier(f.store.db, "commons", "zd-agent", "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  const identity = f.store.identities.create("Scout");
  f.store.db.prepare("INSERT INTO identity_links (room_id,identity_id,member_id,linked_at) VALUES('commons',?,?,?)")
    .run(identity.identityId, "zd-agent", clock.now());
  // A registered host: the only precondition for a durable wake signal.
  f.store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "scout-host", mode: "wakeable", wakeUrl: "https://scout.example.test/wake" });
  return { f, token, clock, identityId: identity.identityId };
}
const say = (f, key, data) => f.store.command(key, "commons", { id: randomUUID(), type: "message.posted", data });
const eventIdOf = (f, messageId) => f.store.db.prepare("SELECT id FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(messageId).id;
const setDeadline = (f, messageId, at) => f.store.db.prepare("UPDATE mention_states SET timeout_at=? WHERE room_id='commons' AND message_event_id=?").run(at, eventIdOf(f, messageId));
const mentionWakes = (f, identityId) => f.store.agentHeartbeats.pendingWakes(identityId).filter(row => row.kind === "mention");


const rewakes = (f, identityId) => mentionWakes(f, identityId).filter(row => row.messageId.startsWith("rewake:"));

test("the sweep re-wakes an unacknowledged mention with no room read, exactly once", t => {
  const { f, clock, identityId } = setup(t);
  say(f, f.keys.owner, { messageId: "q1", body: "@Scout please look" });
  setDeadline(f, "q1", clock.now() + 1000);
  assert.deepEqual(f.store.sweepExpiredMentions(), { rooms: 0, flipped: 0 }, "nothing before the deadline");
  clock.advance(1001);
  assert.deepEqual(f.store.sweepExpiredMentions(), { rooms: 1, flipped: 1 });
  assert.deepEqual(rewakes(f, identityId).map(row => row.messageId), [`rewake:${eventIdOf(f, "q1")}`]);
  // Idempotent: a second sweep, and a later room read, add nothing.
  assert.deepEqual(f.store.sweepExpiredMentions(), { rooms: 0, flipped: 0 });
  f.store.eventsAfter(f.keys.owner, "commons", 0, 5);
  assert.equal(rewakes(f, identityId).length, 1);
});

test("the sweep skips acknowledged mentions and is bounded per tick", t => {
  const { f, token, clock, identityId } = setup(t);
  say(f, f.keys.owner, { messageId: "seen", body: "@Scout seen" });
  say(f, f.keys.owner, { messageId: "unseen", body: "@Scout unseen" });
  f.store.acknowledgeMention(token, "commons", eventIdOf(f, "seen"));
  for (const id of ["seen", "unseen"]) setDeadline(f, id, clock.now() + 1000);
  clock.advance(1001);
  f.store.sweepExpiredMentions({ limit: 1 });
  assert.deepEqual(rewakes(f, identityId).map(row => row.messageId), [`rewake:${eventIdOf(f, "unseen")}`]);
  // A limit below 1 still makes progress and a huge limit is capped.
  assert.doesNotThrow(() => { f.store.sweepExpiredMentions({ limit: 0 }); f.store.sweepExpiredMentions({ limit: 1e9 }); });
});

test("the jobs registry schedules and runs the sweep, and stays idle with nothing waiting", async t => {
  const { f, clock, identityId } = setup(t);
  const job = jobByName("webhook-dispatch");
  assert.equal(f.store.nextMentionSweepAt(), null);
  say(f, f.keys.owner, { messageId: "j1", body: "@Scout please" });
  const deadline = clock.now() + 60000;
  setDeadline(f, "j1", deadline);
  assert.equal(f.store.nextMentionSweepAt(), deadline);
  assert.equal(jobEnabled(job, {}, f.store), true, "a pending mention keeps the job armed");
  assert.equal(jobNextDue(job, f.store, clock.now(), 0), deadline);
  clock.advance(60001);
  await job.run(f.store, {});
  assert.equal(rewakes(f, identityId).length, 1, "the job ran the sweep");
  assert.equal(f.store.nextMentionSweepAt(), null, "terminal: nothing left to wake for");
  await job.run(f.store, {});
  assert.equal(rewakes(f, identityId).length, 1);
});

// #6160 follow-up (Dot's method-level specimens): overflow, a throwing re-wake
// and a failing room must not lose or starve mentions.
test("51 overdue mentions: the first tick wakes 50 and leaves the 51st due, the next tick wakes it", t => {
  const { f, clock, identityId } = setup(t);
  const due = clock.now() + 200000;
  for (let i = 0; i < 51; i++) { clock.advance(2100); say(f, f.keys.owner, { messageId: `o${i}`, body: `@Scout item ${i}` }); setDeadline(f, `o${i}`, due + i); }
  clock.advance(due - clock.now() + 1000);
  f.store.agentHeartbeats.heartbeat({ agentId: identityId, hostId: "scout-host", mode: "wakeable", wakeUrl: "https://scout.example.test/wake" });
  const rewakeCount = () => f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signals WHERE agent_id=? AND message_id LIKE 'rewake:%'").get(identityId).n;
  f.store.sweepExpiredMentions();
  assert.equal(rewakeCount(), 50);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM mention_states WHERE state='delivered'").get().n, 1, "the overflow row is still delivered and due");
  assert.notEqual(f.store.nextMentionSweepAt(), null);
  f.store.sweepExpiredMentions();
  assert.equal(rewakeCount(), 51, "nothing was dropped");
  assert.equal(f.store.nextMentionSweepAt(), null);
});

test("a throwing re-wake keeps the mention retryable and is retried once the backoff passes", t => {
  const { f, clock, identityId } = setup(t);
  say(f, f.keys.owner, { messageId: "r1", body: "@Scout please" });
  setDeadline(f, "r1", clock.now() + 1000);
  clock.advance(1001);
  const real = f.store.rewakeTimedOutMention.bind(f.store);
  let boom = true;
  f.store.rewakeTimedOutMention = (...args) => { if (boom) throw new Error("wake backend down"); return real(...args); };
  f.store.sweepExpiredMentions();
  assert.equal(f.store.db.prepare("SELECT state FROM mention_states").get().state, "delivered", "not terminal after a failed re-wake");
  assert.equal(rewakes(f, identityId).length, 0);
  boom = false;
  f.store.sweepExpiredMentions();
  assert.equal(rewakes(f, identityId).length, 0, "still inside the retry backoff");
  clock.advance(5 * 60 * 1000 + 1);
  f.store.sweepExpiredMentions();
  assert.equal(rewakes(f, identityId).length, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM mention_states").get().state, "timed_out");
});

test("a room that keeps failing cannot starve later rooms", t => {
  const { f, clock, identityId } = setup(t);
  say(f, f.keys.owner, { messageId: "good", body: "@Scout please" });
  setDeadline(f, "good", clock.now() + 2000);
  const goodEvent = eventIdOf(f, "good");
  // A due row in a room that sorts first and whose flip always throws.
  f.store.db.exec("PRAGMA foreign_keys=OFF");
  f.store.db.prepare("INSERT INTO mention_states(room_id,message_event_id,mentioned_member_id,state,created_at,timeout_at) VALUES('aaa-broken','e1','m1','delivered',0,?)").run(clock.now() + 1000);
  clock.advance(2500);
  const real = f.store.flipExpiredMentions.bind(f.store);
  f.store.flipExpiredMentions = (roomId, nowMs) => { if (roomId === "aaa-broken") throw new Error("poisoned room"); return real(roomId, nowMs); };
  f.store.sweepExpiredMentions({ limit: 1 });
  f.store.sweepExpiredMentions({ limit: 1 });
  assert.deepEqual(rewakes(f, identityId).map(row => row.messageId), [`rewake:${goodEvent}`], "the healthy room was reached on a later tick");
});
