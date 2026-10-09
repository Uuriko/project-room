/**
 * bridge/lib/audit.mjs — append-only JSONL audit log.
 *
 * Every call is logged (allowed AND denied — a deny spike is a signal,
 * risk-review §3.4), with params redacted BEFORE write. readPane bodies are
 * NEVER persisted: the read path logs {bytes, lines, sha256} only.
 * Retention: 30 days (see bridge/deploy/logrotate.conf; pruneOld() helper).
 */
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { redactValue } from './redact.mjs';

// Free-text fields that carry private content (prompts, wait patterns, report
// metadata). Like pane reads, they are logged as length + sha256 only.
const BODY_FIELDS = ['text', 'pattern', 'metadata'];
export function scrubBodies(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const out = { ...params };
  for (const k of BODY_FIELDS) {
    if (out[k] === undefined) continue;
    const raw = typeof out[k] === 'string' ? out[k] : JSON.stringify(out[k]);
    out[k] = { bytes: Buffer.byteLength(raw, 'utf8'), sha256: createHash('sha256').update(raw).digest('hex') };
  }
  return out;
}

export class AuditLog {
  constructor(path) {
    this.path = path;
    this.chain = Promise.resolve();
    this._ready = mkdir(dirname(path), { recursive: true }).catch(() => {});
  }

  /** @returns {Promise<void>} resolves when the entry is durably appended. */
  write(entry) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tenant: entry.tenant ?? null,
      route: entry.route ?? null,
      socketMethod: entry.socketMethod ?? null,
      target: entry.target ?? null,
      params: redactValue(scrubBodies(entry.params ?? {})),
      result: entry.result ?? null,
      denyReason: entry.denyReason ?? undefined,
      latencyMs: entry.latencyMs ?? null,
      status: entry.status ?? null,
      extra: entry.extra ?? undefined,
    }) + '\n';
    this.chain = this.chain
      .then(() => this._ready)
      .then(() => appendFile(this.path, line, 'utf8'))
      .catch((err) => {
        // The audit log must never take down the bridge, but a dead audit
        // log is a security incident — scream into the ops log.
        console.error(`[herdr-bridge] AUDIT WRITE FAILED: ${err.message}`);
      });
    return this.chain;
  }

  /** Delete rotated audit files older than `days` (default 30). */
  async pruneOld(days = 30) {
    const dir = dirname(this.path);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      for (const name of await readdir(dir)) {
        if (!name.startsWith('audit.jsonl')) continue;
        if (name === 'audit.jsonl') continue; // live file; logrotate handles it
        const p = join(dir, name);
        const st = await stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoff) { await unlink(p); removed++; }
      }
    } catch { /* best effort */ }
    return removed;
  }
}
