/**
 * bridge/lib/bridge.mjs — herdr-bridge HTTP service (host side).
 *
 * Translates the domain API to herdr's Unix-socket JSON protocol:
 *   POST /v1/{ping,snapshot,spawn,read,send,keys,wait,report,close,list}
 *   GET  /v1/events   (SSE)
 *   GET  /healthz      (unauthenticated)
 *
 * Enforcement summary (see D3 bridge-transport.md + D1 threat-model-terminal.md):
 *  - Auth: bearer-per-tenant, HMAC-derived from the per-host master secret.
 *    Tenant is resolved FROM the verified token, never from caller fields.
 *  - Fencing: socket method allowlist/blocklist (deny-by-default); spawn argv
 *    built from allowlisted kinds (no caller argv/env); tenant-scoped reads
 *    via the ownership registry + live probe; occupant-pinned send/keys/wait;
 *    self-report binding (HERDR_PANE_ID == target).
 *  - readPane: ANSI sanitizer + secret-shaped redaction at the boundary;
 *    bodies never reach the audit log (bytes/lines/sha256 only).
 *  - Idempotency: writes require an idempotencyKey (uuid v4); 15-min dedupe.
 *  - Timeouts per method (5–30s); retries: idempotent reads 3x, writes only
 *    on no-response with the same key (2x); backoff with full jitter;
 *    per-tenant circuit breaker (5 failures → open 60s → ping probe).
 *  - Audit: JSONL per call, redacted, denies included; 30-day retention.
 */
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { BridgeError, bridgeError } from './errors.mjs';
import { deriveToken, resolveTenant, validateTenantId } from './auth.mjs';
import { sanitizePaneText } from './sanitize.mjs';
import { redactSecretShaped } from './redact.mjs';
import {
  PINNED_PROTOCOL,
  assertSocketMethodAllowed,
  buildSpawnArgv,
  validateReportBinding,
  validateResumeArgv,
} from './fence.mjs';
import { HerdrSocketClient } from './socket-client.mjs';
import { IdempotencyCache } from './idempotency.mjs';
import { CircuitBreaker } from './circuit.mjs';
import { AuditLog } from './audit.mjs';
import { loadTenants, checkSocketDir } from './tenants.mjs';

export const BRIDGE_VERSION = '0.1.0';

const DEFAULT_TIMEOUTS = {
  ping: 5_000,
  snapshot: 15_000,
  spawn: 30_000,
  read: 15_000,
  send: 15_000,
  keys: 15_000,
  wait: 120_000, // hard cap per HTTP round-trip; caller timeoutMs is min()'d in
  report: 10_000,
  close: 15_000,
  list: 15_000,
  occupantVerify: 5_000,
};

/** Socket errors that must never be retried. */
const NEVER_RETRY = new Set([
  'auth_denied', 'method_blocked', 'method_unsupported', 'occupant_changed',
  'binding_mismatch', 'input', 'idempotency_conflict', 'pane_not_found',
  'handle_not_found',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_SOURCES = new Set(['visible', 'recent', 'recent-unwrapped']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Exponential backoff with full jitter (D3 §3.2). */
function backoffDelay(attempt) {
  return Math.random() * Math.min(2 ** attempt * 250, 4_000);
}

function stableHash(obj) {
  const sorted = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha256').update(sorted).digest('hex');
}

export function createBridge(opts = {}) {
  const cfg = {
    port: opts.port ?? 8443,
    bind: opts.bind ?? '127.0.0.1',
    masterSecret: opts.masterSecret ?? process.env.BRIDGE_MASTER_SECRET,
    masterSecretPrev: opts.masterSecretPrev ?? process.env.BRIDGE_MASTER_SECRET_PREV,
    keyId: opts.keyId ?? process.env.BRIDGE_KEY_ID ?? 'gen1',
    keyIdPrev: opts.keyIdPrev ?? process.env.BRIDGE_KEY_ID_PREV,
    tenantsFile: opts.tenantsFile ?? process.env.BRIDGE_TENANTS_FILE ?? '/etc/herdr-bridge/tenants.json',
    auditLog: opts.auditLog ?? process.env.BRIDGE_AUDIT_LOG ?? '/var/log/herdr-bridge/audit.jsonl',
    sseHeartbeatMs: opts.sseHeartbeatMs ?? 25_000,
    timeouts: { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) },
    circuitOpenMs: opts.circuitOpenMs ?? 60_000,
    allowSystemctl: opts.allowSystemctl ?? false,
    idempotencyTtlMs: opts.idempotencyTtlMs ?? 15 * 60 * 1000,
  };

  const socket = new HerdrSocketClient();
  const idempotency = new IdempotencyCache(cfg.idempotencyTtlMs);
  const breaker = new CircuitBreaker({ failureThreshold: 5, openMs: cfg.circuitOpenMs });
  const audit = new AuditLog(cfg.auditLog);

  /** tenantId -> tenant record */
  let tenants = new Map();
  /** tenantId -> Set(paneId) — ownership registry (defense in depth behind per-tenant servers) */
  const paneRegistry = new Map();
  /** handle -> { tenantId, paneId, occupant, issuedAt } — occupant-pinned handles */
  const handles = new Map();
  /** tenantId -> true once supervision-checked */
  const supervised = new Set();

  function regPanes(tenantId, paneIds) {
    let set = paneRegistry.get(tenantId);
    if (!set) { set = new Set(); paneRegistry.set(tenantId, set); }
    for (const p of paneIds) if (p) set.add(p);
  }

  function issueHandle(tenantId, paneId, occupant) {
    const handle = randomBytes(24).toString('base64url');
    handles.set(handle, { tenantId, paneId, occupant, issuedAt: Date.now() });
    return handle;
  }

  function dropHandlesForPane(tenantId, paneId) {
    for (const [h, rec] of handles) {
      if (rec.tenantId === tenantId && rec.paneId === paneId) handles.delete(h);
    }
  }

  function resolveHandle(tenantId, handle) {
    const rec = handles.get(handle);
    if (!rec || rec.tenantId !== tenantId) throw bridgeError('handle_not_found');
    return rec;
  }

  // ------------------------------------------------------------------
  // Tenant supervision glue (systemd template units; bridge never execs
  // server binaries with caller-influenced argv).
  // ------------------------------------------------------------------
  async function ensureTenant(tenantId) {
    const tenant = tenants.get(tenantId);
    if (!tenant) throw bridgeError('tenant_unavailable', 'no herdr server configured for tenant');
    if (!supervised.has(tenantId)) {
      supervised.add(tenantId);
      for (const w of await checkSocketDir(tenant)) {
        console.error(`[herdr-bridge] socket-dir drift for ${tenantId}: ${w}`);
      }
    }
    // Liveness is established by real calls + the circuit breaker, not a
    // per-call ping (which would double socket traffic and distort retry
    // budgets). The systemctl bounce below happens on transport failure.
    return tenant;
  }

  function systemctl(action, tenantId) {
    validateTenantId(tenantId); // argv is constructed, never shell-interpolated
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/systemctl', [action, `herdr@${tenantId}`], { stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('systemctl timed out')); }, 15_000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`systemctl ${action} exited ${code}`));
      });
    });
  }

  // ------------------------------------------------------------------
  // Core invoke: fence → breaker → retry → audit
  // ------------------------------------------------------------------
  async function invoke(tenantId, route, socketMethod, params, { timeoutMs, write, idempotent, target, auditExtra } = {}) {
    const t0 = Date.now();
    const log = (entry) => audit.write({
      tenant: tenantId, route, socketMethod, target: target ?? null,
      params, latencyMs: Date.now() - t0, ...(auditExtra ?? {}), ...entry,
    });

    assertSocketMethodAllowed(socketMethod);

    const gate = breaker.canCall(tenantId);
    if (gate === 'open') {
      await log({ result: 'deny', denyReason: 'bridge_circuit_open', status: 503 });
      const denied = bridgeError('bridge_circuit_open');
      denied._audited = true; // handlePost must not log this twice
      throw denied;
    }
    const isProbe = gate === 'probe';

    const tenant = await ensureTenant(tenantId);
    const maxAttempts = write ? 2 : 3;
    let attempt = 0;
    // The breaker counts LOGICAL calls, not retry attempts: one invoke that
    // burns its whole retry budget is a single failure signal.
    let sawTransportFailure = false;
    for (;;) {
      attempt += 1;
      try {
        const result = await socket.callOnce(tenant.socketPath, socketMethod, params, timeoutMs);
        breaker.recordSuccess(tenantId);
        return { result, log };
      } catch (err) {
        const transportFailure = err.code === 'timeout' || err.code === 'transport_error';
        if (transportFailure) {
          sawTransportFailure = true;
          // Supervision glue: one systemctl bounce per incident, then the
          // retry budget decides. Never with caller-influenced argv.
          if (cfg.allowSystemctl && !tenant._bounced) {
            tenant._bounced = true;
            await systemctl('start', tenantId).catch(() => {});
          }
        }
        const noResponse = err.gotResponse === false;
        const mayRetry = attempt < maxAttempts
          && !NEVER_RETRY.has(err.code)
          && (idempotent || (write && noResponse));
        if (!mayRetry || isProbe) {
          if (sawTransportFailure) breaker.recordFailure(tenantId);
          if (transportFailure || err.code === 'timeout') {
            err._audited = true; // handlePost must not log this twice
            await log({ result: 'error', denyReason: err.code, status: err.httpStatus ?? 502 });
          }
          throw err;
        }
        await sleep(backoffDelay(attempt));
      }
    }
  }

  // ------------------------------------------------------------------
  // Route param builders (all fencing lives here)
  // ------------------------------------------------------------------
  function resolvePane(tenantId, body) {
    if (body.handle) return resolveHandle(tenantId, body.handle).paneId;
    if (typeof body.paneId === 'string' && body.paneId) return body.paneId;
    throw bridgeError('input', 'read/close/send/wait need a handle or paneId');
  }

  async function checkPaneOwnership(tenantId, paneId) {
    if (paneRegistry.get(tenantId)?.has(paneId)) return;
    // Live probe against the tenant's OWN server: per-tenant servers make
    // ownership implicit — a pane the tenant's server doesn't know is not
    // the tenant's. (Caller-supplied IDs are untrusted, risk-review §3.3.)
    try {
      await socket.callOnce(tenants.get(tenantId).socketPath, 'pane.get', { paneId }, cfg.timeouts.occupantVerify);
      regPanes(tenantId, [paneId]);
    } catch (err) {
      if (err.code === 'pane_not_found') throw bridgeError('pane_not_found');
      throw err;
    }
  }

  async function verifyOccupant(tenantId, rec) {
    const info = await socket.callOnce(
      tenants.get(tenantId).socketPath, 'pane.process_info', { paneId: rec.paneId }, cfg.timeouts.occupantVerify);
    if (info?.occupant !== rec.occupant) {
      dropHandlesForPane(tenantId, rec.paneId);
      throw bridgeError('occupant_changed');
    }
  }

  // ------------------------------------------------------------------
  // HTTP plumbing
  // ------------------------------------------------------------------
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  function sendErr(res, err) {
    const status = err instanceof BridgeError ? err.httpStatus : 500;
    const code = err instanceof BridgeError ? err.code : 'internal';
    sendJson(res, status, { error: { code, message: err instanceof BridgeError ? err.message : 'internal error' } });
  }

  function readBody(req, limit = 1_048_576) {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const chunks = [];
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes > limit) { reject(bridgeError('input', 'request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        try { resolve(JSON.parse(text)); } catch { reject(bridgeError('input', 'malformed JSON body')); }
      });
      req.on('error', reject);
    });
  }

  function authenticate(req) {
    const authz = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(authz);
    const keyIdHeader = req.headers['x-bridge-key-id'];
    return resolveTenant({
      tenantIds: [...tenants.keys()],
      masterSecret: cfg.masterSecret,
      masterSecretPrev: cfg.masterSecretPrev,
      keyId: cfg.keyId,
      keyIdPrev: cfg.keyIdPrev,
      presentedKeyId: Array.isArray(keyIdHeader) ? keyIdHeader[0] : keyIdHeader,
      token: m?.[1],
    });
  }

  async function handleRoute(tenantId, route, body) {
    const tenant = tenants.get(tenantId);
    const timeouts = cfg.timeouts;
    switch (route) {
      case 'ping': {
        const { result } = await invoke(tenantId, route, 'ping', {}, { timeoutMs: timeouts.ping, idempotent: true });
        return {
          ok: true, protocol: result.protocol ?? result?.protocolVersion ?? PINNED_PROTOCOL,
          herdrVersion: result.herdrVersion,
          methods: ['ping', 'snapshot', 'spawn', 'read', 'send', 'keys', 'wait', 'report', 'close', 'list', 'events'],
          pinnedProtocol: PINNED_PROTOCOL,
        };
      }
      case 'snapshot': {
        const { result } = await invoke(tenantId, route, 'session.snapshot', {}, { timeoutMs: timeouts.snapshot, idempotent: true });
        const panes = (result.panes ?? []).map((p) => {
          regPanes(tenantId, [p.paneId]);
          return { paneId: p.paneId, handle: issueHandle(tenantId, p.paneId, p.occupant) };
        });
        return { panes };
      }
      case 'list': {
        if (body.agentId !== undefined) {
          const { result } = await invoke(tenantId, route, 'agent.get', { agentId: String(body.agentId) }, { timeoutMs: timeouts.list, idempotent: true, target: String(body.agentId) });
          regPanes(tenantId, [result.paneId]);
          return { agent: { agentId: result.agentId, paneId: result.paneId, handle: issueHandle(tenantId, result.paneId, result.occupant) } };
        }
        const { result } = await invoke(tenantId, route, 'agent.list', {}, { timeoutMs: timeouts.list, idempotent: true });
        const agents = (result.agents ?? []).map((a) => {
          regPanes(tenantId, [a.paneId]);
          return { agentId: a.agentId, paneId: a.paneId, handle: issueHandle(tenantId, a.paneId, a.occupant) };
        });
        return { agents };
      }
      case 'spawn': {
        const built = buildSpawnArgv({
          kind: body.kind,
          resumeSessionId: body.resumeSessionId,
          workspaceRoot: body.workspaceRoot ?? tenant.workspaceRoot,
          allowedRoots: [tenant.workspaceRoot].filter(Boolean),
          tenantId,
          tmpDir: tenant.tmpDir ?? undefined,
        });
        const { result } = await invoke(tenantId, route, 'agent.start', {
          argv: built.argv, env: built.env, ...(built.cwd ? { cwd: built.cwd } : {}),
        }, { timeoutMs: timeouts.spawn, write: true, idempotent: false, target: null });
        regPanes(tenantId, [result.paneId]);
        return {
          paneId: result.paneId, agentId: result.agentId,
          handle: issueHandle(tenantId, result.paneId, result.occupant),
        };
      }
      case 'read': {
        const paneId = resolvePane(tenantId, body);
        await checkPaneOwnership(tenantId, paneId);
        const source = body.source ?? 'recent';
        if (!READ_SOURCES.has(source)) throw bridgeError('input', `bad read source: ${source}`);
        const t0 = Date.now();
        const { result, log } = await invoke(tenantId, route, 'pane.read', { paneId, source }, { timeoutMs: timeouts.read, idempotent: true, target: paneId });
        const sanitized = sanitizePaneText(String(result.text ?? ''));
        const text = redactSecretShaped(sanitized);
        const bytes = Buffer.byteLength(text, 'utf8');
        await log({
          result: { bytes, lines: text.split('\n').length, sha256: createHash('sha256').update(text).digest('hex') },
          status: 200, latencyMs: Date.now() - t0, extra: { source },
        });
        return { paneId, text };
      }
      case 'send': {
        const rec = resolveHandle(tenantId, body.handle);
        if (typeof body.text !== 'string') throw bridgeError('input', 'send needs a text string');
        await verifyOccupant(tenantId, rec);
        await invoke(tenantId, route, 'agent.prompt', { paneId: rec.paneId, text: body.text }, { timeoutMs: timeouts.send, write: true, idempotent: false, target: rec.paneId });
        return { ok: true };
      }
      case 'keys': {
        const rec = resolveHandle(tenantId, body.handle);
        if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 64 ||
            !body.keys.every((k) => typeof k === 'string' && k.length <= 64)) {
          throw bridgeError('input', 'keys must be a non-empty array of <=64 short strings');
        }
        await verifyOccupant(tenantId, rec);
        await invoke(tenantId, route, 'agent.send_keys', { paneId: rec.paneId, keys: body.keys }, { timeoutMs: timeouts.keys, write: true, idempotent: false, target: rec.paneId, auditExtra: { auditedPerCall: true } });
        return { ok: true };
      }
      case 'wait': {
        const rec = resolveHandle(tenantId, body.handle);
        await verifyOccupant(tenantId, rec);
        const kind = body.kind ?? 'state';
        const timeoutMs = Math.min(Number(body.timeoutMs) || 30_000, timeouts.wait);
        if (kind === 'state') {
          const { result } = await invoke(tenantId, route, 'agent.wait', { paneId: rec.paneId, timeoutMs }, { timeoutMs: timeoutMs + 5_000, write: true, idempotent: false, target: rec.paneId });
          return { state: result.state ?? result };
        }
        if (kind === 'output') {
          if (body.pattern !== undefined && (typeof body.pattern !== 'string' || body.pattern.length > 512)) {
            throw bridgeError('input', 'wait pattern must be a string <=512 chars');
          }
          // wait_for_output is a targeted secret-harvesting primitive
          // (risk-review §1.5) — audited per call.
          const { result } = await invoke(tenantId, route, 'pane.wait_for_output', { paneId: rec.paneId, pattern: body.pattern, timeoutMs }, { timeoutMs: timeoutMs + 5_000, write: true, idempotent: false, target: rec.paneId, auditExtra: { auditedPerCall: true, pattern: body.pattern } });
          return { matched: result.matched ?? result };
        }
        throw bridgeError('input', `bad wait kind: ${kind}`);
      }
      case 'report': {
        const kind = body.kind ?? 'state';
        const method = kind === 'state' ? 'pane.report_agent'
          : kind === 'resume' ? 'pane.report_agent_session'
          : kind === 'metadata' ? 'pane.report_metadata'
          : null;
        if (!method) throw bridgeError('input', `bad report kind: ${kind}`);
        validateReportBinding({ herdrPaneId: body.herdrPaneId, targetPaneId: body.targetPaneId });
        await checkPaneOwnership(tenantId, body.targetPaneId);
        const params = { paneId: body.targetPaneId };
        if (kind === 'state' && body.state !== undefined) params.state = String(body.state).slice(0, 64);
        if (kind === 'metadata' && body.metadata !== undefined) params.metadata = body.metadata;
        if (kind === 'resume') {
          if (body.resumeSessionId !== undefined) {
            // Rebuild from the template — never forward caller argv.
            const built = buildSpawnArgv({
              kind: body.kind2 ?? body.agentKind, resumeSessionId: body.resumeSessionId,
              workspaceRoot: tenant.workspaceRoot, allowedRoots: [tenant.workspaceRoot].filter(Boolean),
              tenantId, tmpDir: tenant.tmpDir ?? undefined,
            });
            params.argv = built.argv;
          } else if (body.resumeArgv !== undefined) {
            validateResumeArgv(body.resumeArgv); // must match a kind template
            params.argv = body.resumeArgv.map(String);
          }
        }
        await invoke(tenantId, route, method, params, { timeoutMs: timeouts.report, write: true, idempotent: false, target: body.targetPaneId });
        return { ok: true };
      }
      case 'close': {
        const paneId = resolvePane(tenantId, body);
        await checkPaneOwnership(tenantId, paneId);
        await invoke(tenantId, route, 'pane.close', { paneId }, { timeoutMs: timeouts.close, write: true, idempotent: false, target: paneId });
        dropHandlesForPane(tenantId, paneId);
        paneRegistry.get(tenantId)?.delete(paneId);
        return { ok: true };
      }
      default:
        throw bridgeError('input', `unknown route: ${route}`);
    }
  }

  async function handlePost(req, res, route) {
    const t0 = Date.now();
    let tenantId = null;
    try {
      if (!cfg.masterSecret) throw bridgeError('server_misconfigured');
      tenantId = authenticate(req);
      const body = await readBody(req);
      const writeRoutes = new Set(['spawn', 'send', 'keys', 'wait', 'report', 'close']);
      if (writeRoutes.has(route)) {
        const key = body.idempotencyKey;
        if (typeof key !== 'string' || !UUID_RE.test(key)) {
          throw bridgeError('input', 'writes require an idempotencyKey (uuid v4)');
        }
        const cacheKey = `${tenantId}:${route}:${key}`;
        const inputHash = stableHash({ ...body, idempotencyKey: undefined });
        const seen = idempotency.check(cacheKey, inputHash);
        if (seen.hit) {
          await audit.write({
            tenant: tenantId, route, target: null, params: body,
            result: 'deduplicated', status: 200, latencyMs: Date.now() - t0,
            extra: { deduplicated: true },
          });
          sendJson(res, 200, seen.response);
          return;
        }
        if (seen.conflict) throw bridgeError('idempotency_conflict', 'idempotency key reused with different input');
        const response = await handleRoute(tenantId, route, body);
        idempotency.store(cacheKey, inputHash, response);
        await audit.write({
          tenant: tenantId, route, target: null, params: body,
          result: 'ok', status: 200, latencyMs: Date.now() - t0,
        });
        sendJson(res, 200, response);
        return;
      }
      // reads (and ping): audited inside invoke, except ping/snapshot/list
      // which log here for a uniform trail.
      const response = await handleRoute(tenantId, route, body);
      if (route !== 'read') {
        await audit.write({
          tenant: tenantId, route, target: null, params: body,
          result: 'ok', status: 200, latencyMs: Date.now() - t0,
        });
      }
      sendJson(res, 200, response);
    } catch (err) {
      const status = err instanceof BridgeError ? err.httpStatus : 500;
      const code = err instanceof BridgeError ? err.code : 'internal';
      if (!err._audited) {
        // invoke() already audited transport failures and circuit-open denies.
        await audit.write({
          tenant: tenantId, route, target: null, params: {},
          result: status < 500 ? 'deny' : 'error',
          denyReason: code, status, latencyMs: Date.now() - t0,
        });
      }
      sendErr(res, err);
    }
  }

  async function handleEvents(req, res) {
    let tenantId = null;
    try {
      if (!cfg.masterSecret) throw bridgeError('server_misconfigured');
      tenantId = authenticate(req);
      const url = new URL(req.url, 'http://localhost');
      const since = url.searchParams.get('since') ?? undefined;
      const tenant = await ensureTenant(tenantId);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* closed */ }
      }, cfg.sseHeartbeatMs);
      let closed = false;
      const sub = await socket.subscribe(
        tenant.socketPath,
        { filter: { tenant: tenantId }, ...(since !== undefined ? { since } : {}) },
        (event) => {
          // Tenant scoping is structural (per-tenant server), but belt-and-
          // braces: drop frames naming another tenant.
          if (event && typeof event === 'object' && event.tenant && event.tenant !== tenantId) return;
          try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
        },
        () => { if (!closed) { closed = true; clearInterval(heartbeat); try { res.end(); } catch {} } },
      );
      await audit.write({ tenant: tenantId, route: 'events', socketMethod: 'events.subscribe', result: 'ok', status: 200, latencyMs: 0 });
      req.on('close', () => { closed = true; clearInterval(heartbeat); sub.close(); });
    } catch (err) {
      const status = err instanceof BridgeError ? err.httpStatus : 500;
      const code = err instanceof BridgeError ? err.code : 'internal';
      await audit.write({
        tenant: tenantId, route: 'events', result: status < 500 ? 'deny' : 'error',
        denyReason: code, status, latencyMs: 0,
      });
      if (!res.headersSent) sendErr(res, err);
      else try { res.end(); } catch {}
    }
  }

  function handleHealthz(req, res) {
    const missing = [];
    if (!cfg.masterSecret) missing.push('BRIDGE_MASTER_SECRET');
    if (!existsSync(cfg.tenantsFile)) missing.push('BRIDGE_TENANTS_FILE');
    if (tenants.size === 0) missing.push('tenants');
    sendJson(res, 200, {
      ok: missing.length === 0,
      service: 'herdr-bridge',
      version: BRIDGE_VERSION,
      pinnedProtocol: PINNED_PROTOCOL,
      missing,
    });
  }

  const server = createServer((req, res) => {
    (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') return handleHealthz(req, res);
      if (req.method === 'GET' && url.pathname === '/v1/events') return handleEvents(req, res);
      const m = /^\/v1\/(ping|snapshot|spawn|read|send|keys|wait|report|close|list)$/.exec(url.pathname);
      if (req.method === 'POST' && m) return handlePost(req, res, m[1]);
      sendErr(res, bridgeError('input', 'not found'));
    })().catch((err) => {
      try { sendErr(res, err); } catch { /* headers already sent */ }
    });
  });

  return {
    get port() { return server.address()?.port ?? cfg.port; },
    async start() {
      try {
        tenants = await loadTenants(cfg.tenantsFile);
      } catch (err) {
        console.error(`[herdr-bridge] tenants file unreadable: ${err.message}`);
        tenants = new Map();
      }
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(cfg.port, cfg.bind, resolve);
      });
      // Best-effort retention pruning on boot; logrotate does the steady state.
      audit.pruneOld(30).catch(() => {});
      return this;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
    /** Test/ops introspection (not exposed over HTTP). */
    _internals: { deriveToken, breaker, idempotency, get tenants() { return tenants; } },
  };
}
