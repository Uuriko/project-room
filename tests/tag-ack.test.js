// Tag acknowledgment (2026-09-23): a bare 👍 react counts as a response when
// an agent is tagged. Mention items derive ackState ("pending" |
// "acknowledged") at read time; wake pings carry the one-tap ack copy; the
// feed envelope reports a per-member mention ack rate.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EVENT_TYPES as T } from "../src/events.js";
import { deriveNotifications, SUGGESTED_ACK_REACTION } from "../server/notifications.mjs";
import { buildWakePing, WAKE_ACK_HINT, WAKE_PING_EVENT } from "../server/outbound-webhooks.mjs";
import { AgentHeartbeats, agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";

const member = { id: "agent", displayName: "Test Agent", kind: "agent" };
const owner = { id: "owner", displayName: "Owner", kind: "human" };
const maya = { id: "maya", displayName: "Maya", kind: "human" };

const msg = (id, authorId, body, extra = {}) =>
  ({ id, authorId, body, replyToId: null, toMemberId: null, reactions: {}, ...extra });

const posted = (sequence, messageId, actorId, data = {}) => ({
  sequence,
  event: {
    id: `evt-${messageId}`, type: T.MESSAGE_POSTED, actorId,
    at: new Date(1700000000000 + sequence * 1000).toISOString(),
    data: { messageId, body: data.body ?? "", replyToId: data.replyToId ?? null, toMemberId: data.toMemberId ?? null },
  },
});

function derive({ messages, events, viewer = member }) {
  return deriveNotifications({
    events,
    state: { messages, members: { agent: member, owner, maya }, room: { ownerId: "owner" } },
    member: viewer,
  });
}

const mentionsOf = items => items.filter(item => item.kind === "mention");

test("a mention is pending by default and suggests the like react", () => {
  const messages = [msg("m1", "owner", "Hey @Test Agent take a look")];
  const items = mentionsOf(derive({ messages, events: [posted(1, "m1", "owner", { body: "Hey @Test Agent take a look" })] }));
  assert.equal(items.length, 1);
  assert.equal(items[0].ackState, "pending");
  assert.equal(items[0].suggestedAck, SUGGESTED_ACK_REACTION);
  assert.equal(items[0].suggestedAck, "like");
});

test("a reaction by the mentioned member acknowledges the mention", () => {
  const messages = [msg("m1", "owner", "Hey @Test Agent ok", { reactions: { like: ["agent"] } })];
  const items = mentionsOf(derive({ messages, events: [posted(1, "m1", "owner", { body: "Hey @Test Agent" })] }));
  assert.equal(items[0].ackState, "acknowledged");
});

test("any reaction key counts, not just the suggested one", () => {
  const messages = [msg("m1", "owner", "Hey @Test Agent ok", { reactions: { heart: ["agent"] } })];
  const items = mentionsOf(derive({ messages, events: [posted(1, "m1", "owner", { body: "Hey @Test Agent" })] }));
  assert.equal(items[0].ackState, "acknowledged");
});

test("a reaction by someone else does not acknowledge", () => {
  const messages = [msg("m1", "owner", "Hey @Test Agent ok", { reactions: { like: ["maya"] } })];
  const items = mentionsOf(derive({ messages, events: [posted(1, "m1", "owner", { body: "Hey @Test Agent" })] }));
  assert.equal(items[0].ackState, "pending");
});

test("a direct reply to the mentioning message acknowledges", () => {
  const messages = [
    msg("m1", "owner", "Hey @Test Agent"),
    msg("m2", "agent", "On it", { replyToId: "m1" }),
  ];
  const items = mentionsOf(derive({
    messages,
    events: [
      posted(1, "m1", "owner", { body: "Hey @Test Agent" }),
      posted(2, "m2", "agent", { body: "On it", replyToId: "m1" }),
    ],
  }));
  assert.equal(items[0].ackState, "acknowledged");
});

test("a later message in the same thread acknowledges; a different thread does not", () => {
  const messages = [
    msg("m1", "owner", "Hey @Test Agent"),
    msg("m2", "owner", "unrelated root"),
    msg("m3", "agent", "following up", { replyToId: "m1" }),
    msg("m4", "agent", "other thread", { replyToId: "m2" }),
  ];
  const items = mentionsOf(derive({
    messages,
    events: [
      posted(1, "m1", "owner", { body: "Hey @Test Agent" }),
      posted(2, "m2", "owner", { body: "unrelated root" }),
      posted(4, "m4", "agent", { body: "other thread", replyToId: "m2" }),
    ],
  }));
  assert.equal(items[0].ackState, "pending");
  const items2 = mentionsOf(derive({
    messages,
    events: [
      posted(1, "m1", "owner", { body: "Hey @Test Agent" }),
      posted(2, "m2", "owner", { body: "unrelated root" }),
      posted(3, "m3", "agent", { body: "following up", replyToId: "m1" }),
      posted(4, "m4", "agent", { body: "other thread", replyToId: "m2" }),
    ],
  }));
  assert.equal(items2[0].ackState, "acknowledged");
});

test("a deleted mentioning message keeps prior scoping: no item", () => {
  const messages = [msg("m1", "owner", "Hey @Test Agent", { deletedAt: 1700000001000 })];
  const items = mentionsOf(derive({ messages, events: [posted(1, "m1", "owner", { body: "Hey @Test Agent" })] }));
  assert.equal(items.length, 0);
});

test("DM mention to the recipient works; a mention in someone else's DM stays suppressed", () => {
  const messages = [
    msg("dm1", "owner", "ping", { toMemberId: "agent" }),
    msg("dm2", "owner", "Hey @Test Agent", { toMemberId: "maya" }),
  ];
  const items = mentionsOf(derive({
    messages,
    events: [
      posted(1, "dm1", "owner", { body: "ping", toMemberId: "agent" }),
      posted(2, "dm2", "owner", { body: "Hey @Test Agent", toMemberId: "maya" }),
    ],
  }));
  assert.deepEqual(items.map(item => item.messageId), ["dm1"]);
  assert.equal(items[0].ackState, "pending");
});

test("a deleted reply does not count as a thread response", () => {
  const messages = [
    msg("m1", "owner", "Hey @Test Agent"),
    msg("m2", "agent", "On it", { replyToId: "m1", deletedAt: 1700000002000 }),
  ];
  const items = mentionsOf(derive({
    messages,
    events: [
      posted(1, "m1", "owner", { body: "Hey @Test Agent" }),
      posted(2, "m2", "agent", { body: "On it", replyToId: "m1" }),
    ],
  }));
  assert.equal(items[0].ackState, "pending");
});

test("non-mention items carry no ack fields", () => {
  const messages = [msg("m1", "owner", "hello world")];
  // No mention of the agent: no items at all for a plain message.
  const items = derive({ messages, events: [posted(1, "m1", "owner", { body: "hello world" })] });
  assert.equal(items.length, 0);
});

// The per-member mention ack rate uses the same read-time derivation.
function ackRateOf(items) {
  const mentions = items.filter(item => item.kind === "mention");
  const acknowledged = mentions.filter(item => item.ackState === "acknowledged").length;
  return { acknowledged, total: mentions.length, rate: mentions.length > 0 ? acknowledged / mentions.length : null };
}

test("ack rate counts acknowledged over total mentions", () => {
  const messages = [
    msg("m1", "owner", "Hey @Test Agent ok", { reactions: { like: ["agent"] } }),
    msg("m2", "owner", "Hey @Test Agent again"),
    msg("m3", "maya", "Hey @Test Agent too"),
  ];
  const items = mentionsOf(derive({
    messages,
    events: [
      posted(1, "m1", "owner", { body: "Hey @Test Agent" }),
      posted(2, "m2", "owner", { body: "Hey @Test Agent again" }),
      posted(3, "m3", "maya", { body: "Hey @Test Agent too" }),
    ],
  }));
  assert.deepEqual(ackRateOf(items), { acknowledged: 1, total: 3, rate: 1 / 3 });
});

test("ack rate is null with no mentions", () => {
  assert.deepEqual(ackRateOf([]), { acknowledged: 0, total: 0, rate: null });
});

// Wake path: the one-tap ack hint rides the agent.wake payload and the
// journaled pending-wake signal, additively.
test("buildWakePing carries the ack hint additively", () => {
  const signal = { signalId: "ws_1", agentId: "ai_x", kind: "mention", roomId: "r", messageId: "m" };
  const payload = buildWakePing({ agentId: "ai_x", signal });
  assert.equal(payload.event, WAKE_PING_EVENT);
  assert.deepEqual(payload.signal, signal);
  assert.equal(payload.ackHint, WAKE_ACK_HINT);
  assert.equal(payload.ackHint, "react 👍 to acknowledge");
});

test("journaled pending-wake signals carry the ack hint", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  const hb = new AgentHeartbeats({ db, now: () => 1700000000000 });
  const { signal } = hb.enqueueWake({ agentId: "ai_x", kind: "mention", roomId: "r", messageId: "m" });
  assert.equal(signal.ackHint, WAKE_ACK_HINT);
  const pending = hb.pendingWakes("ai_x");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ackHint, WAKE_ACK_HINT);
  db.close();
});
