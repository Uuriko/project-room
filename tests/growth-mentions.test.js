import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, event, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import { createCollector } from "../src/growth-collector.js";
import { validateEvent } from "../src/growth-events.js";
import { detectMentions } from "../src/growth-mentions.js";
import { applyEventWithGrowth } from "../src/growth-emit.js";

const ROOM = "room-project-room-v0";
const at = n => `2026-09-15T18:${String(n).padStart(2, "0")}:00.000Z`;

// Seed roster: potter (human "Potter"), codex (agent "Codex"),
// instinct (agent "Instinct"), maya (human "Maya").
const fresh = () => ({ state: replay(seedEvents), collector: createCollector() });
const roomEvent = (id, type, actorId, data, n = 0) =>
  event({ id, type, actorId, roomId: ROOM, at: at(n), data });
const post = (id, actorId, body, n = 0, extra = {}) =>
  roomEvent(id, EVENT_TYPES.MESSAGE_POSTED, actorId, { messageId: `m-${id}`, body, ...extra }, n);
const membersOf = state => state.members;

test("C4 detectMentions emits one envelope per mentioned agent via registered handle", () => {
  const { state } = fresh();
  const found = detectMentions(post("e1", "maya", "hey @Codex can you review this?"), { members: membersOf(state) });
  assert.equal(found.length, 1);
  const [envelope] = found;
  assert.equal(envelope.type, "agent.mentioned");
  assert.equal(envelope.privacyClass, "public-in-room");
  assert.deepEqual(envelope.fields, { roomId: ROOM, messageId: "m-e1", mentionedAgentId: "codex", mentionCount: 1 });
  assert.deepEqual(envelope.actor, { id: "maya", kind: "human" });
  assert.equal(envelope.source, "system");
  assert.doesNotThrow(() => validateEvent(envelope));
});

test("C4 multiple agents mentioned yield one envelope each, sorted by id", () => {
  const { state } = fresh();
  const found = detectMentions(post("e2", "potter", "@Instinct and @Codex huddle up"), { members: membersOf(state) });
  assert.deepEqual(found.map(e => e.fields.mentionedAgentId), ["codex", "instinct"]);
  assert.deepEqual(found.map(e => e.fields.mentionCount), [1, 1]);
});

test("C4 repeated mentions of one agent collapse into a single envelope with a count", () => {
  const { state } = fresh();
  const found = detectMentions(post("e3", "maya", "@Codex please, @Codex now"), { members: membersOf(state) });
  assert.equal(found.length, 1);
  assert.equal(found[0].fields.mentionCount, 2);
});

test("C4 exact member id is a valid mention label", () => {
  const { state } = fresh();
  // Agent "codex" has displayName "Codex"; the lowercase "@codex" matches its id exactly.
  const found = detectMentions(post("e4", "maya", "ping @codex when ready"), { members: membersOf(state) });
  assert.equal(found.length, 1);
  assert.equal(found[0].fields.mentionedAgentId, "codex");
});

test("C4 matching is exact: prefixes and punctuation boundaries do not match", () => {
  const { state } = fresh();
  const members = membersOf(state);
  assert.deepEqual(detectMentions(post("e5a", "maya", "ask @Codex2 about it", 1), { members }), []);
  assert.deepEqual(detectMentions(post("e5b", "maya", "shoutout to @CODEX", 2), { members }), []);
  assert.deepEqual(detectMentions(post("e5c", "maya", "cc @Codexstein", 3), { members }), []);
  assert.deepEqual(detectMentions(post("e5d", "maya", "ping @Codex!", 4), { members }), []);
});

test("C4 mirrors the product: no leading-boundary requirement, like the room's own mention highlight", () => {
  // messageMentionsMember (which drives the "mentioned" highlight in app.js)
  // flags "maya@Codex" as a mention of Codex; analytics counts the same.
  const { state } = fresh();
  const found = detectMentions(post("e5e", "maya", "email me at maya@Codex"), { members: membersOf(state) });
  assert.equal(found.length, 1);
  assert.equal(found[0].fields.mentionedAgentId, "codex");
});

test("C4 human members and unknown handles are never emitted", () => {
  const { state } = fresh();
  const members = membersOf(state);
  assert.deepEqual(detectMentions(post("e6a", "maya", "thanks @Maya!", 1), { members }), []);
  assert.deepEqual(detectMentions(post("e6b", "maya", "hello @Nobody here", 2), { members }), []);
});

test("C4 inactive agents are not mentioned", () => {
  const { state } = fresh();
  const members = { ...membersOf(state), codex: { ...membersOf(state).codex, active: false } };
  assert.deepEqual(detectMentions(post("e7", "maya", "hey @Codex"), { members }), []);
});

test("C4 display names with regex-special characters match literally", () => {
  const members = [{ id: "agent-cpp", displayName: "C++", kind: "agent", active: true }];
  const found = detectMentions(post("e8", "maya", "ask @C++ ok?"), { members });
  assert.equal(found.length, 1);
  assert.equal(found[0].fields.mentionedAgentId, "agent-cpp");
});

test("C4 non-message events, missing bodies, and empty rosters yield []", () => {
  const { state } = fresh();
  const members = membersOf(state);
  assert.deepEqual(detectMentions(roomEvent("e9a", EVENT_TYPES.ROOM_CREATED, "potter", {}), { members }), []);
  assert.deepEqual(detectMentions(post("e9b", "maya", "", 1), { members }), []);
  assert.deepEqual(detectMentions(post("e9c", "maya", "hey @Codex", 2), { members: {} }), []);
  assert.deepEqual(detectMentions(post("e9d", "maya", "hey @Codex", 3), { members: [] }), []);
  assert.deepEqual(detectMentions(null, { members }), []);
  assert.deepEqual(detectMentions("nope", { members }), []);
});

test("C4 message bodies never reach the envelope", () => {
  const { state } = fresh();
  const body = "this private body text mentions @Codex and must never be collected";
  const [envelope] = detectMentions(post("e10", "maya", body), { members: membersOf(state) });
  assert.equal(JSON.stringify(envelope).includes("private body text"), false);
  assert.deepEqual(Object.keys(envelope.fields).sort(),
    ["mentionCount", "mentionedAgentId", "messageId", "roomId"]);
});

test("C4 applyEventWithGrowth records mention events after message.sent", () => {
  const { state, collector } = fresh();
  const res = applyEventWithGrowth(state, post("e11", "maya", "hey @Codex take a look"), collector);
  assert.equal(res.growthOk, true);
  assert.deepEqual(collector.query({}).map(e => e.type), ["agent.mentioned", "message.sent"]);
  const mention = collector.query({ limit: 1 })[0];
  assert.deepEqual(mention.fields, { roomId: ROOM, messageId: "m-e11", mentionedAgentId: "codex", mentionCount: 1 });
  // The room path is unaffected: the message was committed normally.
  assert.equal(res.state.messages.at(-1).body, "hey @Codex take a look");
});

test("C4 mention emission failure is isolated from the room path", () => {
  const { state, collector } = fresh();
  const base = collector;
  const flaky = {
    ...base,
    record: envelope => {
      if (envelope.type === "agent.mentioned") throw new Error("sink down");
      return base.record(envelope);
    }
  };
  const res = applyEventWithGrowth(state, post("e12", "maya", "hey @Codex"), flaky);
  assert.equal(res.growthOk, true);
  assert.equal(res.state.messages.at(-1).body, "hey @Codex");
  assert.deepEqual(base.query({}).map(e => e.type), ["message.sent"]);
});
