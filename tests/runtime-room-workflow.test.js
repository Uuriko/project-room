import test from "node:test";
import { startWorkLifecycleFixture } from "../scripts/work-lifecycle-agent-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";

test("native Room tools carry accepted work, exact result and independent review across process restart", { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store }), handles = [];
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const workspace = join(realpathSync(f.directory), "workspace"); mkdirSync(workspace);
  t.after(async () => {
    for (const handle of handles) await handle.close();
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const paths = {};
  for (const memberId of ["producer", "reviewer"]) {
    paths[memberId] = join(realpathSync(f.directory), memberId);
    saveAgentConnection(paths[memberId], { version: 1, origin, roomId: "commons", memberId, token: f.keys[memberId] });
  }
  const open = async memberId => {
    const mcp = await openMcpTestClient(paths[memberId], { cwd: workspace, runtimeScope: { origin, roomId: "commons", memberId } });
    handles.push(mcp); return mcp;
  };
  for (const [from, to] of [["producer", "reviewer"], ["reviewer", "producer"]]) {
    f.store.dmConsents.request("commons", from, to, "Two-agent test");
    f.store.dmConsents.decide("commons", to, from, "approve");
  }
  await assert.rejects(openMcpTestClient(paths.producer, { cwd: workspace,
    runtimeScope: { origin, roomId: "commons", memberId: "reviewer" } }), /exited/);
  let producer = await open("producer"); const reviewer = await open("reviewer");
  const call = async (actor, name, args = {}) => {
    const response = await actor.call(name, args);
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
    return response.result.structuredContent;
  };
  const names = (await producer.request("tools/list")).result.tools.map(tool => tool.name);
  for (const name of ["room_read_work", "room_request_reply", "room_record_verification", "get_room_context"]) assert.ok(names.includes(name));
  assert.equal(names.includes("room_set_member_claim_cap"), false);
  assert.equal((await producer.call("room_set_member_claim_cap", { maxMemberOpenClaims: 100 })).error.code, -32602);
  const structural = await call(producer, "get_room_context");
  assert.equal(structural.roomId, "commons");
  assert.equal(typeof structural.context_version, "string");
  assert.equal(structural.messages, undefined, "structural context must not add conversation bodies");
  const workItemId = "test-handoff";
  const read = actor => call(actor, "room_read_work", { workItemId, includeDiscussion: true });
  const act = async (actor, name, requestId, extra = {}) => call(actor, name, { requestId, workItemId, expectedRevision: (await read(actor)).work.revision, ...extra });
  assert.equal((await read(producer)).next.action, "accept");
  await act(producer, "room_accept_work", "accept-native");
  await act(producer, "room_start_work", "start-native");
  const body = "Owner: producer. Agenda: 5 minutes introductions, 10 minutes options, 10 minutes decision, 5 minutes next actions. Total: 30 minutes.";
  const draft = await call(producer, "room_post_draft", { requestId: "native-draft", workItemId, packetId: "native-packet", basisRevision: (await read(producer)).work.revision, body, replyToId: "test-request" });
  const evidenceVersion = "sha256:" + createHash("sha256").update(body).digest("hex");
  const submission = { requestId: "native-result", workItemId, expectedRevision: (await read(producer)).work.revision,
    evidenceMessageId: draft.messageId, evidenceMessageEventId: draft.eventId, evidenceVersion, previousCompletionEventId: null, producerId: "producer", summary: "A 30-minute agenda", nextAction: "Review exact result" };
  const submitted = await call(producer, "room_submit_text_result", submission);
  assert.equal(submitted.status, "recorded");
  const ask = { requestId: "request-independent-review", toMemberId: "reviewer", workItemId,
    body: "Independently inspect the exact submitted agenda and report your result." };
  const requested = await call(producer, "room_request_reply", ask);
  assert.equal((await call(reviewer, "room_read_request", { requestMessageId: requested.requestMessageId })).request.status, "open");
  await producer.close(); producer = await open("producer");
  assert.equal((await call(producer, "room_submit_text_result", submission)).duplicate, true);
  const pending = await read(reviewer);
  assert.equal(pending.next.action, "verify");
  const result = await call(reviewer, "room_read_result", { workItemId });
  assert.equal(result.result.text.body, body);
  assert.equal("sha256:" + createHash("sha256").update(result.result.text.body).digest("hex"), evidenceVersion);
  const review = { completionEventId: pending.work.receipt.eventId, evidenceVersion, result: "pass", summary: "Independently checked owner, four timeboxes totaling 30 minutes, and next actions." };
  assert.equal((await producer.call("room_record_verification", { requestId: "self-review", workItemId, expectedRevision: pending.work.revision, ...review })).result.isError, true);
  await act(reviewer, "room_record_verification", "independent-review", review);
  const context = await call(reviewer, "room_read_request", { requestMessageId: requested.requestMessageId });
  assert.equal(context.page.hasMore, false);
  const answer = { requestId: "review-answer", responseToRequestId: requested.requestMessageId,
    ...context.current.answerBasis, responseOutcome: "answered", toMemberId: "producer", workItemId,
    body: "Pass: inspected the exact stored agenda and recorded the independent review." };
  await call(reviewer, "room_respond_to_request", answer);
  assert.equal((await call(reviewer, "room_respond_to_request", answer)).duplicate, true);
  assert.equal((await call(producer, "room_read_request", { requestMessageId: requested.requestMessageId })).request.status, "answered");
  assert.equal((await call(producer, "room_request_reply", ask)).duplicate, true);
  const after = await read(producer);
  assert.equal(after.next.action, "decide", "independent review is not human approval");
  const reply = { requestId: "result-back-to-conversation", replyToId: "test-request", workItemId,
    body: `Result ${draft.messageId} has an independent review; awaiting the owner's decision.` };
  const posted = await call(producer, "room_reply", reply);
  assert.equal(posted.status, "recorded");
  assert.equal((await call(producer, "room_reply", reply)).duplicate, true);
  const state = f.store.snapshot(f.keys.owner, "commons").state;
  assert.equal(state.messages.filter(message => message.body === reply.body).length, 1);
  assert.ok(state.messages.some(message => message.body === reply.body && message.replyToId === "test-request"));
});

test("native agent can follow deprecated claim guidance and hand work back through canonical tools", { timeout: 30000 }, async t => {
  const f = await startWorkLifecycleFixture();
  let mcp;
  t.after(async () => { await mcp?.close(); await f.close(); });
  const workspace = join(realpathSync(f.directory), "workspace"); mkdirSync(workspace);
  const participant = f.participants[0], workItemId = participant.workItemId;
  mcp = await openMcpTestClient(realpathSync(participant.configDirectory), { cwd: workspace,
    runtimeScope: { origin: f.origin, roomId: "commons", memberId: participant.memberId } });
  const call = async (name, args) => {
    const response = await mcp.call(name, args);
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
    return response.result.structuredContent;
  };
  await call("room_accept_work", { requestId: "accept", workItemId, expectedRevision: 0 });
  const claim = await call("room_acquire_claim", { requestId: "take", workItemId, expectedRevision: 1, ...f.manifest.scope });
  const renewed = await call(claim.successor, { requestId: "renew", workItemId, expectedRevision: 2,
    action: "renew", expiresAt: new Date(Date.now() + 7200000).toISOString() });
  assert.equal(renewed.status, "recorded");
  await call("room_start_work", { requestId: "start", workItemId, expectedRevision: 3 });
  const handoff = await call("room_handoff", { requestId: "handoff", workItemId, expectedRevision: 4,
    done: "Reviewed the brief", next: "Draft the welcome", reason: "Another agent will finish" });
  assert.equal(handoff.status, "recorded");
  const work = await call("room_read_work", { workItemId });
  assert.notEqual(work.work.status, "done");
});

test("native MCP pins startup credentials across file replacement and rejects changed identities", { timeout: 30000 }, async t => {
  const f = await startWorkLifecycleFixture(); let mcp;
  t.after(async () => { await mcp?.close(); await f.close(); });
  const workspace = join(realpathSync(f.directory), "workspace"); mkdirSync(workspace);
  const a = f.participants[0], b = f.participants[1];
  const directory = realpathSync(a.configDirectory), file = join(directory, "connection.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  const other = JSON.parse(readFileSync(join(b.configDirectory, "connection.json"), "utf8"));
  const runtimeScope = { origin: f.origin, roomId: "commons", memberId: a.memberId };
  const open = () => openMcpTestClient(directory, { cwd: workspace, runtimeScope });
  const replace = value => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  // Different public identity between configuration and process startup is refused.
  replace(other); await assert.rejects(open(), /exited/);
  // Public fields alone cannot make the other agent's token act as this agent.
  replace({ ...original, token: other.token }); mcp = await open();
  const refused = await mcp.call("room_accept_work", { requestId: "wrong-token", workItemId: a.workItemId, expectedRevision: 0 });
  assert.equal(refused.result.isError, true);
  assert.equal(f.evidence().workItems[a.workItemId].revision, 0);
  await mcp.close(); mcp = undefined;
  // An already initialized process never adopts a new identity from the file.
  replace(original); mcp = await open(); replace(other);
  const accepted = await mcp.call("room_accept_work", { requestId: "original-identity", workItemId: a.workItemId, expectedRevision: 0 });
  assert.equal(accepted.result.structuredContent.status, "recorded");
  assert.equal(f.evidence().participantEvents.find(entry => entry.event.id === accepted.result.structuredContent.eventId).event.actorId, a.memberId);
  f.store.revoke(original.token);
  const revoked = await mcp.call("room_start_work", { requestId: "revoked-original", workItemId: a.workItemId, expectedRevision: 1 });
  assert.equal(revoked.result.isError, true);
  assert.equal(f.evidence().workItems[a.workItemId].revision, 1);
});
