// Local, bounded evidence only. Never creates/migrates a journal or runs a host.
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

function privateJournal(filename) {
  if (!isAbsolute(filename) || resolve(filename) !== filename) throw new Error("invalid_journal_path");
  let stat;
  try { stat = lstatSync(filename); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const parent = lstatSync(dirname(filename));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
    || (stat.mode & 0o077) || !parent.isDirectory() || (parent.mode & 0o077)
    || parent.uid !== process.getuid() || realpathSync(filename) !== filename)
    throw new Error("journal_requires_private_canonical_path");
  return true;
}

function observeHeartbeat(filename, now) {
  // The existing live-status reader probes ownership using BEGIN IMMEDIATE.
  // This audit deliberately reads only the heartbeat; it cannot prove liveness.
  const path = join(`${filename}.watch`, "status.json");
  if (!privateJournal(path)) return { state: "missing", processOwnership: "not_checked" };
  if (lstatSync(path).size > 4096) throw new Error("invalid_host_heartbeat");
  const value = JSON.parse(readFileSync(path, "utf8"));
  const phases = ["watching_room", "assistant_not_selected", "protocol_qualified", "running", "settled", "recovery_pending", "retrying_room", "stopped"];
  if (value?.schemaVersion !== 1 || !phases.includes(value.phase)
    || !["unknown", "present", "login_required", "not_required"].includes(value.credentials)
    || !["unverified", "qualified"].includes(value.protocol)
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)))
    throw new Error("invalid_host_heartbeat");
  const age = now - Date.parse(value.updatedAt), recent = age >= -5000 && age <= 15000;
  return { state: "observed", reportedPhase: value.phase, updatedAt: value.updatedAt, recent,
    reportedProtocol: value.protocol, reportedCredentials: value.credentials, processOwnership: "not_checked" };
}

export function inspectRequestJournal(filename, { limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid_limit");
  if (!privateJournal(filename)) return { state: "missing", sampled: 0, truncated: false, attempts: [] };
  for (const suffix of ["-journal", "-wal", "-shm"]) privateJournal(filename + suffix);
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    const columns = new Set(db.prepare("PRAGMA table_info(request_runs)").all().map(row => row.name));
    if (!["id", "response", "delivered"].every(column => columns.has(column))) throw new Error("unsupported_journal_schema");
    // Do not select response bytes: these can contain prompts, code or private text.
    // IDs are emitted only after checking the runner's hash/UUID formats.
    const rows = db.prepare(`SELECT id, response IS NOT NULL AS saved, delivered,
      ${columns.has("attempt_id") ? "attempt_id" : "NULL AS attempt_id"}
      FROM request_runs ORDER BY id LIMIT ?`).all(limit + 1);
    const attempts = rows.slice(0, limit).map(row => {
      if (!/^host-[a-f0-9]{64}$/.test(row.id) || ![0, 1].includes(row.saved) || ![0, 1].includes(row.delivered)
        || (row.attempt_id !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.attempt_id)))
        throw new Error("invalid_journal_record");
      const state = !row.saved ? "outcome_unknown" : row.delivered ? "locally_delivered" : "saved_awaiting_delivery";
      return { id: row.id, attemptId: row.attempt_id, state,
        next: !row.saved ? "reconcile_original_attempt" : row.delivered ? "verify_remote_receipt" : "revalidate_saved_delivery" };
    });
    return { state: "observed", sampled: attempts.length, truncated: rows.length > limit, attempts };
  } finally { db.close(); }
}

export function inspectRoomHost(filename, options = {}) {
  // Validate the journal first; do not let an invalid input trigger watcher access.
  const journal = inspectRequestJournal(filename, options);
  const host = observeHeartbeat(filename, Date.now());
  return { schemaVersion: 1, observedAt: new Date().toISOString(), host, journal,
    remoteState: "not_checked", modelExecution: "not_proven", executionAuthorized: false,
    boundary: "Local evidence only; saved results and delivery flags do not prove current remote acceptance or permission to execute." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: node scripts/inspect-room-host.mjs /absolute/private/journal.sqlite");
    console.log(JSON.stringify(inspectRoomHost(process.argv[2]), null, 2));
  } catch (error) {
    // Never print arbitrary SQLite errors (which may include stored values/paths).
    const allowed = new Set(["invalid_journal_path", "journal_requires_private_canonical_path", "invalid_limit",
      "unsupported_journal_schema", "invalid_journal_record", "invalid_host_heartbeat"]);
    console.error(JSON.stringify({ error: allowed.has(error.message) ? error.message : "host_inspection_failed" }));
    process.exitCode = 1;
  }
}
