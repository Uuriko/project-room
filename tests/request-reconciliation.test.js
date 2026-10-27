import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { openRequestJournal, runRequestOnce } from "../client/request-runner.mjs";
import { createCodexRuntimeHost } from "../client/codex-runtime.mjs";
import { superviseCodexRequests } from "../client/codex-request-supervisor.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { acquireCodexProfileLock, validateCodexRuntimeConfig } from "../client/codex-stdio.mjs";
import { codexRuntimeFingerprint, hasUnresolvedRequestIntents, reconcileCancelledCodexRequest } from "../client/request-reconciliation.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture({ dmConsent: true }), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = realpathSync(f.directory), journal = join(root, "requests.sqlite"), db = openRequestJournal(journal);
  const cwd = join(root, "workspace"), codexHome = join(root, "profile");
  mkdirSync(cwd, { mode: 0o700 }); mkdirSync(codexHome, { mode: 0o700 });
  const config = validateCodexRuntimeConfig({ command: realpathSync(process.execPath), cwd, codexHome, policy: { approvalPolicy: "never", sandbox: "read-only" } });
  const runtimeFingerprint = codexRuntimeFingerprint(config);
  const owner = new WatchJournal(journal + ".watch"); owner.health("stopped"); owner.close();
  const connection = { origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "producer", token: f.keys.producer };
  let sequence = 0;
  const open = () => {
    const id = `question-${++sequence}`;
    f.store.command(f.keys.owner, "commons", { id: "post-" + id, type: "message.posted", data: { messageId: id, toMemberId: "producer", requestKind: "reply", body: "Synthetic bounded test" } });
    return id;
  };
  const cancel = requestMessageId => f.store.command(f.keys.owner, "commons", { id: "cancel-" + requestMessageId, type: "reply_request.cancelled",
    data: { requestMessageId, expectedRequestRevision: 0, reason: "Synthetic request no longer needed" } });
  const failAttempt = async (stage = "authorization") => {
    const requestMessageId = open(); let calls = 0;
    const original = new Error("private synthetic failure");
    const rpc = { notify() {}, subscribe() { return () => {}; }, async request(method) {
      calls++;
      if (method === stage) throw original;
      if (method === "initialize") return {};
      if (method === "thread/start") return { thread: { id: "thread" } };
      throw original;
    } };
    const execute = stage === "generic" ? async () => { throw original; }
      : createCodexRuntimeHost({ db, rpc, scope: connection, cwd, policy: config.policy, runtimeFingerprint,
        authorize: async () => { if (stage === "authorization") throw original; } });
    await assert.rejects(runRequestOnce({ connection, requestMessageId, db, execute }), error => error === original);
    const row = db.prepare("SELECT * FROM request_runs ORDER BY rowid DESC LIMIT 1").get();
    return { requestMessageId, attemptId: row.attempt_id, row, calls };
  };
  const reconcile = (attempt, extra = {}) => reconcileCancelledCodexRequest({ connection, journal, config, ...attempt, ...extra });
  t.after(async () => { db.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...f, db, journal, connection, config, runtimeFingerprint, open, cancel, failAttempt, reconcile };
}

test("cancelled pre-authorization intent is audited without changing original rows and permits only a distinct request", async t => {
  const f = await fixture(t), original = await f.failAttempt();
  assert.equal(original.calls, 0);
  f.cancel(original.requestMessageId);
  const serverRow = f.store.db.prepare("SELECT * FROM request_runs WHERE request_id=?").get(original.requestMessageId);
  assert.equal(hasUnresolvedRequestIntents(f.db, f.connection, f.runtimeFingerprint), true);
  const receipt = await f.reconcile(original);
  assert.equal(receipt.status, "reconciled"); assert.equal(receipt.originalRetryAuthorized, false);
  assert.equal(hasUnresolvedRequestIntents(f.db, f.connection, f.runtimeFingerprint), false);
  assert.equal((await f.reconcile(original)).duplicate, true);
  assert.deepEqual(f.db.prepare("SELECT * FROM request_runs WHERE id=?").get(original.row.id), original.row);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM request_runs WHERE request_id=?").get(original.requestMessageId), serverRow);
  assert.throws(() => f.db.exec("DELETE FROM codex_request_audit"), /append-only/);
  assert.throws(() => f.db.exec("UPDATE codex_request_journal SET nonce='replacement'"), /append-only/);
  await assert.rejects(runRequestOnce({ connection: f.connection, db: f.db, requestMessageId: original.requestMessageId,
    execute: () => { assert.fail("Original request must never run again"); } }), /unknown/);
  const fresh = f.open(), controller = new AbortController(); let starts = 0;
  await superviseCodexRequests({ connection: f.connection, db: f.db, directory: f.journal + ".watch", cwd: f.config.cwd,
    policy: f.config.policy, runtimeFingerprint: f.runtimeFingerprint, allowedRequesterIds: ["owner"], allowedRequestIds: [fresh],
    signal: controller.signal, pollMs: 1000, connect: async () => ({ notify() {}, subscribe() { return () => {}; }, close() {}, async request(method) {
      if (method === "initialize") return {};
      if (method === "thread/start") return { thread: { id: "new-thread" } };
      if (method === "turn/start") { starts++; return { turn: { id: "new-turn", status: "completed", items: [{ type: "agentMessage", id: "answer", text: "Distinct synthetic result" }] } }; }
      throw Error("Unexpected RPC");
    } }), emit: event => { if (event.status === "delivered") controller.abort(); } });
  assert.equal(starts, 1);
  assert.equal(f.store.room("commons").state.replyRequests[fresh].status, "answered");
  assert.deepEqual(f.db.prepare("SELECT * FROM request_runs WHERE id=?").get(original.row.id), original.row);
});

for (const stage of ["generic", "initialize", "thread/start", "turn/start"]) test(`no proof or dispatch fence refuses ${stage} failure`, async t => {
  const f = await fixture(t), attempt = await f.failAttempt(stage); f.cancel(attempt.requestMessageId);
  await assert.rejects(f.reconcile(attempt), { code: stage === "generic" ? "reconciliation_proof_unavailable" : "reconciliation_dispatch_unknown" });
  assert.equal(hasUnresolvedRequestIntents(f.db, f.connection, f.runtimeFingerprint), true);
  assert.deepEqual(f.db.prepare("SELECT * FROM request_runs WHERE id=?").get(attempt.row.id), attempt.row);
});

test("legacy intent with existing Codex tables gains no adapter proof", async t => {
  const f = await fixture(t);
  await f.failAttempt(); // other intent creates the adapter schema and evidence
  const legacy = await f.failAttempt("generic"); f.cancel(legacy.requestMessageId);
  await assert.rejects(f.reconcile(legacy), { code: "reconciliation_proof_unavailable" });
});

for (const mismatch of ["request", "attempt", "profile", "identity", "open-request"]) test(`reconciliation refuses ${mismatch} mismatch`, async t => {
  const f = await fixture(t), attempt = await f.failAttempt();
  if (mismatch !== "open-request") f.cancel(attempt.requestMessageId);
  const extra = mismatch === "request" ? { requestMessageId: "other-request" }
    : mismatch === "attempt" ? { attemptId: "other-attempt" }
      : mismatch === "profile" ? { config: { ...f.config, model: "different-model" } }
        : mismatch === "identity" ? { connection: { ...f.connection, roomId: "other-room" } } : {};
  await assert.rejects(f.reconcile(attempt, extra), { code: mismatch === "open-request" ? "reconciliation_cancellation_required" : "reconciliation_binding_mismatch" });
  assert.equal(hasUnresolvedRequestIntents(f.db, f.connection, f.runtimeFingerprint), true);
});

for (const lock of ["watcher", "profile", "journal"]) test(`active ${lock} ownership refuses reconciliation`, async t => {
  const f = await fixture(t), attempt = await f.failAttempt(); f.cancel(attempt.requestMessageId);
  let release;
  if (lock === "watcher") { const held = new WatchJournal(f.journal + ".watch"); release = () => held.close(); }
  if (lock === "profile") release = acquireCodexProfileLock(f.config);
  if (lock === "journal") { const held = new DatabaseSync(f.journal); held.exec("BEGIN IMMEDIATE"); release = () => held.close(); }
  try { await assert.rejects(f.reconcile(attempt)); } finally { release(); }
  assert.equal(f.db.prepare("SELECT count(*) n FROM codex_request_audit WHERE phase='resolved'").get().n, 0);
});

test("fresh cancellation read holds the journal fence against a competing writer", async t => {
  const f = await fixture(t), attempt = await f.failAttempt(); f.cancel(attempt.requestMessageId); let checked = false;
  const connection = { ...f.connection, fetchImpl: async (...args) => {
    if (String(args[0]).includes("reply-context")) {
      const competitor = new DatabaseSync(f.journal);
      try { assert.throws(() => competitor.prepare("UPDATE request_runs SET delivered=1 WHERE id=?").run(attempt.row.id), /locked/); checked = true; }
      finally { competitor.close(); }
    }
    return fetch(...args);
  } };
  await f.reconcile(attempt, { connection }); assert.equal(checked, true);
});

test("read-only journal and failed authenticated reads never append a resolution", async t => {
  const f = await fixture(t), attempt = await f.failAttempt(); f.cancel(attempt.requestMessageId);
  await assert.rejects(f.reconcile(attempt, { connection: { ...f.connection, fetchImpl: async () => { throw Error("private network failure"); } } }));
  chmodSync(f.journal, 0o400);
  try { await assert.rejects(f.reconcile(attempt)); } finally { chmodSync(f.journal, 0o600); }
  assert.equal(f.db.prepare("SELECT count(*) n FROM codex_request_audit WHERE phase='resolved'").get().n, 0);
});


test("operator CLI reports reconciliation and refuses legacy proof without disclosing errors", async t => {
  const f = await fixture(t), attempt = await f.failAttempt(); f.cancel(attempt.requestMessageId);
  const directory = join(dirname(f.journal), "connection"), configPath = join(dirname(f.journal), "runtime.json");
  saveAgentConnection(directory, { version: 1, ...f.connection });
  writeFileSync(configPath, JSON.stringify(f.config), { mode: 0o600 });
  const env = { ...process.env, ROOM_AGENT_CONFIG: directory };
  for (const name of ["ROOM_AGENT_ORIGIN", "ROOM_AGENT_ROOM", "ROOM_AGENT_TOKEN", "ROOM_AGENT_MEMBER"]) delete env[name];
  const args = ["scripts/run-codex-room.mjs", "--reconcile-cancelled-request", f.journal, configPath, attempt.requestMessageId, attempt.attemptId];
  const result = await promisify(execFile)(process.execPath, args, { env, timeout: 10000 });
  const report = JSON.parse(result.stdout); assert.equal(report.status, "reconciled");
  assert.equal(report.originalIntentPreserved, true); assert.equal(report.originalRetryAuthorized, false);
  const legacy = await f.failAttempt("generic"); f.cancel(legacy.requestMessageId);
  await assert.rejects(promisify(execFile)(process.execPath, [...args.slice(0, 4), legacy.requestMessageId, legacy.attemptId], { env, timeout: 10000 }), error => {
    assert.match(error.stderr, /reconciliation_proof_unavailable/);
    assert.doesNotMatch(error.stderr, /private synthetic failure/); assert.ok(!error.stderr.includes(f.connection.token)); return true;
  });
});

test("history replacement and forged resolution receipt remain fenced", async t => {
  const f = await fixture(t), attempt = await f.failAttempt(); f.cancel(attempt.requestMessageId);
  const connection = { ...f.connection, fetchImpl: async (...args) => {
    const response = await fetch(...args);
    if (!String(args[0]).includes("reply-context")) return response;
    const value = await response.json(); value.roomCreatedEventId = "different-room-creation";
    return new Response(JSON.stringify(value), { status: response.status, headers: { "Content-Type": "application/json" } });
  } };
  await assert.rejects(f.reconcile(attempt, { connection }));
  f.db.prepare("INSERT INTO codex_request_audit VALUES(?,?,'resolved',?)").run(attempt.row.id, attempt.attemptId,
    JSON.stringify({ outcome: "cancelled_before_dispatch", fingerprint: "wrong", terminalEventId: "fake", revision: 1, evaluatedThrough: 1 }));
  assert.equal(hasUnresolvedRequestIntents(f.db, f.connection, f.runtimeFingerprint), true);
  await assert.rejects(f.reconcile(attempt), { code: "reconciliation_binding_mismatch" });
});

for (const malformed of ["missing-cursor", "negative-cursor", "unsafe-cursor", "missing-request"]) test(`malformed fresh cancellation evidence refuses ${malformed}`, async t => {
  const f = await fixture(t), attempt = await f.failAttempt(); f.cancel(attempt.requestMessageId);
  const connection = { ...f.connection, fetchImpl: async (...args) => {
    const response = await fetch(...args);
    if (!String(args[0]).includes("reply-context")) return response;
    const value = await response.json();
    if (malformed === "missing-request") delete value.request;
    else if (malformed === "missing-cursor") delete value.evaluatedThrough;
    else value.evaluatedThrough = malformed === "negative-cursor" ? -1 : Number.MAX_SAFE_INTEGER + 1;
    return new Response(JSON.stringify(value), { status: response.status, headers: { "Content-Type": "application/json" } });
  } };
  await assert.rejects(f.reconcile(attempt, { connection }), { code: "reconciliation_cancellation_required" });
  assert.equal(f.db.prepare("SELECT count(*) n FROM codex_request_audit WHERE phase='resolved'").get().n, 0);
  assert.equal(hasUnresolvedRequestIntents(f.db, f.connection, f.runtimeFingerprint), true);
});
