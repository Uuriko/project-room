import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, relative, sep } from "node:path";
import { RoomAgentClient } from "./room-agent.mjs";
import { WatchJournal } from "./watch-journal.mjs";
import { acquireCodexProfileLock, validateCodexRuntimeConfig } from "./codex-stdio.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fields = ["origin", "roomId", "memberId", "requestMessageId", "requestId", "attemptId", "roomCreatedEventId", "openingEventId"];
const definitions = [
  ["codex_request_journal", "CREATE TABLE codex_request_journal (id INTEGER PRIMARY KEY CHECK(id=1), nonce TEXT NOT NULL)"],
  ["codex_request_audit", "CREATE TABLE codex_request_audit (request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('entered','dispatch','resolved')), body TEXT NOT NULL, PRIMARY KEY(request_id,attempt_id,phase))"]
];
for (const table of ["codex_request_journal", "codex_request_audit"]) for (const action of ["UPDATE", "DELETE"])
  definitions.push([`${table}_${action.toLowerCase()}_refused`, `CREATE TRIGGER ${table}_${action.toLowerCase()}_refused BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Runtime evidence is append-only'); END`]);
const normalize = value => value?.replace(/\s+/g, " ").trim().replace(/;$/, "");
function verifySchema(db) {
  for (const [name, sql] of definitions)
    if (normalize(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql) !== normalize(sql)) fail("reconciliation_proof_unavailable");
}
function initialize(db) {
  db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='codex_request_journal'").get()) {
      for (const [, sql] of definitions) db.exec(sql);
      db.prepare("INSERT INTO codex_request_journal VALUES(1,?)").run(randomUUID());
    }
    verifySchema(db); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function codexRuntimeFingerprint(settings) {
  return hash(["codex-native-before-dispatch-v1", settings.command, settings.cwd, settings.codexHome,
    settings.policy.approvalPolicy, settings.policy.sandbox, settings.model ?? null,
    settings.macTools?.command ?? null, settings.macTools?.connection ?? null, settings.macTools?.inputApproval ?? null]);
}
function requestId(binding) {
  return "host-" + hash([binding.origin, binding.roomId, binding.memberId, binding.requestMessageId, binding.roomCreatedEventId, binding.openingEventId]);
}
function proofFingerprint(proof) { return hash([proof.version, proof.journal, proof.runtime, fields.map(key => proof.binding[key])]); }
// Called only by the native Codex adapter, before its first authorization await.
// Generic executors and legacy intents do not gain proof by having empty tables.
export function recordCodexRequestEntry(db, binding, runtime) {
  if (binding.kind === "shared-assistant" || runtime === undefined) return null;
  if (!/^[a-f0-9]{64}$/.test(runtime) || fields.some(key => typeof binding[key] !== "string" || !binding[key])
    || binding.requestId !== requestId(binding)) fail("reconciliation_binding_mismatch");
  const intent = db.prepare("SELECT * FROM request_runs WHERE id=?").get(binding.requestId);
  if (!intent || intent.attempt_id !== binding.attemptId || intent.response !== null || intent.delivered !== 0) fail("reconciliation_binding_mismatch");
  initialize(db);
  const proof = { version: 1, journal: db.prepare("SELECT nonce FROM codex_request_journal WHERE id=1").get().nonce,
    runtime, binding: Object.fromEntries(fields.map(key => [key, binding[key]])) };
  proof.fingerprint = proofFingerprint(proof);
  db.prepare("INSERT INTO codex_request_audit VALUES(?,?,'entered',?)").run(binding.requestId, binding.attemptId, JSON.stringify(proof));
  return proof;
}
// Durable before any execution RPC. Failure to persist prevents dispatch.
export function fenceCodexRequestDispatch(db, proof) {
  if (proof) {
    if (db.prepare("PRAGMA synchronous").get().synchronous !== 2) fail("reconciliation_proof_unavailable");
    db.prepare("INSERT INTO codex_request_audit VALUES(?,?,'dispatch',?)")
      .run(proof.binding.requestId, proof.binding.attemptId, JSON.stringify({ fingerprint: proof.fingerprint }));
  }
}
function readProof(db, row, connection, runtime) {
  verifySchema(db);
  const raw = db.prepare("SELECT body FROM codex_request_audit WHERE request_id=? AND attempt_id=? AND phase='entered'").get(row.id, row.attempt_id)?.body;
  if (!raw || raw.length > 8192) fail("reconciliation_proof_unavailable");
  const proof = JSON.parse(raw), b = proof?.binding;
  if (!b || fields.some(key => typeof b[key] !== "string" || !b[key]) || proof.version !== 1
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(proof.journal ?? "")
    || proof.journal !== db.prepare("SELECT nonce FROM codex_request_journal WHERE id=1").get()?.nonce
    || proof.runtime !== runtime || !/^[a-f0-9]{64}$/.test(runtime ?? "")
    || proof.fingerprint !== proofFingerprint(proof) || b.requestId !== row.id || b.attemptId !== row.attempt_id
    || b.requestId !== requestId(b) || ["origin", "roomId", "memberId"].some(key => b[key] !== connection[key])) fail("reconciliation_binding_mismatch");
  if (row.response !== null || row.delivered !== 0) fail("reconciliation_outcome_present");
  if (db.prepare("SELECT 1 FROM codex_request_audit WHERE request_id=? AND attempt_id=? AND phase='dispatch'").get(row.id, row.attempt_id)
    || db.prepare("SELECT 1 FROM codex_runtime_attempts WHERE json_extract(binding,'$.attemptId')=? OR json_extract(binding,'$.requestId')=?").get(row.attempt_id, row.id)) fail("reconciliation_dispatch_unknown");
  return proof;
}
export function hasUnresolvedRequestIntents(db, connection, runtime) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='request_runs' AND type='table'").get()) return false;
  for (const row of db.prepare("SELECT * FROM request_runs WHERE response IS NULL").all()) {
    try {
      const proof = readProof(db, row, connection, runtime);
      const raw = db.prepare("SELECT body FROM codex_request_audit WHERE request_id=? AND attempt_id=? AND phase='resolved'").get(row.id, row.attempt_id)?.body;
      if (!raw || raw.length > 8192) return true;
      const receipt = JSON.parse(raw);
      if (receipt.fingerprint !== proof.fingerprint || receipt.outcome !== "cancelled_before_dispatch"
        || typeof receipt.terminalEventId !== "string" || !receipt.terminalEventId || receipt.revision !== 1
        || !Number.isSafeInteger(receipt.evaluatedThrough) || receipt.evaluatedThrough < 1) return true;
    } catch { return true; }
  }
  return false;
}
function privateFile(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || stat.uid !== process.getuid() || (stat.mode & 0o077) || realpathSync(path) !== path) fail("reconciliation_private_path_required");
}
// Explicit operator action. No model process is launched and no request is cancelled here.
export async function reconcileCancelledCodexRequest({ connection, journal, config, requestMessageId, attemptId, signal }) {
  if (!isAbsolute(journal ?? "") || resolve(journal) !== journal) fail("reconciliation_private_path_required");
  privateFile(journal); privateFile(dirname(journal), true); privateFile(config.codexHome, true);
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { privateFile(journal + suffix); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const settings = validateCodexRuntimeConfig(config), runtime = codexRuntimeFingerprint(settings);
  const workspaceRelative = relative(settings.cwd, journal);
  if (workspaceRelative === "" || !isAbsolute(workspaceRelative) && workspaceRelative !== ".." && !workspaceRelative.startsWith(`..${sep}`))
    fail("reconciliation_private_path_required");
  let owner, release, db;
  try {
    owner = new WatchJournal(journal + ".watch", { create: false });
    release = acquireCodexProfileLock(settings);
    db = new DatabaseSync(journal); db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    try {
      if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("reconciliation_proof_unavailable");
      const candidates = db.prepare("SELECT * FROM request_runs WHERE attempt_id=?").all(attemptId);
      if (candidates.length !== 1) fail("reconciliation_binding_mismatch");
      const row = candidates[0], proof = readProof(db, row, connection, runtime);
      if (proof.binding.requestMessageId !== requestMessageId) fail("reconciliation_binding_mismatch");
      const context = await new RoomAgentClient(connection).replyContext(requestMessageId, { signal: signal ?? AbortSignal.timeout(15000) })
        .catch(error => { if (error.code === "invalid_response") fail("reconciliation_cancellation_required"); throw error; });
      const request = context?.request;
      if (!request || !Number.isSafeInteger(context.evaluatedThrough) || context.evaluatedThrough < 1
        || context.viewerId !== connection.memberId || request.recipientId !== connection.memberId
        || context.roomCreatedEventId !== proof.binding.roomCreatedEventId || request.openingEventId !== proof.binding.openingEventId
        || request.id !== requestMessageId || request.status !== "cancelled" || request.revision !== 1
        || typeof request.terminalEventId !== "string" || !request.terminalEventId) fail("reconciliation_cancellation_required");
      signal?.throwIfAborted();
      // Recheck after the authenticated read, still holding all three ownership locks.
      readProof(db, db.prepare("SELECT * FROM request_runs WHERE id=?").get(row.id), connection, runtime);
      const receipt = { outcome: "cancelled_before_dispatch", fingerprint: proof.fingerprint,
        terminalEventId: request.terminalEventId, revision: request.revision, evaluatedThrough: context.evaluatedThrough };
      const prior = db.prepare("SELECT body FROM codex_request_audit WHERE request_id=? AND attempt_id=? AND phase='resolved'").get(row.id, attemptId);
      if (prior) {
        const saved = JSON.parse(prior.body);
        if (saved.fingerprint !== receipt.fingerprint || saved.terminalEventId !== receipt.terminalEventId || saved.outcome !== receipt.outcome
          || saved.revision !== 1 || !Number.isSafeInteger(saved.evaluatedThrough) || saved.evaluatedThrough < 1) fail("reconciliation_binding_mismatch");
      } else db.prepare("INSERT INTO codex_request_audit VALUES(?,?,'resolved',?)").run(row.id, attemptId, JSON.stringify(receipt));
      db.exec("COMMIT");
      return { status: "reconciled", ...receipt, requestMessageId, attemptId, duplicate: Boolean(prior), originalIntentPreserved: true,
        serverReservationPreserved: true, originalRetryAuthorized: false, modelExecution: "not_started_by_this_adapter" };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally {
    db?.close(); release?.();
    if (owner) { try { owner.health("stopped"); } finally { owner.close(); } }
  }
}
