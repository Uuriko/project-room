// External liveness for the public room. A separate Worker runs this every
// 5 minutes so an outage is noticed without waiting for the 6-hour GitHub
// probes. One failed run records a streak and stays quiet. The second failed
// run in a row notifies once. A later pass sends one recovery notice.
//
// Destinations are inert until their secrets exist:
//   PROBE_ALERT_WEBHOOK_URL — HTTPS webhook (a Cloudflare notification URL
//     is one option). http is accepted only for 127.0.0.1 and localhost.
//   PROBE_ROOM_ORIGIN, PROBE_ROOM_ID, PROBE_ROOM_TOKEN — ops-room post.
//     ROOM_AGENT_ORIGIN, ROOM_AGENT_ROOM, and ROOM_AGENT_TOKEN are the
//     existing connection names and are used when the PROBE_ROOM_* name is
//     unset. The token and the webhook URL are never written into the notice.

export const FAILURES_BEFORE_ALERT = 2;
export const DEFAULT_ORIGIN = "https://room.trydemigod.com";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const STATE_KEY = "streak";
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
  const token = text(env.PROBE_ROOM_TOKEN) || text(env.ROOM_AGENT_TOKEN);
  if (!origin && !roomId && !token) return { room: null, inert: "unset" };
  if (!validProbeOrigin(origin) || !validRoomId(roomId) || token.length < 8 || token.length > 512) {
    return { room: null, inert: "invalid" };
  }
  return { room: { origin: new URL(origin).origin, roomId, token }, inert: null };
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
  return { id, ok: true, status, reason: null };
}

function fail(id, status, reason) {
  return { id, ok: false, status: Number.isInteger(status) ? status : null, reason };
}

async function checkCall(id, run) {
  try {
    return await run();
  } catch (error) {
    const reason = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network";
    return fail(id, null, reason);
  }
}

async function runChecks(origin, fetchImpl, limitMs) {
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
  const checks = await Promise.all([ready, mcp, llms]);
  return checks;
}

function describe(check) {
  if (check.ok) return `${check.id} passed`;
  if (check.status) return `${check.id} failed (HTTP ${check.status})`;
  return `${check.id} failed (${check.reason})`;
}

export function outageNotice(origin, checks, incidentId) {
  return [
    `External probe: ${origin} failed two probe runs in a row.`,
    `Incident ${incidentId}.`,
    `Latest checks: ${checks.map(describe).join("; ")}.`,
    "The 6-hour GitHub probes still run the deep checks."
  ].join(" ");
}

export function recoveryNotice(origin, incidentId) {
  return `External probe: ${origin} is answering again. Incident ${incidentId}. ready, mcp, and llms passed.`;
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

async function loadState(kv) {
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") return { state: null, error: "state_unbound" };
  try {
    return { state: normalize(await kv.get(STATE_KEY, "json")), error: null };
  } catch {
    return { state: null, error: "state_unreadable" };
  }
}

async function saveState(kv, state) {
  await kv.put(STATE_KEY, JSON.stringify(state));
}

function payload(kind, origin, state, checks, at) {
  return {
    source: "project-room-external-probe",
    kind,
    incidentId: state.incidentId,
    origin,
    consecutiveFailures: state.consecutiveFailures,
    checks: checks.map(check => ({ id: check.id, ok: check.ok, status: check.status, reason: check.reason })),
    at
  };
}

export async function runExternalProbe(env = {}, fetchImpl = globalThis.fetch) {
  const origin = probeOrigin(env);
  const limitMs = timeoutMs(env);
  if (!origin) return { ok: false, error: "invalid_origin", checks: [], alerts: [], consecutiveFailures: null };
  const loaded = await loadState(env.PROBE_STATE);
  const checks = await runChecks(origin, fetchImpl, limitMs);
  const failed = checks.some(check => !check.ok);
  if (loaded.error) {
    return { ok: !failed, error: loaded.error, checks, alerts: [], consecutiveFailures: null };
  }
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
  try {
    await saveState(env.PROBE_STATE, state);
  } catch {
    return { ok: !failed, error: "state_unwritable", checks, alerts: [], consecutiveFailures: state.consecutiveFailures };
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
  const notice = page ? outageNotice(origin, checks, state.incidentId) : recoveryNotice(origin, state.incidentId);
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
      jobs.push(postJson(fetchImpl, new URL(`/api/rooms/${encodeURIComponent(room.room.roomId)}/commands`, room.room.origin), command, {
        authorization: `Bearer ${room.room.token}`
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
    await saveState(env.PROBE_STATE, state);
  } catch {
    return { ok: !failed, error: "state_unwritable", checks, alerts, consecutiveFailures: state.consecutiveFailures };
  }
  return { ok: !failed, error: null, checks, alerts, consecutiveFailures: state.consecutiveFailures };
}
