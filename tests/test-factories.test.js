// Q013: test data factories. Builder tests.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRoom, buildMessage, buildAgent, buildUser, buildWorkItem, resetFactories }
  from "./factories.mjs";

test("builders create frozen fixtures with overrides", () => {
  resetFactories();
  const room = buildRoom({ name: "Custom" });
  assert.equal(room.roomId, "room-1");
  assert.equal(room.name, "Custom");
  assert.ok(Object.isFrozen(room));
  const msg = buildMessage({ text: "Hi" });
  assert.equal(msg.messageId, "msg-1");
  assert.equal(msg.text, "Hi");
  const agent = buildAgent();
  assert.ok(agent.agentId.startsWith("agent-"));
  const user = buildUser();
  assert.ok(user.email.includes("@example.com"));
  const wi = buildWorkItem({ status: "done" });
  assert.equal(wi.status, "done");
});
test("resetFactories makes ids deterministic", () => {
  resetFactories();
  assert.equal(buildRoom().roomId, "room-1");
  resetFactories();
  assert.equal(buildRoom().roomId, "room-1");
});
