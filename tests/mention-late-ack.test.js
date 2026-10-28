// A timed-out mention the member explicitly acknowledges after its deadline
// leaves the open list, the way an in-thread answer does. Before this, a
// mention answered outside its thread stayed open forever and the list only
// grew. An acknowledgment before the deadline keeps the mention open.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

function enrolledAgent(t) {
  const f = createAcceptanceFixture(), session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "mention-enroll", memberId: "mention-agent", displayName: "Scout", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  // #953: new agents default to t1_readonly; Scout needs write access for message.posted
  setTier(f.store.db, "commons", "mention-agent", "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  return { f, token };
}
const say = (f, key, data) => f.store.command(key, "commons", { id: randomUUID(), type: "message.posted", data });

const eventIdOf = (f, messageId) => f.store.db.prepare("SELECT id FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(messageId).id;
const expire = (f, messageId, at) => f.store.db.prepare("UPDATE mention_states SET timeout_at=? WHERE room_id='commons' AND message_event_id=?").run(at, eventIdOf(f, messageId));
const open = (f, token) => f.store.agentInbox(token, "commons").directMentions.map(m => m.messageId);

test("a late ack clears a timed-out mention; an on-time ack keeps it open", t => {
  const { f, token } = enrolledAgent(t);
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  say(f, f.keys.owner, { messageId: "answered-elsewhere", body: "@Scout did the deploy go out?" });
  say(f, f.keys.owner, { messageId: "acked-in-time", body: "@Scout please look at the logs" });
  say(f, f.keys.owner, { messageId: "ignored", body: "@Scout ping" });
  assert.deepEqual(open(f, token), ["ignored", "acked-in-time", "answered-elsewhere"]);

  // Acked before its deadline, then the deadline passes: still open.
  f.store.acknowledgeMention(token, "commons", eventIdOf(f, "acked-in-time"));
  const past = f.store.now() - 1;
  for (const id of ["answered-elsewhere", "acked-in-time", "ignored"]) expire(f, id, past);
  assert.deepEqual(open(f, token), ["ignored", "acked-in-time", "answered-elsewhere"], "timing out alone clears nothing");

  // Answered in a new message, then acknowledged after the deadline: handled.
  say(f, token, { messageId: "status", body: "Deploy went out at 10:00." });
  f.store.acknowledgeMention(token, "commons", eventIdOf(f, "answered-elsewhere"));
  assert.deepEqual(open(f, token), ["ignored", "acked-in-time"], "late ack clears only that mention");
  assert.deepEqual(f.store.agentInbox(token, "commons").attention.pendingMentions.map(m => m.replyToId), ["ignored", "acked-in-time"], "standing attention agrees");

  // Repeating the ack is harmless, and the in-thread path still works.
  f.store.acknowledgeMention(token, "commons", eventIdOf(f, "answered-elsewhere"));
  say(f, token, { messageId: "logs", body: "Logs are clean", replyToId: "acked-in-time" });
  assert.deepEqual(open(f, token), ["ignored"]);
});

test("a late ack never closes a formal reply request or another member's mention", t => {
  const { f, token } = enrolledAgent(t);
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  say(f, f.keys.owner, { messageId: "formal", body: "@Scout please confirm the release window", toMemberId: "mention-agent", requestKind: "reply" });
  say(f, f.keys.owner, { messageId: "shared", body: "@Scout and @guest both look at this" });
  const before = f.store.replyRequests.selected(token, "commons", "formal");
  const past = f.store.now() - 1;
  for (const id of ["formal", "shared"]) expire(f, id, past);
  f.store.acknowledgeMention(token, "commons", eventIdOf(f, "formal"));
  const after = f.store.replyRequests.selected(token, "commons", "formal");
  assert.equal(before.request.status, "open");
  assert.equal(after.request.status, "open", "the formal request stays open");
  assert.equal(after.request.revision, before.request.revision, "the ack does not touch the request");
  const guestMentions = () => f.store.db.prepare("SELECT state FROM mention_states WHERE room_id='commons' AND mentioned_member_id='guest'").all().map(r => r.state);
  const guestBefore = guestMentions();
  assert.equal(guestBefore.length, 1, "guest has their own mention row");
  f.store.acknowledgeMention(token, "commons", eventIdOf(f, "shared"));
  assert.deepEqual(guestMentions(), guestBefore, "my ack does not touch another member's mention");
  assert.throws(() => f.store.acknowledgeMention(f.keys.guest, "commons", eventIdOf(f, "formal")), /mention_not|not yours|No mention/i, "a member cannot ack someone else's private mention");
});

test("an on-time ack followed by a late ack still clears the mention", t => {
  const { f, token } = enrolledAgent(t);
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  say(f, f.keys.owner, { messageId: "seen-then-handled", body: "@Scout can you check the invoices?" });
  const id = eventIdOf(f, "seen-then-handled");
  f.store.acknowledgeMention(token, "commons", id);
  const firstAck = f.store.db.prepare("SELECT acknowledged_at AS at FROM mention_observations WHERE room_id='commons' AND message_event_id=?").get(id).at;
  expire(f, "seen-then-handled", f.store.now() - 1);
  assert.deepEqual(open(f, token), ["seen-then-handled"], "an on-time ack alone keeps it open after the deadline");
  f.store.acknowledgeMention(token, "commons", id);
  assert.deepEqual(open(f, token), [], "the later ack clears it");
  const row = f.store.db.prepare("SELECT acknowledged_at AS at, late_acknowledged_at AS late FROM mention_observations WHERE room_id='commons' AND message_event_id=?").get(id);
  assert.equal(row.at, firstAck, "the first ack time is kept");
  assert.ok(Number.isSafeInteger(row.late), "the late ack is recorded separately");
  assert.equal(f.store.db.prepare("SELECT state FROM mention_states WHERE room_id='commons' AND message_event_id=?").get(id).state, "timed_out", "timed-out history is kept");
});
