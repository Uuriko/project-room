import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync, chmodSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { readAgentConnection, ConnectionError } from "../client/agent-connection.mjs";
import {
  GrokHostError, parseNeedsMeBody, parseWakePing, wakeToAttentionItem,
  pendingWakeToItem, attentionKey, selectUnhandled, markHandled, setCursor, loadJournal,
  emptyJournal, buildRunPlan, assertPlanSafe, childEnvFor, emptyAttentionNext, countKinds
} from "../client/grok-host.mjs";
import { parseRoomText } from "../client/text-plug.mjs";
import { matchListings } from "../client/matchmaking.mjs";

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

function pendingAccessPathFor(env = process.env) {
  if (typeof env.ROOM_AGENT_CONFIG === "string" && env.ROOM_AGENT_CONFIG.trim()) {
    return join(resolve(env.ROOM_AGENT_CONFIG.trim()), "pending-access.json");
  }
  fail("config_not_found", "Set ROOM_AGENT_CONFIG");
}

export function loadPendingAccess(data) {
  if (data == null) return { requests: [] };
  if (typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.requests)) return { requests: [] };
  const requests = [];
  for (const row of data.requests) {
    if (!row || typeof row.requestId !== "string" || typeof row.roomId !== "string") continue;
    requests.push({ requestId: row.requestId, roomId: row.roomId, identityId: typeof row.identityId === "string" ? row.identityId : null });
  }
  return { requests };
}

export function rememberPendingAccess(current, row) {
  const next = loadPendingAccess(current);
  if (next.requests.some(item => item.requestId === row.requestId)) return next;
  next.requests.push({ requestId: row.requestId, roomId: row.roomId, identityId: row.identityId ?? null });
  return next;
}

export function readJournalFile(filename) {
  if (!existsSync(filename)) return emptyJournal();
  try { return loadJournal(JSON.parse(readFileSync(filename, "utf8"))); }
  catch { fail("invalid_journal", "Journal exists but is not valid JSON for this host"); }
}

export function writeJournalFile(filename, journal) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(journal) + "\n";
  // M-53: write to a temp file and rename — a crash mid-write must never
  // leave a truncated journal behind (the old truncate-in-place did).
  const tmp = `${filename}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(tmp, 0o600);
  renameSync(tmp, filename);
}

export function readPendingAccessFile(filename) {
  if (!existsSync(filename)) return { requests: [] };
  let parsed;
  try { parsed = JSON.parse(readFileSync(filename, "utf8")); }
  catch {
    // M-53: fail loudly on corrupt files like readJournalFile does. Returning
    // { requests: [] } silently forgot pending access requests. The corrupt
    // file is preserved alongside for forensics.
    const backup = `${filename}.corrupt-${Date.now()}`;
    try { renameSync(filename, backup); } catch { /* keep the original; still fail */ }
    fail("invalid_pending_access", `Pending-access file is not valid JSON (moved to ${backup})`);
  }
  return loadPendingAccess(parsed);
}

export function writePendingAccessFile(filename, data) {
  writeJournalFile(filename, loadPendingAccess(data));
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
      rooms,
      pendingAdmissions: await pollPendingAdmissions(connection, env, fetchImpl)
    };
  } catch (error) {
    const code = error instanceof ConnectionError || error instanceof GrokHostError ? error.code : "doctor_failed";
    return { ok: false, code, next: nextFor(code) };
  }
}

async function pollPendingAdmissions(connection, env, fetchImpl) {
  const filename = pendingAccessPathFor(env);
  const pending = readPendingAccessFile(filename);
  const out = [];
  for (const row of pending.requests) {
    const identityId = row.identityId || connection.memberId;
    try {
      const parsed = await jsonRequest(connection, `/api/access-requests/${encodeURIComponent(row.requestId)}?identityId=${encodeURIComponent(identityId)}`, { fetchImpl });
      out.push({ requestId: row.requestId, roomId: parsed.roomId || row.roomId, status: parsed.status || "unknown" });
    } catch {
      out.push({ requestId: row.requestId, roomId: row.roomId, status: "poll_failed" });
    }
  }
  return out;
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

// H-20: head+tail capped byte buffer. A noisy child previously had every
// chunk retained forever, growing operator memory without bound. The first
// half of the budget keeps the head, the last half keeps the tail; dropped
// bytes are counted so the truncation is visible in the output.
function cappedOutputBuffer(limit) {
  const half = Math.max(1, Math.floor(limit / 2));
  const head = [];
  const tail = [];
  let headLen = 0, tailLen = 0, dropped = 0;
  const pushTail = buf => {
    tail.push(buf);
    tailLen += buf.length;
    while (tailLen > half) {
      const first = tail[0];
      const over = tailLen - half;
      if (first.length <= over) {
        tail.shift();
        tailLen -= first.length;
        dropped += first.length;
      } else {
        tail[0] = first.subarray(over);
        tailLen -= over;
        dropped += over;
      }
    }
  };
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buf.length === 0) return;
      if (headLen < half) {
        const take = Math.min(buf.length, half - headLen);
        head.push(buf.subarray(0, take));
        headLen += take;
        if (take < buf.length) pushTail(buf.subarray(take));
        return;
      }
      pushTail(buf);
    },
    text() {
      const parts = head.concat(tail);
      if (dropped === 0) return Buffer.concat(parts).toString("utf8");
      const marker = `\n…[grok host: output truncated, ${dropped} bytes dropped]…\n`;
      return Buffer.concat([...head, Buffer.from(marker), ...tail]).toString("utf8");
    },
  };
}

async function defaultRunner(plan, env, connection) {
  const bin = env.GROK_BIN?.trim() || "grok";
  const cwd = env.GROK_ROOM_CWD?.trim() || process.cwd();
  // H-20: a hung child previously stalled the standing host loop indefinitely
  // (the promise resolved only on child close). Bound the run and kill the
  // child on timeout; resolve (not reject) so the loop continues with the
  // next item and the unhandled plan is retried on a later tick.
  const timeoutMs = Number(env.GROK_HOST_TIMEOUT_MS) > 0 ? Number(env.GROK_HOST_TIMEOUT_MS) : 300000;
  const maxBytes = Number(env.GROK_HOST_MAX_OUTPUT_BYTES) > 0 ? Number(env.GROK_HOST_MAX_OUTPUT_BYTES) : 1000000;
  const childEnv = childEnvFor({ ...process.env, ...env }, connection);
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, ["-p", plan.prompt], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = cappedOutputBuffer(maxBytes);
    const stderr = cappedOutputBuffer(maxBytes);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    let timedOut = false;
    let settled = false;
    const settle = fn => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(...args);
    };
    const finish = settle(code => {
      // The timeout note leads stderr so it survives the journal's
      // stderr slice: the most operationally important fact comes first.
      const note = timedOut ? `[grok host] timed out after ${timeoutMs}ms; child killed (SIGKILL)\n` : "";
      resolve({
        code: timedOut ? null : code,
        stdout: stdout.text(),
        stderr: note + stderr.text(),
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // Resolve now instead of waiting for "close": orphaned grandchildren
      // can hold the stdio pipes open and delay "close" indefinitely.
      // The settle guard makes a later "close" a no-op.
      finish(null);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.on("error", settle(error => reject(new GrokHostError("execute_failed", error.message))));
    child.on("close", code => finish(code));
  });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args[0] === "request-access") {
    const roomId = args[1];
    if (typeof roomId !== "string" || roomId.length < 1 || args.length !== 2) return null;
    return { command: "request-access", roomId };
  }
  if (args[0] === "claim") {
    const workItemId = args[1];
    if (typeof workItemId !== "string" || workItemId.length < 1) return null;
    const out = { command: "claim", workItemId, leaseHours: undefined, roomId: undefined };
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--lease-hours" && args[i + 1]) {
        const hours = Number(args[++i]);
        if (!Number.isInteger(hours) || hours < 1 || hours > 720) return null;
        out.leaseHours = hours;
        continue;
      }
      if (args[i] === "--room" && args[i + 1]) { out.roomId = args[++i]; continue; }
      return null;
    }
    return out;
  }
  if (args[0] === "text") {
    const line = args.slice(1).join(" ").trim();
    if (!line) return null;
    return { command: "text", line };
  }
  const command = args[0] === "doctor" || args[0] === "pull" || args[0] === "wake" ? args[0] : null;
  if (!command) return null;
  const execute = args.includes("--execute");
  if (execute && command === "doctor") return null;
  if (args.some((word, i) => i > 0 && word !== "--execute")) return null;
  return { command, execute };
}

export async function fileAccessRequest({ env = process.env, fetchImpl = fetch, roomId, note = "" } = {}) {
  const connection = connectionFromEnv(env);
  if (typeof roomId !== "string" || roomId.length < 1 || roomId.length > 128) fail("invalid_attention_item", "roomId required");
  const requestId = `ar_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const parsed = await jsonRequest(connection, "/api/access-requests", {
    fetchImpl, method: "POST",
    body: {
      roomId,
      identityId: connection.memberId,
      displayName: "Grok Build",
      requestedPermissions: ["accept_work", "complete_work"],
      note,
      requestId
    }
  });
  const filename = pendingAccessPathFor(env);
  const remembered = rememberPendingAccess(readPendingAccessFile(filename), {
    requestId: parsed.requestId || requestId,
    roomId: parsed.roomId || roomId,
    identityId: connection.memberId
  });
  writePendingAccessFile(filename, remembered);
  return { ok: true, requestId: parsed.requestId || requestId, status: parsed.status, roomId: parsed.roomId || roomId };
}

export async function claimWork({ env = process.env, fetchImpl = fetch, workItemId, leaseHours, roomId } = {}) {
  const connection = connectionFromEnv(env);
  if (typeof workItemId !== "string" || workItemId.length < 1 || workItemId.length > 128) fail("invalid_attention_item", "workItemId required");
  const room = (typeof roomId === "string" && roomId) ? roomId : connection.roomId;
  const path = `/api/rooms/${encodeURIComponent(room)}/work-claims/${encodeURIComponent(workItemId)}/claim`;
  const body = { ...(leaseHours === undefined ? {} : { leaseHours }) };
  const parsed = await jsonRequest(connection, path, { fetchImpl, method: "POST", body });
  const token = connection.token;
  const safe = JSON.parse(JSON.stringify(parsed));
  const blob = JSON.stringify(safe);
  if (blob.includes(token)) fail("secret_in_plan");
  return {
    ok: true,
    workItemId: parsed.id || workItemId,
    roomId: room,
    state: parsed.state || null,
    owner: parsed.owner || parsed.claimedBy || null,
    leaseExpiresAt: parsed.leaseExpiresAt ?? null,
    fileWarnings: Array.isArray(parsed.fileWarnings) ? parsed.fileWarnings : []
  };
}

export async function handleTextCommand({ env = process.env, fetchImpl = fetch, line, listings = [] } = {}) {
  const parsed = parseRoomText(line);
  if (parsed.verb === "pull") {
    const result = await pull({ env, fetchImpl, execute: false });
    return { ok: true, verb: "pull", silent: result.silent, planned: result.planned.length };
  }
  if (parsed.verb === "claim") {
    const result = await claimWork({ env, fetchImpl, workItemId: parsed.workItemId });
    return { ok: true, verb: "claim", workItemId: result.workItemId, state: result.state };
  }
  if (parsed.verb === "done") return { ok: true, verb: "done" };
  const hits = matchListings({ motive: parsed.motive, tags: parsed.tags }, listings);
  return {
    ok: true,
    verb: "match",
    matches: hits.map(hit => ({ id: hit.listing.id, score: hit.score, reasons: hit.reasons }))
  };
}

function readWakeBody() {
  const text = readFileSync(0, "utf8");
  try { return JSON.parse(text); }
  catch { fail("invalid_wake_ping", "stdin must be one agent.wake JSON object"); }
}

export async function main(argv = process.argv, env = process.env, io = { log: console.log, error: console.error }) {
  const parsed = parseArgs(argv);
  if (!parsed) {
    io.error("Usage: node scripts/grok-room-host.mjs doctor | pull [--execute] | wake [--execute] | request-access <roomId> | claim <workItemId> [--lease-hours N] [--room ROOM] | text <line>");
    process.exitCode = 2;
    return;
  }
  try {
    const result = parsed.command === "doctor" ? await doctor({ env })
      : parsed.command === "wake" ? await ingestWake({ env, body: readWakeBody(), execute: parsed.execute })
        : parsed.command === "request-access" ? await fileAccessRequest({ env, roomId: parsed.roomId })
          : parsed.command === "claim" ? await claimWork({ env, workItemId: parsed.workItemId, leaseHours: parsed.leaseHours, roomId: parsed.roomId })
            : parsed.command === "text" ? await handleTextCommand({ env, line: parsed.line })
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
