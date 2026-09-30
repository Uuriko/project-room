import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { readAgentConnection, ConnectionError } from "../client/agent-connection.mjs";
import {
  GrokHostError, parseNeedsMeBody, parseWakePing, wakeToAttentionItem,
  pendingWakeToItem, attentionKey, selectUnhandled, markHandled, setCursor, loadJournal,
  emptyJournal, buildRunPlan, assertPlanSafe, childEnvFor, emptyAttentionNext, countKinds
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
    body: { hostId, mode: "pull-only", cadenceSeconds: 60 }
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
    let hostId = null, pendingWakes = 0, presence = "pull-only";
    try {
      const beat = await beatPullOnly(connection, { fetchImpl, env });
      hostId = beat.hostId;
      pendingWakes = beat.pendingWakes.length;
    } catch {
      presence = "heartbeat_failed";
    }
    const rooms = attention.cursor?.rooms && typeof attention.cursor.rooms === "object"
      ? Object.keys(attention.cursor.rooms)
      : [connection.roomId];
    return {
      ok: true,
      code: "credential_accepted",
      origin: connection.origin,
      roomId: connection.roomId,
      memberId: connection.memberId,
      health: health.status,
      items: attention.items.length,
      hasMore: attention.hasMore,
      hostId,
      pendingWakes,
      presence,
      listening: presence === "pull-only" ? "pull-only" : presence,
      executeDefault: false,
      rooms
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
  const distinct = [...new Map(items.map(item => [attentionKey(item), item])).values()];
  const fresh = selectUnhandled(distinct, journal);
  const secrets = [connection.token];
  const plans = fresh.map(item => assertPlanSafe(buildRunPlan(item, { origin: connection.origin }), secrets));
  const executed = [];
  for (const plan of plans) {
    if (!execute) continue;
    const raw = await (runner ?? defaultRunner)(plan, env, connection);
    // A child has the bearer in its environment; its output is not trusted.
    const redact = (value, limit) => typeof value === "string"
      ? value.replaceAll(connection.token, "[REDACTED]").slice(0, limit) : "";
    const result = { code: raw?.code, stdout: redact(raw?.stdout, 8000), stderr: redact(raw?.stderr, 2000) };
    executed.push({ key: plan.key, result });
    if (result.code === 0) {
      journal = markHandled(journal, plan.item, now());
      writeJournalFile(filename, journal);
    }
  }
  // Preview and unsuccessful execution must not advance past pending work.
  if (execute && executed.every(entry => entry.result.code === 0) && extra.cursor !== undefined) {
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
  const items = [...beat.items];
  let cursor = journal.cursor ?? undefined;
  let identityId = null;
  let hasMore = false;
  let pages = 0;
  do {
    const attention = await readNeedsMe(connection, { fetchImpl, since: cursor });
    items.push(...attention.items);
    identityId = attention.identityId;
    cursor = attention.cursor;
    hasMore = attention.hasMore === true;
    pages += 1;
  } while (hasMore && pages < 5);
  const result = await planAndJournal({
    connection, items, env, execute, runner, now, extra: { cursor: cursor ?? null }
  });
  if (execute) {
    const completedSignals = beat.pendingWakes.filter(wake =>
      Object.hasOwn(result.journal.handled, attentionKey(pendingWakeToItem(wake))))
      .map(wake => wake.signalId).filter(id => typeof id === "string" && id.length > 0);
    await ackWakes(connection, completedSignals, { fetchImpl });
  }
  const silent = result.plans.length === 0;
  return {
    ok: true,
    identityId,
    seen: items.length,
    planned: result.plans,
    executed: result.executed,
    hasMore,
    pages,
    cursor: cursor ?? null,
    pendingWakes: beat.pendingWakes.length,
    hostId: beat.hostId,
    silent,
    kinds: countKinds(result.plans.map(plan => plan.item)),
    next: silent ? emptyAttentionNext({ execute }) : "Review planned items; --execute starts Grok."
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

async function defaultRunner(plan, env, connection) {
  const bin = env.GROK_BIN?.trim() || "grok";
  const cwd = env.GROK_ROOM_CWD?.trim() || process.cwd();
  const childEnv = childEnvFor({ ...process.env, ...env }, connection);
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, ["-p", plan.prompt], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => reject(new GrokHostError("execute_failed", error.message)));
    child.on("close", code => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
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
