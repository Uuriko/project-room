import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("local API handoff: distinct scripted clients, revision correction, restart, review and human decision", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-handoff-contract-"));
  const filename = join(directory, "fixture.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const [memberId, permissions] of [["producer", ["accept_work", "complete_work"]], ["reviewer", ["verify"]]]) {
    store.command(ownerKey, "commons", { id: `add-${memberId}`, type: T.MEMBER_ADDED, data: {
      memberId, displayName: `${memberId} (scripted fixture)`, kind: "agent", permissions, accountableHumanId: "owner"
    } });
  }
  const producerKey = store.issueAccessKey("commons", "producer"), reviewerKey = store.issueAccessKey("commons", "reviewer");
  let server;
  const start = async () => {
    server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); };
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  let origin = await start();
  const client = token => new RoomAgentClient({ origin, roomId: "commons", token });
  let owner = client(ownerKey), producer = client(producerKey), reviewer = client(reviewerKey);
  const command = (id, type, data) => ({ id, type, data });
  const item = async actor => (await actor.orient()).work.find(work => work.id === "handoff");
  const mutate = async (actor, id, type, data = {}) => actor.command(command(id, type, { workItemId: "handoff", expectedRevision: (await item(actor)).revision, ...data }));
  await owner.command(command("source", T.MESSAGE_POSTED, { messageId: "request", body: "Prepare a short agenda that names its owner." }));
  await owner.command(command("propose", T.WORK_PROPOSED, {
    workItemId: "handoff", title: "Local handoff fixture", definitionOfDone: "A short agenda naming its owner, checked at the exact submitted version.",
    accountableMemberId: "producer", verifierMemberId: "reviewer", independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: "owner", sourceMessageId: "request", mode: "read"
  }));
  assert.equal((await item(producer)).next.action, "accept");
  await mutate(producer, "accept", T.WORK_ACCEPTED);
  await mutate(producer, "start", T.WORK_STARTED);
  assert.equal((await item(producer)).next.needsAttention, false, "running work does not repeatedly request attention");
  const version = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const submit = async (id, text) => mutate(producer, id, T.WORK_COMPLETED, {
    summary: text, evidenceVersion: version(text), producerId: "producer",
    evidenceUrl: "https://example.invalid/explicitly-synthetic-handoff-fixture", nextAction: "Review the text contained in this receipt; the fixture URL is not live."
  });
  await submit("draft-1", "Agenda: discuss the proposal.");
  let received = await item(reviewer);
  assert.equal(received.next.action, "verify");
  assert.equal(received.receipt.evidenceVersion, version(received.receipt.summary));
  await mutate(reviewer, "finding", T.VERIFICATION_RECORDED, {
    result: "fail", completionEventId: received.receipt.eventId, evidenceVersion: received.receipt.evidenceVersion,
    summary: "The submitted text does not name its owner.", nextAction: "Add the owner to the agenda."
  });
  assert.equal((await item(producer)).next.action, "revise");
  const checkpoint = (await producer.snapshot()).sequence;

  // Close every client transport and reopen the actual persisted database.
  await stop(); store = new RoomStore(filename); origin = await start();
  owner = client(ownerKey); producer = client(producerKey); reviewer = client(reviewerKey);
  assert.equal((await item(producer)).next.action, "revise");
  await mutate(producer, "resolve", T.WORK_BLOCKER_RESOLVED, { resolution: "The correction is understood." });
  await mutate(producer, "restart", T.WORK_STARTED);
  await submit("draft-2", "Owner: Room owner. Agenda: discuss the proposal and record the decision.");
  received = await item(reviewer);
  assert.equal(received.verification, null, "old review is not inherited");
  assert.equal(received.decision, null);
  assert.equal(received.receipt.evidenceVersion, version(received.receipt.summary));
  assert.match(received.receipt.summary, /^Owner:/);
  const review = command("review-2", T.VERIFICATION_RECORDED, {
    workItemId: "handoff", expectedRevision: received.revision, result: "pass",
    completionEventId: received.receipt.eventId, evidenceVersion: received.receipt.evidenceVersion,
    summary: "Scripted local check: text hash matches, and the agenda names its owner. Not a live AI or organizationally independent review."
  });
  await reviewer.command(review);
  assert.equal((await reviewer.command(review)).duplicate, true);
  assert.equal((await item(owner)).next.action, "decide");
  assert.equal((await producer.changes(checkpoint)).events.length > 0, true);
  const brief = await owner.returnBrief();
  assert.equal(brief.current.needsAttention.find(work => work.workItemId === "handoff").step, "decide");
  await mutate(owner, "decision", T.OWNER_DECISION_RECORDED, {
    decision: "approved", completionEventId: received.receipt.eventId, evidenceVersion: received.receipt.evidenceVersion,
    reason: "Synthetic human-role fixture decision; no external action."
  });
  assert.equal((await item(owner)).next.action, "complete");
  assert.equal((await owner.snapshot()).state.workItems.handoff.receiptHistory.length, 1);
  store.issueAccessKey("commons", "producer");
  await assert.rejects(() => producer.orient(), error => error.status === 401 && error.code === "unauthenticated");
});

test("structured client keeps credentials private and preserves explicit retry IDs", async () => {
  const calls = [];
  const token = "a".repeat(43);
  const actor = new RoomAgentClient({ origin: "http://127.0.0.1:1234", roomId: "room", token, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ duplicate: calls.length > 1 }) };
  } });
  const payload = { id: "stable-command", type: T.MESSAGE_POSTED, data: { body: "Local fixture" } };
  await actor.command(payload); await actor.command(payload);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].url.includes(token), false);
  assert.equal(JSON.stringify(actor).includes(token), false);
});
