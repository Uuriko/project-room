import test from "node:test";
import assert from "node:assert/strict";
import { sessionRunView, SESSION_HEARTBEAT_STALE_MS } from "../src/work-item-session.js";
import { confirmsWorkAction } from "../src/workflow.js";
import { createHash } from "node:crypto";
const now = Date.now(), item = { id: "work", state: "proposed", accountableMemberId: "agent", status: "processing",
  worker_member_id: "agent", heartbeat_at: new Date(now).toISOString() };
const member = { id: "owner", active: true, permissions: ["steer"] };

test("session view hides unused runs and separates requested stop, stale report and terminal state", () => {
  assert.equal(sessionRunView({ ...item, status: "queued" }, member, now), null);
  assert.equal(sessionRunView(item, member, now).label, "Run in progress");
  const stopped = sessionRunView({ ...item, stop_requested_at: new Date(now).toISOString() }, member, now);
  assert.equal(stopped.label, "Stop requested"); assert.equal(stopped.canStop, false);
  assert.equal(sessionRunView(item, member, now + SESSION_HEARTBEAT_STALE_MS + 1).label, "Run unconfirmed");
  const done = sessionRunView({ ...item, status: "done" }, member, now);
  assert.equal(done.label, "Run ended"); assert.equal(done.canStop, false);
  assert.match(done.detail, /reviewed separately/);
});

test("stop affordance follows accountable-or-steerer permission and active membership", () => {
  assert.equal(sessionRunView(item, member, now).canStop, true);
  assert.equal(sessionRunView(item, { id: "agent", active: true, permissions: ["accept_work"] }, now).canStop, true);
  for (const denied of [{ ...member, active: false }, { ...member, permissions: [] }, { id: "other", active: true, permissions: ["accept_work"] }])
    assert.equal(sessionRunView(item, denied, now).canStop, false);
  assert.equal(sessionRunView({ ...item, supersededBy: "new" }, member, now).canStop, false);
});

test("browser stop confirmation requires the exact event and business identity", async () => {
  const command = { id: "stop", type: "session.stop_requested", data: { workItemId: "work", expectedRevision: 1 } };
  const receipt = { sequence: 2, duplicate: false, event: { id: "event", type: command.type, data: command.data,
    actorId: "owner", roomId: "room", causationId: null, at: new Date(now).toISOString(),
    idempotencyKey: createHash("sha256").update("owner:stop").digest("hex") } };
  assert.equal(await confirmsWorkAction(receipt, command, "room", "owner"), true);
  assert.equal(await confirmsWorkAction({ ...receipt, event: { ...receipt.event, actorId: "agent" } }, command, "room", "owner"), false);
  assert.equal(await confirmsWorkAction(receipt, { ...command, data: { ...command.data, expectedRevision: 2 } }, "room", "owner"), false);
});
