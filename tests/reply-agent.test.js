import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { buildReplyCommand, validReplyArguments, replyTools, validateReplyRead, replyRefusal } from "../client/reply-actions.mjs";
import { confirmsAgentCommand } from "../client/work-actions.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { auditRecovery } from "../server/recovery.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store }), handles = new Set();
  t.after(async () => {
    for (const handle of handles) await handle.close();
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${server.address().port}`, identity = { roomId: "commons", memberId: "producer" };
  const config = { version: 1, origin, ...identity, token: f.keys.producer }, configDirectory = join(f.directory, "private-agent");
  saveAgentConnection(configDirectory, config);
  const client = new RoomAgentClient(config);
  const open = (id = crypto.randomUUID(), extra = {}) => {
    const command = { id, type: "message.posted", data: { messageId: "question-" + id, requestKind: "reply", toMemberId: "producer", body: "Which agenda is clearest?", ...extra } };
    return { command, receipt: f.store.command(f.keys.owner, "commons", command) };
  };
  const respond = (context, patch = {}) => ({ requestId: crypto.randomUUID(), responseToRequestId: context.request.id,
    ...context.current.answerBasis, responseOutcome: "answered", toMemberId: context.request.requesterId, workItemId: context.request.workItemId,
    body: "Use one owner and one next action.\r\nExact answer 🪷 é", ...patch });
  const mcp = async () => { const handle = await openMcpTestClient(configDirectory); handles.add(handle); return handle; };
  const cli = (name, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", "reply", name], { env: { ROOM_AGENT_CONFIG: configDirectory }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.on("error", reject); child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    child.on("exit", code => resolve({ code, out, err })); child.stdin.end(JSON.stringify(args));
  });
  return { ...f, origin, identity, config, configDirectory, client, open, respond, mcp, cli };
}

test("direct, MCP and CLI share one request/clarification/answer journey with exact retries", async t => {
  const f = await fixture(t), q = f.open(), before = f.store.snapshot(f.keys.owner, "commons"), id = q.command.data.messageId;
  assert.equal((await f.client.replyRequests()).requests[0].id, id);
  const adapter = await f.mcp(), initial = (await adapter.call("room_read_request", { requestMessageId: id })).result.structuredContent;
  assert.equal(initial.current.answerBasis.contextEventId, q.receipt.event.id);
  const clarify = { requestId: "clarify", replyToId: id, body: "Should the agenda have a time limit?" };
  const clarified = (await adapter.call("room_reply", clarify)).result.structuredContent;
  assert.equal(clarified.status, "recorded"); assert.equal(f.store.room("commons").state.replyRequests[id].status, "open");
  await assert.rejects(f.client.replyAction("room_respond_to_request", f.respond(initial)), { code: "command_rejected" });
  const context = await f.client.replyContext(id), input = f.respond(context, { requestId: "answer-once" });
  const answered = await f.cli("room_respond_to_request", input);
  assert.equal(answered.code, 0, answered.err);
  const saved = JSON.parse(answered.out), sequence = f.store.room("commons").sequence;
  assert.equal(saved.status, "recorded");
  const retry = (await adapter.call("room_respond_to_request", input)).result.structuredContent;
  assert.equal(retry.eventId, saved.eventId); assert.equal(retry.duplicate, true);
  assert.equal(f.store.room("commons").sequence, sequence);
  const final = await f.client.replyContext(id);
  assert.equal(final.request.status, "answered"); assert.equal(final.page.items.at(-1).message.body, input.body);
  assert.equal(final.current.answerBasis, null);
  const history = await f.cli("room_request_history", {});
  assert.equal(history.code, 0, history.err);
  assert.deepEqual(JSON.parse(history.out).page.items.map(row => row.kind), ["opened", "context", "answered"]);
  const after = f.store.snapshot(f.keys.owner, "commons");
  assert.deepEqual(after.state.workItems, before.state.workItems); assert.equal(after.cursor, before.cursor);
  auditRecovery(f.store);
});

test('human and agent hearts are appreciation, own reactions only, with exact retries', async t => {
  const f = await fixture(t), q = f.open(), messageId = q.command.data.messageId;
  const before = structuredClone(f.store.room('commons').state.workItems);
  f.store.command(f.keys.owner, 'commons', { id: 'human-heart', type: 'message.reaction_set', data: { messageId, reaction: 'heart', active: true } });
  const input = { requestId: 'agent-heart', messageId, reaction: 'heart', active: true };
  const first = await f.client.replyAction('room_react_message', input);
  assert.equal(first.status, 'recorded'); assert.equal(first.approvalGranted, false);
  const adapter = await f.mcp(), retry = (await adapter.call('room_react_message', input)).result.structuredContent;
  assert.equal(retry.duplicate, true); assert.equal(retry.eventId, first.eventId);
  const message = () => f.store.room('commons').state.messages.find(m => m.id === messageId);
  assert.deepEqual(message().reactions.heart, ['owner', 'producer']);
  await f.client.replyAction('room_react_message', { ...input, requestId: 'remove-agent-heart', active: false });
  assert.deepEqual(message().reactions.heart, ['owner']);
  assert.deepEqual(f.store.room('commons').state.workItems, before);
  assert.equal(validReplyArguments('room_react_message', { ...input, memberId: 'owner' }), false);
  assert.equal(validReplyArguments('room_react_message', { ...input, reaction: 'approve' }), false);
  f.store.issueAccessKey('commons', 'producer');
  await assert.rejects(f.client.replyAction('room_react_message', { ...input, requestId: 'revoked-heart' }), { status: 401 });
});

test("ordinary agent chat crosses direct, MCP and CLI without creating requests or work", async t => {
  const f = await fixture(t), before = f.store.snapshot(f.keys.owner, "commons");
  const input = { requestId: "ordinary-root", body: "Here is a useful observation for the room." };
  const posted = await f.client.replyAction("room_post_message", input);
  assert.equal(posted.status, "recorded");
  assert.equal(posted.requestMessageId, null);
  assert.equal(posted.appliedRequestRevision, null);
  assert.equal(posted.next, null);
  const adapter = await f.mcp();
  const retry = (await adapter.call("room_post_message", input)).result.structuredContent;
  assert.equal(retry.duplicate, true);
  assert.equal(retry.eventId, posted.eventId);
  const addressed = await f.cli("room_post_message", {
    requestId: "ordinary-addressed", body: "An observation, not a formal request.", toMemberId: "reviewer"
  });
  assert.equal(addressed.code, 0, addressed.err);
  assert.equal(JSON.parse(addressed.out).status, "recorded");
  const after = f.store.snapshot(f.keys.owner, "commons");
  assert.equal(after.sequence, before.sequence + 2);
  assert.deepEqual(after.state.workItems, before.state.workItems);
  assert.deepEqual(after.state.replyRequests, before.state.replyRequests);
  assert.equal(after.cursor, before.cursor);
  const message = after.state.messages.find(item => item.id === posted.messageId);
  assert.equal(message.authorId, "producer");
  assert.equal(message.body, input.body);
  assert.equal(message.replyToId, null);
  await assert.rejects(f.client.replyAction("room_post_message", { ...input, body: "Changed" }), { code: "idempotency_conflict" });
  auditRecovery(f.store);
});

test("request run controls share direct MCP and CLI receipts without answering or executing", async t => {
  const f = await fixture(t), q = f.open(), requestMessageId = q.command.data.messageId;
  const before = f.store.snapshot(f.keys.owner, "commons").state.workItems;
  const context = await f.client.replyContext(requestMessageId);
  assert.equal(context.current.runContractVersion, 1); assert.equal(context.current.run, null);
  const input = { requestId: "claim-run", requestMessageId, expectedRevision: 0, runId: "external-run",
    contextEventId: context.current.contextEventId, instructionsRevision: context.current.instructionsRevision,
    maxRuntimeMs: 10000, maxOutputBytes: 4096 };
  const adapter = await f.mcp();
  const claimed = (await adapter.call("room_claim_request_run", input)).result.structuredContent;
  assert.equal(claimed.status, "recorded"); assert.equal(claimed.processStarted, false);
  assert.equal(claimed.appliedRunRevision, 1); assert.equal(claimed.duplicate, false);
  const current = await f.client.replyContext(requestMessageId);
  assert.equal(current.current.run.runId, input.runId);
  const stopped = await f.cli("room_stop_request_run", { requestId: "stop-run", requestMessageId, runId: input.runId, expectedRevision: 1 });
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal(JSON.parse(stopped.out).appliedRunRevision, 2);
  const retry = await f.client.replyAction("room_claim_request_run", input);
  assert.equal(retry.eventId, claimed.eventId); assert.equal(retry.duplicate, true); assert.equal(retry.currentStateVerified, false);
  const finished = await f.client.replyAction("room_finish_request_run", { requestId: "finish-run", requestMessageId, runId: input.runId, expectedRevision: 2, status: "cancelled" });
  assert.equal(finished.appliedRunRevision, 3);
  assert.equal((await f.client.replyContext(requestMessageId)).current.run.status, "cancelled");
  assert.equal(f.store.room("commons").state.replyRequests[requestMessageId].status, "open");
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons").state.workItems, before);
  await assert.rejects(f.client.replyAction("room_claim_request_run", { ...input, maxRuntimeMs: 9000 }), { code: "idempotency_conflict" });
  for (const extra of [{ actorId: "owner" }, { command: "/bin/sh" }, { token: "secret" }]) assert.equal(validReplyArguments("room_claim_request_run", { ...input, ...extra }), false);
  auditRecovery(f.store);
});

test("selected run metadata rejects wrong identity, malformed bounds and unknown contract versions", async t => {
  const f = await fixture(t), q = f.open(), requestMessageId = q.command.data.messageId;
  await f.client.replyAction("room_claim_request_run", { requestId: "claim", requestMessageId, expectedRevision: 0, runId: "run", contextEventId: q.receipt.event.id, instructionsRevision: 0, maxRuntimeMs: 10000, maxOutputBytes: 4096 });
  const source = await f.client.replyContext(requestMessageId), selection = { name: "room_read_request", args: { requestMessageId }, roomId: "commons" };
  for (const corrupt of [value => { value.current.run.memberId = "owner"; }, value => { value.current.run.requestMessageId = "other"; },
    value => { value.current.run.maxRuntimeMs = 300001; }, value => { value.current.run.deadlineAt = value.current.run.startedAt; },
    value => { value.current.run.usedRunIds.push("run"); }, value => { value.current.run.secret = "not allowed"; },
    value => { value.current.runContractVersion = 2; }, value => { delete value.current.run; }]) {
    const value = structuredClone(source); corrupt(value);
    assert.throws(() => validateReplyRead(value, selection), { code: "invalid_response" });
  }
  const legacy = structuredClone(source); delete legacy.current.run; delete legacy.current.runContractVersion;
  assert.equal(validateReplyRead(legacy, selection).current.run, undefined, "legacy absence remains unknown, not an idle run");
});

test("ordinary chat preserves uncertain writes and refuses action or identity injection", async t => {
  const f = await fixture(t), input = { requestId: "chat-lost", body: "Posted once despite a lost confirmation." };
  const lossy = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/commands")) throw new TypeError("Lost chat confirmation");
    return response;
  } });
  await assert.rejects(lossy.replyAction("room_post_message", input), /Lost chat confirmation/);
  const sequence = f.store.room("commons").sequence;
  const receipt = await f.client.replyAction("room_post_message", input);
  assert.equal(receipt.duplicate, true);
  assert.equal(f.store.room("commons").sequence, sequence);
  for (const extra of [{ actorId: "owner" }, { requestKind: "reply" }, { replyToId: "other" }, { token: "secret" }, { responseOutcome: "answered" }]) {
    assert.equal(validReplyArguments("room_post_message", { ...input, ...extra }), false);
  }
  assert.equal(validReplyArguments("room_post_message", { ...input, body: " " }), false);
  assert.equal(validReplyArguments("room_post_message", { ...input, body: "a".repeat(4097) }), false);
  f.store.issueAccessKey("commons", "producer");
  await assert.rejects(f.client.replyAction("room_post_message", { requestId: "revoked-chat", body: "No longer allowed" }), { status: 401 });
  assert.equal(f.store.room("commons").sequence, sequence);
});

test("HTTP rejects unknown, duplicate, mixed and malformed selections; each read reauthenticates", async t => {
  const f = await fixture(t), q = f.open(), headers = { Authorization: "Bearer " + f.keys.producer };
  const query = async (route, suffix, extraHeaders = {}) => fetch(f.origin + "/api/rooms/commons/" + route + "?" + suffix, { headers: { ...headers, ...extraHeaders } });
  for (const [route, suffix] of [
    ["reply-requests", "direction=all"], ["reply-requests", "status=open&status=answered"], ["reply-requests", "viewerId=owner"],
    ["reply-context", "requestMessageId=" + q.command.data.messageId + "&checkpoint=abc"], ["reply-context", "requestMessageId="],
    ["reply-history", "status=open"], ["reply-history", "limit=01"], ["reply-history", "limit=9007199254740992"],
    ["reply-history", "cursor="], ["reply-history", "checkpoint="], ["reply-history", "cursor=x&checkpoint=y"]
  ]) assert.equal((await query(route, suffix)).status, 422, route + "?" + suffix);
  assert.equal((await query("reply-history", "", { "X-Session-Binding": "f".repeat(64) })).status, 409);
  f.store.revoke(f.keys.producer);
  assert.equal((await query("reply-requests", "")).status, 401);
});

test("exact policy-stamped receipts are required and unknown transport outcomes retain original input", async t => {
  const f = await fixture(t), args = { requestId: "agent-asks", toMemberId: "owner", body: "Can you clarify the desired result?" };
  const command = buildReplyCommand(f.identity, "room_request_reply", args), receipt = f.store.command(f.keys.producer, "commons", command);
  assert.ok(confirmsAgentCommand(receipt, command, f.identity));
  for (const change of [value => { delete value.event.data.requestPolicyVersion; }, value => { value.event.data.requestPolicyVersion = 2; },
    value => { value.event.data.extra = true; }, value => { value.event.actorId = "owner"; }, value => { value.event.data.body += " altered"; }]) {
    const value = structuredClone(receipt); change(value); assert.equal(confirmsAgentCommand(value, command, f.identity), false);
  }
  const sent = [];
  const lossy = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
    if (url.endsWith("/commands")) { sent.push(JSON.parse(options.body)); await fetch(url, options); throw new TypeError("Lost response"); }
    return fetch(url, options);
  } });
  const unknown = { requestId: "unknown", toMemberId: "owner", body: "Another explicit question" }, copy = structuredClone(unknown);
  await assert.rejects(lossy.replyAction("room_request_reply", unknown), /Lost response/);
  assert.deepEqual(unknown, copy);
  const retry = await f.client.replyAction("room_request_reply", copy);
  assert.equal(retry.duplicate, true); assert.deepEqual(sent[0], buildReplyCommand(f.identity, "room_request_reply", copy));
  assert.equal(JSON.stringify(replyRefusal({ code: "PRIVATE SECRET", message: "PRIVATE SECRET" })).includes("PRIVATE SECRET"), false);
});

test("read validators refuse changed identity, window, body, lineage and answer basis", async t => {
  const f = await fixture(t), q = f.open(), args = { requestMessageId: q.command.data.messageId };
  const value = await f.client.replyContext(args.requestMessageId);
  for (const change of [v => { v.roomId = "other"; }, v => { v.selection.requestMessageId = "other"; },
    v => { v.page.rowBytes++; }, v => { v.page.items[0].message.authorId = "producer"; }, v => { v.page.items[0].message.body = ""; },
    v => { v.current.answerBasis.contextEventId = "other"; }, v => { v.current.actions.answer = false; },
    v => { v.page.completedCheckpoint = "unusable"; }, v => { v.scope.acknowledges = true; },
    v => { v.page.items = []; v.page.rowBytes = 0; }, v => { v.request.openingEventId = "different"; },
    v => { v.request.requesterId = "reviewer"; }, v => { v.request.contextMessageId = "different"; },
    v => { v.page.horizonEventId = "different"; }]) {
    const altered = structuredClone(value); change(altered);
    assert.throws(() => validateReplyRead(altered, { roomId: "commons", name: "room_read_request", args }), { code: "invalid_response" });
  }
  const client = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!url.includes("/reply-context?")) return response;
    const result = await response.json(); result.viewerId = "owner";
    return Response.json(result);
  } });
  await assert.rejects(client.replyContext(args.requestMessageId), { code: "identity_mismatch" });
  f.store.command(f.keys.owner, "commons", { id: "clarification", type: "message.posted", data: { body: "Clarification", replyToId: args.requestMessageId } });
  const clarified = await f.client.replyContext(args.requestMessageId), wrongWork = structuredClone(clarified);
  wrongWork.page.items.at(-1).message.workItemId = "other-work";
  wrongWork.page.rowBytes = wrongWork.page.items.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  assert.throws(() => validateReplyRead(wrongWork, { roomId: "commons", name: "room_read_request", args }), { code: "invalid_response" });
  await f.client.replyAction("room_respond_to_request", f.respond(clarified));
  const answered = await f.client.replyContext(args.requestMessageId); answered.page.items.pop();
  answered.page.rowBytes = answered.page.items.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  assert.throws(() => validateReplyRead(answered, { roomId: "commons", name: "room_read_request", args }), { code: "invalid_response" });
});

test("reply tool schemas are finite and partial/null bundles cannot be silently converted", () => {
  assert.equal(replyTools.length, 20);
  for (const name of ["room_respond_to_request", "room_request_reply", "room_cancel_request"]) {
    assert.equal(validReplyArguments(name, {}), false);
    assert.equal(validReplyArguments(name, { token: "secret" }), false);
  }
  assert.equal(validReplyArguments("room_request_history", { cursor: "a", checkpoint: "b" }), false);
  assert.equal(validReplyArguments("room_reply", { requestId: "r", replyToId: "q", body: "  " }), false);
  assert.equal(validReplyArguments("room_reply", { requestId: "r", replyToId: "q", body: "hi", requestKind: "reply" }), false);
  assert.deepEqual(buildReplyCommand({ roomId: "commons", memberId: "producer" }, "room_cancel_request",
    { requestId: "cancel", requestMessageId: "q", expectedRequestRevision: 0, reason: "No longer needed" }),
  { id: "cancel", type: "reply_request.cancelled", data: { requestMessageId: "q", expectedRequestRevision: 0, reason: "No longer needed" } });
});

test("lost answer and cancellation responses keep the original terminal operation retryable", async t => {
  const f = await fixture(t), q = f.open(), context = await f.client.replyContext(q.command.data.messageId);
  const lossy = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
    if (!url.endsWith("/commands")) return fetch(url, options);
    await fetch(url, options); throw new TypeError("Lost terminal response");
  } });
  const answer = f.respond(context, { requestId: "terminal-answer" });
  await assert.rejects(lossy.replyAction("room_respond_to_request", answer), /Lost terminal response/);
  f.store.command(f.keys.owner, "commons", { id: "later", type: "message.posted", data: { body: "Later discussion", replyToId: q.command.data.messageId } });
  const beforeRetry = auditRecovery(f.store);
  const retried = await f.client.replyAction("room_respond_to_request", answer);
  assert.equal(retried.duplicate, true); assert.deepEqual(auditRecovery(f.store), beforeRetry);
  const own = await f.client.replyAction("room_request_reply", { requestId: "own-question", toMemberId: "owner", body: "Another question" });
  const cancel = { requestId: "terminal-cancel", requestMessageId: own.requestMessageId, expectedRequestRevision: 0, reason: "No longer needed" };
  await assert.rejects(lossy.replyAction("room_cancel_request", cancel), /Lost terminal response/);
  const beforeCancelRetry = auditRecovery(f.store);
  assert.equal((await f.client.replyAction("room_cancel_request", cancel)).duplicate, true);
  assert.deepEqual(auditRecovery(f.store), beforeCancelRetry);
  const history = await f.client.replyHistory({ direction: "outgoing", limit: 1 });
  const last = await f.client.replyHistory({ direction: "outgoing", cursor: history.page.nextCursor });
  assert.equal(last.page.items[0].kind, "cancelled");
  const wrong = structuredClone(last); wrong.page.items[0].requesterId = "reviewer";
  wrong.page.rowBytes = wrong.page.items.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  assert.throws(() => validateReplyRead(wrong, { roomId: "commons", name: "room_request_history", args: { direction: "outgoing", cursor: history.page.nextCursor } }), { code: "invalid_response" });
});
