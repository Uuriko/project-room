// Zero-drop tier 1: a mention that was delivered but never acknowledged by its
// deadline gets exactly one fresh wake signal. Acknowledged or answered
// mentions are not re-woken, and re-reading never repeats it.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { createTestClock } from "./helpers/test-clock.mjs";

function setup(t) {
  const f = createAcceptanceFixture(), clock = createTestClock(f.store.now());
  f.store.now = clock.now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "rewake-enroll", memberId: "rewake-agent", displayName: "Scout", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  setTier(f.store.db, "commons", "rewake-agent", "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  const identity = f.store.identities.create("Scout");
  f.store.db.prepare("INSERT INTO identity_links (room_id,identity_id,member_id,linked_at) VALUES('commons',?,?,?)")
    .run(identity.identityId, "rewake-agent", clock.now());
  const wakes = [], pings = [];
  f.store.agentHeartbeats.wakeIfOffline = args => { wakes.push(args); return { woken: true, signal: { signalId: `sig-${wakes.length}`, ...args } }; };
  f.store.agentPlugin.deliverWakePing = args => { pings.push(args); return { deliveries: [] }; };
  f.store.agentHeartbeats.pushNotify = () => {};
  return { f, token, clock, identityId: identity.identityId, wakes, pings };
}
const say = (f, key, data) => f.store.command(key, "commons", { id: randomUUID(), type: "message.posted", data });
const eventIdOf = (f, messageId) => f.store.db.prepare("SELECT id FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(messageId).id;
const setDeadline = (f, messageId, at) => f.store.db.prepare("UPDATE mention_states SET timeout_at=? WHERE room_id='commons' AND message_event_id=?").run(at, eventIdOf(f, messageId));

test("an unacknowledged mention is re-woken once at its deadline", t => {
  const { f, clock, identityId, wakes, pings } = setup(t);
  say(f, f.keys.owner, { messageId: "unseen", body: "@Scout can you take this?" });
  wakes.length = 0; pings.length = 0; // the original wake is not under test
  setDeadline(f, "unseen", clock.now() + 1000);
  f.store.flipExpiredMentions("commons");
  assert.equal(wakes.length, 0, "nothing before the deadline");
  clock.advance(1001);
  f.store.flipExpiredMentions("commons");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].agentId, identityId);
  assert.equal(wakes[0].kind, "mention");
  assert.equal(wakes[0].messageId, `rewake:${eventIdOf(f, "unseen")}`, "distinct coalescing key so the first (acked) signal does not swallow it");
  assert.equal(pings.length, 1);
  f.store.flipExpiredMentions("commons");
  f.store.flipExpiredMentions("commons");
  assert.equal(wakes.length, 1, "terminal after the flip; re-reading never repeats it");
});

test("acknowledged and answered mentions are not re-woken", t => {
  const { f, token, clock, wakes } = setup(t);
  say(f, f.keys.owner, { messageId: "acked", body: "@Scout look at the logs" });
  say(f, f.keys.owner, { messageId: "answered", body: "@Scout status?" });
  f.store.acknowledgeMention(token, "commons", eventIdOf(f, "acked"));
  say(f, token, { messageId: "status", body: "fine", replyToId: "answered" });
  wakes.length = 0;
  const deadline = clock.now() + 1000;
  for (const id of ["acked", "answered"]) setDeadline(f, id, deadline);
  clock.advance(1001);
  f.store.flipExpiredMentions("commons");
  assert.equal(wakes.length, 0);
});

test("a failing re-wake never blocks the flip", t => {
  const { f, clock, wakes } = setup(t);
  say(f, f.keys.owner, { messageId: "m1", body: "@Scout hello" });
  wakes.length = 0;
  setDeadline(f, "m1", clock.now() + 1000);
  clock.advance(1001);
  f.store.agentHeartbeats.wakeIfOffline = () => { throw new Error("boom"); };
  assert.doesNotThrow(() => f.store.flipExpiredMentions("commons"));
  const state = f.store.db.prepare("SELECT state FROM mention_states WHERE room_id='commons' AND mentioned_member_id='rewake-agent'").get().state;
  assert.equal(state, "timed_out");
});
