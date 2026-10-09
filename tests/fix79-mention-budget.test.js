import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { resolveMentionTargetsCapped, MAX_MENTIONS_PER_MESSAGE } from "../server/mention-lifecycle.mjs";
import { createMentionBudgetRegistry, MENTION_NOTIFICATION_BUDGET, MENTION_NOTIFICATION_WINDOW_MS } from "../server/mention-budgets.mjs";

// FIX-79: mention/notification budgets — per-message mention caps plus
// per-sender notification budgets. Fail-first: these fail before the
// implementation (no cap, no budget, no mentionBudget on the response).
const MEMBER_COUNT = 25; // > MAX_MENTIONS_PER_MESSAGE (20)

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-fix79-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  const ids = [];
  for (let i = 1; i <= MEMBER_COUNT; i++) {
    const memberId = `m${String(i).padStart(2, "0")}`;
    ids.push(memberId);
    send("owner", T.MEMBER_ADDED, { memberId, displayName: `Member ${i}`, kind: "human", permissions: [] });
  }
  send("owner", T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] });
  keys.maya = store.issueAccessKey("commons", "maya");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, send, ids };
}

const mentionBody = ids => ids.map(id => `@${id}`).join(" ");
const mentionRows = store =>
  store.db.prepare("SELECT COUNT(*) AS n FROM mention_states WHERE room_id=?").get("commons").n;

test("per-message mention cap: fanout truncated to 20 with a note, post still lands", t => {
  const f = setup(t);
  const result = f.send("owner", T.MESSAGE_POSTED, { messageId: "bomb1", body: mentionBody(f.ids) });
  assert.ok(result.sequence, "the post itself lands (no 422/429)");
  assert.equal(mentionRows(f.store), MAX_MENTIONS_PER_MESSAGE,
    `mention fanout bounded at the cap (got ${mentionRows(f.store)} rows for ${MEMBER_COUNT} mentions)`);
  const budget = result.mentionBudget;
  assert.ok(budget, "truncation is reported on the command response");
  assert.equal(budget.truncated, true);
  assert.equal(budget.totalResolved, MEMBER_COUNT);
  assert.equal(budget.delivered, MAX_MENTIONS_PER_MESSAGE);
  assert.equal(budget.cap, MAX_MENTIONS_PER_MESSAGE);
  assert.match(budget.note, /truncat/i);
});

test("resolveMentionTargetsCapped: first-appearance order, frozen", () => {
  const members = {};
  for (let i = 1; i <= 25; i++) members[`m${i}`] = { displayName: `M${i}`, kind: "human", active: true };
  const text = Array.from({ length: 25 }, (_, i) => `@m${25 - i}`).join(" ");
  const { targets, totalResolved, truncated } = resolveMentionTargetsCapped(members, {}, text, "owner");
  assert.equal(totalResolved, 25);
  assert.equal(truncated, true);
  assert.equal(targets.length, MAX_MENTIONS_PER_MESSAGE);
  assert.deepEqual(targets.slice(0, 3), ["m25", "m24", "m23"], "first appearance wins");
  assert.ok(Object.isFrozen(targets));
});

test("per-sender notification budget: a mention-bomber is shed after the window budget, post still lands", t => {
  const f = setup(t);
  const twenty = f.ids.slice(0, MAX_MENTIONS_PER_MESSAGE);
  const body = mentionBody(twenty);
  const perMessage = MENTION_NOTIFICATION_BUDGET / MAX_MENTIONS_PER_MESSAGE; // 5 fully-loaded messages
  let last;
  for (let i = 0; i < perMessage + 1; i++) {
    last = f.send("owner", T.MESSAGE_POSTED, { messageId: `spam${i}`, body });
  }
  assert.equal(mentionRows(f.store), MENTION_NOTIFICATION_BUDGET,
    "only the budgeted notifications were minted");
  assert.ok(last.sequence, "the over-budget post still lands");
  assert.ok(last.mentionBudget, "budget shed is reported on the response");
  assert.equal(last.mentionBudget.shedByBudget, MAX_MENTIONS_PER_MESSAGE);
  assert.match(last.mentionBudget.note, /budget/i);
});

test("per-sender notification budget: one bomber never spends another sender's budget", t => {
  const f = setup(t);
  const twenty = f.ids.slice(0, MAX_MENTIONS_PER_MESSAGE);
  const body = mentionBody(twenty);
  const perMessage = MENTION_NOTIFICATION_BUDGET / MAX_MENTIONS_PER_MESSAGE;
  for (let i = 0; i < perMessage + 1; i++) {
    f.send("owner", T.MESSAGE_POSTED, { messageId: `spam${i}`, body });
  }
  const before = mentionRows(f.store);
  const result = f.send("maya", T.MESSAGE_POSTED, { messageId: "maya1", body: "@m01 @m02" });
  assert.equal(mentionRows(f.store), before + 2, "another sender's budget is untouched");
  assert.equal(result.mentionBudget, undefined, "no budget note when under budget and under cap");
});

test("mention budget registry: window refill restores credits", () => {
  let now = 1_000_000;
  const registry = createMentionBudgetRegistry({ now: () => now });
  const key = { roomId: "r", senderId: "s", now };
  assert.deepEqual(registry.consume({ ...key, count: MENTION_NOTIFICATION_BUDGET }), { allowed: MENTION_NOTIFICATION_BUDGET, shed: 0 });
  assert.deepEqual(registry.consume({ ...key, count: 1 }), { allowed: 0, shed: 1 });
  now += MENTION_NOTIFICATION_WINDOW_MS; // a full window passes
  assert.deepEqual(registry.consume({ roomId: "r", senderId: "s", now, count: MENTION_NOTIFICATION_BUDGET }),
    { allowed: MENTION_NOTIFICATION_BUDGET, shed: 0 });
});
