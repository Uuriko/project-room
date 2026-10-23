import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { WatchJournal } from "./watch-journal.mjs";

const phases = new Set(["watching_room", "protocol_qualified", "running", "settled", "recovery_pending", "retrying_room", "stopped"]);
const credentials = new Set(["unknown", "present", "login_required", "not_required"]);
const privatePath = (path, directory = false) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error("Host status requires a private owned path");
  return stat;
};
function readRecord(path) {
  if (!existsSync(path)) return null;
  if (privatePath(path).size > 4096) throw new Error("Host status exceeds limit");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schemaVersion !== 1 || typeof value.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(value.sessionId)
    || !Number.isInteger(value.pid) || value.pid < 1 || !phases.has(value.phase)
    || !credentials.has(value.credentials) || !["unverified", "qualified"].includes(value.protocol)
    || ![value.startedAt, value.updatedAt].every(x => typeof x === "string" && Number.isFinite(Date.parse(x))))
    throw new Error("Invalid host status");
  // Return only the documented bounded fields. Never forward arbitrary stored JSON.
  const result = { schemaVersion: 1, sessionId: value.sessionId, pid: value.pid, startedAt: value.startedAt, updatedAt: value.updatedAt,
    phase: value.phase, protocol: value.protocol, credentials: value.credentials, modelExecution: "not_tested" };
  for (const key of ["origin", "roomId", "memberId", "runId"])
    if (typeof value[key] === "string" && value[key].length <= 256) result[key] = value[key];
  return result;
}

// Created lazily after the supervisor holds WatchJournal ownership. A later
// owner has a new session ID; the prior writer cannot overwrite that status.
export function createCodexStatusWriter(directory, connection, { onError = () => {} } = {}) {
  privatePath(directory, true);
  if (realpathSync(directory) !== directory) throw new Error("Host status directory must be canonical");
  const watcher = new WatchJournal(directory, { acquire: false, create: false });
  let sessionId;
  try { sessionId = watcher.ownerIdentity(); } finally { watcher.close(); }
  if (!sessionId) throw new Error("Host status requires active watcher ownership");
  const path = join(directory, "status.json"), now = new Date().toISOString();
  let stopped = false, first = true;
  const record = { schemaVersion: 1, sessionId, pid: process.pid, startedAt: now, updatedAt: now,
    origin: new URL(connection.origin).origin, roomId: connection.roomId, memberId: connection.memberId,
    phase: "watching_room", protocol: "unverified", credentials: "unknown", modelExecution: "not_tested" };
  const write = () => {
    if (stopped) return;
    const prior = readRecord(path);
    if (!first && prior?.sessionId !== sessionId) { stopped = true; return; }
    record.updatedAt = new Date().toISOString();
    const temp = join(directory, `.status-${sessionId}.tmp`);
    try { writeFileSync(temp, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 }); renameSync(temp, path); first = false; }
    finally { try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  };
  write();
  let failure;
  const timer = setInterval(() => { try { write(); } catch (error) { failure = error; clearInterval(timer); onError(error); } }, 5000);
  timer.unref();
  return {
    event(event) {
      if (failure) throw failure;
      if (!["host_status", "host_readiness"].includes(event.type)) return;
      if (event.type === "host_status" && phases.has(event.status)) {
        record.phase = event.status;
        if (event.status === "protocol_qualified") record.protocol = "qualified";
        if (event.status === "recovery_pending") record.protocol = "unverified";
        if (typeof event.runId === "string" && event.runId.length <= 128) record.runId = event.runId;
        else if (["watching_room", "stopped"].includes(event.status)) delete record.runId;
      }
      if (event.type === "host_readiness" && credentials.has(event.credentials)) {
        record.credentials = event.credentials; record.protocol = "qualified";
      }
      write();
    },
    close() { clearInterval(timer); stopped = true; }
  };
}

export function readCodexHostStatus(journal, { now = Date.now(), freshMs = 15000 } = {}) {
  if (!isAbsolute(journal)) throw new Error("Journal path must be absolute");
  const directory = `${journal}.watch`;
  if (!existsSync(directory)) return { schemaVersion: 1, phase: "stopped", processState: "stopped", fresh: false,
    protocol: "unverified", credentials: "unknown", modelExecution: "not_tested" };
  const watcher = new WatchJournal(directory, { acquire: false, create: false });
  try {
    const control = watcher.status(), record = readRecord(join(directory, "status.json"));
    const held = ["held", "stop_requested"].includes(control.state);
    const age = record ? now - Date.parse(record.updatedAt) : Infinity;
    const fresh = held && record?.sessionId === watcher.ownerIdentity() && age >= -5000 && age <= freshMs;
    return { ...(record ?? { schemaVersion: 1, modelExecution: "not_tested" }),
      phase: !held ? "stopped" : fresh ? record.phase : "unknown",
      processState: control.state, fresh, stopRequested: control.state === "stop_requested",
      protocol: fresh ? record.protocol : "unverified", credentials: fresh ? record.credentials : "unknown" };
  } finally { watcher.close(); }
}

export function stopCodexHost(journal) {
  const status = readCodexHostStatus(journal);
  if (status.processState === "stopped") return status;
  const watcher = new WatchJournal(`${journal}.watch`, { acquire: false, create: false });
  try { watcher.requestStop(); } finally { watcher.close(); }
  return readCodexHostStatus(journal);
}
