import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// An in-thread reply to an agent's post must notify that agent: a delivered
// mention_states row (needs-me surfaces it) and a wake signal for a
// registered host. Before this fix a reply without an @name created
// nothing, so an agent never learned its post was answered.
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-reply-notify-"));
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "alice", displayName: "Alice", kind: "human", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "claude", displayName: "Claude", kind: "agent", permissions: [] });
  send("owner", T.MEMBER_ADDED, { memberId: "dave", displayName: "Dave", kind: "agent", permissions: [] });
  keys.alice = store.issueAccessKey("commons", "alice");
  keys.claude = store.issueAccessKey("commons", "claude");
  keys.dave = store.issueAccessKey("commons", "dave");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const mentionRows = (memberId) => store.db.prepare(
    "SELECT message_event_id AS eventId, state FROM mention_states WHERE room_id='commons' AND mentioned_member_id=?"
  ).all(memberId);
  return { store, keys, send, clock, mentionRows };
}

test("reply to an agent's post lands a delivered mention row for that agent", (t) => {
  const f = setup(t);
  f.send("claude", T.MESSAGE_POSTED, { messageId: "m1", body: "Status report from claude" });
  const reply = f.send("alice", T.MESSAGE_POSTED, { messageId: "r1", body: "Thanks, read it", replyToId: "m1" });
  const rows = f.mentionRows("claude");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventId, reply.event.id);
  assert.equal(rows[0].state, "delivered");
  // The agent's needs-me inbox surfaces the reply as a mention from alice.
  const inbox = f.store.openDirectMentions("commons", "claude");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, "alice");
  assert.equal(inbox[0].body, "Thanks, read it");
  assert.equal(inbox[0].messageId, "r1");
});

test("no row for self-replies, DM replies, replies to human posts, or inactive agents", (t) => {
  const f = setup(t);
  f.send("claude", T.MESSAGE_POSTED, { messageId: "m1", body: "claude's post" });
  // Self-reply: the author already knows.
  f.send("claude", T.MESSAGE_POSTED, { messageId: "r-self", body: "follow-up", replyToId: "m1" });
  assert.equal(f.mentionRows("claude").length, 0);
  // DM reply: the dm wake path already notifies the recipient.
  f.send("alice", T.MESSAGE_POSTED, { messageId: "r-dm", body: "private answer", replyToId: "m1", toMemberId: "claude" });
  assert.equal(f.mentionRows("claude").length, 0);
  // Reply to a human's post: humans keep their existing attention paths.
  f.send("alice", T.MESSAGE_POSTED, { messageId: "m2", body: "alice's post" });
  f.send("owner", T.MESSAGE_POSTED, { messageId: "r2", body: "owner answers", replyToId: "m2" });
  assert.equal(f.mentionRows("alice").length, 0);
  // Inactive agent: no row.
  f.send("dave", T.MESSAGE_POSTED, { messageId: "m4", body: "dave's earlier post" });
  const dave = f.store.room("commons").state.members.dave;
  f.send("owner", T.MEMBER_ACCESS_CHANGED, { memberId: "dave", expectedMemberRevision: dave.revision, permissions: dave.permissions ?? [], active: false });
  f.send("alice", T.MESSAGE_POSTED, { messageId: "r3", body: "answering dave", replyToId: "m4" });
  assert.equal(f.mentionRows("dave").length, 0);
});

test("reply that also @mentions the author creates exactly one row", (t) => {
  const f = setup(t);
  f.send("claude", T.MESSAGE_POSTED, { messageId: "m1", body: "claude's post" });
  f.send("alice", T.MESSAGE_POSTED, { messageId: "r1", body: "@Claude thanks", replyToId: "m1" });
  const rows = f.mentionRows("claude");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "delivered");
});

test("reply to an agent's post wakes the agent's registered host", async (t) => {
  const { AgentRooms } = await import("../server/agent-rooms.mjs");
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const owner = store.identities.create("Wake owner");
  new AgentRooms(store).create(owner.secret, { roomId: "wake-room", title: "Wake", purpose: "Reply wake testing" });
  const alias = store.identities.create("Linked alias");
  store.identities.link(owner.secret, "wake-room", { identityId: alias.identityId, memberId: "linked-alias", displayName: "Alias", permissions: [] });
  store.agentHeartbeats.heartbeat({ agentId: alias.identityId, hostId: "laptop", mode: "pull-only", cadenceSeconds: 60 });
  store.command(alias.secret, "wake-room", { id: randomUUID(), type: "message.posted", data: { messageId: "m1", body: "agent post" } });
  assert.equal(store.agentHeartbeats.pendingWakes(alias.identityId).length, 0);
  store.command(owner.secret, "wake-room", { id: randomUUID(), type: "message.posted", data: { messageId: "r1", body: "here is your answer", replyToId: "m1" } });
  const wakes = store.agentHeartbeats.pendingWakes(alias.identityId);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].kind, "mention");
  assert.equal(wakes[0].messageId, "r1");
  const row = store.db.prepare(
    "SELECT state FROM mention_states WHERE room_id='wake-room' AND mentioned_member_id='linked-alias'"
  ).get();
  assert.equal(row.state, "delivered");
});
