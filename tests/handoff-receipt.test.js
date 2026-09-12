import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("handoff receipt: recorded without closing work, halt-all gates mutations until owner clears", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-handoff-receipt-"));
  const filename = join(directory, "fixture.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-producer", type: T.MEMBER_ADDED, data: {
    memberId: "producer", displayName: "producer (scripted fixture)", kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" } });
  const producerKey = store.issueAccessKey("commons", "producer");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const client = token => new RoomAgentClient({ origin, roomId: "commons", token });
  const owner = client(ownerKey), producer = client(producerKey);
  const command = (id, type, data) => ({ id, type, data });
  const item = async actor => (await actor.orient()).work.find(work => work.id === "handoff-demo");
  const rejects = async (fn, code) => {
    try { await fn(); } catch (error) { assert.equal(error.code, code); return error; }
    assert.fail(`expected ${code} rejection`);
  };

  await owner.command(command("propose", T.WORK_PROPOSED, {
    workItemId: "handoff-demo", title: "Parse feeds", definitionOfDone: "All five feeds parsed", accountableMemberId: "producer",
    mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false }));
  await producer.command(command("accept", T.WORK_ACCEPTED, { workItemId: "handoff-demo", expectedRevision: 0 }));
  await producer.command(command("start", T.WORK_STARTED, { workItemId: "handoff-demo", expectedRevision: 1 }));

  const handoff = await producer.command(command("handoff-1", T.WORK_HANDOFF_RECORDED, {
    workItemId: "handoff-demo", expectedRevision: 2,
    doneSummary: "3 of 5 feeds parsed", nextAction: "Reassign the adapter feed work", limitReason: "context window exhausted" }));
  assert.equal(handoff.duplicate, false);
  assert.equal(handoff.event.type, T.WORK_HANDOFF_RECORDED);

  const after = await item(producer);
  assert.equal(after.state, "working", "no self-close: handoff never advances the state");
  assert.equal(after.handoff.open, true);
  assert.equal(after.handoff.doneSummary, "3 of 5 feeds parsed");
  assert.equal(after.handoff.limitReason, "context window exhausted");
  assert.equal(after.handoff.nextAction, "Reassign the adapter feed work");
  assert.equal(after.handoff.actorId, "producer");
  assert.equal(after.next.action, "triaged_handoff");
  assert.equal(after.next.needsAttention, true);

  const halt = await producer.command(command("handoff-2", T.WORK_HANDOFF_RECORDED, {
    workItemId: "handoff-demo", expectedRevision: 3,
    doneSummary: "Same partial state", nextAction: "Owner reassigns everything of mine", limitReason: "provider account suspended", haltAll: true }));
  const halted = await item(producer);
  assert.equal(halted.handoff.haltAll, true);
  assert.equal(halted.handoffHistory.length, 1, "previous handoff retained");

  await rejects(() => producer.command(command("block-while-halted", T.WORK_BLOCKED, { workItemId: "handoff-demo", expectedRevision: 4, reason: "x", nextAction: "y" })), "halt_active");
  await rejects(() => producer.command(command("complete-while-halted", T.WORK_COMPLETED, { workItemId: "handoff-demo", expectedRevision: 4, summary: "s", evidenceUrl: "https://example.invalid/e", evidenceVersion: "v1", nextAction: "n" })), "halt_active");

  const boardHalted = await producer.board();
  assert.deepEqual(boardHalted.halts.map(h => h.memberId), ["producer"]);
  assert.equal(boardHalted.halts[0].reason, "provider account suspended");
  assert.equal(boardHalted.columns.handoff[0].id, "handoff-demo");
  assert.equal(boardHalted.columns.handoff[0].handoff.limitReason, "provider account suspended");

  await rejects(() => producer.command(command("clear-own", T.WORK_HALT_CLEARED, { memberId: "producer", haltEventId: halt.event.id })), "command_rejected");
  await rejects(() => owner.command(command("clear-stale", T.WORK_HALT_CLEARED, { memberId: "producer", haltEventId: handoff.event.id })), "command_rejected");

  const cleared = await owner.command(command("clear-1", T.WORK_HALT_CLEARED, { memberId: "producer", haltEventId: halt.event.id, note: "triaged: reassigned" }));
  assert.equal(cleared.duplicate, false);
  assert.deepEqual((await producer.board()).halts, []);

  await producer.command(command("block-after-clear", T.WORK_BLOCKED, { workItemId: "handoff-demo", expectedRevision: 4, reason: "resumed then blocked", nextAction: "get new credentials" }));
  const resumed = await item(producer);
  assert.equal(resumed.state, "blocked");
  assert.equal(resumed.handoff.open, false, "later lifecycle action closes the open handoff marker");
  assert.equal(resumed.next.action, "revise");

  await rejects(() => owner.command(command("clear-again", T.WORK_HALT_CLEARED, { memberId: "producer", haltEventId: halt.event.id })), "command_rejected");

  // A halted member can still record handoff receipts (documentation, not work mutation).
  await producer.command(command("resolve-after-clear", T.WORK_BLOCKER_RESOLVED, { workItemId: "handoff-demo", expectedRevision: 5, resolution: "credentials rotated" }));
  const docOnly = await producer.command(command("handoff-3", T.WORK_HANDOFF_RECORDED, {
    workItemId: "handoff-demo", expectedRevision: 6, doneSummary: "nothing further", nextAction: "close out", limitReason: "rotation broke session", haltAll: true,
    evidenceUrl: "https://example.invalid/partial", evidenceVersion: "v3" }));
  assert.equal(docOnly.event.data.evidenceUrl, "https://example.invalid/partial");
  const final = await item(producer);
  assert.equal(final.handoff.evidenceVersion, "v3");
  assert.equal(final.handoffHistory.length, 2);
  await owner.command(command("clear-2", T.WORK_HALT_CLEARED, { memberId: "producer", haltEventId: docOnly.event.id }));
});
