import test from "node:test";
import assert from "node:assert/strict";
import { defineEvent, validateEvent, isKnownEvent, eventVersion, GROWTH_EVENT_TYPES, GROWTH_SCHEMA_VERSION } from "../src/growth-events.js";

const base = { actor: { id: "zoe", kind: "human" }, source: "web", occurredAt: "2026-09-15T16:00:00.000Z" };

test("C1 defineEvent builds a frozen envelope stamped with the registry version", () => {
  const event = defineEvent("member.joined", { ...base, fields: { roomId: "r1", memberId: "zoe", memberKind: "human", via: "invitation" } });
  assert.equal(event.type, "member.joined");
  assert.equal(event.schemaVersion, GROWTH_SCHEMA_VERSION);
  assert.equal(event.schemaVersion, eventVersion("member.joined"));
  assert.equal(event.occurredAt, "2026-09-15T16:00:00.000Z");
  assert.deepEqual(event.actor, { id: "zoe", kind: "human" });
  assert.equal(event.source, "web");
  assert.equal(event.privacyClass, "public-in-room");
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.fields) && Object.isFrozen(event.actor));
  assert.deepEqual(validateEvent(event), event);
});

test("C1 all registered types are known and every envelope round-trips", () => {
  assert.ok(GROWTH_EVENT_TYPES.length >= 10);
  for (const type of GROWTH_EVENT_TYPES) assert.ok(isKnownEvent(type), type);
  assert.ok(!isKnownEvent("room.deleted"));
  const samples = {
    "room.created": { roomId: "r1", roomKind: "personal" },
    "invite.accepted": { roomId: "r1", invitationId: "inv1" },
    "message.sent": { roomId: "r1", messageId: "m1", lengthBucket: "short", hasAttachment: false },
    "agent.mentioned": { roomId: "r1", messageId: "m1", mentionedAgentId: "agent-7", mentionCount: 2 },
    "reaction.added": { roomId: "r1", messageId: "m1", reaction: "thumbsup" },
    "message.pinned": { roomId: "r1", messageId: "m1" },
    "work.proposed": { roomId: "r1", workItemId: "w1" },
    "work.completed": { roomId: "r1", workItemId: "w1", verificationKind: "none" },
    "help.offer_opened": { roomId: "r1", offerId: "h1" },
    "notification.preference_set": { roomId: "r1", channel: "mentions", level: "mentions_only" },
    "inbound.received": { channel: "telegram", roomId: "r1", hasAttachment: true }
  };
  for (const [type, fields] of Object.entries(samples)) {
    const event = defineEvent(type, { ...base, fields });
    assert.deepEqual(validateEvent(JSON.parse(JSON.stringify(event))), event);
  }
});

test("C1 content bodies are rejected by default", () => {
  for (const field of ["body", "text", "content", "message", "email"]) {
    assert.throws(() => defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1", [field]: "hello" } }), /collect/, field);
  }
  // Identifier-style names stay usable; bare content names do not.
  const ok = defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1", replyToMessageId: "m0" } });
  assert.equal(ok.fields.replyToMessageId, "m0");
});

test("C1 secrets are rejected by default", () => {
  for (const field of ["password", "apiKey", "token", "secret", "authHeader", "sessionId"]) {
    assert.throws(() => defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1", [field]: "x" } }), /sensitive|collect/, field);
  }
});

test("C1 unknown fields are rejected on the envelope and inside fields", () => {
  assert.throws(() => defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1", debug: true } }), /does not collect/);
  const event = defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1" } });
  assert.throws(() => validateEvent({ ...event, extra: 1 }), /envelope field/);
  assert.throws(() => validateEvent({ ...event, fields: { ...event.fields, extra: 1 } }), /does not collect/);
});

test("C1 missing required fields are rejected", () => {
  assert.throws(() => defineEvent("member.joined", { ...base, fields: { roomId: "r1", memberId: "zoe" } }), /missing required field "memberKind"/);
  assert.throws(() => defineEvent("room.created", { ...base, fields: { roomId: "r1" } }), /missing required field "roomKind"/);
});

test("C1 actor, source and timestamp are enforced", () => {
  assert.throws(() => defineEvent("message.sent", { ...base, actor: { id: "zoe", kind: "robot" }, fields: { roomId: "r1", messageId: "m1" } }), /kind/);
  assert.throws(() => defineEvent("message.sent", { ...base, actor: { id: "", kind: "human" }, fields: { roomId: "r1", messageId: "m1" } }), /Actor id/);
  assert.throws(() => defineEvent("message.sent", { ...base, source: "carrier-pigeon", fields: { roomId: "r1", messageId: "m1" } }), /source/);
  assert.throws(() => defineEvent("message.sent", { ...base, occurredAt: "not-a-time", fields: { roomId: "r1", messageId: "m1" } }), /timestamp/);
  const agent = defineEvent("agent.mentioned", { ...base, actor: { id: "agent-7", kind: "agent" }, source: "agent-inbox", fields: { roomId: "r1", messageId: "m1", mentionedAgentId: "agent-7" } });
  assert.equal(agent.actor.kind, "agent");
});

test("C1 privacy class is stamped by the registry and cannot be overridden", () => {
  const priv = defineEvent("notification.preference_set", { ...base, fields: { roomId: "r1" } });
  assert.equal(priv.privacyClass, "account-private");
  assert.throws(() => validateEvent({ ...priv, privacyClass: "public-in-room" }), /privacy class/);
  assert.throws(() => validateEvent({ ...priv, privacyClass: "never-collect" }), /privacy class/);
});

test("C1 non-scalar field values are rejected so content cannot be smuggled", () => {
  assert.throws(() => defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1", threadId: { id: "t1" } } }), /scalar/);
  assert.throws(() => defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1", threadId: ["t1"] } }), /scalar/);
  const ok = defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1", threadId: null } });
  assert.equal(ok.fields.threadId, null);
});

test("C1 enum fields reject values outside the vocabulary", () => {
  assert.throws(() => defineEvent("message.sent", { ...base, fields: { roomId: "r1", messageId: "m1", lengthBucket: "novel" } }), /one of/);
  assert.throws(() => defineEvent("room.created", { ...base, fields: { roomId: "r1", roomKind: "secret" } }), /one of/);
});

test("C1 unknown types and version drift fail closed", () => {
  assert.throws(() => defineEvent("room.deleted", { ...base, fields: {} }), /Unknown growth event type/);
  assert.throws(() => eventVersion("room.deleted"), /Unknown growth event type/);
  const event = defineEvent("work.proposed", { ...base, fields: { roomId: "r1", workItemId: "w1" } });
  assert.throws(() => validateEvent({ ...event, schemaVersion: "0.9" }), /schema version/);
  assert.throws(() => validateEvent({ ...event, schemaVersion: "2.0" }), /schema version/);
});
