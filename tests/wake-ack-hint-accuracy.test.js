// REL-08: the wake ackHint must name BOTH steps. The old copy ("react 👍 to
// acknowledge") told agents a bare 👍 react clears the wake signal — it does
// not. A reaction marks the mention as responded; only POST
// /api/agent-heartbeats/ack {signalIds} (or MCP heartbeat_ack) removes the
// signal. Agents that followed the old hint kept the same stale signals in
// every poll.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildWakePing, WAKE_ACK_HINT } from "../server/outbound-webhooks.mjs";
import { AgentHeartbeats, agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";

test("the ack hint names the reaction step", () => {
  assert.match(WAKE_ACK_HINT, /react 👍/, "names the bare-👍 react");
});

test("the ack hint names the signal-clearing step", () => {
  assert.match(WAKE_ACK_HINT, /POST \/api\/agent-heartbeats\/ack/, "names the ack endpoint");
  assert.match(WAKE_ACK_HINT, /heartbeat_ack/, "names the MCP ack tool");
});

test("the ack hint says a reaction alone does not clear the wake signal", () => {
  assert.match(WAKE_ACK_HINT, /does not (clear|remove)/i, "corrects the old one-tap-ack reading");
});

test("buildWakePing and journaled signals carry the accurate hint", () => {
  const signal = { signalId: "ws_1", agentId: "ai_x", kind: "mention", roomId: "r", messageId: "m" };
  const payload = buildWakePing({ agentId: "ai_x", signal });
  assert.equal(payload.ackHint, WAKE_ACK_HINT);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(agentHeartbeatSchema);
    const hb = new AgentHeartbeats({ db, now: () => 1700000000000 });
    const { signal: journaled } = hb.enqueueWake({ agentId: "ai_x", kind: "mention", roomId: "r", messageId: "m" });
    assert.equal(journaled.ackHint, WAKE_ACK_HINT);
  } finally {
    db.close();
  }
});
