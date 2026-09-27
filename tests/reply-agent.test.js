import { openRequestJournal, runRequestOnce, runRequestQueue } from "../client/request-runner.mjs";
import test from "node:test";
import { createServer } from "node:http";
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
import { AgentRooms } from "../server/agent-rooms.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
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
  const hostCode = `const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const v=JSON.parse(input);if(!v.context.preparation.room.id||!v.context.messages.length||process.env.ROOM_AGENT_CONFIG)process.exit(2);fs.appendFileSync(process.argv[1],'1');console.log(JSON.stringify({body:'Separate host answered the prepared request'}));});`;
  writeFileSync(hostFile, JSON.stringify({ command: process.execPath, args: ["-e", hostCode, counter], cwd: f.directory, timeoutMs: 5000, policy: { version: 1, checkout: f.directory, filesystem: "checkout-write", network: "none", ambientSecrets: "none", externalEffects: "none" } }));
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

test("coding result survives lost delivery with exact patch bytes and stays private", async t => {
  const f = await fixture(t), args = runner(t, f), q = f.open("code-result");
  const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-before\n+after\n";
  let calls = 0;
  const connection = { ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === "POST" && new URL(url).pathname.endsWith("/commands")) throw new TypeError("lost result receipt");
    return response;
  } };
  const execute = async () => { calls++; return { body: "Fixed.", codeResult: {
    repositoryUrl: "https://example.com/repo", baseRevision: "a".repeat(40), patch, files: ["a"],
    checks: [{ command: "node --test", outcome: "passed" }]
  } }; };
  await assert.rejects(runRequestOnce({ ...args, connection, requestMessageId: q.command.data.messageId, execute }));
  const saved = JSON.parse(args.db.prepare("SELECT response FROM request_runs").get().response);
  assert.ok(saved.body.endsWith(patch));
  const recovered = await runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute });
  assert.equal(calls, 1); assert.equal(recovered.receipt.duplicate, true);
  const response = f.store.room("commons").state.messages.find(m => m.id === recovered.receipt.messageId);
  assert.equal(response.body, saved.body); assert.equal(response.toMemberId, "owner");
  const outsider = new RoomAgentClient({ ...f.config, memberId: "reviewer", token: f.keys.reviewer });
  await assert.rejects(outsider.replyContext(q.command.data.messageId), { status: 404 });
});


test("request reads reject nonparticipants and exclude another private reply before paging", async t => {
  const f = await fixture(t), q = f.open("private-context"), id = q.command.data.messageId;
  // Owner is in both exchanges, but the producer must not receive owner's private side message.
  f.store.dmConsents.request("commons", "owner", "reviewer", "fixture");
  f.store.dmConsents.decide("commons", "reviewer", "owner", "approve");
  f.store.command(f.keys.owner, "commons", { id: "side-message", type: "message.posted", data: {
    messageId: "side-message", replyToId: id, toMemberId: "reviewer", body: "Secret side discussion"
  } });
  await assert.rejects(f.client.replyContext(id), { status: 409, code: "reply_context_unavailable" });
  f.store.command(f.keys.owner, "commons", { id: "visible-clarification", type: "message.posted", data: {
    messageId: "visible-clarification", replyToId: id, toMemberId: "producer", body: "Use the original request."
  } });
  const producer = await f.client.replyContext(id, { limit: 2 });
  assert.equal(producer.scope.targetedMessages, "participants-only");
  assert.equal(producer.page.hasMore, false);
  assert.equal(producer.page.items.length, 2);
  assert.equal(JSON.stringify(producer).includes("Secret side discussion"), false);
  const history = await f.client.replyHistory({ limit: 2 });
  assert.equal(history.page.hasMore, false);
  assert.equal(JSON.stringify(history).includes("Secret side discussion"), false);
  for (const memberId of ["reviewer", "guest"]) {
    const other = new RoomAgentClient({ ...f.config, memberId, token: f.keys[memberId] });
    // Use HTTP directly for human guest, since the agent client rejects human identity.
    const response = await fetch(`${f.origin}/api/rooms/commons/reply-context?requestMessageId=${id}`, {
      headers: { Authorization: `Bearer ${f.keys[memberId]}` }
    });
    assert.equal(response.status, 404);
    if (memberId === "reviewer") assert.deepEqual((await other.replyRequests()).requests, []);
  }
});

test("a follow-up host receives the earlier result and runs independently without repeating its parent", async t => {
  const f = await fixture(t), args = runner(t, f), first = f.open("first-pass");
  const calls = [];
  const execute = async input => {
    calls.push(input.request.id);
    if (calls.length === 1) return { body: "First implementation and test result" };
    assert.equal(input.preparation.previousExchanges[0].messages.at(-1).body, "First implementation and test result");
    assert.equal(input.messages[0].message.body, "Make this work with the keyboard too");
    return { body: "Keyboard support added" };
  };
  await runRequestOnce({ ...args, requestMessageId: first.command.data.messageId, execute });
  const parent = (await f.client.replyContext(first.command.data.messageId)).request;
  const next = f.open("refinement", { replyToId: parent.responseMessageId, body: "Make this work with the keyboard too" });
  await runRequestOnce({ ...args, requestMessageId: next.command.data.messageId, execute });
  await runRequestOnce({ ...args, requestMessageId: next.command.data.messageId, execute });
  assert.deepEqual(calls, [first.command.data.messageId, next.command.data.messageId]);
  assert.deepEqual((await f.client.replyContext(first.command.data.messageId)).request, parent);
});

test("a room stream wakes the automatic host before its polling interval", { timeout: 8000 }, async t => {
  const f = await fixture(t), a = runner(t, f), controller = new AbortController();
  t.after(() => controller.abort());
  let listening, calls = 0;
  const ready = new Promise(resolve => { listening = resolve; });
  const connection = { ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (new URL(url).pathname.endsWith("/stream")) {
      assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit"); listening();
    }
    return response;
  } };
  const queue = runRequestQueue({ ...a, connection, signal: controller.signal, intervalMs: 10000,
    execute: async () => { calls++; return { body: "Stream woke this host" }; },
    emit: result => { if (result.status === "delivered") controller.abort(); } });
  await ready; const started = Date.now();
  const requestMessageId = f.open("stream-wake").command.data.messageId;
  await queue;
  assert.equal(calls, 1); assert.ok(Date.now() - started < 5000, "delivery did not wait for the 10-second poll");
  assert.equal((await f.client.replyContext(requestMessageId)).request.status, "answered");
});

test("an unavailable stream falls back to bounded polling without losing a request", { timeout: 8000 }, async t => {
  const f = await fixture(t), a = runner(t, f), controller = new AbortController();
  t.after(() => controller.abort()); let failed, streams = 0, calls = 0;
  const ready = new Promise(resolve => { failed = resolve; });
  const connection = { ...f.config, fetchImpl: async (url, options) => {
    if (new URL(url).pathname.endsWith("/stream")) { streams++; failed(); return new Response("unavailable", { status: 503 }); }
    return fetch(url, options);
  } };
  const queue = runRequestQueue({ ...a, connection, signal: controller.signal, intervalMs: 1000,
    execute: async () => { calls++; return { body: "Polling recovered" }; },
    emit: result => { if (result.status === "delivered") controller.abort(); } });
  await ready; const started = Date.now(); f.open("fallback-wake"); await queue;
  assert.ok(Date.now() - started >= 800, "failed streams do not spin a tight polling loop");
  assert.equal(streams, 1); assert.equal(calls, 1);
});

test("stream wakeups retain deadlines, reject malformed cursors and enforce revocation", { timeout: 8000 }, async t => {
  const f = await fixture(t), after = f.store.room("commons").sequence;
  assert.deepEqual(await f.client.waitForChange(after, { timeoutMs: 100 }), { changed: false });
  const malformed = new RoomAgentClient({ ...f.config, fetchImpl: (url, options) => new URL(url).pathname.endsWith("/stream")
    ? Promise.resolve(new Response("event: room-event\nid: nope\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }))
    : fetch(url, options) });
  await assert.rejects(malformed.waitForChange(after), { code: "invalid_response" });
  let listening; const ready = new Promise(resolve => { listening = resolve; });
  const client = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => {
    const response = await fetch(url, options); if (new URL(url).pathname.endsWith("/stream")) listening(); return response;
  } });
  const ended = assert.rejects(client.waitForChange(after), { code: "access_ended" }); await ready;
  const member = f.store.room("commons").state.members.producer;
  f.store.command(f.keys.owner, "commons", { id: "end-stream-member", type: "member.access_changed", data: {
    memberId: "producer", expectedMemberRevision: member.revision, permissions: [], active: false } });
  await ended;
});


test("a fresh recipient discovers how to answer from messages and verifies closure without reconstructing fixed arguments", async t => {
  const f = await fixture(t), q = f.open("guided-answer"), id = q.command.data.messageId;
  const adapter = await f.mcp();
  const messages = (await adapter.call("room_read_messages", {})).result.structuredContent;
  const inbox = (await adapter.call("room_read_inbox", {})).result.structuredContent;
  const listing = inbox.next.find(step => step.action === "list-open-requests").nextRead;
  const listed = (await adapter.call(listing.tool, listing.arguments)).result.structuredContent;
  assert.deepEqual(listed.requests.map(request => request.id), [id]);
  const incoming = messages.messages.find(message => message.messageId === id);
  assert.deepEqual(inbox.directMessages.find(message => message.messageId === id).nextRead, incoming.nextRead);
  assert.equal(incoming.requestKind, "reply");
  const step = inbox.next.find(step => step.action === "read-request");
  assert.equal(step.method, "GET");
  const rest = await fetch(f.origin + step.path, { headers: { Authorization: `Bearer ${f.keys.producer}` } });
  assert.equal(rest.status, 200); assert.equal((await rest.json()).request.id, id);
  assert.equal(inbox.next.some(step => step.action === "reply-dm"), false);
  const discovered = step.nextRead;
  assert.equal(discovered.tool, "room_read_request");
  const context = (await adapter.call(discovered.tool, discovered.arguments)).result.structuredContent;
  const unbound = new RoomAgentClient({ origin: f.origin, roomId: "commons", token: f.keys.producer });
  const unboundMessage = (await unbound.roomMessages()).messages.find(message => message.messageId === id);
  assert.equal(Object.hasOwn(unboundMessage, "nextRead"), false, "a client without expected identity must not claim to be a request party");
  const action = context.responseActions.find(action => action.arguments.responseOutcome === "answered");
  assert.deepEqual(action.requiredInput, ["requestId", "body"]);
  const args = { ...action.arguments, requestId: "guided-answer-once", body: "A concrete answer from the discovered action." };
  const receipt = (await adapter.call(action.tool, args)).result.structuredContent;
  assert.equal(receipt.status, "recorded");
  const sequence = f.store.room("commons").sequence;
  const retried = (await adapter.call(action.tool, args)).result.structuredContent;
  assert.equal(retried.duplicate, true); assert.equal(retried.eventId, receipt.eventId);
  assert.equal(f.store.room("commons").sequence, sequence);
  const final = (await adapter.call(receipt.next.tool, receipt.next.arguments)).result.structuredContent;
  assert.equal(final.request.status, "answered");
  assert.equal(final.page.items.at(-1).message.body, args.body);
  assert.deepEqual(final.responseActions, []);
  assert.equal((await f.client.replyRequests()).requests.length, 0);
});

test("HTTP response templates require completed current recipient context and stale templates cannot write", async t => {
  const f = await fixture(t), q = f.open("guided-fence"), id = q.command.data.messageId;
  const get = async (path, key = f.keys.producer) => {
    const response = await fetch(f.origin + path, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200); return response.json();
  };
  const list = await get("/api/rooms/commons/reply-requests");
  assert.equal(Object.hasOwn(list, "responseActions"), false);
  const path = list.nextReads[0].http.path;
  const initial = await get(path);
  assert.equal(initial.responseActions.length, 2);
  const requesterRead = await get(path, f.keys.owner);
  assert.deepEqual(requesterRead.responseActions, []); assert.deepEqual(requesterRead.responseHttpActions, []);
  await f.client.replyAction("room_reply", { requestId: "guided-clarification", replyToId: id, body: "A new constraint" });
  const before = f.store.room("commons").sequence;
  const stale = initial.responseActions[0];
  await assert.rejects(f.client.replyAction(stale.tool, { ...stale.arguments, requestId: "guided-stale", body: "Old answer" }), { code: "command_rejected" });
  const staleHttp = initial.responseHttpActions[0];
  const staleCommand = structuredClone(staleHttp.command); staleCommand.data.body = "Old REST answer";
  const refused = await fetch(f.origin + staleHttp.path, { method: staleHttp.method,
    headers: { Authorization: `Bearer ${f.keys.producer}`, "Content-Type": "application/json" }, body: JSON.stringify(staleCommand) });
  assert.equal(refused.status, 409);
  assert.equal(f.store.room("commons").sequence, before);
  const first = await get(path + "&limit=1");
  assert.equal(first.page.hasMore, true); assert.deepEqual(first.responseActions, []); assert.deepEqual(first.responseHttpActions, []);
  const last = await get(path + "&limit=1&cursor=" + encodeURIComponent(first.page.nextCursor));
  assert.equal(last.responseActions.length, 2);
  const valid = { name: "room_read_request", args: { requestMessageId: id, limit: 1, cursor: first.page.nextCursor }, roomId: "commons" };
  validateReplyRead(last, valid);
  for (const change of [value => { value.responseActions[0] = null; }, value => { value.responseActions[0].arguments.toMemberId = "reviewer"; },
    value => { value.responseActions[0].arguments.contextSequence--; },
    value => { value.responseActions[0].arguments.workItemId = "unrelated"; },
    value => { value.responseActions[0].arguments.body = "Injected answer"; }]) {
    const forged = structuredClone(last); change(forged);
    assert.throws(() => validateReplyRead(forged, valid), { code: "invalid_response" });
  }
  const legacy = structuredClone(last); delete legacy.responseActions;
  validateReplyRead(legacy, valid);
});


test("hosted discovery keeps room identity and distinguishes formal requests from ordinary private chat", async t => {
  const f = await fixture(t), owner = f.store.identities.create("Host"), peer = f.store.identities.create("Responder"), outsider = f.store.identities.create("Observer");
  const rooms = new AgentRooms(f.store);
  const created = rooms.create(owner.secret, { roomId: "guided-hosted", title: "Replies", purpose: "Answer questions", kind: "personal", displayName: "Host" });
  for (const person of [peer, outsider]) f.store.identities.link(owner.secret, created.roomId, { identityId: person.identityId, displayName: person === peer ? "Responder" : "Observer", permissions: [] });
  for (const [from, to] of [[created.ownerMemberId, peer.identityId], [peer.identityId, created.ownerMemberId]]) {
    f.store.dmConsents.request(created.roomId, from, to, "Fixture");
    f.store.dmConsents.decide(created.roomId, to, from, "approve");
  }
  for (const [id, formal] of [["formal", true], ["ordinary", false]]) f.store.command(owner.secret, created.roomId, {
    id, type: "message.posted", data: { messageId: id, body: "Private question", toMemberId: peer.identityId, ...(formal ? { requestKind: "reply" } : {}) }
  });
  const mcp = createHostedRoomMcp(f.store, { agentRooms: rooms });
  const call = async (name, args, secret = peer.secret) => {
    const response = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${secret}` });
    assert.equal(response.result?.isError, undefined, JSON.stringify(response)); return response.result.structuredContent;
  };
  const messages = await call("room_read_messages", { roomId: created.roomId });
  const formal = messages.messages.find(message => message.messageId === "formal");
  const ordinary = messages.messages.find(message => message.messageId === "ordinary");
  assert.equal(formal.requestKind, "reply");
  assert.equal(Object.hasOwn(ordinary, "requestKind"), false); assert.equal(Object.hasOwn(ordinary, "nextRead"), false);
  assert.deepEqual((await call("room_read_messages", { roomId: created.roomId }, outsider.secret)).messages, []);
  const inbox = await call("room_read_inbox", { roomId: created.roomId });
  assert.deepEqual(inbox.directMessages.find(message => message.messageId === "formal").nextRead, formal.nextRead);
  assert.equal(Object.hasOwn(inbox.directMessages.find(message => message.messageId === "ordinary"), "nextRead"), false);
  const list = await call("room_list_requests", { roomId: created.roomId });
  assert.deepEqual(list.nextReads[0].nextRead, formal.nextRead);
  const selected = await call(formal.nextRead.tool, formal.nextRead.arguments);
  const action = selected.responseActions[0];
  const receipt = await call(action.tool, { ...action.arguments, requestId: "hosted-answer", body: "A helpful answer" });
  const closed = await call(receipt.next.tool, receipt.next.arguments);
  assert.equal(closed.request.status, "answered"); assert.deepEqual(closed.responseActions, []);
});


test("a REST-only recipient follows the supplied command recipe and verifies its exact retried answer", async t => {
  const f = await fixture(t), q = f.open("rest-recipe"), headers = { Authorization: `Bearer ${f.keys.producer}`, "Content-Type": "application/json" };
  const list = await (await fetch(f.origin + "/api/rooms/commons/reply-requests", { headers })).json();
  const readPath = list.nextReads[0].http.path;
  const context = await (await fetch(f.origin + readPath, { headers })).json();
  const selection = { name: "room_read_request", args: { requestMessageId: q.command.data.messageId }, roomId: "commons" };
  validateReplyRead(context, selection);
  for (const alter of [value => { value.responseHttpActions[0] = null; },
    value => { value.responseHttpActions[0].path = "https://outside.invalid/commands"; },
    value => { value.responseHttpActions[0].verify.path = "/api/rooms/other/reply-context?requestMessageId=unrelated"; },
    value => { value.responseHttpActions[0].command.data.messageId = "forged"; },
    value => { value.responseHttpActions[0].command.data.replyToId = null; },
    value => { value.responseHttpActions[0].command.data.requestPolicyVersion = 1; },
    value => { value.responseHttpActions[0].command.data.body = "Injected answer"; }]) {
    const forged = structuredClone(context); alter(forged);
    assert.throws(() => validateReplyRead(forged, selection), { code: "invalid_response" });
  }
  const legacy = structuredClone(context); delete legacy.responseHttpActions; validateReplyRead(legacy, selection);
  const recipe = context.responseHttpActions.find(action => action.command.data.responseOutcome === "answered");
  assert.deepEqual(recipe.requiredInput, ["command.data.body"]);
  assert.notEqual(recipe.command.id, q.command.data.messageId);
  assert.equal(recipe.command.data.responseToRequestId, q.command.data.messageId);
  const command = structuredClone(recipe.command); command.data.body = "REST answer without guessing protocol fields.";
  const submit = () => fetch(f.origin + recipe.path, { method: recipe.method, headers, body: JSON.stringify(command) });
  const sent = await submit(); assert.equal(sent.status, 201);
  const receipt = await sent.json(), sequence = f.store.room("commons").sequence;
  const retried = await submit(); assert.equal(retried.status, 200);
  const duplicate = await retried.json(); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.event.id, receipt.event.id);
  assert.equal(f.store.room("commons").sequence, sequence);
  const final = await (await fetch(f.origin + recipe.verify.path, { headers })).json();
  assert.equal(final.request.status, "answered"); assert.equal(final.request.responseMessageId, command.data.messageId);
  assert.deepEqual(final.responseHttpActions, []);
});


test("MCP failed request reads give private-safe read recovery instead of uncertain-write advice", async t => {
  const f = await fixture(t), privateQuestion = f.open("private-other", { toMemberId: "reviewer" }), adapter = await f.mcp();
  const read = async args => {
    const response = await adapter.call("room_read_request", args);
    assert.equal(response.result.isError, true); return response.result.structuredContent;
  };
  const before = f.store.room("commons").sequence;
  const missing = await read({ requestMessageId: "absent-question" });
  assert.equal(missing.outcome, "read_failed");
  assert.deepEqual(missing.next, [{ tool: "room_list_requests", arguments: { direction: "both", status: "all" } }]);
  assert.deepEqual(await read({ requestMessageId: privateQuestion.command.data.messageId }), missing);
  assert.equal(/unknown write|requestId exactly/.test(missing.message), false);
  const q = f.open("read-error-cursor");
  await f.client.replyAction("room_reply", { requestId: "read-error-clarify", replyToId: q.command.data.messageId, body: "Clarification" });
  const selection = { requestMessageId: q.command.data.messageId, limit: 1 };
  const page = (await adapter.call("room_read_request", selection)).result.structuredContent;
  const changed = JSON.parse(Buffer.from(page.page.nextCursor, "base64url")); changed.horizonEventId = "different-anchor";
  const failed = await read({ ...selection, cursor: Buffer.from(JSON.stringify(changed)).toString("base64url") });
  assert.equal(failed.code, "reply_history_changed"); assert.equal(failed.outcome, "read_failed");
  assert.deepEqual(failed.next, []); assert.match(failed.message, /never.*reset/i);
  const invalid = await read({ ...selection, cursor: "abc" });
  assert.equal(invalid.code, "invalid_reply_cursor"); assert.equal(invalid.outcome, "read_failed");
  assert.equal(f.store.room("commons").sequence, before + 2);
});

test("automatic pickup reports one connection failure per outage and reports a later outage after recovery", { timeout: 20000 }, async t => {
  const f = await fixture(t), a = runner(t, f), controller = new AbortController(), observed = [];
  let reads = 0;
  const gateway = createServer(async (req, res) => {
    if (req.url.startsWith("/api/rooms/commons/reply-requests")) {
      reads++;
      if (reads !== 3) {
        res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: "service_unavailable", message: "Temporary outage" } }));
        if (reads === 5) setTimeout(() => controller.abort(), 50);
        return;
      }
    }
    const upstream = await fetch(f.origin + req.url, { headers: req.headers });
    res.writeHead(upstream.status, { "Content-Type": "application/json" }); res.end(await upstream.text());
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  t.after(async () => { controller.abort(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const sequence = f.store.room("commons").sequence;
  await runRequestQueue({ ...a, connection: { ...f.config, origin: `http://127.0.0.1:${gateway.address().port}` },
    signal: controller.signal, stream: false, intervalMs: 1000,
    execute: async () => { throw new Error("An empty queue must not execute"); }, emit: value => observed.push(value) });
  assert.equal(reads, 5);
  assert.deepEqual(observed, [{ status: "connection_unavailable" }, { status: "connection_unavailable" }]);
  assert.equal(f.store.room("commons").sequence, sequence);
});


test("MCP transport failures distinguish a failed read from a saved answer with a lost response", async t => {
  const f = await fixture(t);
  const gateway = createServer(async (req, res) => {
    if (req.url.startsWith("/api/rooms/commons/reply-requests")) {
      res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: "service_unavailable", message: "PRIVATE upstream detail" } })); return;
    }
    let body = ""; for await (const chunk of req) body += chunk;
    const upstream = await fetch(f.origin + req.url, { method: req.method, headers: req.headers, ...(body ? { body } : {}) });
    if (req.method === "POST" && req.url.endsWith("/commands")) { await upstream.text(); res.destroy(); return; }
    res.writeHead(upstream.status, { "Content-Type": "application/json" }); res.end(await upstream.text());
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const directory = join(f.directory, "recovery-proxy");
  saveAgentConnection(directory, { ...f.config, origin: `http://127.0.0.1:${gateway.address().port}` });
  const adapter = await openMcpTestClient(directory);
  t.after(async () => { await adapter.close(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const args = { direction: "incoming", status: "open" };
  const read = (await adapter.call("room_list_requests", args)).result.structuredContent;
  assert.equal(read.outcome, "read_failed"); assert.deepEqual(read.next, [{ tool: "room_list_requests", arguments: args }]);
  assert.equal(JSON.stringify(read).includes("PRIVATE upstream detail"), false);
  const q = f.open("lost-answer"), context = await f.client.replyContext(q.command.data.messageId), input = f.respond(context, { requestId: "lost-answer-write" });
  const uncertain = (await adapter.call("room_respond_to_request", input)).result.structuredContent;
  assert.equal(uncertain.type, "reply_refused"); assert.equal(uncertain.outcome, "not_confirmed");
  assert.match(uncertain.message, /Preserve unknown write input/);
  const retry = await f.client.replyAction("room_respond_to_request", input);
  assert.equal(retry.duplicate, true);
  assert.equal((await f.client.replyContext(q.command.data.messageId)).request.status, "answered");
});

test("automatic pickup keeps separate failed-request notifications visible", async t => {
  const f = await fixture(t), a = runner(t, f), controller = new AbortController(), observed = [];
  t.after(() => controller.abort());
  const ids = [f.open("failed-one").command.data.messageId, f.open("failed-two").command.data.messageId];
  await runRequestQueue({ ...a, signal: controller.signal, stream: false, intervalMs: 1000,
    execute: async () => { throw new Error("Host needs operator attention"); },
    emit: value => { observed.push(value); if (observed.length === 2) controller.abort(); } });
  assert.deepEqual(observed, ids.map(requestMessageId => ({ status: "needs_attention", requestMessageId })));
});
