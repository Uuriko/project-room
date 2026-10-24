import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { callHostedStdioTool, validHostedStdioArgs } from "../server/mcp-full-profile.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

test("real stdio process uses owner enrollment, selected work and stable draft retries across restart", { timeout: 20000 }, async t => {
  const f = createAcceptanceFixture(), session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "mcp-enroll", memberId: "mcp-agent", displayName: "MCP agent", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  // #953: new agent members default to t1_readonly; the MCP agent needs write access for room_post_draft
  setTier(f.store.db, "commons", "mcp-agent", "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = join(f.directory, "mcp"); saveAgentConnection(directory, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "mcp-agent", token });
  let mcp;
  t.after(async () => { if (mcp) await mcp.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  mcp = await openMcpTestClient(directory);
  const tools = (await mcp.request("tools/list")).result.tools;
  assert.equal(tools.length, 45);
  assert.deepEqual(tools.filter(tool => tool.name.startsWith("room_assistant_")).map(tool => tool.name), ["room_assistant_context", "room_assistant_action"]);
  const assistant = (await mcp.call("room_assistant_context", {})).result.structuredContent;
  assert.equal(assistant.roomId, "commons");
  assert.equal(assistant.assistant.availability, "not_connected");
  assert.deepEqual(assistant.runs, []);
  const batchIds = ["test-handoff", "batch-two", "batch-three", "batch-four"];
  for (const workItemId of batchIds.slice(1)) f.store.command(f.keys.owner, "commons", { id: workItemId, type: "work.proposed", data: {
    workItemId, title: workItemId, definitionOfDone: "A useful decision", accountableMemberId: "owner", mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false
  } });
  const before = f.store.snapshot(token, "commons");
  assert.equal((await mcp.call("room_check_access")).result.structuredContent.status, "credential_accepted");
  const selected = (await mcp.call("room_read_work", { workItemId: "test-handoff" })).result.structuredContent;
  assert.equal(selected.context.source.status, "not_requested");
  const prepared = (await mcp.call("room_read_work", { workItemId: "test-handoff", includeDiscussion: true })).result.structuredContent;
  assert.equal(prepared.preparation.discussion.items[0].message.id, "test-request");
  assert.equal(prepared.preparation.discussion.hasMore, false);
  assert.equal(prepared.preparation.changedDuringRead, false);
  assert.equal(prepared.work.id, "test-handoff");
  const compact = (await mcp.call("room_read_work", { workItemId: "test-handoff", brief: true })).result.structuredContent;
  assert.equal(compact.workItemId, "test-handoff");
  assert.match(compact.brief, /Accept the assignment/);
  assert.match(compact.brief, /Session budget/);
  assert.equal(compact.toolFocus.focus, "work");
  assert.match(compact.brief, /Suggested tool focus: work/);
  assert.equal(compact.brief.includes("Please prepare an agenda"), false);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(selected).length);
  assert.match(compact.briefVersion, /^[a-f0-9]{64}$/);
  const batch = (await mcp.call("room_read_work", { workItemIds: batchIds })).result.structuredContent;
  const withoutReadTime = item => ({ ...item, brief: item.brief.replace(/Evaluated: [^\n]+/, "Evaluated: <fresh read>") });
  assert.deepEqual(batch.items.map(item => item.workItemId), batchIds);
  assert.deepEqual(withoutReadTime(batch.items[0]), withoutReadTime(compact));
  assert.equal(batch.readOnly, true);
  assert.equal(batch.atomicSnapshot, false);
  const hosted = await callHostedStdioTool(f.store, token, "room_read_work", { roomId: "commons", workItemIds: batchIds });
  assert.deepEqual(hosted.value.items.map(withoutReadTime), batch.items.map(withoutReadTime));
  assert.equal(validHostedStdioArgs("room_read_work", { roomId: "commons", workItemIds: ["test-handoff", "test-handoff"] }), false);
  const refusedBatch = (await mcp.call("room_read_work", { workItemIds: ["test-handoff", "missing-task"] })).result;
  assert.equal(refusedBatch.isError, true);
  assert.equal(Object.hasOwn(refusedBatch.structuredContent, "items"), false);
  assert.deepEqual(f.store.snapshot(token, "commons"), before);
  const input = { requestId: "stable-mcp-draft", workItemId: "test-handoff", packetId: "mcp-fixture", basisRevision: 0, body: "Synthetic draft for human review.", replyToId: "test-request" };
  const posted = (await mcp.call("room_post_draft", input)).result.structuredContent;
  assert.equal(posted.status, "draft_posted"); assert.equal(posted.duplicate, false);
  assert.equal((await mcp.close()).diagnostics, ""); mcp = await openMcpTestClient(directory);
  const retry = (await mcp.call("room_post_draft", input)).result.structuredContent;
  assert.equal(retry.duplicate, true); assert.equal(retry.eventId, posted.eventId);
  const after = f.store.snapshot(token, "commons"); assert.equal(after.sequence, before.sequence + 1);
  assert.equal(after.state.messages.find(m => m.id === posted.messageId).replyToId, "test-request");
  assert.deepEqual(after.state.workItems, before.state.workItems); assert.equal(after.cursor, before.cursor);
  f.store.agentConnections.apply(session.token, "commons", { action: "disconnect", requestId: "end-mcp", memberId: "mcp-agent", expectedOwnerRevision: 0, expectedMemberRevision: 0, expectedGeneration: 1 }, session.session.sessionBinding);
  const ended = (await mcp.call("room_check_access")).result;
  assert.equal(ended.isError, true); assert.equal(ended.structuredContent.code, "access_ended");
  const endedBatch = (await mcp.call("room_read_work", { workItemIds: batchIds })).result;
  assert.equal(endedBatch.isError, true);
  assert.equal(Object.hasOwn(endedBatch.structuredContent, "items"), false);
  await assert.rejects(callHostedStdioTool(f.store, token, "room_read_work", { roomId: "commons", workItemIds: batchIds }));

  assert.equal(JSON.stringify([posted, retry, ended]).includes(token), false);
});
