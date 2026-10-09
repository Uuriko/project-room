/**
 * bridge/lib/fence.mjs — method allowlist/blocklist + spawn argv allowlist.
 *
 * Deny-by-default, fail closed. The bridge refuses never-expose methods for
 * room code; the fork (B1) strips them from the socket API as defense in depth
 * against bypassing pane processes (threat-model §4).
 */
import { resolve as resolvePath, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { bridgeError } from './errors.mjs';

/** Pinned herdr socket protocol version (REDESIGN.md §2.3). */
export const PINNED_PROTOCOL = 22;

/** Socket methods the bridge may issue on room code's behalf (risk-review §3.1). */
export const SOCKET_ALLOWLIST = new Set([
  'ping',
  'session.snapshot',
  'pane.list', 'pane.get', 'pane.current', 'pane.process_info', 'pane.read', 'pane.close',
  'agent.list', 'agent.get', 'agent.start', 'agent.prompt', 'agent.send_keys', 'agent.wait',
  'pane.wait_for_output',
  'pane.report_agent', 'pane.report_agent_session', 'pane.report_metadata',
  'events.subscribe', 'events.wait',
  'workspace.create', 'workspace.close', 'workspace.rename',
  'tab.create', 'tab.close', 'tab.rename', 'tab.focus',
  'layout.export',
]);

/** Never-expose: adapter refuses, fork strips (risk-review §3.2 / threat-model §5 S4–S11). */
const BLOCKED_PREFIXES = ['server.', 'plugin.', 'integration.', 'worktree.'];
const BLOCKED_EXACT = new Set([
  'layout.apply',          // applies cwd+env → environment injection
  'notification.show',     // toast spam / social-engineering text
  'pane.send_text', 'pane.send_keys', 'pane.send_input', // raw cross-pane send;
  // only the occupant-pinned agent.prompt / agent.send_keys path exists
  'agent.view.set', 'agent.view.clear', // sidebar projection spoofing
]);

export function assertSocketMethodAllowed(method) {
  if (typeof method !== 'string') throw bridgeError('method_unsupported', 'method must be a string');
  if (BLOCKED_EXACT.has(method) || BLOCKED_PREFIXES.some((p) => method.startsWith(p))) {
    throw bridgeError('method_blocked', `socket method never exposed: ${method}`);
  }
  if (!SOCKET_ALLOWLIST.has(method)) {
    throw bridgeError('method_unsupported', `unknown socket method: ${method}`);
  }
}

/**
 * Agent-kind → fixed argv template. The template is CODE, not config —
 * not overridable via env or any caller field. Caller supplies only `kind`,
 * an optional validated resumeSessionId, and a workspaceRoot clamped to an
 * allowlisted root. Env for the child is adapter-constructed (allowlisted
 * names only); no caller env passthrough. (threat-model §2.2)
 */
const RESUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const KIND_TEMPLATES = {
  claude: (resume) => (resume ? ['claude', '--resume', resume] : ['claude']),
  codex: (resume) => (resume ? ['codex', 'resume', resume] : ['codex']),
  opencode: (resume) => (resume ? ['opencode', 'run', '--session', resume] : ['opencode']),
};
export const AGENT_KINDS = Object.keys(KIND_TEMPLATES);

/** Env names the bridge sets on spawned agent processes. Fixed values only. */
const CHILD_ENV_ALLOWLIST = ['HERDR_BRIDGE', 'HERDR_TENANT', 'TMPDIR', 'PATH'];
const PINNED_PATH = '/usr/local/bin:/usr/bin:/bin';

function clampWorkspaceRoot(workspaceRoot, allowedRoots) {
  if (workspaceRoot == null) return null;
  // realpath both sides when they exist so a symlink inside the root cannot
  // point the cwd outside it; a path that does not exist yet keeps resolve().
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const resolved = real(resolvePath(String(workspaceRoot)));
  const ok = (allowedRoots ?? []).some((root) => {
    const r = real(resolvePath(String(root)));
    return resolved === r || resolved.startsWith(r + sep);
  });
  if (!ok) throw bridgeError('input', 'workspaceRoot is outside the allowlisted roots');
  return resolved;
}

export function buildSpawnArgv({ kind, resumeSessionId, workspaceRoot, allowedRoots, tenantId, tmpDir }) {
  const template = KIND_TEMPLATES[kind];
  if (!template) {
    throw bridgeError('input', `unknown agent kind: ${kind}; allowed: ${AGENT_KINDS.join(', ')}`);
  }
  let resume = null;
  if (resumeSessionId != null) {
    if (!RESUME_ID_RE.test(String(resumeSessionId))) {
      throw bridgeError('input', 'resumeSessionId has an invalid shape');
    }
    resume = String(resumeSessionId);
  }
  const cwd = clampWorkspaceRoot(workspaceRoot, allowedRoots);
  const argv = template(resume);
  const env = {
    HERDR_BRIDGE: '1',
    HERDR_TENANT: String(tenantId ?? ''),
    TMPDIR: tmpDir ?? '/tmp',
    PATH: PINNED_PATH,
  };
  for (const k of Object.keys(env)) {
    if (!CHILD_ENV_ALLOWLIST.includes(k)) throw bridgeError('input', `env name not allowlisted: ${k}`);
  }
  return { argv, env, cwd };
}
 * bridge/lib/fence.mjs — method allowlist/blocklist + spawn argv allowlist.
 *
 * Deny-by-default, fail closed. The bridge refuses never-expose methods for
 * room code; the fork (B1) strips them from the socket API as defense in depth
 * against bypassing pane processes (threat-model §4).
 */
import { resolve as resolvePath, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { bridgeError } from './errors.mjs';

/** Pinned herdr socket protocol version (REDESIGN.md §2.3). */
export const PINNED_PROTOCOL = 22;

/** Socket methods the bridge may issue on room code's behalf (risk-review §3.1). */
export const SOCKET_ALLOWLIST = new Set([
  'ping',
  'session.snapshot',
  'pane.list', 'pane.get', 'pane.current', 'pane.process_info', 'pane.read', 'pane.close',
  'agent.list', 'agent.get', 'agent.start', 'agent.prompt', 'agent.send_keys', 'agent.wait',
  'pane.wait_for_output',
  'pane.report_agent', 'pane.report_agent_session', 'pane.report_metadata',
  'events.subscribe', 'events.wait',
  'workspace.create', 'workspace.close', 'workspace.rename',
  'tab.create', 'tab.close', 'tab.rename', 'tab.focus',
  'layout.export',
]);

/** Never-expose: adapter refuses, fork strips (risk-review §3.2 / threat-model §5 S4–S11). */
const BLOCKED_PREFIXES = ['server.', 'plugin.', 'integration.', 'worktree.'];
const BLOCKED_EXACT = new Set([
  'layout.apply',          // applies cwd+env → environment injection
  'notification.show',     // toast spam / social-engineering text
  'pane.send_text', 'pane.send_keys', 'pane.send_input', // raw cross-pane send;
  // only the occupant-pinned agent.prompt / agent.send_keys path exists
  'agent.view.set', 'agent.view.clear', // sidebar projection spoofing
]);

export function assertSocketMethodAllowed(method) {
  if (typeof method !== 'string') throw bridgeError('method_unsupported', 'method must be a string');
  if (BLOCKED_EXACT.has(method) || BLOCKED_PREFIXES.some((p) => method.startsWith(p))) {
    throw bridgeError('method_blocked', `socket method never exposed: ${method}`);
  }
  if (!SOCKET_ALLOWLIST.has(method)) {
    throw bridgeError('method_unsupported', `unknown socket method: ${method}`);
  }
}

/**
 * Agent-kind → fixed argv template. The template is CODE, not config —
 * not overridable via env or any caller field. Caller supplies only `kind`,
 * an optional validated resumeSessionId, and a workspaceRoot clamped to an
 * allowlisted root. Env for the child is adapter-constructed (allowlisted
 * names only); no caller env passthrough. (threat-model §2.2)
 */
const RESUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const KIND_TEMPLATES = {
  claude: (resume) => (resume ? ['claude', '--resume', resume] : ['claude']),
  codex: (resume) => (resume ? ['codex', 'resume', resume] : ['codex']),
  opencode: (resume) => (resume ? ['opencode', 'run', '--session', resume] : ['opencode']),
};
export const AGENT_KINDS = Object.keys(KIND_TEMPLATES);

/** Env names the bridge sets on spawned agent processes. Fixed values only. */
const CHILD_ENV_ALLOWLIST = ['HERDR_BRIDGE', 'HERDR_TENANT', 'TMPDIR', 'PATH'];
const PINNED_PATH = '/usr/local/bin:/usr/bin:/bin';

function clampWorkspaceRoot(workspaceRoot, allowedRoots) {
  if (workspaceRoot == null) return null;
  // realpath both sides when they exist so a symlink inside the root cannot
  // point the cwd outside it; a path that does not exist yet keeps resolve().
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const resolved = real(resolvePath(String(workspaceRoot)));
  const ok = (allowedRoots ?? []).some((root) => {
    const r = real(resolvePath(String(root)));
    return resolved === r || resolved.startsWith(r + sep);
  });
  if (!ok) throw bridgeError('input', 'workspaceRoot is outside the allowlisted roots');
  return resolved;
}

export function buildSpawnArgv({ kind, resumeSessionId, workspaceRoot, allowedRoots, tenantId, tmpDir }) {
  const template = KIND_TEMPLATES[kind];
  if (!template) {
    throw bridgeError('input', `unknown agent kind: ${kind}; allowed: ${AGENT_KINDS.join(', ')}`);
  }
  let resume = null;
  if (resumeSessionId != null) {
    if (!RESUME_ID_RE.test(String(resumeSessionId))) {
      throw bridgeError('input', 'resumeSessionId has an invalid shape');
    }
    resume = String(resumeSessionId);
  }
  const cwd = clampWorkspaceRoot(workspaceRoot, allowedRoots);
  const argv = template(resume);
  const env = {
    HERDR_BRIDGE: '1',
    HERDR_TENANT: String(tenantId ?? ''),
    TMPDIR: tmpDir ?? '/tmp',
    PATH: PINNED_PATH,
  };
  for (const k of Object.keys(env)) {
    if (!CHILD_ENV_ALLOWLIST.includes(k)) throw bridgeError('input', `env name not allowlisted: ${k}`);
  }
  return { argv, env, cwd };
}

/**
 * Report metadata is forwarded to the herdr sidebar/projection, so it is a
 * small flat record, not a free-form object: <=16 keys, simple keys, scalar
 * values (string <=256 chars, finite number, boolean, null), <=2048 bytes total.
 * Anything else is rejected, never trimmed.
 */
export const METADATA_LIMITS = { keys: 16, keyLen: 64, valueLen: 256, bytes: 2048 };
const METADATA_KEY_RE = /^[A-Za-z0-9_.-]+$/;
export function validateReportMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw bridgeError('input', 'report metadata must be a flat object');
  }
  const entries = Object.entries(metadata);
  if (entries.length > METADATA_LIMITS.keys) throw bridgeError('input', 'report metadata has too many fields');
  for (const [k, v] of entries) {
    if (k.length > METADATA_LIMITS.keyLen || !METADATA_KEY_RE.test(k)) {
      throw bridgeError('input', 'report metadata key is not allowed');
    }
    const ok = v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
      || (typeof v === 'string' && v.length <= METADATA_LIMITS.valueLen);
    if (!ok) throw bridgeError('input', 'report metadata values must be short scalars');
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > METADATA_LIMITS.bytes) {
    throw bridgeError('input', 'report metadata is too large');
  }
  return metadata;
}

/**
 * Resume argv arriving via report_agent_session must match an allowlisted
 * kind template (deferred-RCE fence, threat-model §2.1 item 4). The bridge
 * never forwards raw caller argv to the socket.
 */
export function validateResumeArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 64) {
    throw bridgeError('input', 'resume argv must be a non-empty array of <=64 args');
  }
  const [bin, ...rest] = argv.map(String);
  for (const [kind, template] of Object.entries(KIND_TEMPLATES)) {
    const t0 = template(null);
    const t1 = template('RESUME_PROBE');
    if (bin !== t0[0]) continue;
    if (rest.length === 0 && argv.length === t0.length) return kind;
    if (rest.length === t1.length - 1 &&
        rest.slice(0, -1).join('\x00') === t1.slice(1, -1).join('\x00') &&
        RESUME_ID_RE.test(rest[rest.length - 1])) return kind;
  }
  throw bridgeError('input', 'resume argv does not match any allowlisted agent-kind template');
                      }
