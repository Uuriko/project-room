import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, statSync, symlinkSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection, readAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { localRequestContext } from "../client/local-request-context.mjs";
import { executeLocalRun, inspectLocalRun } from "../client/local-run-record.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-run-record-")), privateDir = join(directory, "run");
  mkdirSync(privateDir, { mode: 0o700 });
  const store = new RoomStore(":memory:"); store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: "member", type: "member.added", data: {
    memberId: "agent", displayName: "Agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  store.command(owner, "commons", { id: "task", type: "work.proposed", data: {
    workItemId: "task", title: "Record fixture", definitionOfDone: "Separate review", accountableMemberId: "agent", mode: "read" } });
  const token = store.issueAccessKey("commons", "agent"), server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const connectionDirectory = join(directory, "connection");
  saveAgentConnection(connectionDirectory, { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "agent", token });
  const config = { version: 1, connectionDirectory, workItemId: "task", runId: "once", expectedRevision: 0,
    command: process.execPath, args: ["-e", "console.log('PRIVATE_OUTPUT')"], cwd: directory, env: {}, maxRuntimeMs: 3000, maxOutputBytes: 4096 };
  const path = join(privateDir, "run.json"), journal = join(privateDir, "run-once.jsonl");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const cli = async (...args) => {
    try { return { ...(await promisify(execFile)(process.execPath, ["scripts/room-run.mjs", ...args], { timeout: 10000 })), code: 0 }; }
    catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
  };
  return { directory, privateDir, store, owner, token, config, path, journal, cli };
}

test("CLI records a real run privately; status hides output and repeats cannot execute", async t => {
  const f = await fixture(t), run = await f.cli("run", f.privateDir);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, "done");
  assert.equal(run.stdout.includes("PRIVATE_OUTPUT"), false);
  const source = readFileSync(f.journal, "utf8");
  assert.equal(source.includes(f.token), false); assert.equal(statSync(f.journal).mode & 0o777, 0o600);
  assert.deepEqual(source.trim().split("\n").map(line => JSON.parse(line).state), ["reserved", "finished"]);
  const status = await f.cli("status", f.privateDir, "once");
  assert.equal(status.code, 0); assert.equal(status.stdout.includes("PRIVATE_OUTPUT"), false);
  const output = await f.cli("output", f.privateDir, "once");
  assert.equal(JSON.parse(output.stdout).output, "PRIVATE_OUTPUT\n");
  const again = await f.cli("run", f.privateDir);
  assert.equal(again.code, 1); assert.equal(JSON.parse(again.stderr).error, "run_exists");
  assert.equal(readFileSync(f.journal, "utf8"), source);
});

test("simultaneous invocations acquire exactly one private reservation", async t => {
  const f = await fixture(t), results = await Promise.allSettled([executeLocalRun(f.privateDir), executeLocalRun(f.privateDir)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "EEXIST");
  assert.equal(f.store.room("commons").state.workItems.task.attempt_count, 1);
});

test("private configuration rejects public files and linked paths before execution", async t => {
  const f = await fixture(t);
  chmodSync(f.path, 0o644);
  await assert.rejects(executeLocalRun(f.privateDir), /private_file_required/);
  chmodSync(f.path, 0o600);
  const link = join(f.directory, "linked-run"); symlinkSync(f.privateDir, link);
  await assert.rejects(executeLocalRun(link), /private_directory_required/);
  const original = join(f.directory, "original"); writeFileSync(original, "preserved", { mode: 0o600 });
  symlinkSync(original, f.journal);
  await assert.rejects(executeLocalRun(f.privateDir), { code: "EEXIST" });
  assert.equal(readFileSync(original, "utf8"), "preserved");
  assert.equal(f.store.room("commons").state.workItems.task.status, undefined);
});

test("a crash reservation or torn terminal record never authorizes a rerun", async t => {
  const f = await fixture(t);
  writeFileSync(f.journal, JSON.stringify({ version: 1, runId: "once", state: "reserved" }) + "\n", { mode: 0o600 });
  appendFileSync(f.journal, '{"version":1,"state":"finished"');
  assert.equal(inspectLocalRun(f.privateDir, "once").state, "reserved");
  assert.match(inspectLocalRun(f.privateDir, "once").message, /do not rerun/);
  await assert.rejects(executeLocalRun(f.privateDir), { code: "EEXIST" });
});

test("failed configuration after reservation records uncertainty without leaking arguments", async t => {
  const f = await fixture(t);
  f.config.command = "PRIVATE_BAD_COMMAND";
  writeFileSync(f.path, JSON.stringify(f.config), { mode: 0o600 });
  const result = await f.cli("run", f.privateDir);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).state, "unconfirmed");
  assert.equal((result.stdout + result.stderr).includes("PRIVATE_BAD_COMMAND"), false);
  assert.equal(readFileSync(f.journal, "utf8").includes("PRIVATE_BAD_COMMAND"), false);
  await assert.rejects(executeLocalRun(f.privateDir), { code: "EEXIST" });
});

function requestRun(f, { requester = f.owner, args } = {}) {
  f.store.command(requester, "commons", { id: "question", type: "message.posted", data: {
    messageId: "question", requestKind: "reply", toMemberId: "agent", workItemId: "task", body: "Summarize this exchange." } });
  Object.assign(f.config, { answerRequestId: "question", args: args ?? ["-e",
    "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);console.error('PRIVATE_DIAGNOSTIC');console.log('Read '+p.messages.length+' messages for '+p.requestMessageId);});"] });
  writeFileSync(f.path, JSON.stringify(f.config), { mode: 0o600 });
}

test("agent request reaches a real process as data and stdout returns to its exact exchange", async t => {
  const f = await fixture(t);
  f.store.command(f.owner, "commons", { id: "peer", type: "member.added", data: { memberId: "peer", displayName: "Peer agent", kind: "agent", permissions: [] } });
  const peer = f.store.issueAccessKey("commons", "peer");
  requestRun(f, { requester: peer });
  for (let n = 0; n < 3; n++) f.store.command(peer, "commons", { id: `clarify-${n}`, type: "message.posted", data: { body: `Context ${n}`, replyToId: "question" } });
  const client = new RoomAgentClient(readAgentConnection(f.config.connectionDirectory));
  const packet = await localRequestContext(client, "question", "task", { limit: 1 });
  assert.equal(JSON.parse(packet.input).messages.length, 4);
  const result = await f.cli("run", f.privateDir);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).answerStatus, "recorded");
  const state = f.store.room("commons").state, answer = state.messages.at(-1);
  assert.equal(answer.body, "Read 4 messages for question\n"); assert.equal(answer.authorId, "agent");
  assert.equal(answer.toMemberId, "peer"); assert.equal(answer.replyToId, "question");
  assert.equal(state.replyRequests.question.status, "answered"); assert.equal(state.workItems.task.state, "proposed");
  assert.equal(state.messages.some(m => m.body.includes("PRIVATE_DIAGNOSTIC")), false);
  const records = readFileSync(f.journal, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(r => r.state), ["reserved", "answer_pending", "finished"]);
  assert.deepEqual(records[1].result.answerInput, records[2].result.answerInput);
});

test("new clarification during execution refuses the old answer without silent refresh", async t => {
  const f = await fixture(t);
  requestRun(f, { args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>console.log('Old-context answer'),250));"] });
  let changed = false;
  const timer = setInterval(() => {
    if (changed || f.store.room("commons").state.workItems.task.status !== "processing") return;
    changed = true;
    f.store.command(f.owner, "commons", { id: "new-context", type: "message.posted", data: { body: "Changed requirements", replyToId: "question" } });
  }, 10);
  t.after(() => clearInterval(timer));
  const result = await executeLocalRun(f.privateDir);
  assert.equal(result.answerStatus, "refused");
  assert.equal(f.store.room("commons").state.replyRequests.question.status, "open");
  assert.equal(f.store.room("commons").state.messages.some(m => m.body.includes("Old-context answer")), false);
  await assert.rejects(executeLocalRun(f.privateDir), { code: "EEXIST" });
});

test("wrong-work context and oversized answers are not posted", async t => {
  const f = await fixture(t);
  requestRun(f, { args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('x'.repeat(4097)));"] });
  f.config.maxOutputBytes = 8192;
  writeFileSync(f.path, JSON.stringify(f.config), { mode: 0o600 });
  const client = new RoomAgentClient(readAgentConnection(f.config.connectionDirectory));
  await assert.rejects(localRequestContext(client, "question", "other-work"), /not assigned/);
  const result = await f.cli("run", f.privateDir);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).answerStatus, "not_sent");
  assert.equal(f.store.room("commons").state.replyRequests.question.status, "open");
});

for (const change of ["cancel", "clarify", "instructions"]) test(`request ${change} stops an already running process without posting its output`, async t => {
  const f = await fixture(t), marker = join(f.directory, "started");
  requestRun(f, { args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'started');console.log('UNFINISHED');setInterval(()=>{},100);", marker] });
  let changed = false;
  const timer = setInterval(() => {
    if (changed || !existsSync(marker)) return;
    changed = true;
    f.store.command(f.owner, "commons", change === "cancel"
      ? { id: "cancel-question", type: "reply_request.cancelled", data: { requestMessageId: "question", expectedRequestRevision: 0, reason: "No longer needed" } }
      : change === "instructions"
        ? { id: "instructions", type: "room.charter_updated", data: { expectedRevision: 0, purpose: "New room instructions", outputs: null, boundaries: null, escalation: null } }
        : { id: "clarify-question", type: "message.posted", data: { replyToId: "question", body: "Use the updated requirements" } });
  }, 10);
  t.after(() => clearInterval(timer));
  const result = await executeLocalRun(f.privateDir);
  assert.equal(changed, true, "the process actually started before the request changed");
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "request_changed");
  assert.equal(result.recording, "recorded");
  assert.equal(result.answerStatus, "not_sent");
  assert.equal(f.store.room("commons").state.messages.some(message => message.body.includes("UNFINISHED")), false);
  assert.equal(f.store.room("commons").state.replyRequests.question.status, change === "cancel" ? "cancelled" : "open");
  await assert.rejects(executeLocalRun(f.privateDir), { code: "EEXIST" });
});
