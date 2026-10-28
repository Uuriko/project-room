// #661: anti-shout pacing for multi-agent rooms.
// A per-room, owner-set, server-enforced pacing policy for agent replies:
// broadcast (@channel) replies land in a deterministic sequence, agent
// replies to an unnamed message are capped at the policy's N (default 2),
// and a reply that is out of turn or past the cap is refused with a named
// code — never silently dropped. Humans and policy-less rooms are untouched.
// Determinism: order and counts derive only from recorded state (parent id,
// member ids, already-recorded replies). No timers, no sleeps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  EVENT_TYPES as T, applyEvent, replay
} from "../src/events.js";
import {
  roomPacingPolicy, pacingBroadcastOrder,
  PACING_DEFAULT_MAX_UNNAMED_AGENT_REPLIES
} from "../src/message-reducers.js";
import { seedEvents } from "../src/seed.js";
import { RoomStore, validateCommand } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { agentErrorBody } from "../src/agent-error.mjs";

const ROOM = "room-project-room-v0";

// Reducer fixture over the seed room: potter (human owner), maya (human),
// codex + instinct (agents), plus a third agent added here.
function fixture() {
  let state = replay(structuredClone(seedEvents));
  let serial = 0;
  const send = (actorId, type, data) => {
    const incoming = { id: `pacing-event-${++serial}`, idempotencyKey: `pacing-key-${serial}`, roomId: ROOM, actorId, type,
      at: new Date(Date.UTC(2026, 9, 18, 12, 0, serial)).toISOString(), causationId: null, data };
    state = applyEvent(state, incoming);
    return incoming;
  };
  send("potter", T.MEMBER_ADDED, { memberId: "third", displayName: "Third", kind: "agent", permissions: ["accept_work"] });
  const post = (actorId, body, extra = {}) => send(actorId, T.MESSAGE_POSTED, { messageId: `pacing-msg-${++serial}`, body, ...extra });
  const reply = (actorId, parentId, body = "reply") => post(actorId, body, { replyToId: parentId });
  const setPacing = (actorId, data) => send(actorId, T.ROOM_PACING_POLICY_SET, data);
  return { get state() { return state; }, send, post, reply, setPacing };
}

const refused = (fn, code) => assert.throws(fn, error => error.code === code && /Pacing:/.test(error.message));

test("policy absent: no pacing field, no cap, behaviour is today's", () => {
  const f = fixture();
  assert.equal(f.state.room.pacingPolicy, undefined, "an untouched room stores no pacing field");
  assert.equal(roomPacingPolicy(f.state), null);
  const parent = f.post("potter", "An unnamed question for the room");
  // Three agent replies would exceed the default cap of 2 if pacing were on.
  f.reply("codex", parent.data.messageId);
  f.reply("instinct", parent.data.messageId);
  f.reply("third", parent.data.messageId);
  assert.equal(f.state.messages.filter(m => m.replyToId === parent.data.messageId).length, 3);
});

test("only the owner sets pacing, and the number is validated", () => {
  const f = fixture();
  assert.throws(() => f.setPacing("maya", { enabled: true }), /Only the Room owner may set room pacing policy/);
  assert.throws(() => f.setPacing("potter", { enabled: "yes" }), /enabled as true or false/);
  assert.throws(() => f.setPacing("potter", { enabled: true, maxUnnamedAgentReplies: 99 }), /maxUnnamedAgentReplies as an integer from 0 to 16/);
  assert.throws(() => f.setPacing("potter", { enabled: true, maxUnnamedAgentReplies: 1.5 }), /maxUnnamedAgentReplies/);
  f.setPacing("potter", { enabled: true });
  assert.deepEqual(roomPacingPolicy(f.state), {
    enabled: true, maxUnnamedAgentReplies: PACING_DEFAULT_MAX_UNNAMED_AGENT_REPLIES,
    revision: 1, setById: "potter", setAt: f.state.room.pacingPolicy.setAt
  }, "the default N is 2, the norm named in #661's evidence");
  assert.equal(PACING_DEFAULT_MAX_UNNAMED_AGENT_REPLIES, 2);
});

test("unnamed message: agent replies capped at the default 2, the 3rd is refused by name", () => {
  const f = fixture();
  f.setPacing("potter", { enabled: true });
  const parent = f.post("potter", "What should we do about the flaky lane?");
  f.reply("codex", parent.data.messageId, "first");
  f.reply("instinct", parent.data.messageId, "second");
  const before = f.state.messages.length;
  refused(() => f.reply("third", parent.data.messageId, "third"), "pacing_cap_exceeded");
  assert.equal(f.state.messages.length, before, "a refused reply is not recorded — and the refusal, not silence, is the signal");
  // A human reply is never governed, even past the cap.
  f.reply("maya", parent.data.messageId, "human take");
  // A different parent has its own count.
  const other = f.post("potter", "A separate unnamed question");
  f.reply("third", other.data.messageId, "fresh thread, fresh count");
});

test("unnamed cap carries the policy's number", () => {
  const f = fixture();
  f.setPacing("potter", { enabled: true, maxUnnamedAgentReplies: 1 });
  const parent = f.post("maya", "One agent answer is enough here");
  f.reply("codex", parent.data.messageId);
  refused(() => f.reply("instinct", parent.data.messageId), "pacing_cap_exceeded");
});

test("broadcast @channel: replies land in the deterministic sequence, out-of-turn refused by name", () => {
  const f = fixture();
  f.setPacing("potter", { enabled: true });
  const parent = f.post("potter", "@channel status, please");
  const parentMessage = f.state.messages.find(m => m.id === parent.data.messageId);
  const order = pacingBroadcastOrder(f.state, parentMessage);
  assert.deepEqual([...order].sort(), ["codex", "instinct", "third"], "every room agent is a responder");
  assert.deepEqual(pacingBroadcastOrder(f.state, parentMessage), order, "the order is a stable function of the parent");
  // Out of turn: the last responder may not pile in first.
  assert.throws(() => f.reply(order[2], parent.data.messageId),
    error => error.code === "pacing_out_of_turn" && error.pacing.expectedResponderId === order[0] && error.pacing.slot === 2);
  assert.throws(() => f.reply(order[1], parent.data.messageId), error => error.code === "pacing_out_of_turn");
  // In sequence, each lands.
  for (const [i, memberId] of order.entries()) f.reply(memberId, parent.data.messageId, `report ${i}`);
  assert.deepEqual(
    f.state.messages.filter(m => m.replyToId === parent.data.messageId).map(m => m.authorId), order,
    "the recorded replies are exactly the policy's sequence");
  // The sequence governs first answers; a responder may follow up after.
  f.reply(order[0], parent.data.messageId, "follow-up detail");
});

test("named message: replies to a directly-mentioned agent are not capped or sequenced", () => {
  const f = fixture();
  f.setPacing("potter", { enabled: true, maxUnnamedAgentReplies: 0 });
  const named = f.post("potter", "@Codex please look at this");
  f.reply("instinct", named.data.messageId, "not the named one, still a direct thread");
  f.reply("third", named.data.messageId);
  f.reply("codex", named.data.messageId);
  // With N=0 an unnamed parent admits no agent replies at all.
  const unnamed = f.post("potter", "nobody named here");
  refused(() => f.reply("codex", unnamed.data.messageId), "pacing_cap_exceeded");
});

test("disabling the policy restores uncapped replies; replay reproduces the paced log exactly", () => {
  const f = fixture();
  f.setPacing("potter", { enabled: true });
  const parent = f.post("potter", "@channel roll call");
  const parentMessage = f.state.messages.find(m => m.id === parent.data.messageId);
  for (const memberId of pacingBroadcastOrder(f.state, parentMessage)) f.reply(memberId, parent.data.messageId, "here");
  f.setPacing("potter", { enabled: false });
  assert.equal(roomPacingPolicy(f.state), null);
  const other = f.post("potter", "unnamed again");
  f.reply("codex", other.data.messageId);
  f.reply("instinct", other.data.messageId);
  f.reply("third", other.data.messageId);
  assert.deepEqual(replay(f.state.eventLog), f.state, "the admitted log replays identically under the reducer gate");
});

test("store surface: the policy command validates, and a refusal is a named 409", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-pacing-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data) => store.command(keys[actor], "commons", { id: randomUUID(), type, data });
  for (const memberId of ["agent-a", "agent-b", "agent-c"]) {
    send("owner", T.MEMBER_ADDED, { memberId, displayName: memberId, kind: "agent", permissions: ["steer"] });
    keys[memberId] = store.issueAccessKey("commons", memberId);
  }
  assert.throws(() => validateCommand({ id: randomUUID(), type: T.ROOM_PACING_POLICY_SET, data: { enabled: true, maxUnnamedAgentReplies: "two" } }),
    error => error.status === 422 && error.code === "invalid_command" && /Invalid field: maxUnnamedAgentReplies/.test(error.message));
  send("owner", T.ROOM_PACING_POLICY_SET, { enabled: true, maxUnnamedAgentReplies: 2 });
  const parent = send("owner", T.MESSAGE_POSTED, { messageId: "pacing-parent", body: "unnamed at store level" });
  assert.equal(parent.event.data.messageId, "pacing-parent");
  send("agent-a", T.MESSAGE_POSTED, { messageId: "pacing-r1", body: "one", replyToId: "pacing-parent" });
  send("agent-b", T.MESSAGE_POSTED, { messageId: "pacing-r2", body: "two", replyToId: "pacing-parent" });
  assert.throws(
    () => send("agent-c", T.MESSAGE_POSTED, { messageId: "pacing-r3", body: "three", replyToId: "pacing-parent" }),
    error => error.status === 409 && error.code === "pacing_cap_exceeded" && /at most 2 agent replies/.test(error.message));
  const guidance = agentErrorBody({ httpStatus: 409, code: "pacing_cap_exceeded", message: "x" });
  assert.equal(guidance.reason, "pacing_cap_exceeded");
});
