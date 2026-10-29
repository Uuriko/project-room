import test from "node:test";
import assert from "node:assert/strict";
import { readAgentAudit } from "../server/agent-audit.mjs";

const SECRET = "privbody-7f3a9c";
const owner = { memberId: "owner" };
const agent = { memberId: "agent-a" };
const other = { memberId: "human-b", isOwner: true, ownerId: "human-b" };

const roomState = {
  room: { ownerId: "owner", visibility: "public", private: false },
  members: { owner: { id: "owner", identityId: "id-owner" } },
  channels: {
    general: { id: "general", name: "general" },
    "ch-secret": { id: "ch-secret", private: true, memberIds: ["agent-a", "human-b"], createdBy: "owner" },
    "ch-owner": { id: "ch-owner", visibility: "private", members: { owner: { id: "owner" }, "agent-a": { id: "agent-a" } } },
  },
  messages: [
    { id: "m-edited", authorId: "agent-a", toMemberId: "human-b", channelId: "general" },
    { id: "m-hidden-chan", authorId: "agent-a", channelId: "ch-secret", toMemberId: null },
    { id: "m-chan-owner", authorId: "agent-a", channelId: "ch-owner", toMemberId: null },
  ],
};

function assertNoSecret(value) {
  assert.equal(JSON.stringify(value).includes(SECRET), false);
}

function oneNext(result) {
  assert.equal(result.ok, false);
  assert.equal(result.next.length, 1);
  assert.equal(result.body.next.length, 1);
  assert.equal(result.next[0].command, result.body.next[0].command);
  assert.equal(result.next[0].command.length > 0, true);
  assert.equal(result.hint.length > 0, true);
  assertNoSecret(result);
}

const mixed = [
  { sequence: 2, id: "e2", type: "message.posted", actorId: "agent-a", at: "2026-10-25T00:00:02.000Z", roomId: "room-1",
    data: { messageId: "m2", body: SECRET, text: SECRET, note: SECRET, toMemberId: "human-b", channelId: "general" } },
  { sequence: 1, id: "e1", type: "work.completed", actorId: "agent-a", at: "2026-10-25T00:00:01.000Z", roomId: "room-1",
    data: { workItemId: "w1", state: "completed", body: SECRET, result: `note ${SECRET}` } },
  { sequence: 3, id: "e3", type: "message.posted", actorId: "other", at: "2026-10-25T00:00:03.000Z", roomId: "room-1",
    data: { messageId: "m3", body: SECRET } },
];

test("the owner is state.room.ownerId, and a caller isOwner flag is not authority", () => {
  const asOwner = readAgentAudit({ viewer: owner, memberId: "agent-a", events: mixed, state: roomState });
  const asAgent = readAgentAudit({ viewer: agent, memberId: "agent-a", events: mixed, state: roomState });
  assert.deepEqual(asAgent, asOwner);
  assert.deepEqual(asOwner.actions, [
    { time: "2026-10-25T00:00:02.000Z", action: "message.posted", target: null, result: "posted" },
    { time: "2026-10-25T00:00:01.000Z", action: "work.completed", target: "w1", result: "completed" },
  ]);
  assert.equal(JSON.stringify(asOwner).includes("m2"), false);
  assert.equal(JSON.stringify(asOwner).includes("human-b"), false);
  assertNoSecret(asOwner);
  const flaggedPublic = readAgentAudit({
    viewer: owner, memberId: "agent-a", events: mixed, state: roomState,
    room: { visibility: "public", private: false },
  });
  assert.equal(flaggedPublic.actions[0].target, null);
  const claimed = readAgentAudit({ viewer: other, memberId: "agent-a", events: mixed, state: roomState });
  oneNext(claimed);
  assert.equal(claimed.status, 403);
  assert.equal(claimed.code, "agent_audit_forbidden");
  const noRoom = readAgentAudit({
    viewer: { memberId: "owner", isOwner: true, ownerId: "owner" },
    memberId: "agent-a", events: mixed,
  });
  oneNext(noRoom);
  assert.equal(noRoom.status, 403);
});

test("DM and private-channel actions omit target ids unless the owner is a member", () => {
  const events = [
    { sequence: 1, id: "e1", type: "message.posted", actorId: "agent-a", at: "2026-10-25T00:00:01.000Z",
      data: { messageId: "m-dm", toMemberId: "human-b", channelId: "ch-owner", body: SECRET } },
    { sequence: 2, id: "e2", type: "message.posted", actorId: "agent-a", at: "2026-10-25T00:00:02.000Z",
      data: { messageId: "m-to-owner", toMemberId: "owner", body: SECRET } },
    { sequence: 3, id: "e3", type: "message.edited", actorId: "agent-a", at: "2026-10-25T00:00:03.000Z",
      data: { messageId: "m-edited", body: SECRET } },
    { sequence: 4, id: "e4", type: "message.deleted", actorId: "agent-a", at: "2026-10-25T00:00:04.000Z",
      data: { messageId: "m-dm" } },
    { sequence: 5, id: "e5", type: "message.posted", actorId: "agent-a", at: "2026-10-25T00:00:05.000Z",
      data: { messageId: "m-secret", channelId: "ch-secret", body: SECRET } },
    { sequence: 6, id: "e6", type: "work.updated", actorId: "agent-a", at: "2026-10-25T00:00:06.000Z",
      data: { workItemId: "w-secret", channelId: "ch-secret", state: "working", body: SECRET } },
    { sequence: 7, id: "e7", type: "work.updated", actorId: "agent-a", at: "2026-10-25T00:00:07.000Z",
      data: { workItemId: "w-owner", channelId: "ch-owner", state: "working" } },
    { sequence: 8, id: "e8", type: "message.posted", actorId: "agent-a", at: "2026-10-25T00:00:08.000Z",
      data: { messageId: "m-public", channelId: "general", body: SECRET } },
    { sequence: 9, id: "e9", type: "dm.posted", actorId: "agent-a", at: "2026-10-25T00:00:09.000Z",
      data: { messageId: "m-peer-other", fromIdentityId: "id-agent", toIdentityId: "id-other", body: SECRET } },
    { sequence: 10, id: "e10", type: "dm.posted", actorId: "agent-a", at: "2026-10-25T00:00:10.000Z",
      data: { messageId: "m-peer-owner", fromIdentityId: "id-agent", toIdentityId: "id-owner", body: SECRET } },
    { sequence: 11, id: "e11", type: "message.redacted", actorId: "agent-a", at: "2026-10-25T00:00:11.000Z",
      data: { messageId: "m-hidden-chan", body: SECRET } },
    { sequence: 12, id: "e12", type: "message.redacted", actorId: "agent-a", at: "2026-10-25T00:00:12.000Z",
      data: { messageId: "m-chan-owner" } },
  ];
  const privateRoom = { ...roomState, room: { ownerId: "owner", visibility: "private", private: true } };
  const asOwner = readAgentAudit({ viewer: owner, memberId: "agent-a", events, state: privateRoom });
  const asAgent = readAgentAudit({ viewer: agent, memberId: "agent-a", events, state: privateRoom });
  assert.deepEqual(asAgent.actions, asOwner.actions);
  const byAction = Object.fromEntries(asOwner.actions.map(row => [row.time, row]));
  assert.equal(byAction["2026-10-25T00:00:01.000Z"].target, null);
  assert.equal(byAction["2026-10-25T00:00:02.000Z"].target, "m-to-owner");
  assert.equal(byAction["2026-10-25T00:00:03.000Z"].target, null);
  assert.equal(byAction["2026-10-25T00:00:03.000Z"].result, "edited");
  assert.equal(byAction["2026-10-25T00:00:04.000Z"].target, null);
  assert.equal(byAction["2026-10-25T00:00:05.000Z"].target, null);
  assert.equal(byAction["2026-10-25T00:00:05.000Z"].result, "posted");
  assert.equal(byAction["2026-10-25T00:00:06.000Z"].target, null);
  assert.equal(byAction["2026-10-25T00:00:06.000Z"].result, "working");
  assert.equal(byAction["2026-10-25T00:00:07.000Z"].target, "w-owner");
  assert.equal(byAction["2026-10-25T00:00:08.000Z"].target, "m-public");
  assert.equal(byAction["2026-10-25T00:00:09.000Z"].target, null);
  assert.equal(byAction["2026-10-25T00:00:10.000Z"].target, "m-peer-owner");
  assert.equal(byAction["2026-10-25T00:00:11.000Z"].target, null);
  assert.equal(byAction["2026-10-25T00:00:11.000Z"].result, "redacted");
  assert.equal(byAction["2026-10-25T00:00:12.000Z"].target, "m-chan-owner");
  const page = JSON.stringify(asOwner);
  for (const hidden of ["m-dm", "m-edited", "m-secret", "m-hidden-chan", "w-secret", "m-peer-other", "ch-secret", "human-b", "id-other", SECRET]) {
    assert.equal(page.includes(hidden), false, hidden);
  }
  assertNoSecret(asOwner);
});

test("pages cover one actor in order, and a bad cursor or page size is a 422 with one next step", () => {
  const events = [];
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    events.push({ sequence, id: `e${sequence}`, type: "work.accepted", actorId: "agent-a", at: `2026-10-25T00:00:0${sequence}.000Z`, data: { workItemId: `w${sequence}`, state: "accepted" } });
  }
  events.push({ sequence: 9, id: "other", type: "work.accepted", actorId: "other", at: "2026-10-25T00:00:09.000Z", data: { workItemId: "w9", state: "accepted", body: SECRET } });
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = readAgentAudit({ viewer: owner, memberId: "agent-a", events, cursor, limit: 2, state: roomState });
    assertNoSecret(page);
    seen.push(...page.actions);
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages < 5);
  } while (cursor);
  assert.deepEqual(seen.map(row => row.target), ["w5", "w4", "w3", "w2", "w1"]);
  const badCursor = readAgentAudit({ viewer: owner, memberId: "agent-a", events, cursor: "%%%", state: roomState });
  oneNext(badCursor);
  assert.equal(badCursor.status, 422);
  assert.equal(badCursor.code, "invalid_audit_cursor");
  const badLimit = readAgentAudit({ viewer: owner, memberId: "agent-a", events, limit: 1001, state: roomState });
  oneNext(badLimit);
  assert.equal(badLimit.status, 422);
  assert.equal(badLimit.code, "invalid_audit_limit");
});

test("receipt rows, event-page rows, and raw events project the same action", () => {
  const event = { id: "e1", type: "work.completed", roomId: "room-1", actorId: "agent-a", at: "2026-10-25T00:00:01.000Z", data: { workItemId: "w1", state: "completed", body: SECRET } };
  const shapes = [
    [{ sequence: 4, event }],
    [{ seq: 4, entry: { sequence: 4, event } }],
    [{ ...event, sequence: 4 }],
  ];
  const pages = shapes.map(events => readAgentAudit({ viewer: agent, memberId: "agent-a", events }));
  assert.deepEqual(pages[1].actions, pages[0].actions);
  assert.deepEqual(pages[2].actions, pages[0].actions);
  assert.deepEqual(pages[0].actions, [
    { time: event.at, action: "work.completed", target: "w1", result: "completed" },
  ]);
  assert.equal(pages[0].nextCursor, null);
  assertNoSecret(pages[0]);
});

test("a read of 1000 actions stays under 20ms p95", () => {
  const events = [];
  for (let sequence = 1; sequence <= 1000; sequence += 1) {
    events.push({
      sequence, id: `e${sequence}`, type: "work.updated", actorId: "agent-a",
      at: "2026-10-25T00:00:00.000Z", data: { workItemId: `w${sequence % 17}`, state: "working", body: "x".repeat(40) },
    });
  }
  const read = () => readAgentAudit({ viewer: owner, memberId: "agent-a", events, limit: 1000, state: roomState });
  for (let i = 0; i < 3; i += 1) read();
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const start = performance.now();
    const page = read();
    samples.push(performance.now() - start);
    if (i === 0) assert.equal(page.actions.length, 1000);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
  console.log(`agent-audit 1000 actions p95 ${p95.toFixed(3)} ms`);
  assert.ok(p95 < 20, `p95 ${p95.toFixed(3)} ms`);
});
