import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync, fsyncSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { readAgentConnection } from "./agent-connection.mjs";
import { RoomAgentClient } from "./room-agent.mjs";
import { runLocalSession } from "./local-session-runner.mjs";
import { validId } from "../src/events.js";

function privatePath(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error("private_directory_required");
  return realpathSync(directory);
}
function readPrivate(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.size > limit)
      throw new Error("private_file_required");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > limit) throw new Error("file_too_large");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { closeSync(fd); }
}
const fields = ["version", "connectionDirectory", "workItemId", "runId", "expectedRevision", "command", "args", "cwd", "env", "maxRuntimeMs", "maxOutputBytes"];
function configAt(directory) {
  const config = JSON.parse(readPrivate(join(directory, "run.json"), 65536));
  if (!config || Array.isArray(config) || Object.keys(config).length !== fields.length
    || fields.some(field => !Object.hasOwn(config, field)) || config.version !== 1
    || ![config.workItemId, config.runId].every(validId) || config.runId.length > 110
    || typeof config.connectionDirectory !== "string" || !isAbsolute(config.connectionDirectory)) throw new Error("invalid_run_config");
  return config;
}
const journalName = runId => {
  if (!validId(runId) || runId.length > 110) throw new Error("invalid_run_id");
  return `run-${runId}.jsonl`;
};
const summary = record => ({ runId: record.runId, state: record.state,
  ...(record.result ? { status: record.result.status, reason: record.result.reason, recording: record.result.recording,
    outputBytes: record.result.outputBytes, workCompleted: false } : {}),
  message: ["reserved", "unconfirmed"].includes(record.state) ? "Run outcome unknown. Inspect the process and Room session; do not rerun." : undefined });

export async function executeLocalRun(directory, { signal } = {}) {
  const root = privatePath(directory), config = configAt(root), connection = readAgentConnection(config.connectionDirectory);
  const path = join(root, journalName(config.runId));
  // Exclusive reservation is durable before *any* Room mutation or execution.
  // Never delete this record automatically, even for a validation/network error.
  const fd = openSync(path, "wx", 0o600);
  const append = record => { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); };
  const base = { version: 1, runId: config.runId, roomId: connection.roomId, memberId: connection.memberId,
    workItemId: config.workItemId, configDigest: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
  try {
    append({ ...base, state: "reserved", at: new Date().toISOString() });
    const directoryFd = openSync(root, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    const { version, connectionDirectory, ...options } = config;
    let result;
    try {
      result = await runLocalSession({ ...options, roomId: connection.roomId, memberId: connection.memberId,
        client: new RoomAgentClient(connection), signal });
    } catch {
      // Do not echo transport errors, commands or environment secrets.
      const record = { ...base, state: "unconfirmed", at: new Date().toISOString(),
        result: { status: "unknown", reason: "run_not_confirmed", recording: "unconfirmed" } };
      append(record); return summary(record);
    }
    const record = { ...base, state: "finished", at: new Date().toISOString(), result };
    append(record); return summary(record);
  } finally { closeSync(fd); }
}

export function inspectLocalRun(directory, runId, { includeOutput = false } = {}) {
  const root = privatePath(directory), source = readPrivate(join(root, journalName(runId)), 8 * 1024 * 1024);
  const lines = source.split("\n");
  // A torn final write is not a completed record. Retain the reservation warning.
  if (lines.at(-1) !== "") lines.pop();
  const records = lines.filter(Boolean).map(line => JSON.parse(line));
  if (!records.length || records.some(record => record.version !== 1 || record.runId !== runId)) throw new Error("invalid_run_record");
  const last = records.at(-1);
  return { ...summary(last), ...(includeOutput ? { output: last.result?.output ?? null } : {}) };
}
