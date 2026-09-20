import { openRequestJournal, runRequestOnce, runRequestQueue } from "../client/request-runner.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
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
  // Consent-bound DMs: the owner→producer questions and producer→owner
  // answers need mutual approval.
  f.store.dmConsents.request("commons", "owner", "producer", "test fixture");
  f.store.dmConsents.decide("commons", "producer", "owner", "approve");
  f.store.dmConsents.request("commons", "producer", "owner", "test fixture");
  f.store.dmConsents.decide("commons", "owner", "producer", "approve");
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
  assert.equal(replyTools.length, 7);
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

test("request tools automatically prepare only current room instructions and linked work", async t => {
  const f = await fixture(t);
  const send = (id, type, data) => f.store.command(f.keys.owner, "commons", { id, type, data });
  send("prepare-instructions", "room.charter_updated", { expectedRevision: 0, purpose: "Build a useful room", outputs: "A working result", boundaries: null, escalation: null });
  for (const id of ["linked", "unrelated"]) send(`prepare-${id}`, "work.proposed", {
    workItemId: id, title: id, definitionOfDone: `${id} requirements`, accountableMemberId: "producer", mode: "read"
  });
  send("private-context", "message.posted", { messageId: "unrelated-message", body: "Unrelated conversation should not be bundled" });
  const q = f.open("prepared", { workItemId: "linked" });
  const before = f.store.snapshot(f.keys.owner, "commons");
  const context = await f.client.replyContext(q.command.data.messageId);
  assert.equal(context.preparation.room.purpose, "Build a useful room");
  assert.equal(context.preparation.instructions.charter.outputs, "A working result");
  assert.equal(context.preparation.work.id, "linked");
  assert.equal(context.preparation.work.definitionOfDone, "linked requirements");
  assert.equal(context.preparation.evaluatedThrough, context.current.evaluatedThrough);
  assert.equal(JSON.stringify(context.preparation).includes('Unrelated conversation'), false);
  assert.equal(JSON.stringify(context.preparation).includes('unrelated requirements'), false);
  assert.deepEqual(f.store.snapshot(f.keys.owner, "commons"), before);
  const adapter = await f.mcp();
  const read = (await adapter.call("room_read_request", { requestMessageId: q.command.data.messageId })).result.structuredContent;
  assert.deepEqual(read.preparation, context.preparation);
  const args = { name: "room_read_request", args: { requestMessageId: q.command.data.messageId }, roomId: "commons" };
  for (const change of [p => p.room.id = 'other-room', p => p.work.id = 'unrelated', p => p.instructions.revision++, p => p.evaluatedThrough--]) {
    const bad = structuredClone(context); change(bad.preparation);
    assert.throws(() => validateReplyRead(bad, args), { code: "invalid_response" });
  }
  const legacy = structuredClone(context); delete legacy.preparation;
  assert.equal(validateReplyRead(legacy, args), legacy, "older services remain readable");
  const plain = f.open("no-work");
  assert.equal((await f.client.replyContext(plain.command.data.messageId)).preparation.work, null);
});


const runner = (t, f) => {
  const db = openRequestJournal(join(f.directory, "host-requests.sqlite"));
  t.after(() => db.close());
  return { connection: f.config, db };
};
test("configured host receives prepared request once and its answer returns through real Room HTTP", async t => {
  const f = await fixture(t), args = runner(t, f), q = f.open("host-run");
  let calls = 0;
  const execute = async input => {
    calls++;
    assert.equal(input.request.recipientId, "producer");
    assert.equal(input.messages[0].message.body, q.command.data.body);
    assert.equal(input.preparation.room.id, "commons");
    assert.equal(JSON.stringify(input).includes(f.config.token), false);
    return { body: "A result from the configured test host" };
  };
  const result = await runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute });
  assert.equal(result.hostExecuted, true);
  assert.equal((await f.client.replyContext(q.command.data.messageId)).request.status, "answered");
  const retry = await runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute });
  assert.equal(retry.receipt.duplicate, true);
  assert.equal(retry.hostExecuted, false);
  assert.equal(calls, 1);
});
test("lost delivery response reuses saved answer without executing host again", async t => {
  const f = await fixture(t), args = runner(t, f), q = f.open("host-lost");
  let calls = 0, lost = false;
  const connection = { ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === "POST" && new URL(url).pathname.endsWith("/commands") && !lost) { lost = true; throw new TypeError("lost response"); }
    return response;
  } };
  const execute = async () => { calls++; return { body: "Persisted result" }; };
  await assert.rejects(runRequestOnce({ ...args, connection, requestMessageId: q.command.data.messageId, execute }));
  const recovered = await runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute });
  assert.equal(recovered.receipt.duplicate, true);
  assert.equal(calls, 1);
});
test("host failure is unknown and is never automatically executed a second time", async t => {
  const f = await fixture(t), args = runner(t, f), q = f.open("host-unknown");
  let calls = 0;
  const execute = async () => { calls++; throw new Error("host disconnected"); };
  await assert.rejects(runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute }), /disconnected/);
  await assert.rejects(runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute }), /unknown/);
  assert.equal(calls, 1);
});
test("human clarification during execution refuses stale delivery without rerunning or rebasing", async t => {
  const f = await fixture(t), args = runner(t, f), q = f.open("host-steering");
  let calls = 0;
  const execute = async () => {
    calls++;
    f.store.command(f.keys.owner, "commons", { id: "steer-host", type: "message.posted", data: { messageId: "steer-host-msg", replyToId: q.command.data.messageId, body: "New clarification" } });
    return { body: "An answer to the old request context" };
  };
  for (let i = 0; i < 2; i++) await assert.rejects(runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute }), { code: "command_rejected" });
  assert.equal(calls, 1);
  assert.equal((await f.client.replyContext(q.command.data.messageId)).request.status, "open");
});

test("durable host result survives journal reopen and excludes concurrent execution", async t => {
  const f = await fixture(t), path = join(f.directory, "restart.sqlite"), q = f.open("host-concurrent");
  let db = openRequestJournal(path), entered, release, calls = 0;
  const started = new Promise(resolve => entered = resolve);
  const blocked = new Promise(resolve => release = resolve);
  const execute = async () => { calls++; entered(); await blocked; return { body: "One durable answer" }; };
  const args = { connection: f.config, requestMessageId: q.command.data.messageId, execute };
  try {
    const running = runRequestOnce({ ...args, db });
    await started;
    const other = openRequestJournal(path);
    try { await assert.rejects(runRequestOnce({ ...args, db: other }), /unknown|owns/); }
    finally { other.close(); release(); }
    await running;
    db.close(); db = openRequestJournal(path);
    const recovered = await runRequestOnce({ ...args, db });
    assert.equal(recovered.receipt.duplicate, true);
    assert.equal(calls, 1);
  } finally { release?.(); db.close(); }
});
test("closed and unaddressed requests never execute the configured host", async t => {
  const f = await fixture(t), args = runner(t, f), q = f.open("host-closed");
  const context = await f.client.replyContext(q.command.data.messageId);
  await f.client.replyAction("room_respond_to_request", f.respond(context));
  let calls = 0;
  const execute = async () => { calls++; return { body: "Unexpected" }; };
  await assert.rejects(runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute }), /not ready/);
  await assert.rejects(runRequestOnce({ ...args, connection: { ...f.config, memberId: "owner", token: f.keys.owner }, requestMessageId: q.command.data.messageId, execute }));
  assert.equal(calls, 0);
});


test("one command drives a separate host process and repeat invocation reuses its result", async t => {
  const f = await fixture(t), q = f.open("process-host"), counter = join(f.directory, "executions"), hostFile = join(f.directory, "host.json");
  const hostCode = `const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const v=JSON.parse(input);if(!v.preparation.room.id||!v.messages.length||process.env.ROOM_AGENT_CONFIG)process.exit(2);fs.appendFileSync(process.argv[1],'1');console.log(JSON.stringify({body:'Separate host answered the prepared request'}));});`;
  writeFileSync(hostFile, JSON.stringify({ command: process.execPath, args: ["-e", hostCode, counter], cwd: f.directory, timeoutMs: 5000 }));
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-room-request.mjs", q.command.data.messageId, join(f.directory, "process.sqlite"), hostFile],
      { env: { ROOM_AGENT_CONFIG: f.configDirectory }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", c => out += c); child.stderr.on("data", c => err += c);
    child.on("error", reject); child.on("exit", code => resolve({ code, out, err }));
  });
  const first = await invoke(); assert.equal(first.code, 0, first.err);
  assert.equal(JSON.parse(first.out).hostExecuted, true);
  const second = await invoke(); assert.equal(second.code, 0, second.err);
  assert.equal(JSON.parse(second.out).hostExecuted, false);
  assert.equal(readFileSync(counter, "utf8"), "1");
  assert.equal((await f.client.replyContext(q.command.data.messageId)).request.status, "answered");
});


test("separate journals racing one request start exactly one host and disclose status only to participants", async t => {
  const f = await fixture(t), a = runner(t, f), second = openRequestJournal(join(f.directory, "other.sqlite"));
  t.after(() => second.close());
  const requestMessageId = f.open("distributed").command.data.messageId;
  let calls = 0;
  const execute = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return { body: "Only one host" }; };
  const results = await Promise.allSettled([a, { connection: f.config, db: second }].map(args => runRequestOnce({ ...args, requestMessageId, execute })));
  assert.equal(calls, 1); assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.store.requestRuns.list(f.keys.owner, "commons").runs[requestMessageId].state, "delivered");
  assert.deepEqual(f.store.requestRuns.list(f.keys.guest, "commons").runs, {});
  assert.equal(JSON.stringify(f.store.requestRuns.list(f.keys.owner, "commons")).includes("attemptId"), false);
});
test("a lost reservation response cannot launch or relaunch a host", async t => {
  const f = await fixture(t), a = runner(t, f), requestMessageId = f.open("lost-claim").command.data.messageId;
  let calls = 0;
  const connection = { ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === "POST" && new URL(url).pathname.endsWith("/request-runs")) throw new TypeError("lost claim response");
    return response;
  } };
  const execute = async () => { calls++; return { body: "Must not execute" }; };
  await assert.rejects(runRequestOnce({ ...a, connection, requestMessageId, execute }));
  await assert.rejects(runRequestOnce({ ...a, requestMessageId, execute }), /unknown/);
  const second = openRequestJournal(join(f.directory, "new-machine.sqlite")); t.after(() => second.close());
  await assert.rejects(runRequestOnce({ connection: f.config, db: second, requestMessageId, execute }), /owns/);
  assert.equal(calls, 0);
});
test("stale heartbeats show unknown without transferring ownership; status does not change answer basis", async t => {
  const f = await fixture(t), requestMessageId = f.open("status").command.data.messageId;
  const before = await f.client.replyContext(requestMessageId), attemptId = "original-host";
  const basis = { expectedRequestRevision: before.request.revision, contextEventId: before.request.contextEventId };
  const send = action => f.client.requestRuns({ requestMessageId, attemptId, action, ...basis });
  await send("claim"); await send("working");
  assert.deepEqual((await f.client.replyContext(requestMessageId)).current.answerBasis, before.current.answerBasis);
  const now = f.store.now; f.store.now = () => now() + 120001;
  assert.equal((await f.client.requestRuns()).runs[requestMessageId].state, "unknown");
  await assert.rejects(f.client.requestRuns({ requestMessageId, attemptId: "new-host", action: "claim", ...basis }), /owns/);
  await assert.rejects(send("delivered"), /recorded answer/);
  await send("needs_attention"); await assert.rejects(send("working"), /silently resume/);
});
test("paused agents cannot start and a definite preflight refusal can be retried after resume", async t => {
  const f = await fixture(t), a = runner(t, f), requestMessageId = f.open("paused-host").command.data.messageId;
  f.store.wakeQueue.pause(f.keys.producer, "commons", { requestId: "pause-run", reason: null });
  let calls = 0; const execute = async () => { calls++; return { body: "Resumed" }; };
  await assert.rejects(runRequestOnce({ ...a, requestMessageId, execute }), /paused/);
  assert.equal(calls, 0);
  f.store.wakeQueue.resume(f.keys.producer, "commons", { requestId: "resume-run" });
  await runRequestOnce({ ...a, requestMessageId, execute }); assert.equal(calls, 1);
});
test("automatic mode ignores ordinary chat and delivers an addressed request without a per-request command", async t => {
  const f = await fixture(t), a = runner(t, f), controller = new AbortController();
  t.after(() => controller.abort());
  f.store.command(f.keys.owner, "commons", { id: "plain", type: "message.posted", data: { messageId: "plain", body: "Just chatting" } });
  let calls = 0;
  const queue = runRequestQueue({ ...a, signal: controller.signal, intervalMs: 1000,
    execute: async () => { calls++; return { body: "Automatically picked up" }; }, emit: result => { if (result.status === "delivered") controller.abort(); } });
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(calls, 0);
  const requestMessageId = f.open("automatic", { messageId: "toString" }).command.data.messageId;
  await queue;
  assert.equal(calls, 1); assert.equal((await f.client.replyContext(requestMessageId)).request.status, "answered");
});


test("automatic restart delivers a saved response without another model call", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = runner(t, f), requestMessageId = f.open("queue-recovery").command.data.messageId;
  const connection = { ...f.config, fetchImpl: async (url, options) => {
    if (options.method === "POST" && new URL(url).pathname.endsWith("/commands")) throw new TypeError("delivery offline");
    return fetch(url, options);
  } };
  let calls = 0;
  await assert.rejects(runRequestOnce({ ...a, connection, requestMessageId,
    execute: async () => { calls++; return { body: "Saved while offline" }; } }));
  assert.equal((await f.client.requestRuns()).runs[requestMessageId].state, "result_ready");
  const reopened = openRequestJournal(join(f.directory, "host-requests.sqlite")); t.after(() => reopened.close());
  const controller = new AbortController(); t.after(() => controller.abort());
  await runRequestQueue({ connection: f.config, db: reopened, signal: controller.signal,
    execute: async () => { calls++; throw new Error("Must not invoke again"); },
    emit: result => { if (result.status === "delivered") controller.abort(); } });
  assert.equal(calls, 1); assert.equal((await f.client.replyContext(requestMessageId)).request.status, "answered");
});

test("heartbeat detects new clarification and signals the running host to stop", { timeout: 10000 }, async t => {
  const f = await fixture(t), a = runner(t, f), requestMessageId = f.open("heartbeat-steering").command.data.messageId;
  t.mock.timers.enable({ apis: ["setInterval"] });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = runRequestOnce({ ...a, requestMessageId, execute: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }); entered();
  }) });
  const refused = assert.rejects(pending, /changed, paused or closed/);
  await started;
  await f.client.replyAction("room_reply", { requestId: "new-direction", replyToId: requestMessageId, body: "A new constraint changes the task." });
  t.mock.timers.tick(30000);
  await refused;
  assert.equal((await f.client.requestRuns()).runs[requestMessageId].state, "needs_attention");
  assert.equal((await f.client.replyContext(requestMessageId)).request.status, "open");
});


test("rate-limited reservation is a definite refusal, not an uncertain execution", async t => {
  const f = await fixture(t), a = runner(t, f), requestMessageId = f.open("throttled-host").command.data.messageId;
  const connection = { ...f.config, fetchImpl: async (url, options) => {
    if (options.method === "POST" && new URL(url).pathname.endsWith("/request-runs"))
      return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Try later" } }), { status: 429 });
    return fetch(url, options);
  } };
  let calls = 0; const execute = async () => { calls++; return { body: "Retried after throttling" }; };
  await assert.rejects(runRequestOnce({ ...a, connection, requestMessageId, execute }), { status: 429 });
  assert.equal(calls, 0);
  await runRequestOnce({ ...a, requestMessageId, execute }); assert.equal(calls, 1);
});


test("saved-answer recovery stops retrying when clarification arrived while the host was offline", async t => {
  const f = await fixture(t), a = runner(t, f), requestMessageId = f.open("offline-steering").command.data.messageId;
  const connection = { ...f.config, fetchImpl: async (url, options) => {
    if (options.method === "POST" && new URL(url).pathname.endsWith("/commands")) throw new TypeError("offline");
    return fetch(url, options);
  } };
  let calls = 0; const execute = async () => { calls++; return { body: "Saved before clarification" }; };
  await assert.rejects(runRequestOnce({ ...a, connection, requestMessageId, execute }));
  assert.equal((await f.client.requestRuns()).runs[requestMessageId].state, "result_ready");
  await f.client.replyAction("room_reply", { requestId: "offline-clarification", replyToId: requestMessageId, body: "The requirement changed." });
  await assert.rejects(runRequestOnce({ ...a, requestMessageId, execute }), { status: 409 });
  assert.equal((await f.client.requestRuns()).runs[requestMessageId].state, "needs_attention");
  assert.equal(calls, 1);
});
