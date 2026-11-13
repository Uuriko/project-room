// settleLinkedWork: a woken host accepts, starts and saves the linked work
// itself (baseline stall fix). Real Room HTTP and the acceptance fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openRequestJournal, runRequestOnce } from "../client/request-runner.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { spawn } from "node:child_process";

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


const runner = (t, f) => { const db = openRequestJournal(join(f.directory, "host-requests.sqlite")); t.after(() => db.close()); return { connection: f.config, db }; };
const propose = (f, workItemId, extra = {}) => f.store.command(f.keys.owner, "commons", { id: "p-" + workItemId, type: "work.proposed",
  data: { workItemId, title: workItemId, definitionOfDone: "Answer the request", accountableMemberId: "producer", mode: "read", ...extra } });
const work = async (f, id) => (await f.client.workContext(id)).work;

test("opt-in: woken host accepts, starts and saves the delivered answer as the linked result, with no main worker", async t => {
  const f = await fixture(t), args = runner(t, f);
  propose(f, "review-5819");
  const q = f.open("settle", { workItemId: "review-5819" });
  let seenState = null;
  const execute = async () => { seenState = (await work(f, "review-5819")).state; return { body: "Reviewed: LGTM at eb31fb0" }; };
  const result = await runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute, settleLinkedWork: true });
  assert.equal(seenState, "working", "started before the model ran");
  assert.deepEqual(result.linkedWork.map(s => s.steps).flat(), ["accepted", "started", "result_saved"]);
  const after = await work(f, "review-5819");
  assert.equal(after.state, "completed");
  assert.equal(after.receipt.producerId, "producer");
  assert.match(after.receipt.evidenceVersion, /^sha256:[0-9a-f]{64}$/);
  const retry = await runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute, settleLinkedWork: true });
  assert.equal(retry.hostExecuted, false, "replay does not rerun the model or re-settle");
  assert.equal((await work(f, "review-5819")).revision, after.revision);
});

test("default off: the same request leaves linked work untouched", async t => {
  const f = await fixture(t), args = runner(t, f);
  propose(f, "untouched");
  const q = f.open("off", { workItemId: "untouched" });
  const result = await runRequestOnce({ ...args, requestMessageId: q.command.data.messageId, execute: async () => ({ body: "answer" }) });
  assert.equal(result.linkedWork, undefined);
  assert.equal((await work(f, "untouched")).state, "proposed");
});

test("never transitions work assigned to someone else, and leaves write mode for the main worker", async t => {
  const f = await fixture(t), args = runner(t, f);
  propose(f, "owners", { accountableMemberId: "owner" });
  const a = f.open("other", { workItemId: "owners" });
  const r1 = await runRequestOnce({ ...args, requestMessageId: a.command.data.messageId, execute: async () => ({ body: "x" }), settleLinkedWork: true });
  assert.equal(r1.linkedWork[0].skipped, "not_assigned_to_this_member");
  assert.equal((await f.client.workContext("owners")).work.state, "proposed");
  propose(f, "writes", { mode: "write" });
  const b = f.open("write", { workItemId: "writes" });
  const r2 = await runRequestOnce({ ...args, requestMessageId: b.command.data.messageId, execute: async () => ({ body: "y" }), settleLinkedWork: true });
  assert.deepEqual(r2.linkedWork[0], { steps: ["accepted"], skipped: "write_mode_needs_scope_claim" });
  assert.equal((await work(f, "writes")).state, "accepted");
});
