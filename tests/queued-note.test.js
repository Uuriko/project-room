import test from "node:test";
import assert from "node:assert/strict";
import { queuedNote } from "../src/conversation.js";

test("#5382 queuedNote says queued only for away agents with waiting mentions", () => {
  assert.equal(queuedNote({ kind: "agent", queuedWakes: 2 }, "unreachable"), "2 queued until it reconnects");
  assert.equal(queuedNote({ kind: "agent", queuedWakes: 2 }, "listening"), "");
  assert.equal(queuedNote({ kind: "agent", queuedWakes: 0 }, "unknown"), "");
  assert.equal(queuedNote({ kind: "human", queuedWakes: 3 }, "idle"), "");
});
