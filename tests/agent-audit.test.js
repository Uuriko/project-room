import test from "node:test";
import assert from "node:assert/strict";
import { readAgentAudit } from "../server/agent-audit.mjs";

const SECRET = "privbody-7f3a9c";
const owner = { memberId: "owner", isOwner: true };
const agent = { memberId: "agent-a", isOwner: false };
const other = { memberId: "human-b", isOwner: false };

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
    data: { messageId: "m2", body: SECRET, text: SECRET, note: SECRET, toMemberId: "human-b" } },
  { sequence: 1, id: "e1", type: "work.completed", actorId: "agent-a", at: "2026-10-25T00:00:01.000Z", roomId: "room-1",
    data: { workItemId: "w1", state: "completed", body: SECRET, result: `note ${SECRET}` } },
  { sequence: 3, id: "e3", type: "message.posted", actorId: "other", at: "2026-10-25T00:00:03.000Z", roomId: "room-1",
    data: { messageId: "m3", body: SECRET } },
];

test("the owner and the agent read the same audit, and another member gets 403 with one next step", () => {
  const room = { visibility: "private", private: true };
  const asOwner = readAgentAudit({ viewer: owner, memberId: "agent-a", events: mixed, room });
  const asAgent = readAgentAudit({ viewer: agent, memberId: "agent-a", events: mixed, room });
  assert.deepEqual(asAgent, asOwner);
  assert.deepEqual(asOwner.actions, [
    { time: "2026-10-25T00:00:02.000Z", action: "message.posted", target: null, result: "posted" },
    { time: "2026-10-25T00:00:01.000Z", action: "work.completed", target: "w1", result: "completed" },
  ]);
  assertNoSecret(asOwner);
  const visible = readAgentAudit({ viewer: owner, memberId: "agent-a", events: mixed, room: { visibility: "public" } });
  assert.equal(visible.actions[0].target, "m2");
  assert.equal(visible.actions[0].result, "posted");
  assertNoSecret(visible);
  const denied = readAgentAudit({ viewer: other, memberId: "agent-a", events: mixed, room });
  oneNext(denied);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "agent_audit_forbidden");
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
    const page = readAgentAudit({ viewer: owner, memberId: "agent-a", events, cursor, limit: 2 });
    assertNoSecret(page);
    seen.push(...page.actions);
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages < 5);
  } while (cursor);
  assert.deepEqual(seen.map(row => row.target), ["w5", "w4", "w3", "w2", "w1"]);
  const badCursor = readAgentAudit({ viewer: owner, memberId: "agent-a", events, cursor: "%%%" });
  oneNext(badCursor);
  assert.equal(badCursor.status, 422);
  assert.equal(badCursor.code, "invalid_audit_cursor");
  const badLimit = readAgentAudit({ viewer: owner, memberId: "agent-a", events, limit: 1001 });
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
  const read = () => readAgentAudit({ viewer: owner, memberId: "agent-a", events, limit: 1000 });
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
