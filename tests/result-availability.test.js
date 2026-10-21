import test from "node:test";
import assert from "node:assert/strict";
import { canReplyToResult } from "../src/result-availability.js";

test("shared result replies require a live public message and writable room/channel", () => {
  const message = { id: "result", channelId: "design" };
  const state = { room: {}, channels: { design: {} } };
  assert.equal(canReplyToResult(state, message), true);
  for (const changed of [{ ...message, deletedAt: 1 }, { ...message, toMemberId: "private" }, null]) assert.equal(canReplyToResult(state, changed), false);
  assert.equal(canReplyToResult({ ...state, room: { archivedAt: "2026-10-19T00:00:00Z" } }, message), false);
  assert.equal(canReplyToResult({ ...state, channels: { design: { archivedAt: 1 } } }, message), false);
});
