// A declined reply is a delivered reply (docs/HOST-OUTCOME-CONTRACT.md):
// the run must be able to reach `delivered` instead of staying result_ready.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const [a, b] of [["owner", "producer"], ["producer", "owner"]]) {
    f.store.dmConsents.request("commons", a, b, "test fixture");
    f.store.dmConsents.decide("commons", b, a, "approve");
  }
  const client = new RoomAgentClient({ version: 1, origin: `http://127.0.0.1:${server.address().port}`,
    roomId: "commons", memberId: "producer", token: f.keys.producer });
  const open = id => f.store.command(f.keys.owner, "commons", { id, type: "message.posted",
    data: { messageId: "question-" + id, requestKind: "reply", toMemberId: "producer", body: "Can you take this?" } }) && "question-" + id;
  return { ...f, client, open };
}

async function claimed(f, label) {
  const requestMessageId = f.open(label);
  const context = await f.client.replyContext(requestMessageId);
  const attemptId = label + "-host";
  await f.client.requestRuns({ requestMessageId, attemptId, action: "claim",
    expectedRequestRevision: context.request.revision, contextEventId: context.request.contextEventId });
  await f.client.requestRuns({ requestMessageId, attemptId, action: "result_ready" });
  const respond = outcome => f.client.replyAction("room_respond_to_request", { requestId: crypto.randomUUID(),
    responseToRequestId: context.request.id, ...context.current.answerBasis, responseOutcome: outcome,
    toMemberId: context.request.requesterId, workItemId: context.request.workItemId, body: "Not something I can do here." });
  const report = action => f.client.requestRuns({ requestMessageId, attemptId, action });
  const state = async () => (await f.client.requestRuns()).runs[requestMessageId].state;
  return { requestMessageId, respond, report, state };
}

test("declined reply: delivered is accepted and the run leaves result_ready", async t => {
  const f = await fixture(t), run = await claimed(f, "declined-delivered");
  await run.respond("declined");
  assert.equal(f.store.room("commons").state.replyRequests[run.requestMessageId].status, "declined");
  assert.equal(await run.state(), "result_ready");
  await run.report("delivered");
  assert.equal(await run.state(), "delivered");
  await assert.rejects(run.report("result_ready"), { code: "request_run_changed" });
});

test("answered still delivers; an open or cancelled request still refuses delivered", async t => {
  const f = await fixture(t);
  const answered = await claimed(f, "answered-delivered");
  await answered.respond("answered");
  await answered.report("delivered");
  assert.equal(await answered.state(), "delivered");
  const open = await claimed(f, "still-open");
  await assert.rejects(open.report("delivered"), { code: "request_run_not_delivered" });
  const cancelled = await claimed(f, "cancelled");
  const ctx = await f.client.replyContext(cancelled.requestMessageId);
  f.store.command(f.keys.owner, "commons", { id: "cancel-1", type: "reply_request.cancelled",
    data: { requestMessageId: cancelled.requestMessageId, expectedRequestRevision: ctx.request.revision, reason: "No longer needed" } });
  await assert.rejects(cancelled.report("delivered"), { code: "request_run_not_delivered" });
});
