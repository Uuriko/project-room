// External liveness for the public room. A separate Worker runs this every
// minute so an outage is noticed without waiting for the 6-hour GitHub
// probes. One failed run records a streak and stays quiet. The second failed
// run in a row notifies once. A later pass sends one recovery notice.
//
// /api/health stayed ok on 2026-10-24 while room reads returned 503, and
// this probe never opened a room. When PROBE_QA_TOKEN is set, each run
// still checks ready, then opens the dedicated qa-external-probe room,
// posts a nonce every PROBE_NONCE_EVERY runs (default 5), and reads that
// message back. Latencies are kept on each step. The token is a Worker
// secret: it is sent as a bearer header and never copied into a notice,
// the KV value, or GET /status. Unset, the room path stays out of the run
// so a Worker without the secret keeps the public checks. Invalid, the
// run fails closed instead of looking healthy.
//
// A probe that cannot read or write its own streak state confesses loudly:
// runExternalProbe throws a ProbeStateError, which the scheduled handler
// surfaces as a failed Cron invocation. It never returns a healthy-looking
// result — without state the two-failure threshold is unreachable, so a
// quiet return would make a dead watcher indistinguishable from a healthy
// one.
//
// Destinations are inert until their secrets exist:
//   PROBE_ALERT_WEBHOOK_URL — HTTPS webhook (a Cloudflare notification URL
//     is one option). http is accepted only for 127.0.0.1 and localhost.
//   PROBE_ROOM_ORIGIN, PROBE_ROOM_ID, PROBE_ROOM_TOKEN — muse-room post.
//     ROOM_AGENT_ORIGIN, ROOM_AGENT_ROOM, and ROOM_AGENT_TOKEN are the
//     existing connection names and are used when the PROBE_ROOM_* name is
//     unset. The token and the webhook URL are never written into the notice.
//     A getdasha door origin (https://www.getdasha.com, no /room path) is
//     prefixed via edgeDoorApiPath: /api/* there is Webflow, not the Worker.

import { edgeDoorApiPath } from "../server/agent-discovery.mjs";

export const FAILURES_BEFORE_ALERT = 2;
export const DEFAULT_ORIGIN = "https://room.trydemigod.com";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const STATE_KEY = "streak";
export const LAST_KEY = "last";
export const SYNTHETIC_KEY = "synthetic";
export const STATUS_SCHEMA = "project-room.external-probe-status/1";
export const QA_ROOM_ID = "qa-external-probe";
export const NONCE_EVERY_RUNS = 5;
export const PROBE_USER_AGENT = "project-room-external-probe";
const BODY_LIMIT = 65_536;
const LLMS_HEADING = "# Uuriko Project Room";

const emptyState = () => ({
  consecutiveFailures: 0,
  incidentId: null,
  alertedWebhook: false,
  alertedRoom: false,
  lastAt: null
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function loopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validProbeOrigin(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && loopback(url.hostname);
  } catch {
    return false;
  }
}

function validWebhook(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && loopback(url.hostname);
  } catch {
    return false;
  }
}

function validRoomId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    && !["constructor", "prototype", "__proto__"].includes(value);
}

function timeoutMs(env) {
  const raw = text(env.PROBE_CHECK_TIMEOUT_MS);
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 30_000 ? parsed : DEFAULT_TIMEOUT_MS;
}

function probeOrigin(env) {
  const configured = text(env.PROBE_ORIGIN);
  if (!configured) return DEFAULT_ORIGIN;
  return validProbeOrigin(configured) ? new URL(configured).origin : null;
}

function webhookDestination(env) {
  const configured = text(env.PROBE_ALERT_WEBHOOK_URL);
  if (!configured) return { url: null, inert: "unset" };
  if (!validWebhook(configured)) return { url: null, inert: "invalid" };
  return { url: configured, inert: null };
}

function roomDestination(env) {
  const origin = text(env.PROBE_ROOM_ORIGIN) || text(env.ROOM_AGENT_ORIGIN);
  const roomId = text(env.PROBE_ROOM_ID) || text(env.ROOM_AGENT_ROOM);
  const credential = text(env.PROBE_ROOM_TOKEN) || text(env.ROOM_AGENT_TOKEN);
  if (!origin && !roomId && !credential) return { room: null, inert: "unset" };
  if (!validProbeOrigin(origin) || !validRoomId(roomId) || credential.length < 8 || credential.length > 512) {
    return { room: null, inert: "invalid" };
  }
  return { room: { origin: new URL(origin).origin, roomId, credential }, inert: null };
}

function normalize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState();
  const incidentId = typeof raw.incidentId === "string" && /^[a-f0-9]{32}$/.test(raw.incidentId) ? raw.incidentId : null;
  if (!incidentId) return emptyState();
  const consecutiveFailures = Number.isSafeInteger(raw.consecutiveFailures)
    && raw.consecutiveFailures >= 0 && raw.consecutiveFailures <= 100_000
    ? raw.consecutiveFailures : 0;
  return {
    consecutiveFailures,
    incidentId,
    alertedWebhook: raw.alertedWebhook === true,
    alertedRoom: raw.alertedRoom === true,
    lastAt: typeof raw.lastAt === "string" ? raw.lastAt : null
  };
}

function newIncidentId() {
  return crypto.randomUUID().replaceAll("-", "");
}

async function readLimited(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  try {
    while (size < BODY_LIMIT) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.byteLength;
      chunks.push(step.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(size, BODY_LIMIT));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.length - offset);
    if (take <= 0) break;
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder().decode(bytes);
}

function pass(id, status) {
  return { id, ok: true, status, reason: null, detail: null };
}

function fail(id, status, reason, detail = null) {
  return { id, ok: false, status: Number.isInteger(status) ? status : null, reason, detail };
}

async function checkCall(id, run) {
  const started = Date.now();
  try {
    const result = await run();
    return { ...result, latencyMs: Math.max(0, Date.now() - started) };
  } catch (error) {
    const reason = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network";
    return { ...fail(id, null, reason), latencyMs: Math.max(0, Date.now() - started) };
  }
}

async function runChecks(origin, fetchImpl, limitMs, afterReady = null) {
  const headers = { "user-agent": PROBE_USER_AGENT, accept: "application/json" };
  const signal = () => AbortSignal.timeout(limitMs);
  const ready = checkCall("ready", async () => {
    const response = await fetchImpl(new URL("/api/ready", origin), { method: "GET", headers, redirect: "manual", signal: signal() });
    const body = await readLimited(response);
    if (response.status !== 200) return fail("ready", response.status, "http_status");
    let parsed;
    try { parsed = JSON.parse(body); } catch { return fail("ready", 200, "invalid_json"); }
    if (!parsed || parsed.status !== "ready") return fail("ready", 200, "not_ready");
    return pass("ready", 200);
  });
  const mcp = checkCall("mcp", async () => {
    const response = await fetchImpl(new URL("/mcp", origin), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "probe-tools", method: "tools/list" }),
      redirect: "manual",
      signal: signal()
    });
    const body = await readLimited(response);
    if (response.status !== 200) return fail("mcp", response.status, "http_status");
    let parsed;
    try { parsed = JSON.parse(body); } catch { return fail("mcp", 200, "invalid_json"); }
    const tools = parsed?.result?.tools;
    const named = Array.isArray(tools) && tools.length > 0
      && tools.every(tool => tool && typeof tool.name === "string" && tool.name.length > 0);
    if (parsed?.error || !named) return fail("mcp", 200, "tools_missing");
    return pass("mcp", 200);
  });
  const llms = checkCall("llms", async () => {
    const response = await fetchImpl(new URL("/llms.txt", origin), {
      method: "GET",
      headers: { "user-agent": PROBE_USER_AGENT, accept: "text/plain" },
      redirect: "manual",
      signal: signal()
    });
    const body = await readLimited(response);
    if (response.status !== 200) return fail("llms", response.status, "http_status");
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/plain") || !body.includes(LLMS_HEADING)) return fail("llms", 200, "packet_missing");
    return pass("llms", 200);
  });
  // Background-job health (#3334's blind spot): the room can answer every
  // request while its cron jobs wedge silently — job heartbeats live on the
  // public /api/health/jobs view precisely so an outside watcher can see
  // them. Failure and staleness are different alarms and stay distinct: a
  // failing job names itself and its public error code; a stale job means
  // the heartbeat itself stopped, which no in-room signal can report.
  const jobs = checkCall("jobs", async () => {
    const response = await fetchImpl(new URL("/api/health/jobs", origin), { method: "GET", headers, redirect: "manual", signal: signal() });
    const body = await readLimited(response);
    if (![200, 503].includes(response.status)) return fail("jobs", response.status, "http_status");
    let parsed;
    try { parsed = JSON.parse(body); } catch { return fail("jobs", response.status, response.status === 503 ? "http_status" : "invalid_json"); }
    // The real jobs route uses 503 for stale/failing heartbeats. Only its
    // known diagnostic envelope may refine that HTTP failure; unavailable
    // or unrelated upstream responses retain the generic, text-free fallback.
    if (response.status === 503 && (parsed?.schema !== "room.job-health/1"
      || !["stale", "failing"].includes(parsed.status) || !Array.isArray(parsed.jobs) || !parsed.jobs.length)) {
      return fail("jobs", 503, "http_status");
    }
    if (!parsed || !Array.isArray(parsed.jobs) || parsed.jobs.length === 0) return fail("jobs", 200, "jobs_missing");
    const active = parsed.jobs.filter(job => job && typeof job === "object" && job.enabled !== false && job.status !== "disabled");
    const nameOf = job => (typeof job.name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(job.name) ? job.name : "job");
    // #3894: a required job reporting disabled means the deployment lost
    // the configuration the safety work needs (the room-backup binding).
    // It is neither failing nor stale, so without this scan the probe
    // ignored it exactly like a work-gated idle disable.
    const requiredDisabled = parsed.jobs.filter(job => job && typeof job === "object" && job.status === "disabled" && job.required === true);
    if (requiredDisabled.length) {
      return fail("jobs", response.status, "job_required_disabled", requiredDisabled.slice(0, 3).map(nameOf).join(", "));
    }
    const failing = active.filter(job => job.status === "failing" || Number(job.consecutiveFailures) > 0);
    if (failing.length) {
      const detail = failing.slice(0, 3).map(job => {
        const code = typeof job.lastErrorCode === "string" && /^[a-z0-9_]{1,64}$/i.test(job.lastErrorCode) ? job.lastErrorCode : "unclassified";
        return `${nameOf(job)} (${code})`;
      }).join(", ");
      return fail("jobs", response.status, "job_failing", detail);
    }
    const now = Date.now();
    const stale = active.filter(job => {
      if (job.stale === true || job.status === "stale") return true;
      // Views without a stale flag: an enabled job whose last run is more
      // than 2.5 periods old has missed whole ticks. A job that has never
      // run cannot be judged from one snapshot and is not called stale.
      const periodMs = Number(job.periodSeconds) * 1000;
      const lastRun = Date.parse(job.lastRunAt ?? job.lastSuccessAt ?? "");
      return Number.isFinite(periodMs) && periodMs > 0 && Number.isFinite(lastRun) && now - lastRun > periodMs * 2.5;
    });
    if (stale.length) return fail("jobs", response.status, "job_stale", stale.slice(0, 3).map(nameOf).join(", "));
    return response.status === 200 ? pass("jobs", 200) : fail("jobs", 503, "http_status");
  });
  const extra = Promise.resolve(ready).then(() => (afterReady ? afterReady() : []));
  const [readyResult, mcpResult, llmsResult, jobsResult, more] = await Promise.all([ready, mcp, llms, jobs, extra]);
  return [readyResult, mcpResult, llmsResult, jobsResult, ...(Array.isArray(more) ? more : [])];
}

function describe(check) {
  if (check.ok) return `${check.id} passed`;
  const base = check.status ? `${check.id} failed (HTTP ${check.status})` : `${check.id} failed (${check.reason})`;
  return check.detail ? `${base}: ${check.detail}` : base;
}

export function outageNotice(origin, checks, incidentId) {
  return [
    `External probe: ${origin} failed two probe runs in a row.`,
    `Incident ${incidentId}.`,
    `Latest checks: ${checks.map(describe).join("; ")}.`,
    "The 6-hour GitHub probes still run the deep checks."
  ].join(" ");
}

export function recoveryNotice(origin, incidentId, checks) {
  const sentence = `External probe: ${origin} is answering again. Incident ${incidentId}. ready, mcp, llms, and jobs passed.`;
  const extra = Array.isArray(checks)
    ? checks.filter(check => check.ok && !["ready", "mcp", "llms", "jobs"].includes(check.id)).map(check => check.id)
    : [];
  return extra.length ? `${sentence} ${extra.join(", ")} passed.` : sentence;
}

async function postJson(fetchImpl, url, body, headers, limitMs) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "user-agent": PROBE_USER_AGENT, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(limitMs)
  });
  await readLimited(response);
  return response.status >= 200 && response.status < 300;
}

export class ProbeStateError extends Error {
  constructor(code, options) {
    super(`external probe state failure: ${code}`, options);
    this.name = "ProbeStateError";
    this.code = code;
  }
}

async function loadState(kv) {
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") return { state: null, error: "state_unbound" };
  try {
    return { state: normalize(await kv.get(STATE_KEY, "json")), error: null };
  } catch {
    return { state: null, error: "state_unreadable" };
  }
}

function publicCheck(check) {
  const detail = typeof check?.detail === "string" && /^[A-Za-z0-9_:,() -]{1,120}$/.test(check.detail) ? check.detail : null;
  return {
    id: typeof check?.id === "string" && /^[a-z0-9-]{1,32}$/.test(check.id) ? check.id : "check",
    ok: check?.ok === true,
    status: Number.isInteger(check?.status) ? check.status : null,
    reason: typeof check?.reason === "string" && /^[a-z0-9_]{1,64}$/.test(check.reason) ? check.reason : null,
    detail,
    latencyMs: Number.isSafeInteger(check?.latencyMs) && check.latencyMs >= 0 && check.latencyMs <= 120_000 ? check.latencyMs : null
  };
}

function publicStatus(raw) {
  const checks = Array.isArray(raw?.checks) ? raw.checks.slice(0, 16).map(publicCheck) : [];
  return {
    schema: STATUS_SCHEMA,
    ok: raw?.ok === true,
    at: typeof raw?.at === "string" && raw.at.length <= 40 ? raw.at : null,
    origin: typeof raw?.origin === "string" && validProbeOrigin(raw.origin) ? new URL(raw.origin).origin : null,
    consecutiveFailures: Number.isSafeInteger(raw?.consecutiveFailures) && raw.consecutiveFailures >= 0 && raw.consecutiveFailures <= 100_000
      ? raw.consecutiveFailures : null,
    incidentId: typeof raw?.incidentId === "string" && /^[a-f0-9]{32}$/.test(raw.incidentId) ? raw.incidentId : null,
    checks
  };
}

function statusSnapshot(origin, checks, state, at) {
  return {
    schema: STATUS_SCHEMA,
    ok: checks.every(check => check.ok),
    at,
    origin,
    consecutiveFailures: state.consecutiveFailures,
    incidentId: state.incidentId,
    checks
  };
}

async function saveState(kv, state, extras = {}) {
  await kv.put(STATE_KEY, JSON.stringify(state));
  if (extras.synthetic) {
    await kv.put(SYNTHETIC_KEY, JSON.stringify({
      runs: extras.synthetic.runs,
      lastNonce: extras.synthetic.lastNonce
    }));
  }
  if (extras.last) await kv.put(LAST_KEY, JSON.stringify(publicStatus(extras.last)));
}

function payload(kind, origin, state, checks, at) {
  return {
    source: "project-room-external-probe",
    kind,
    incidentId: state.incidentId,
    origin,
    consecutiveFailures: state.consecutiveFailures,
    checks: checks.map(check => ({
      id: check.id,
      ok: check.ok,
      status: check.status,
      reason: check.reason,
      detail: check.detail ?? null,
      latencyMs: Number.isSafeInteger(check.latencyMs) ? check.latencyMs : null
    })),
    at
  };
}

function qaCredential(env) {
  const credential = text(env.PROBE_QA_TOKEN);
  if (!credential) return { token: null, inert: "unset" };
  if (credential.length < 8 || credential.length > 512) return { token: null, inert: "invalid" };
  return { token: credential, inert: null };
}

function nonceEveryRuns(env) {
  const raw = text(env.PROBE_NONCE_EVERY);
  if (!raw) return NONCE_EVERY_RUNS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 60 ? parsed : NONCE_EVERY_RUNS;
}

async function loadSynthetic(kv) {
  try {
    const raw = await kv.get(SYNTHETIC_KEY, "json");
    const runs = Number.isSafeInteger(raw?.runs) && raw.runs >= 0 && raw.runs <= 1_000_000 ? raw.runs : 0;
    const lastNonce = typeof raw?.lastNonce === "string" && /^[a-f0-9]{32}$/.test(raw.lastNonce) ? raw.lastNonce : null;
    return { runs, lastNonce };
  } catch {
    return { runs: 0, lastNonce: null };
  }
}

function authHeaders(token) {
  return {
    "user-agent": PROBE_USER_AGENT,
    accept: "application/json",
    authorization: `Bearer ${token}`
  };
}

function apiUrl(origin, path) {
  return new URL(edgeDoorApiPath(origin, path), origin);
}

async function openProbeRoom(origin, fetchImpl, limitMs, token) {
  const response = await fetchImpl(apiUrl(origin, "/api/agent-rooms"), {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      roomId: QA_ROOM_ID,
      title: "External probe",
      purpose: "Minute synthetic read of the public room.",
      starter: false
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(limitMs)
  });
  const body = await readLimited(response);
  if (response.status !== 200 && response.status !== 201) return fail("room-open", response.status, "http_status");
  let parsed;
  try { parsed = JSON.parse(body); } catch { return fail("room-open", response.status, "invalid_json"); }
  if (parsed?.roomId !== QA_ROOM_ID) return fail("room-open", response.status, "room_mismatch");
  return pass("room-open", response.status);
}

async function postNonce(origin, fetchImpl, limitMs, token, nonce) {
  const messageId = `probe-${nonce}`;
  const response = await fetchImpl(apiUrl(origin, `/api/rooms/${encodeURIComponent(QA_ROOM_ID)}/commands`), {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      id: messageId,
      type: "message.posted",
      data: { messageId, body: `probe-nonce ${nonce}` }
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(limitMs)
  });
  await readLimited(response);
  if (response.status !== 200 && response.status !== 201) return fail("room-post", response.status, "http_status");
  return pass("room-post", response.status);
}

async function readLatest(origin, fetchImpl, limitMs, token, nonce) {
  const url = apiUrl(origin, `/api/rooms/${encodeURIComponent(QA_ROOM_ID)}/conversation`);
  url.searchParams.set("limit", "1");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: authHeaders(token),
    redirect: "manual",
    signal: AbortSignal.timeout(limitMs)
  });
  const body = await readLimited(response);
  if (response.status !== 200) return fail("room-read", response.status, "http_status");
  let parsed;
  try { parsed = JSON.parse(body); } catch { return fail("room-read", 200, "invalid_json"); }
  if (!Array.isArray(parsed?.messages)) return fail("room-read", 200, "messages_missing");
  if (nonce) {
    const latest = parsed.messages.at(-1);
    if (latest?.body !== `probe-nonce ${nonce}`) return fail("room-read", 200, "nonce_missing");
  }
  return pass("room-read", 200);
}

async function runUserPath(origin, fetchImpl, limitMs, token, synthetic, nonceEvery) {
  const steps = [];
  const open = await checkCall("room-open", () => openProbeRoom(origin, fetchImpl, limitMs, token));
  steps.push(open);
  const runs = Math.min(synthetic.runs + 1, 1_000_000);
  let lastNonce = synthetic.lastNonce;
  if (open.ok && runs % nonceEvery === 0) {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const posted = await checkCall("room-post", () => postNonce(origin, fetchImpl, limitMs, token, nonce));
    steps.push(posted);
    if (posted.ok) lastNonce = nonce;
  }
  steps.push(await checkCall("room-read", () => readLatest(origin, fetchImpl, limitMs, token, lastNonce)));
  return { steps, synthetic: { runs, lastNonce } };
}

export async function runExternalProbe(env = {}, fetchImpl = globalThis.fetch) {
  const origin = probeOrigin(env);
  const limitMs = timeoutMs(env);
  if (!origin) return { ok: false, error: "invalid_origin", checks: [], alerts: [], consecutiveFailures: null };
  const loaded = await loadState(env.PROBE_STATE);
  if (loaded.error) throw new ProbeStateError(loaded.error);
  const qa = qaCredential(env);
  let syntheticState = null;
  const checks = await runChecks(origin, fetchImpl, limitMs, async () => {
    if (qa.inert === "invalid") return [{ ...fail("room-open", null, "token_invalid"), latencyMs: 0 }];
    if (!qa.token) return [];
    const prior = await loadSynthetic(env.PROBE_STATE);
    const user = await runUserPath(origin, fetchImpl, limitMs, qa.token, prior, nonceEveryRuns(env));
    syntheticState = user.synthetic;
    return user.steps;
  });
  const failed = checks.some(check => !check.ok);
  const at = new Date().toISOString();
  const previous = loaded.state;
  let state = failed
    ? {
      ...previous,
      consecutiveFailures: Math.min(previous.consecutiveFailures + 1, 100_000),
      incidentId: previous.incidentId ?? newIncidentId(),
      lastAt: at
    }
    : {
      consecutiveFailures: 0,
      incidentId: previous.alertedWebhook || previous.alertedRoom ? previous.incidentId : null,
      alertedWebhook: previous.alertedWebhook,
      alertedRoom: previous.alertedRoom,
      lastAt: at
    };
  const persisted = () => ({ synthetic: syntheticState, last: statusSnapshot(origin, checks, state, at) });
  try {
    await saveState(env.PROBE_STATE, state, persisted());
  } catch (error) {
    throw new ProbeStateError("state_unwritable", { cause: error });
  }
  const webhook = webhookDestination(env);
  const room = roomDestination(env);
  const alerts = [];
  const page = failed && state.consecutiveFailures >= FAILURES_BEFORE_ALERT;
  const recover = !failed && (state.alertedWebhook || state.alertedRoom);
  if (!page && !recover) {
    return { ok: !failed, error: null, checks, alerts, consecutiveFailures: state.consecutiveFailures };
  }
  const kind = page ? "outage" : "recovery";
  const notice = page ? outageNotice(origin, checks, state.incidentId) : recoveryNotice(origin, state.incidentId, checks);
  const body = payload(kind, origin, state, checks, at);
  const jobs = [];
  if (page ? !state.alertedWebhook : state.alertedWebhook) {
    if (webhook.url) {
      jobs.push(postJson(fetchImpl, webhook.url, body, {}, limitMs).then(ok => {
        if (ok) state = { ...state, alertedWebhook: page };
        alerts.push({ destination: "webhook", kind, ok, inert: null });
      }, () => {
        alerts.push({ destination: "webhook", kind, ok: false, inert: null });
      }));
    } else {
      alerts.push({ destination: "webhook", kind, ok: false, inert: webhook.inert });
    }
  }
  if (page ? !state.alertedRoom : state.alertedRoom) {
    if (room.room) {
      const commandId = `probe-${state.incidentId}-${kind}`;
      const command = { id: commandId, type: "message.posted", data: { messageId: commandId, body: notice } };
      jobs.push(postJson(fetchImpl, new URL(edgeDoorApiPath(room.room.origin, `/api/rooms/${encodeURIComponent(room.room.roomId)}/commands`), room.room.origin), command, {
        authorization: `Bearer ${room.room.credential}`
      }, limitMs).then(ok => {
        if (ok) state = { ...state, alertedRoom: page };
        alerts.push({ destination: "room", kind, ok, inert: null });
      }, () => {
        alerts.push({ destination: "room", kind, ok: false, inert: null });
      }));
    } else {
      alerts.push({ destination: "room", kind, ok: false, inert: room.inert });
    }
  }
  await Promise.all(jobs);
  if (recover && !state.alertedWebhook && !state.alertedRoom) state = { ...state, incidentId: null };
  try {
    await saveState(env.PROBE_STATE, state, persisted());
  } catch (error) {
    throw new ProbeStateError("state_unwritable", { cause: error });
  }
  return { ok: !failed, error: null, checks, alerts, consecutiveFailures: state.consecutiveFailures };
}

const STATUS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function redactStatus(json, env) {
  let out = json;
  for (const secret of [env?.PROBE_QA_TOKEN, env?.PROBE_ROOM_TOKEN, env?.ROOM_AGENT_TOKEN, env?.PROBE_ALERT_WEBHOOK_URL]) {
    const value = text(secret);
    if (value.length >= 8) out = out.split(value).join("[redacted]");
  }
  return out;
}

export async function probeStatusResponse(request, env = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ schema: STATUS_SCHEMA, error: "method_not_allowed" }), {
      status: 405,
      headers: { ...STATUS_HEADERS, allow: "GET, HEAD" }
    });
  }
  const kv = env?.PROBE_STATE;
  if (!kv || typeof kv.get !== "function") {
    return new Response(redactStatus(JSON.stringify({
      schema: STATUS_SCHEMA, ok: null, error: "state_unbound", checks: [], at: null
    }), env), { status: 503, headers: STATUS_HEADERS });
  }
  let raw;
  try {
    raw = await kv.get(LAST_KEY, "json");
  } catch {
    return new Response(redactStatus(JSON.stringify({
      schema: STATUS_SCHEMA, ok: null, error: "state_unreadable", checks: [], at: null
    }), env), { status: 503, headers: STATUS_HEADERS });
  }
  const body = raw
    ? publicStatus(raw)
    : { schema: STATUS_SCHEMA, ok: null, error: "no_result", checks: [], at: null, consecutiveFailures: null };
  return new Response(redactStatus(JSON.stringify(body), env), { status: 200, headers: STATUS_HEADERS });
}
