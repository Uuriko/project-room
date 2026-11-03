import test from "node:test";
import assert from "node:assert/strict";
import { workStatusChip } from "../server/work-status-chip.mjs";

const W = "w1";
let n = 0;
const ev = (type, data = {}) => ({ id: `e${++n}`, type, at: `2026-11-03T22:00:${String(n).padStart(2, "0")}Z`, data: { workItemId: W, ...data } });

test("every chip names its source event", () => {
  const events = [ev("work.proposed")];
  assert.deepEqual(workStatusChip(events, W), { state: "received", sourceEventId: events[0].id, sourceType: "work.proposed", at: events[0].at });
});

test("claimed is not started", () => {
  const p = ev("work.proposed"), a = ev("work.accepted"), c = ev("claim.acquired");
  assert.equal(workStatusChip([p, a], W).state, "claimed");
  assert.equal(workStatusChip([p, a, c], W).sourceEventId, a.id, "a later claim does not move a claimed chip");
  const s = ev("work.started");
  assert.deepEqual([workStatusChip([p, a, c, s], W).state, workStatusChip([p, a, c, s], W).sourceEventId], ["started", s.id]);
  assert.equal(workStatusChip([p, a, s, ev("claim.renewed")], W).state, "started", "claim renewal never regresses");
});

test("a saved result is not reviewed; only a verification of the latest completion is", () => {
  const p = ev("work.proposed"), s = ev("work.started"), done = ev("work.completed");
  assert.equal(workStatusChip([p, s, done], W).state, "result_saved");
  const wrong = ev("verification.recorded", { completionEventId: "other", result: "pass" });
  assert.equal(workStatusChip([p, s, done, wrong], W).state, "result_saved");
  const v = ev("verification.recorded", { completionEventId: done.id, result: "pass" });
  const chip = workStatusChip([p, s, done, v], W);
  assert.deepEqual([chip.state, chip.sourceEventId, chip.result], ["reviewed", v.id, "pass"]);
});

test("reopened work drops the stale result and review", () => {
  const s = ev("work.started"), d1 = ev("work.completed"), v1 = ev("verification.recorded", { completionEventId: d1.id });
  const again = ev("work.started");
  assert.equal(workStatusChip([s, d1, v1, again], W).state, "started");
  const d2 = ev("work.completed");
  const late = ev("verification.recorded", { completionEventId: d1.id });
  assert.equal(workStatusChip([s, d1, v1, again, d2, late], W).state, "result_saved", "review of the old completion is stale");
});

test("waiting holds until the blocker resolves, then restores the prior chip", () => {
  const s = ev("work.started"), b = ev("work.blocked");
  assert.equal(workStatusChip([s, b], W).state, "waiting");
  const r = ev("work.blocker_resolved");
  const chip = workStatusChip([s, b, r], W);
  assert.deepEqual([chip.state, chip.sourceEventId], ["started", s.id]);
});

test("ignores other work items and returns null with no events", () => {
  assert.equal(workStatusChip([{ ...ev("work.started"), data: { workItemId: "other" } }], W), null);
  assert.equal(workStatusChip([], W), null);
});

test("hosted room_read_work carries the chip with its source event", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RoomStore } = await import("../server/store.mjs");
  const { legacyAgentRoom } = await import("./helpers/legacy-agent-room.mjs");
  const { callHostedStdioTool } = await import("../server/mcp-full-profile.mjs");
  const dir = mkdtempSync(join(tmpdir(), "chip-")), store = new RoomStore(join(dir, "room.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = store.identities.create("Owen");
  legacyAgentRoom(store, owner, { roomId: "r", title: "T", purpose: "chip", kind: "personal", displayName: "Owner" });
  const send = (type, data) => store.command(owner.secret, "r", { id: crypto.randomUUID(), type, data });
  send("work.proposed", { workItemId: "task", title: "Task", definitionOfDone: "Do it", mode: "read", accountableMemberId: owner.identityId });
  const read = async () => (await callHostedStdioTool(store, owner.secret, "room_read_work", { roomId: "r", workItemId: "task" })).value;
  assert.equal((await read()).statusChip.state, "received");
  const accepted = send("work.accepted", { workItemId: "task" });
  const chip = (await read()).statusChip;
  assert.equal(chip.state, "claimed", "accepted is claimed, not started");
  assert.equal(chip.sourceType, "work.accepted");
  assert.equal(chip.sourceEventId, accepted.event?.id ?? chip.sourceEventId);
});
