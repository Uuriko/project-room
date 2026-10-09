/**
 * bridge/lib/tenants.mjs — tenant → herdr server resolution + supervision glue.
 *
 * Tenants come from the operator-managed `/etc/herdr-bridge/tenants.json`
 * (never from caller input). The bridge never execs a server binary itself;
 * per-tenant servers are systemd template units (`herdr@<tenant>.service`)
 * started via a tightly-scoped sudoers rule (see bridge/deploy/).
 *
 * SO_PEERCRED dependency (B1's fork work, threat-model §4.2): the fork must
 * check the connecting UID on socket accept. The bridge connects as its own
 * user (`herdr-bridge`), NOT as the tenant UID — so the fork's accept gate
 * must explicitly permit the bridge UID (operator-configured allowlist in the
 * fork), while still rejecting every other non-tenant UID. Until B1 lands the
 * gate, socket-dir 0700 + socket 0600 owned by the tenant UID is the only
 * enforcement, and it is advisory against same-UID processes.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateTenantId } from './auth.mjs';

export async function loadTenants(file) {
  const raw = await readFile(file, 'utf8');
  const cfg = JSON.parse(raw);
  const tenants = new Map();
  for (const [id, t] of Object.entries(cfg.tenants ?? {})) {
    validateTenantId(id);
    if (!t || typeof t.socketPath !== 'string' || !t.socketPath) {
      throw new Error(`tenant ${id}: missing socketPath`);
    }
    tenants.set(id, {
      id,
      socketPath: t.socketPath,
      uid: t.uid,
      workspaceRoot: t.workspaceRoot ?? null,
      tmpDir: t.tmpDir ?? null,
    });
  }
  return tenants;
}

/**
 * Best-effort audit of the socket-dir boundary: dir should be 0700 owned by
 * the tenant UID, socket 0600. Returns warning strings (warn-only: the bridge
 * must not refuse service over a drift it cannot fix — the drift itself is
 * the signal, surfaced in the ops log and audit trail).
 */
export async function checkSocketDir(tenant) {
  const warnings = [];
  const dir = dirname(tenant.socketPath);
  try {
    const st = await stat(dir);
    const mode = st.mode & 0o777;
    if (mode !== 0o700) warnings.push(`socket dir ${dir} mode is ${mode.toString(8)}, want 700`);
    if (typeof tenant.uid === 'number' && st.uid !== tenant.uid) {
      warnings.push(`socket dir ${dir} owned by uid ${st.uid}, want ${tenant.uid}`);
    }
  } catch (err) {
    warnings.push(`socket dir ${dir} not stat-able: ${err.code ?? err.message}`);
  }
  try {
    const st = await stat(tenant.socketPath);
    if ((st.mode & 0o777) !== 0o600) {
      warnings.push(`socket ${tenant.socketPath} mode is ${(st.mode & 0o777).toString(8)}, want 600`);
    }
  } catch { /* socket may not exist yet — ping will report that */ }
  return warnings;
}
