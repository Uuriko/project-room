import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { readAgentConnection, ConnectionError } from "../client/agent-connection.mjs";
import {
  GrokHostError, parseNeedsMeBody, parseWakePing, wakeToAttentionItem,
  pendingWakeToItem, selectUnhandled, markHandled, setCursor, loadJournal,
  emptyJournal, buildRunPlan, assertPlanSafe
} from "../client/grok-host.mjs";

function fail(code, message) {
  throw new GrokHostError(code, message);
}

function connectionFromEnv(env = process.env) {
  const directory = env.ROOM_AGENT_CONFIG;
  if (typeof directory === "string" && directory.trim()) return readAgentConnection(directory.trim());
  fail("config_not_found", "Set ROOM_AGENT_CONFIG to the private connection directory");
}

function journalPathFor(env = process.env) {
  if (typeof env.ROOM_GROK_STATE === "string" && env.ROOM_GROK_STATE.trim()) return resolve(env.ROOM_GROK_STATE.trim());
  if (typeof env.ROOM_AGENT_CONFIG === "string" && env.ROOM_AGENT_CONFIG.trim()) {
    return join(resolve(env.ROOM_AGENT_CONFIG.trim()), "grok-host-journal.json");
  }
  fail("config_not_found", "Set ROOM_AGENT_CONFIG or ROOM_GROK_STATE for the journal");
}

export function readJournalFile(filename) {
  if (!existsSync(filename)) return emptyJournal();
  try { return loadJournal(JSON.parse(readFileSync(filename, "utf8"))); }
  catch { fail("invalid_journal", "Journal exists but is not valid JSON for this host"); }
}

export function writeJournalFile(filename, journal) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(journal) + "\n";
  const fd = openSync(filename, "w", 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(filename, 0o600);
}

function hostIdFor(env = process.env) {
  const value = env.GROK_HOST_ID?.trim() || "grok-build";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) fail("invalid_host_id");
  return value;
}

async function jsonRequest(connection, path, { fetchImpl = fetch, method = "GET", body } = {}) {
  const url = new URL(path, connection.origin);
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail("invalid_response", `${path} returned non-JSON (${response.status})`); }
  if (response.status < 200 || response.status >= 300) {
    const code = typeof parsed?.code === "string" ? parsed.code
      : typeof parsed?.error?.code === "string" ? parsed.error.code
        : "request_failed";
    const message = typeof parsed?.message === "string" ? parsed.message
      : typeof parsed?.error?.message === "string" ? parsed.error.message
        : `${path} HTTP ${response.status}`;
    fail(code, message);
  }
  return parsed;
}

async function readNeedsMe(connection, { fetchImpl = fetch, since } = {}) {
  const url = new URL("/api/needs-me", connection.origin);
  if (since != null) url.searchParams.set("since", typeof since === "string" ? since : JSON.stringify(since));
  const parsed = await jsonRequest(connection, `${url.pathname}${url.search}`, { fetchImpl });
  return parseNeedsMeBody(parsed);
}

async function beatPullOnly(connection, { fetchImpl = fetch, env = process.env } = {}) {
  const hostId = hostIdFor(env);
  const parsed = await jsonRequest(connection, "/api/agent-heartbeats", {
    fetchImpl, method: "POST",
    body: { hostId, mode: "pull-only", cadenceSeconds: 60, workWakes: true }
  });
  const pending = Array.isArray(parsed.pendingWakes) ? parsed.pendingWakes : [];
  return {
    hostId: parsed.host?.hostId ?? hostId,
    pendingWakes: pending,
    items: pending.map(pendingWakeToItem),
    signalIds: pending.map(row => row.signalId).filter(id => typeof id === "string" && id.length > 0)
  };
}

async function ackWakes(connection, signalIds, { fetchImpl = fetch } = {}) {
  if (!signalIds.length) return { acknowledged: [] };
  return await jsonRequest(connection, "/api/agent-heartbeats/ack", {
    fetchImpl, method: "POST", body: { signalIds }
  });
}

export async function doctor({ env = process.env, fetchImpl = fetch } = {}) {
  try {
    const connection = connectionFromEnv(env);
    const healthUrl = new URL("/api/health", connection.origin);
    const health = await fetchImpl(healthUrl, { method: "GET", headers: { Accept: "application/json" } });
    const attention = await readNeedsMe(connection, { fetchImpl });
    return {
      ok: true,
      code: "credential_accepted",
      origin: connection.origin,
      roomId: connection.roomId,
      memberId: connection.memberId,
      health: health.status,
      items: attention.items.length,
      hasMore: attention.hasMore
    };
  } catch (error) {
    const code = error instanceof ConnectionError || error instanceof GrokHostError ? error.code : "doctor_failed";
    return { ok: false, code, next: nextFor(code) };
  }
}

function nextFor(code) {
  if (code === "config_not_found" || code === "config_not_private") {
    return "Save a connection with: node scripts/agent-inbox.mjs join '<invite>' ~/.project-room/grok-build --name \"Grok Build\"";
  }
  if (code === "unauthenticated") return "The saved secret was rejected. Reuse the existing identity directory; do not mint a replacement until this one is proven dead.";
  return "See docs/GROK-DEEP-PLUG-PLAN-2026-09-29.md";
}

async function planAndJournal({ connection, items, env, execute, runner, now, extra = {} }) {
  const filename = journalPathFor(env);
  let journal = readJournalFile(filename);
  if (extra.cursor !== undefined) journal = setCursor(journal, extra.cursor);
  const fresh = selectUnhandled(items, journal);
  const secrets = [connection.token];
  const plans = fresh.map(item => assertPlanSafe(buildRunPlan(item, { origin: connection.origin }), secrets));
  const executed = [];
  for (const plan of plans) {
    journal = markHandled(journal, plan.item, now());
    writeJournalFile(filename, journal);
    if (execute) {
      const result = await (runner ?? defaultRunner)(plan, env);
      executed.push({ key: plan.key, result });
    }
  }
  if (extra.cursor !== undefined) {
    journal = setCursor(journal, extra.cursor);
    writeJournalFile(filename, journal);
  }
  return { journal, plans, executed, filename };
}

export async function pull({ env = process.env, fetchImpl = fetch, execute = false, runner, now = Date.now } = {}) {
  const connection = connectionFromEnv(env);
  const filename = journalPathFor(env);
  const journal = readJournalFile(filename);
  const beat = await beatPullOnly(connection, { fetchImpl, env });
  const attention = await readNeedsMe(connection, { fetchImpl, since: journal.cursor ?? undefined });
  const items = [...beat.items, ...attention.items];
  const result = await planAndJournal({
    connection, items, env, execute, runner, now, extra: { cursor: attention.cursor }
  });
  await ackWakes(connection, beat.signalIds, { fetchImpl });
  return {
    ok: true,
    identityId: attention.identityId,
    seen: items.length,
    planned: result.plans,
    executed: result.executed,
    hasMore: attention.hasMore,
    cursor: attention.cursor,
    pendingWakes: beat.pendingWakes.length,
    hostId: beat.hostId
  };
}

export async function ingestWake({ env = process.env, body, execute = false, runner, now = Date.now } = {}) {
  const connection = connectionFromEnv(env);
  const item = wakeToAttentionItem(parseWakePing(body));
  const result = await planAndJournal({
    connection, items: [item], env, execute, runner, now
  });
  return { ok: true, planned: result.plans, executed: result.executed, key: result.plans[0]?.key ?? null };
}

async function defaultRunner(plan, env) {
  const bin = env.GROK_BIN?.trim() || "grok";
  const cwd = env.GROK_ROOM_CWD?.trim() || process.cwd();
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, ["-p", plan.prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => reject(new GrokHostError("execute_failed", error.message)));
    child.on("close", code => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8").slice(0, 8000),
        stderr: Buffer.concat(stderr).toString("utf8").slice(0, 2000)
      });
    });
  });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] === "doctor" || args[0] === "pull" || args[0] === "wake" ? args[0] : null;
  if (!command) return null;
  const execute = args.includes("--execute");
  if (execute && command === "doctor") return null;
  if (args.some((word, i) => i > 0 && word !== "--execute")) return null;
  return { command, execute };
}

function readWakeBody() {
  const text = readFileSync(0, "utf8");
  try { return JSON.parse(text); }
  catch { fail("invalid_wake_ping", "stdin must be one agent.wake JSON object"); }
}

export async function main(argv = process.argv, env = process.env, io = { log: console.log, error: console.error }) {
  const parsed = parseArgs(argv);
  if (!parsed) {
    io.error("Usage: node scripts/grok-room-host.mjs doctor | pull [--execute] | wake [--execute]");
    process.exitCode = 2;
    return;
  }
  try {
    const result = parsed.command === "doctor" ? await doctor({ env })
      : parsed.command === "wake" ? await ingestWake({ env, body: readWakeBody(), execute: parsed.execute })
        : await pull({ env, execute: parsed.execute });
    io.log(JSON.stringify(result));
    if (parsed.command === "doctor" && result.ok === false) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof ConnectionError || error instanceof GrokHostError ? error.code : "host_failed";
    io.log(JSON.stringify({ ok: false, code, next: nextFor(code) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
