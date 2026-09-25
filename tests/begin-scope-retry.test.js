import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { submitWorkAction } from "../client/work-actions.mjs";
import { beginRequestId, beginSelectedWork, findBeginReceipt } from "../client/begin-work.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

const expiresAt = "2027-01-01T00:00:00.000Z";
const scopeA = { repository: "test/repo", ref: "main", paths: ["src/a.js"], expiresAt };
const scopeB = { repository: "test/repo", ref: "main", paths: ["src/b.js"], expiresAt };

function proposeAccepted(store, key, workItemId, memberId) {
  store.command(key, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId, title: "Scope repro", definitionOfDone: "The reserved paths match the request",
    accountableMemberId: memberId, mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false
  } });
  store.command(key, "commons", { id: randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId, expectedRevision: 0 } });
}

async function httpRoom(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  const origin = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const client = new RoomAgentClient({ origin, roomId: "commons", token: f.keys.owner });
  proposeAccepted(f.store, f.keys.owner, "scope-repro", "owner");
  return { f, client, identity: { roomId: "commons", memberId: "owner" } };
}

test("lost claim response reconciles its receipt after a later revision without changing scope", async t => {
  const { f, client, identity } = await httpRoom(t);
  const item = () => f.store.room("commons").state.workItems["scope-repro"];
  const read = () => client.workContext("scope-repro");
  const first = await beginSelectedWork({
    connected: true, scope: scopeA, read,
    execute: async stage => {
      const outcome = await submitWorkAction(client, identity, stage.action, stage.args);
      if (stage.action === "room_acquire_claim") throw new Error("response lost after commit");
      return outcome;
    }
  });
  assert.equal(first.working, false);
  assert.equal(first.stopped, "unknown");
  assert.equal(first.invented, false);
  assert.equal(first.resume.action, "room_acquire_claim");
  assert.equal(first.resume.requestId, beginRequestId("scope-repro", "room_acquire_claim", first.resume.expectedRevision, scopeA));
  assert.notEqual(first.resume.requestId, beginRequestId("scope-repro", "room_acquire_claim", first.resume.expectedRevision, scopeB));
  assert.deepEqual(item().claim.paths, ["src/a.js"]);
  assert.equal(item().state, "accepted");

  let mismatchedWrites = 0;
  const mismatched = await beginSelectedWork({
    connected: true, scope: scopeB, read,
    execute: async () => { mismatchedWrites += 1; return { status: "recorded" }; }
  });
  assert.equal(mismatchedWrites, 0);
  assert.equal(mismatched.stopped, "scope_mismatch");
  assert.equal(mismatched.working, false);
  assert.equal(mismatched.invented, false);
  assert.deepEqual(mismatched.currentClaim.paths, ["src/a.js"]);
  assert.equal(item().state, "accepted");
  assert.deepEqual(item().claim.paths, ["src/a.js"]);

  await client.command({ id: randomUUID(), type: T.WORK_HANDOFF_RECORDED, data: {
    workItemId: "scope-repro", expectedRevision: item().revision,
    doneSummary: "Scope reserved", nextAction: "Start work", limitReason: "Handoff before retry"
  } });
  const wrong = await callHostedStdioTool(f.store, f.keys.owner, "room_begin_work", {
    roomId: "commons", workItemId: "scope-repro", ...scopeA, invocationRequestId: "begin-not-the-claim-receipt"
  });
  assert.equal(wrong.value.stopped, "invocation_mismatch");
  assert.equal(item().state, "accepted");
  const outcome = await callHostedStdioTool(f.store, f.keys.owner, "room_begin_work", {
    roomId: "commons", workItemId: "scope-repro", ...scopeA, invocationRequestId: first.resume.requestId
  });
  const reconciled = outcome.value;
  assert.equal(reconciled.working, true);
  assert.equal(reconciled.roomState, "working");
  assert.equal(reconciled.stopped, null);
  assert.equal(reconciled.confirmed.some(row => row.action === "room_acquire_claim"), false);
  assert.equal(reconciled.confirmed.some(row => row.action === "room_start_work"), true);
  assert.deepEqual(item().claim.paths, ["src/a.js"]);
  assert.equal(item().claim.repository, "test/repo");
  assert.equal(item().state, "working");
});

test("lost accept response reconciles the recorded receipt after a later revision and starts", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  const origin = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const client = new RoomAgentClient({ origin, roomId: "commons", token: f.keys.owner });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "accept-repro", title: "Accept recovery", definitionOfDone: "A lost accept response still starts",
    accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false
  } });
  const identity = { roomId: "commons", memberId: "owner" };
  const item = () => f.store.room("commons").state.workItems["accept-repro"];
  const read = () => client.workContext("accept-repro");
  const receipts = (requestId, work) => findBeginReceipt(after => client.changes(after, 100), requestId, work);
  const first = await beginSelectedWork({
    connected: true, read, receipts,
    execute: async stage => {
      const outcome = await submitWorkAction(client, identity, stage.action, stage.args);
      if (stage.action === "room_accept_work") throw new Error("response lost after commit");
      return outcome;
    }
  });
  assert.equal(first.working, false);
  assert.equal(first.stopped, "unknown");
  assert.equal(first.invented, false);
  assert.equal(first.resume.action, "room_accept_work");
  assert.equal(first.resume.requestId, beginRequestId("accept-repro", "room_accept_work", 0));
  assert.equal(first.resume.expectedRevision, 0);
  assert.equal(first.resume.args.workItemId, "accept-repro");
  assert.equal(first.resume.args.requestId, first.resume.requestId);
  assert.equal(item().state, "accepted");
  await client.command({ id: randomUUID(), type: T.WORK_HANDOFF_RECORDED, data: {
    workItemId: "accept-repro", expectedRevision: item().revision,
    doneSummary: "accepted", nextAction: "start", limitReason: "revision after lost accept"
  }});
  assert.equal(item().state, "accepted");
  assert.notEqual(first.resume.requestId, beginRequestId("accept-repro", "room_accept_work", item().revision - 1));
  let wrongWrites = 0;
  const wrong = await beginSelectedWork({
    connected: true, read, receipts, invocation: { requestId: "begin-not-the-accept-receipt" },
    execute: async () => { wrongWrites += 1; return { status: "recorded" }; }
  });
  assert.equal(wrongWrites, 0);
  assert.equal(wrong.stopped, "invocation_mismatch");
  assert.equal(wrong.working, false);
  assert.equal(wrong.resume.planned.action, "room_start_work");
  assert.equal(wrong.resume.planned.expectedRevision, item().revision);
  assert.equal(wrong.resume.planned.args.workItemId, "accept-repro");
  assert.equal(item().state, "accepted");
  const retried = await beginSelectedWork({
    connected: true, read, receipts, invocation: { requestId: first.resume.requestId },
    execute: stage => submitWorkAction(client, identity, stage.action, stage.args)
  });
  assert.equal(retried.working, true);
  assert.equal(retried.roomState, "working");
  assert.equal(retried.stopped, null);
  assert.equal(retried.confirmed.some(row => row.action === "room_accept_work"), false);
  assert.equal(retried.confirmed.some(row => row.action === "room_start_work"), true);
  assert.equal(item().state, "working");
});

test("hosted Begin reconciles a lost accept receipt and starts", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  const origin = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const client = new RoomAgentClient({ origin, roomId: "commons", token: f.keys.owner });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "hosted-accept", title: "Hosted accept recovery", definitionOfDone: "Hosted Begin starts after a lost accept",
    accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false
  } });
  const identity = { roomId: "commons", memberId: "owner" };
  const read = () => client.workContext("hosted-accept");
  const first = await beginSelectedWork({
    connected: true, read,
    execute: async stage => {
      const outcome = await submitWorkAction(client, identity, stage.action, stage.args);
      if (stage.action === "room_accept_work") throw new Error("response lost after commit");
      return outcome;
    }
  });
  assert.equal(first.stopped, "unknown");
  assert.equal(f.store.room("commons").state.workItems["hosted-accept"].state, "accepted");
  const outcome = await callHostedStdioTool(f.store, f.keys.owner, "room_begin_work", {
    roomId: "commons", workItemId: "hosted-accept", invocationRequestId: first.resume.requestId
  });
  assert.equal(outcome.value.working, true);
  assert.equal(outcome.value.stopped, null);
  assert.equal(outcome.value.confirmed.some(row => row.action === "room_start_work"), true);
  assert.equal(outcome.value.confirmed.some(row => row.action === "room_accept_work"), false);
  assert.equal(f.store.room("commons").state.workItems["hosted-accept"].state, "working");
});

test("an unknown claim id is not reused to acquire a different scope", async t => {
  const { f, client } = await httpRoom(t);
  const read = () => client.workContext("scope-repro");
  const first = await beginSelectedWork({
    connected: true, scope: scopeA, read,
    execute: async () => { throw new Error("response lost before commit"); }
  });
  assert.equal(first.stopped, "unknown");
  assert.equal(f.store.room("commons").state.workItems["scope-repro"].claim, null);
  let writes = 0;
  const changed = await beginSelectedWork({
    connected: true, scope: scopeB, invocation: { requestId: first.resume.requestId }, read,
    execute: async () => { writes += 1; return { status: "recorded" }; }
  });
  assert.equal(writes, 0);
  assert.equal(changed.stopped, "invocation_mismatch");
  assert.equal(changed.working, false);
  assert.equal(f.store.room("commons").state.workItems["scope-repro"].claim, null);
  assert.equal(f.store.room("commons").state.workItems["scope-repro"].state, "accepted");
});

test("a refused start is not restarted at a later revision under a new id", async t => {
  const { f, client, identity } = await httpRoom(t);
  const read = () => client.workContext("scope-repro");
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.CLAIM_ACQUIRED, data: {
    workItemId: "scope-repro", expectedRevision: 1, ...scopeA
  } });
  const blocked = await beginSelectedWork({
    connected: true, scope: scopeA, read,
    execute: async stage => {
      await client.command({ id: randomUUID(), type: T.WORK_HANDOFF_RECORDED, data: {
        workItemId: "scope-repro", expectedRevision: stage.expectedRevision,
        doneSummary: "partial", nextAction: "keep src/a.js", limitReason: "concurrent revision"
      } });
      return submitWorkAction(client, identity, stage.action, stage.args);
    }
  });
  assert.equal(blocked.working, false);
  assert.equal(blocked.invented, false);
  assert.equal(["unknown", "refused"].includes(blocked.stopped), true);
  const item = f.store.room("commons").state.workItems["scope-repro"];
  assert.equal(item.state, "accepted");
  assert.deepEqual(item.claim.paths, ["src/a.js"]);
  let writes = 0;
  const otherScope = await beginSelectedWork({
    connected: true, scope: scopeB, invocation: { requestId: blocked.resume.requestId }, read,
    execute: async () => { writes += 1; return { status: "recorded" }; }
  });
  assert.equal(writes, 0);
  assert.equal(otherScope.stopped, "scope_mismatch");
  assert.deepEqual(otherScope.currentClaim.paths, ["src/a.js"]);
  const sameScope = await beginSelectedWork({
    connected: true, scope: scopeA, invocation: { requestId: blocked.resume.requestId }, read,
    execute: async () => { writes += 1; return { status: "recorded" }; }
  });
  assert.equal(writes, 0);
  assert.equal(sameScope.stopped, "invocation_mismatch");
  assert.equal(f.store.room("commons").state.workItems["scope-repro"].state, "accepted");
  assert.deepEqual(f.store.room("commons").state.workItems["scope-repro"].claim.paths, ["src/a.js"]);
});

test("hosted MCP begin stops a different scope before start", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  proposeAccepted(f.store, f.keys.owner, "scope-repro", "owner");
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.CLAIM_ACQUIRED, data: {
    workItemId: "scope-repro", expectedRevision: 1, ...scopeA
  } });
  const outcome = await callHostedStdioTool(f.store, f.keys.owner, "room_begin_work", {
    roomId: "commons", workItemId: "scope-repro", ...scopeB
  });
  assert.equal(outcome.value.stopped, "scope_mismatch");
  assert.equal(outcome.value.working, false);
  assert.deepEqual(outcome.value.currentClaim.paths, ["src/a.js"]);
  const item = f.store.room("commons").state.workItems["scope-repro"];
  assert.equal(item.state, "accepted");
  assert.deepEqual(item.claim.paths, ["src/a.js"]);
});

test("stdio MCP over HTTP does not start a different active scope", { timeout: 20000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  const origin = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MEMBER_ADDED, data: {
    memberId: "writer", displayName: "Writer", kind: "agent", permissions: ["accept_work", "complete_work", "write_external"], accountableHumanId: "owner"
  } });
  const token = f.store.issueAccessKey("commons", "writer");
  setTier(f.store.db, "commons", "writer", "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "scope-repro", title: "Scope repro", definitionOfDone: "The reserved paths match the request",
    accountableMemberId: "writer", mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false
  } });
  f.store.command(token, "commons", { id: randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId: "scope-repro", expectedRevision: 0 } });
  f.store.command(token, "commons", { id: randomUUID(), type: T.CLAIM_ACQUIRED, data: {
    workItemId: "scope-repro", expectedRevision: 1, ...scopeA
  } });
  const directory = join(f.directory, "mcp");
  saveAgentConnection(directory, { version: 1, origin, roomId: "commons", memberId: "writer", token });
  let mcp;
  t.after(async () => {
    if (mcp) await mcp.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  mcp = await openMcpTestClient(directory);
  const result = await mcp.call("room_begin_work", { workItemId: "scope-repro", ...scopeB });
  const value = result.result.structuredContent ?? result.result;
  assert.equal(value.stopped, "scope_mismatch");
  assert.equal(value.working, false);
  assert.deepEqual(value.currentClaim.paths, ["src/a.js"]);
  const item = f.store.room("commons").state.workItems["scope-repro"];
  assert.equal(item.state, "accepted");
  assert.deepEqual(item.claim.paths, ["src/a.js"]);
});
