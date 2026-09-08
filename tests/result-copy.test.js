import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resultDraft, resultDraftText } from "../src/work-packet.js";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("result draft selects exact reported text without reading or exporting authority", () => {
  const expected = { title: "  Outcome 🌱\r\nOne  ", summary: "One useful finding.\n  No implied author." };
  const forbidden = () => { throw Error("Unrelated private field read"); };
  const receipt = Object.freeze({ summary: expected.summary, get evidenceUrl() { return forbidden(); }, get producerId() { return forbidden(); } });
  const work = Object.freeze({ title: expected.title, receipt, get decision() { return forbidden(); }, get verification() { return forbidden(); }, get sourceMessageId() { return forbidden(); }, get state() { return forbidden(); } });
  assert.deepEqual(resultDraft(work), expected);
  assert.equal(resultDraftText(resultDraft(work)), `${expected.title}\n\nReported result\n${expected.summary}`);
  for (const value of [null, [], {}, Object.create(expected), { title: 1, summary: "s" }, { title: "t", summary: {} }]) assert.throws(() => resultDraftText(value));
  const maximum = { title: "t".repeat(4096), receipt: { summary: "s".repeat(4096) } };
  assert.equal(resultDraft(maximum).summary.length, 4096);
  for (const value of [null, [], "work", {}, Object.create(work), { title: "t", receipt: [] }, { title: "t", receipt: Object.create({ summary: "s" }) }]) assert.throws(() => resultDraft(value));
  for (const value of [null, false, 1, {}, "", " \n", "x".repeat(4097)]) {
    assert.throws(() => resultDraft({ title: value, receipt: { summary: "s" } }));
    assert.throws(() => resultDraft({ title: "t", receipt: { summary: value } }));
  }
});

test("field selection is not automatic redaction, rendering, approval or publication", () => {
  const summary = "Private Alex: https://example.invalid/private?token=synthetic\n<script>not executed</script>";
  for (const state of ["completed", "blocked", "superseded"]) {
    const work = { title: "Test", state, receipt: { summary }, verification: { result: "pass" }, decision: { decision: "approved" } };
    assert.deepEqual(resultDraft(work), { title: "Test", summary });
    assert.equal(resultDraftText(resultDraft(work)).includes("approved"), false);
    assert.equal(resultDraft(work).summary, summary, "the user must review and redact the literal text");
  }
});

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = actor => new RoomAgentClient({ origin, roomId: "commons", token: f.keys[actor] });
  const snapshot = () => f.store.snapshot(f.keys.owner, "commons");
  const mutate = (actor, type, data = {}) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data: { workItemId: "test-handoff", expectedRevision: snapshot().state.workItems["test-handoff"].revision, ...data } });
  return { ...f, origin, client, snapshot, mutate };
}

test("result reads use one cancellable selected-context GET, not source, writes or evidence fetches", async t => {
  const f = await fixture(t);
  f.store.reminders.mutate(f.keys.guest, "commons", { requestId: crypto.randomUUID(), workItemId: "test-handoff", expectedRevision: 0, action: "schedule", dueAt: Date.now() + 3600000 });
  const reminders = f.store.reminders.list(f.keys.guest, "commons").reminders;
  f.mutate("producer", T.WORK_ACCEPTED);
  f.mutate("producer", T.WORK_COMPLETED, { summary: "Selected synthetic summary", evidenceUrl: "https://example.invalid/private", evidenceVersion: "v1", producerId: "producer", nextAction: "Review" });
  let response = f.store.workContext(f.keys.guest, "commons", "test-handoff");
  const calls = [], actor = new RoomAgentClient({ origin: f.origin, roomId: "commons", token: f.keys.guest, fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => response }; } });
  const controller = new AbortController(), before = f.snapshot();
  assert.deepEqual(await actor.resultDraft("test-handoff", { signal: controller.signal }), resultDraft(response.work));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "GET");
  assert.equal(new URL(calls[0].url).search, "?workItemId=test-handoff");
  assert.equal(calls[0].options.credentials, "omit"); assert.equal(calls[0].options.redirect, "error");
  controller.abort(); assert.equal(calls[0].options.signal.aborted, true);
  for (const options of [null, [], { includeSource: true }, { publish: true }]) await assert.rejects(actor.resultDraft("test-handoff", options));
  await assert.rejects(actor.resultDraft("../elsewhere")); assert.equal(calls.length, 1);
  response = { ...response, roomId: "different" };
  await assert.rejects(actor.resultDraft("test-handoff"), error => error.code === "invalid_response");
  assert.deepEqual(await f.client("guest").resultDraft("test-handoff"), resultDraft(before.state.workItems["test-handoff"]));
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.store.reminders.list(f.keys.guest, "commons").reminders, reminders);
  f.store.revoke(f.keys.guest);
  await assert.rejects(f.client("guest").resultDraft("test-handoff"), error => error.status === 401);
});

test("reported copies never inherit review or approval across exact receipt/rework states", async t => {
  const f = await fixture(t), actor = f.client("guest");
  await assert.rejects(actor.resultDraft("test-handoff"), /reported result/);
  f.mutate("producer", T.WORK_ACCEPTED);
  const complete = (version, producerId) => f.mutate("producer", T.WORK_COMPLETED, { summary: `Synthetic summary ${version}`, evidenceUrl: "https://example.invalid/result", evidenceVersion: version, ...(producerId ? { producerId } : {}), nextAction: "Review" });
  const draft = async version => {
    const before = f.snapshot(), result = await actor.resultDraft("test-handoff");
    assert.deepEqual(result, { title: "Test: prepare an agenda", summary: `Synthetic summary ${version}` });
    assert.deepEqual(f.snapshot(), before);
  };
  complete("v1"); await draft("v1");
  let work = f.snapshot().state.workItems["test-handoff"];
  f.mutate("reviewer", T.VERIFICATION_RECORDED, { result: "pass", completionEventId: work.receipt.eventId, evidenceVersion: "v1", summary: "Unknown producer check" });
  await draft("v1");
  f.mutate("producer", T.WORK_BLOCKED, { reason: "Record provenance", nextAction: "Revise" });
  f.mutate("producer", T.WORK_BLOCKER_RESOLVED, { resolution: "Ready" }); complete("v2", "producer");
  work = f.snapshot().state.workItems["test-handoff"];
  f.mutate("reviewer", T.VERIFICATION_RECORDED, { result: "pass", completionEventId: work.receipt.eventId, evidenceVersion: "v2", summary: "Independent synthetic check" });
  f.mutate("owner", T.OWNER_DECISION_RECORDED, { decision: "approved", completionEventId: work.receipt.eventId, evidenceVersion: "v2", reason: "Synthetic approval" });
  await draft("v2");
  f.mutate("producer", T.WORK_BLOCKED, { reason: "Reopened after approval", nextAction: "Revise again" });
  assert.equal(f.snapshot().state.workItems["test-handoff"].verification.result, "pass"); await draft("v2");
  f.mutate("producer", T.WORK_BLOCKER_RESOLVED, { resolution: "Ready" }); complete("v3", "producer");
  assert.equal(f.snapshot().state.workItems["test-handoff"].verification, null); await draft("v3");
});
