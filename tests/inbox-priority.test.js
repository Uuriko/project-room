// LANE B: priority scoring + ranked queue tests (pure, fixture-driven).
import test from "node:test";
import assert from "node:assert/strict";
import { scoreMessage, rankQueue, PriorityError, DEFAULT_WEIGHTS } from "../server/inbox-priority.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof PriorityError && error.code === code);

const NOW = 1_750_000_000_000;
const H = 3600_000;
const base = (over = {}) => ({ id: "m1", sender: "a@x.com", receivedAt: NOW - H, ...over });

test("score components and tiers", () => {
  const result = scoreMessage(base({ sender: "vip@x.com", body: "hey @quill look", deadlineAt: NOW + H, read: false }), {
    vipSenders: new Set(["vip@x.com"]),
    mentionTokens: ["@quill"],
    now: NOW,
  });
  assert.equal(result.messageId, "m1");
  assert.equal(result.components.vip, DEFAULT_WEIGHTS.vip);
  assert.equal(result.components.mention, DEFAULT_WEIGHTS.mention);
  assert.ok(result.components.sla > 0 && result.components.sla < DEFAULT_WEIGHTS.sla);
  assert.ok(result.components.staleness > 0);
  assert.equal(result.tier, "urgent");
  assert.ok(result.signals.vip);
  assert.ok(result.signals.mentioned);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.components));
});

test("low-signal message scores low", () => {
  const result = scoreMessage(base({ read: true }), { now: NOW });
  assert.equal(result.score, 0);
  assert.equal(result.tier, "low");
});

test("SLA urgency: overdue is max, distant deadline is ~0", () => {
  const overdue = scoreMessage(base({ deadlineAt: NOW - H }), { now: NOW });
  assert.equal(overdue.components.sla, DEFAULT_WEIGHTS.sla);
  const distant = scoreMessage(base({ deadlineAt: NOW + 30 * 24 * H, read: true }), { now: NOW });
  assert.ok(distant.components.sla < 1);
});

test("staleness saturates at 72h and ignores read messages", () => {
  const stale = scoreMessage(base({ receivedAt: NOW - 200 * H }), { now: NOW });
  assert.equal(stale.components.staleness, DEFAULT_WEIGHTS.staleness);
  const read = scoreMessage(base({ receivedAt: NOW - 200 * H, read: true }), { now: NOW });
  assert.equal(read.components.staleness, 0);
});

test("mention tokens match case-insensitively; custom weights apply", () => {
  const result = scoreMessage(base({ body: "Hello @Quill, hi" }), { mentionTokens: ["@quill"], now: NOW });
  assert.ok(result.signals.mentioned);
  const custom = scoreMessage(base({ sender: "vip@x.com" }), { vipSenders: ["vip@x.com"], weights: { vip: 10 }, now: NOW });
  assert.equal(custom.components.vip, 10);
  throwsCode(() => scoreMessage(base(), { weights: { vip: -1 }, now: NOW }), "PRIO_INVALID_INPUT");
});

test("rankQueue orders by score, ties break oldest-first", () => {
  const vip = base({ id: "vip", sender: "vip@x.com", receivedAt: NOW - H });
  const old = base({ id: "old", sender: "b@x.com", receivedAt: NOW - 50 * H });
  const fresh = base({ id: "fresh", sender: "c@x.com", receivedAt: NOW - H });
  const ranked = rankQueue([fresh, old, vip], { vipSenders: new Set(["vip@x.com"]), now: NOW });
  assert.deepEqual(ranked.map(r => r.messageId), ["vip", "old", "fresh"]);
  assert.ok(Object.isFrozen(ranked));
  // every entry carries its own frozen breakdown
  assert.ok(ranked.every(r => Object.isFrozen(r.components)));
});

test("scoreMessage validation", () => {
  throwsCode(() => scoreMessage(null, { now: NOW }), "PRIO_INVALID_INPUT");
  throwsCode(() => scoreMessage({ id: "" }, { now: NOW }), "PRIO_INVALID_INPUT");
  throwsCode(() => scoreMessage(base({ deadlineAt: "soon" }), { now: NOW }), "PRIO_INVALID_INPUT");
  throwsCode(() => scoreMessage(base({ receivedAt: "yesterday" }), { now: NOW }), "PRIO_INVALID_INPUT");
  throwsCode(() => scoreMessage(base(), { mentionTokens: "x", now: NOW }), "PRIO_INVALID_INPUT");
  throwsCode(() => scoreMessage(base(), { now: "soon" }), "PRIO_INVALID_INPUT");
  throwsCode(() => rankQueue("nope", { now: NOW }), "PRIO_INVALID_INPUT");
});
