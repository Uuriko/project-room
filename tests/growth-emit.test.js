import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, applyEvent, event, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { createCollector } from "../src/growth-collector.js";
import {
  ROOM_TO_GROWTH,
  growthTypeFor,
  growthCollector,
  getGrowthEmissionFailures,
  buildGrowthEvent,
  applyEventWithGrowth
} from "../src/growth-emit.js";

const ROOM = "room-project-room-v0";
const at = n => `2026-09-15T17:${String(n).padStart(2, "0")}:00.000Z`;

// Fresh base projection plus a fresh collector per test.
const fresh = () => ({ state: replay(seedEvents), collector: createCollector() });
const roomEvent = (id, type, actorId, data, n = 0) =>
  event({ id, type, actorId, roomId: ROOM, at: at(n), data });

const lastEnvelope = collector => collector.query({ limit: 1 })[0];

test("C3 ROOM_TO_GROWTH covers the nine mapped room event types and is frozen", () => {
  assert.deepEqual({ ...ROOM_TO_GROWTH }, {
    "room.created": "room.created",
    "member.added": "member.joined",
    "member.joined_via_invitation": "member.joined",
    "message.posted": "message.sent",
    "message.reaction_set": "reaction.added",
    "message.pinned": "message.pinned",
    "work.proposed": "work.proposed",
    "work.completed": "work.completed",
    "notifications.preferences_set": "notification.preference_set"
  });
  assert.throws(() => { ROOM_TO_GROWTH["message.posted"] = "x"; }, TypeError);
  assert.equal(growthTypeFor(EVENT_TYPES.MESSAGE_POSTED), "message.sent");
  assert.equal(growthTypeFor(EVENT_TYPES.MESSAGE_EDITED), null);
  assert.equal(growthTypeFor(null), null);
});

test("C3 shared growthCollector is a working C2 collector", () => {
  assert.equal(typeof growthCollector.record, "function");
  assert.equal(typeof growthCollector.query, "function");
  assert.equal(typeof growthCollector.stats, "function");
});

test("C3 room.created projects roomId and roomKind", () => {
  const envelope = buildGrowthEvent(
    roomEvent("ev-room", EVENT_TYPES.ROOM_CREATED, "potter", { roomId: "r-new", kind: "organization" })
  );
  assert.equal(envelope.type, "room.created");
  assert.deepEqual(envelope.fields, { roomId: ROOM, roomKind: "organization" });
  assert.deepEqual(envelope.actor, { id: "potter", kind: "human" });
  assert.equal(envelope.source, "system");
});

test("C3 member.joined maps direct adds and invitation joins", () => {
  const { state, collector } = fresh();
  // Direct add of an agent member by the owner.
  let res = applyEventWithGrowth(state, roomEvent("ev-add", EVENT_TYPES.MEMBER_ADDED, "potter", {
    memberId: "agent-9", displayName: "Agent Nine", kind: "agent",
    permissions: ["accept_work", "complete_work", "verify"]
  }, 1), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(lastEnvelope(collector).fields,
    { roomId: ROOM, memberId: "agent-9", memberKind: "agent", via: "direct" });
  assert.deepEqual(lastEnvelope(collector).actor, { id: "potter", kind: "human" });

  // Invitation join: always human, always via invitation.
  res = applyEventWithGrowth(res.state, roomEvent("ev-join", EVENT_TYPES.MEMBER_JOINED_VIA_INVITATION, "zoe", {
    memberId: "zoe", displayName: "Zoe", role: "member",
    permissions: ["accept_work", "complete_work", "verify"],
    invitedByMemberId: "potter", invitationId: "inv-1", rolePolicyVersion: 1, authorityPolicyVersion: 2
  }, 2), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(lastEnvelope(collector).fields,
    { roomId: ROOM, memberId: "zoe", memberKind: "human", via: "invitation" });
});

test("C3 message.sent carries identifiers and aggregates, never the body", () => {
  const { state, collector } = fresh();
  const body = "this body text must never reach the collector, it is private content";
  const res = applyEventWithGrowth(state,
    roomEvent("ev-msg", EVENT_TYPES.MESSAGE_POSTED, "maya", { messageId: "m-9", body }, 3), collector);
  assert.equal(res.growthOk, true);
  const envelope = lastEnvelope(collector);
  assert.equal(envelope.type, "message.sent");
  assert.deepEqual(envelope.fields, { roomId: ROOM, messageId: "m-9", lengthBucket: "short" });
  for (const key of Object.keys(envelope.fields)) {
    assert.match(key, /^(roomId|messageId|threadId|replyToMessageId|hasAttachment|lengthBucket)$/);
  }
  assert.equal(JSON.stringify(envelope).includes("private content"), false);
});

test("C4 applyEventWithGrowth emits agent.mentioned alongside message.sent (C3 integration)", () => {
  // C4 wired mention detection into the wrapped choke point: an exact-case
  // @-mention of an agent member now emits agent.mentioned after message.sent.
  const { state, collector } = fresh();
  const res = applyEventWithGrowth(state,
    roomEvent("ev-mention", EVENT_TYPES.MESSAGE_POSTED, "maya", { body: "hey @Codex look" }, 4), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(collector.query({}).map(e => e.type), ["agent.mentioned", "message.sent"]);
  const mention = collector.query({ limit: 1 })[0];
  assert.deepEqual(mention.fields,
    { roomId: ROOM, messageId: "ev-mention", mentionedAgentId: "codex", mentionCount: 1 });
});

test("C4 mention matching is exact and case-sensitive (C3 integration)", () => {
  // "@CODEX" matches neither the "Codex" handle nor the "codex" id, so only
  // message.sent is emitted.
  const { state, collector } = fresh();
  const res = applyEventWithGrowth(state,
    roomEvent("ev-nomention", EVENT_TYPES.MESSAGE_POSTED, "maya", { body: "hey @CODEX look" }, 5), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(collector.query({}).map(e => e.type), ["message.sent"]);
});

test("C3 reaction.added and message.pinned project message identifiers", () => {
  const { state, collector } = fresh();
  let res = applyEventWithGrowth(state,
    roomEvent("ev-post", EVENT_TYPES.MESSAGE_POSTED, "maya", { messageId: "m-r", body: "react to me" }, 5), collector);
  res = applyEventWithGrowth(res.state,
    roomEvent("ev-react", EVENT_TYPES.MESSAGE_REACTION_SET, "codex",
      { messageId: "m-r", reaction: "like", active: true }, 6), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(lastEnvelope(collector).fields, { roomId: ROOM, messageId: "m-r", reaction: "like" });
  res = applyEventWithGrowth(res.state,
    roomEvent("ev-pin", EVENT_TYPES.MESSAGE_PINNED, "potter", { messageId: "m-r" }, 7), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(lastEnvelope(collector).fields, { roomId: ROOM, messageId: "m-r" });
});

test("C3 work.proposed and work.completed project work identifiers", () => {
  const { state, collector } = fresh();
  let res = applyEventWithGrowth(state, roomEvent("ev-prop", EVENT_TYPES.WORK_PROPOSED, "potter", {
    workItemId: "work-c3", title: "Wire growth emission", definitionOfDone: "Events flow",
    accountableMemberId: "maya", verifierMemberId: "codex", independentVerificationRequired: true
  }, 8), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(lastEnvelope(collector).fields, { roomId: ROOM, workItemId: "work-c3" });

  res = applyEventWithGrowth(res.state,
    roomEvent("ev-accept", EVENT_TYPES.WORK_ACCEPTED, "maya", { workItemId: "work-c3", expectedRevision: 0 }, 9), collector);
  assert.equal(res.growthOk, false); // unmapped: accepted is not in the vocabulary
  res = applyEventWithGrowth(res.state, roomEvent("ev-done", EVENT_TYPES.WORK_COMPLETED, "maya", {
    workItemId: "work-c3", expectedRevision: 1,
    summary: "done", evidenceUrl: "https://example.com/e", evidenceVersion: "1", nextAction: "none"
  }, 10), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(lastEnvelope(collector).fields,
    { roomId: ROOM, workItemId: "work-c3", verificationKind: "independent_review" });
});

test("C3 notification.preference_set is account-private and takes the first channel", () => {
  const { state, collector } = fresh();
  const res = applyEventWithGrowth(state, roomEvent("ev-prefs", EVENT_TYPES.NOTIFICATION_PREFERENCES_SET, "codex", {
    preferences: { mentions: "none", replies: "mentions_only" }
  }, 11), collector);
  assert.equal(res.growthOk, true);
  const envelope = lastEnvelope(collector);
  assert.equal(envelope.type, "notification.preference_set");
  assert.equal(envelope.privacyClass, "account-private");
  assert.deepEqual(envelope.fields, { roomId: ROOM, channel: "mentions", level: "none" });
});

test("C3 unmapped room event types are skipped silently", () => {
  const { state, collector } = fresh();
  const res = applyEventWithGrowth(state,
    roomEvent("ev-caps", EVENT_TYPES.CAPABILITIES_ADVERTISED, "codex", { capabilities: ["parsing"] }, 12), collector);
  assert.deepEqual({ growthOk: res.growthOk, growthReason: res.growthReason },
    { growthOk: false, growthReason: "unmapped room event type" });
  assert.equal(collector.stats().total, 0);
  // The room state still applied normally.
  assert.deepEqual(res.state.members.codex.capabilities, ["parsing"]);
});

test("C3 emission failure never breaks the room path", () => {
  const { state } = fresh();
  const posted = roomEvent("ev-fail", EVENT_TYPES.MESSAGE_POSTED, "maya", { body: "hello" }, 13);
  const expected = applyEvent(state, posted);
  const before = getGrowthEmissionFailures();
  const broken = { record() { throw new Error("sink down"); } };
  const res = applyEventWithGrowth(state, posted, broken);
  assert.deepEqual(res.state, expected);
  assert.equal(res.growthOk, false);
  assert.match(res.growthReason, /sink down/);
  assert.equal(getGrowthEmissionFailures(), before + 1);
});

test("C3 collector refusal is reported, not thrown", () => {
  const { state } = fresh();
  const before = getGrowthEmissionFailures();
  const picky = { record: () => ({ ok: false, reason: "nope" }) };
  const res = applyEventWithGrowth(state,
    roomEvent("ev-ref", EVENT_TYPES.MESSAGE_POSTED, "maya", { body: "hi" }, 14), picky);
  assert.equal(res.state.messages.length, state.messages.length + 1);
  assert.equal(res.growthOk, false);
  assert.match(res.growthReason, /collector refused event: nope/);
  assert.equal(getGrowthEmissionFailures(), before + 1);
});

test("C3 actor classification follows member kind", () => {
  const { state, collector } = fresh();
  const agentRes = applyEventWithGrowth(state,
    roomEvent("ev-agent", EVENT_TYPES.MESSAGE_POSTED, "codex", { body: "beep" }, 15), collector);
  assert.deepEqual(lastEnvelope(collector).actor, { id: "codex", kind: "agent" });
  applyEventWithGrowth(agentRes.state,
    roomEvent("ev-human", EVENT_TYPES.MESSAGE_POSTED, "maya", { body: "boop" }, 16), collector);
  assert.deepEqual(lastEnvelope(collector).actor, { id: "maya", kind: "human" });
  assert.equal(collector.stats().perActor.agent, 1);
  assert.equal(collector.stats().perActor.human, 1);
});

test("C3 room apply failures still throw before any emission", () => {
  const { state, collector } = fresh();
  assert.throws(() => applyEventWithGrowth(state,
    roomEvent("ev-bad", EVENT_TYPES.MESSAGE_POSTED, "stranger", { body: "nope" }, 17), collector),
    /Unknown member/);
  assert.equal(collector.stats().total, 0);
});
