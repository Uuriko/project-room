/**
 * bridge/lib/tenants.mjs — tenant → herdr server resolution + supervision glue.
 *
 * Tenants come from the operator-managed `/etc/herdr-bridge/tenants.json`
 * (never from caller input). The bridge never execs a server binary itself;
 * per-tenant servers are systemd template units (`herdr@<tenant>.service`)
 * that systemd itself starts and restarts; the bridge holds no privilege to
 * control them (see bridge/deploy/).
 *
 * Socket boundary (shared-group model): /run/herdr/<tenant> is 0750, owned by
 * the tenant UID, group `herdr-bridge`, setgid, and the socket is 0660 (so it
 * inherits group herdr-bridge). The tenant UID and the bridge can reach it;
 * every other tenant UID has no bits on the directory and cannot traverse it.
 * The fork's SO_PEERCRED accept gate (B1) stays defense in depth: it must
 * permit the tenant UID and the bridge UID only.
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
 * Best-effort audit of the socket-dir boundary: dir 0750 (no access for other
 * UIDs, group r-x) owned by the tenant UID, socket 0660 with no access for
 * others. The setgid bit is ignored in the comparison. Returns warning strings (warn-only: the bridge
 * must not refuse service over a drift it cannot fix — the drift itself is
 * the signal, surfaced in the ops log and audit trail).
 */
export async function checkSocketDir(tenant) {
  const warnings = [];
  const dir = dirname(tenant.socketPath);
  try {
    const st = await stat(dir);
    const mode = st.mode & 0o777;
    if (mode !== 0o750) warnings.push(`socket dir ${dir} mode is ${mode.toString(8)}, want 750`);
    if (typeof tenant.uid === 'number' && st.uid !== tenant.uid) {
      warnings.push(`socket dir ${dir} owned by uid ${st.uid}, want ${tenant.uid}`);
    }
  } catch (err) {
    warnings.push(`socket dir ${dir} not stat-able: ${err.code ?? err.message}`);
  }
  try {
    const st = await stat(tenant.socketPath);
    if ((st.mode & 0o777) !== 0o660) {
      warnings.push(`socket ${tenant.socketPath} mode is ${(st.mode & 0o777).toString(8)}, want 660`);
    }
  } catch { /* socket may not exist yet — ping will report that */ }
  return warnings;
}
