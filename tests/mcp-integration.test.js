import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";

test("real stdio process uses owner enrollment, selected work and stable draft retries across restart", { timeout: 20000 }, async t => {
  const f = createAcceptanceFixture(), session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "mcp-enroll", memberId: "mcp-agent", displayName: "MCP agent", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = join(f.directory, "mcp"); saveAgentConnection(directory, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "mcp-agent", token });
  let mcp;
  t.after(async () => { if (mcp) await mcp.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  mcp = await openMcpTestClient(directory);
  assert.equal((await mcp.request("tools/list")).result.tools.length, 32);
  const before = f.store.snapshot(token, "commons");
  assert.equal((await mcp.call("room_check_access")).result.structuredContent.status, "credential_accepted");
  const selected = (await mcp.call("room_read_work", { workItemId: "test-handoff" })).result.structuredContent;
  assert.equal(selected.context.source.status, "not_requested");
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
  assert.equal(JSON.stringify([posted, retry, ended]).includes(token), false);
});
