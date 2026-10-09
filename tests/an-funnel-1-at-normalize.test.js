// Worker-33 (guild-06 shard 33): fail-first regression for an-funnel-1's
// message-timestamp normalization. The script Date.parse()s every
// message.posted body.at, so a numeric epoch-ms timestamp (written by a
// fixture or another event producer) parses to NaN and the message is
// silently dropped from the funnel (only a coverage counter hints at it).
// normalizeMessageAt must accept finite numbers as epoch ms and ISO strings.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMessageAt } from "../scripts/an-funnel-1.mjs";

test("normalizeMessageAt parses ISO strings", () => {
  assert.equal(normalizeMessageAt("2026-10-09T12:00:00.000Z"), Date.parse("2026-10-09T12:00:00.000Z"));
});

test("normalizeMessageAt passes numeric epoch-ms through", () => {
  const ms = 1781000000000;
  assert.equal(normalizeMessageAt(ms), ms, "numeric at must not be silently dropped");
});

test("normalizeMessageAt rejects garbage", () => {
  assert.ok(Number.isNaN(normalizeMessageAt("not a date")));
  assert.ok(Number.isNaN(normalizeMessageAt(null)));
  assert.ok(Number.isNaN(normalizeMessageAt(Number.NaN)));
});
