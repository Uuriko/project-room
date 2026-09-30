#!/usr/bin/env node
// Register pull-only presence with the saved room access key and print
// pending wake pointers. The key cannot install a wake URL. Acknowledgement
// happens only for a signal id this same pull just printed. The credential
// is never written to stdout or stderr.

import { pathToFileURL } from "node:url";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";

const usage = `Usage: node scripts/room-key-pull.mjs --host HOST [--cadence SECONDS] [--ack SIGNAL_ID]
Reads ROOM_AGENT_CONFIG, or ROOM_AGENT_ORIGIN + ROOM_AGENT_ROOM + ROOM_AGENT_TOKEN.
Sends mode pull-only only. Does not start a listener.`;

function fail(status, message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = status;
}

function args(argv) {
  const out = { ack: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--host" && value) { out.hostId = value; i++; continue; }
    if (flag === "--cadence" && value) { out.cadenceSeconds = Number(value); i++; continue; }
    if (flag === "--ack" && value) { out.ack.push(value); i++; continue; }
    return { error: "usage" };
  }
  if (!out.hostId || !/^[A-Za-z0-9._-]{1,128}$/.test(out.hostId)) return { error: "usage" };
  if (out.cadenceSeconds !== undefined && (!Number.isInteger(out.cadenceSeconds) || out.cadenceSeconds < 30 || out.cadenceSeconds > 86400)) return { error: "usage" };
  return out;
}

async function post(origin, token, path, body) {
  // Bound the heartbeat/ack POST so a stalled network can't hang the pull
  // loop forever (L-53).
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let doc = null;
  try { doc = await response.json(); } catch { doc = null; }
  return { response, doc };
}

export async function pullOnce({ origin, token, hostId, cadenceSeconds = 60, ackIds = [] }) {
  const reported = await post(origin, token, "/api/agent-heartbeats", {
    hostId, mode: "pull-only", ...(cadenceSeconds === undefined ? {} : { cadenceSeconds }),
  });
  if (!reported.response.ok) {
    const error = new Error("heartbeat refused");
    error.status = reported.response.status;
    error.code = reported.doc?.error?.code ?? null;
    throw error;
  }
  const pending = (reported.doc.pendingWakes ?? []).map(wake => ({
    signalId: wake.signalId ?? null,
    kind: wake.kind ?? null,
    roomId: wake.roomId ?? null,
    messageId: wake.messageId ?? null,
  }));
  const seen = new Set(pending.map(wake => wake.signalId).filter(Boolean));
  if (ackIds.some(id => !seen.has(id))) {
    const error = new Error("ack requires a signal id from this pull");
    error.status = 2;
    error.code = "ack_not_in_pull";
    throw error;
  }
  const acknowledged = [];
  if (ackIds.length) {
    const acked = await post(origin, token, "/api/agent-heartbeats/ack", { signalIds: ackIds });
    if (!acked.response.ok) {
      const error = new Error("ack refused");
      error.status = acked.response.status;
      error.code = acked.doc?.error?.code ?? null;
      throw error;
    }
    acknowledged.push(...(acked.doc.acknowledged ?? ackIds));
  }
  return {
    ok: true,
    mode: reported.doc.host?.mode ?? null,
    wakeUrl: reported.doc.host?.wakeUrl ?? null,
    pending,
    acknowledged,
  };
}

async function main() {
  const parsed = args(process.argv.slice(2));
  if (parsed.help) { process.stdout.write(`${usage}\n`); return; }
  if (parsed.error) { fail(1, usage); return; }
  let connection;
  try { connection = agentConnectionFromEnvironment(); }
  catch (error) { fail(1, error.message ?? "connection unavailable"); return; }
  try {
    const result = await pullOnce({
      origin: connection.origin,
      token: connection.token,
      hostId: parsed.hostId,
      cadenceSeconds: parsed.cadenceSeconds ?? 60,
      ackIds: parsed.ack,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error.code === "ack_not_in_pull") { fail(2, error.message); return; }
    fail(1, error.code ? `${error.code}` : "heartbeat failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
