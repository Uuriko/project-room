import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { reusableWorkDefinition, confirmsWorkProposal } from "../src/workflow.js";
import { EVENT_TYPES as T } from "../src/events.js";

test("reusable definition is an exact two-field projection, not cloned authority or state", () => {
  const content = { title: "  Repeat 🌱\nnext week  ", definitionOfDone: "One result\nwith its exact evidence.  " };
  for (const state of ["proposed", "completed", "blocked", "superseded"]) {
    const source = Object.freeze({ ...content, state, mode: "write", receipt: { pass: true }, accountableMemberId: "old" });
    assert.deepEqual(reusableWorkDefinition(source), content);
  }
  const guarded = { ...content, get credentials() { throw Error("Do not inspect unrelated fields"); } };
  assert.deepEqual(reusableWorkDefinition(guarded), content);
  const maximum = { title: "t".repeat(4096), definitionOfDone: "d".repeat(4096) };
  assert.deepEqual(reusableWorkDefinition(maximum), maximum);
  for (const source of [null, [], "work", {}, Object.create(content)]) assert.throws(() => reusableWorkDefinition(source));
  for (const key of Object.keys(content)) for (const value of [" ", "", null, {}, 10, false, "x".repeat(4097)]) {
    assert.throws(() => reusableWorkDefinition({ ...content, [key]: value }));
  }
});

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ...f, origin, client: actor => new RoomAgentClient({ origin, roomId: "commons", token: f.keys[actor] }) };
}

test("agent definition reads once without source, accepts cancellation and rejects malformed context", async t => {
  const f = await fixture(t), calls = [];
  let response = f.store.workContext(f.keys.producer, "commons", "test-handoff");
  const actor = new RoomAgentClient({ origin: f.origin, roomId: "commons", token: f.keys.producer, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => response };
  } });
  const controller = new AbortController();
  assert.deepEqual(await actor.workDefinition("test-handoff", { signal: controller.signal }), reusableWorkDefinition(response.work));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "GET");
  assert.equal(new URL(calls[0].url).search, "?workItemId=test-handoff");
  assert.equal(calls[0].options.credentials, "omit"); assert.equal(calls[0].options.redirect, "error");
  controller.abort(); assert.equal(calls[0].options.signal.aborted, true);
  for (const options of [null, [], { includeSource: true }, { roomId: "other" }]) await assert.rejects(actor.workDefinition("test-handoff", options));
  await assert.rejects(actor.workDefinition("../elsewhere")); assert.equal(calls.length, 1);
  response = { ...response, roomId: "other" };
  await assert.rejects(actor.workDefinition("test-handoff"), error => error.code === "invalid_response");
  response = f.store.workContext(f.keys.producer, "commons", "test-handoff");
  response.work.title = null; await assert.rejects(actor.workDefinition("test-handoff"), /Invalid work title/);
});

test("actual agent reuse creates fresh work, preserves source and exact retry, and grants no read-to-write authority", async t => {
  const f = await fixture(t), owner = f.client("owner");
  const before = f.store.snapshot(f.keys.owner, "commons");
  const definition = await f.client("guest").workDefinition("test-handoff");
  assert.deepEqual(definition, reusableWorkDefinition(before.state.workItems["test-handoff"]));
  const command = { id: crypto.randomUUID(), type: T.WORK_PROPOSED, data: {
    ...definition, workItemId: "new-definition-work", accountableMemberId: "producer", verifierMemberId: "reviewer",
    humanDecisionMakerId: "owner", independentVerificationRequired: true, ownerDecisionRequired: true, mode: "read"
  } };
  await assert.rejects(f.client("guest").command(command), error => error.status === 422);
  await assert.rejects(f.client("producer").command(command), error => error.status === 422);
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), before);
  await owner.command({ id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId: "planner", displayName: "Test planner agent", kind: "agent", accountableHumanId: "owner", permissions: ["steer"]
  } });
  f.keys.planner = f.store.issueAccessKey("commons", "planner");
  const actor = f.client("planner"), receipt = await actor.command(command);
  assert.equal(confirmsWorkProposal(receipt, command, "commons", "planner"), true);
  const after = f.store.snapshot(f.keys.owner, "commons"), item = after.state.workItems[command.data.workItemId];
  assert.equal(item.state, "proposed"); assert.equal(item.revision, 0); assert.equal(item.proposedById, "planner");
  assert.equal(item.mode, "read"); assert.equal(item.independentVerificationRequired, true); assert.equal(item.ownerDecisionRequired, true);
  for (const key of ["claim", "receipt", "verification", "decision", "blocker", "sourceMessageId", "supersededBy"]) assert.equal(item[key], null);
  for (const key of ["receiptHistory", "verificationHistory", "decisionHistory"]) assert.deepEqual(item[key], []);
  assert.deepEqual(after.state.workItems["test-handoff"], before.state.workItems["test-handoff"]);
  assert.equal(after.cursor, before.cursor);
  assert.equal((await actor.command(command)).duplicate, true);
  assert.equal(f.store.snapshot(f.keys.owner, "commons").sequence, after.sequence);
  await assert.rejects(actor.command({ ...command, data: { ...command.data, title: "Changed" } }), error => error.code === "idempotency_conflict");
  f.store.issueAccessKey("commons", "planner");
  await assert.rejects(actor.workDefinition("test-handoff"), error => error.status === 401);
});

test("only an exact work proposal receipt can clear a pending creation", () => {
  const command = { type: T.WORK_PROPOSED, data: { workItemId: "new-work", title: "New", definitionOfDone: "Done", accountableMemberId: "owner" } };
  const receipt = { sequence: 2, duplicate: false, event: { id: "event-1", roomId: "commons", actorId: "owner", type: T.WORK_PROPOSED, data: { ...command.data } } };
  assert.equal(confirmsWorkProposal(receipt, command, "commons", "owner"), true);
  assert.equal(confirmsWorkProposal({ ...receipt, duplicate: true }, command, "commons", "owner"), true);
  for (const changed of [null, {}, { ...receipt, sequence: 0 }, { ...receipt, duplicate: null },
    ...[{ roomId: "other" }, { actorId: "other" }, { type: T.WORK_COMPLETED }, { id: null }, { data: { ...command.data, title: "Other" } }, { data: { ...command.data, permission: "write" } }]
      .map(delta => ({ ...receipt, event: { ...receipt.event, ...delta } }))]) {
    assert.equal(Boolean(confirmsWorkProposal(changed, command, "commons", "owner")), false);
  }
});
