/**
 * bridge/lib/idempotency.mjs — 15-minute dedupe cache for write idempotency keys.
 *
 * A repeated key returns the ORIGINAL response instead of re-executing, which
 * makes timeout-retries safe for non-idempotent methods (D3 §1.1, same pattern
 * as relay's replay-guard). Only successful outcomes are cached: a
 * no-response/timeout outcome must remain retryable under the same key.
 */
export class IdempotencyCache {
  constructor(ttlMs = 15 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { response, inputHash, expiresAt }
  }
  _sweep(now = Date.now()) {
    for (const [k, v] of this.map) {
      if (v.expiresAt <= now) this.map.delete(k);
    }
  }
  /**
   * @returns {{hit:boolean, response?:any, conflict?:boolean}}
   * conflict = key seen before with DIFFERENT input (never silently merged).
   */
  check(key, inputHash) {
    this._sweep();
    const rec = this.map.get(key);
    if (!rec) return { hit: false };
    if (rec.inputHash !== inputHash) return { hit: false, conflict: true };
    return { hit: true, response: rec.response };
  }
  /**
   * Run `fn` once per key. The key is claimed BEFORE `fn` runs, so a retry that
   * arrives while the first call is still in flight waits for it instead of
   * executing the write a second time. A failed `fn` releases the key so the
   * caller can retry; only successes stay cached for the TTL.
   * @returns {Promise<{conflict:true}|{hit:boolean, response:any}>}
   */
  async run(key, inputHash, fn) {
    this._sweep();
    const rec = this.map.get(key);
    if (rec) {
      if (rec.inputHash !== inputHash) return { conflict: true };
      return { hit: true, response: rec.pending ? await rec.pending : rec.response };
    }
    const entry = { response: undefined, inputHash, pending: null, expiresAt: Infinity };
    entry.pending = Promise.resolve().then(fn);
    this.map.set(key, entry);
    try {
      entry.response = await entry.pending;
      entry.pending = null;
      entry.expiresAt = Date.now() + this.ttlMs;
      return { hit: false, response: entry.response };
    } catch (err) {
      if (this.map.get(key) === entry) this.map.delete(key);
      throw err;
    }
  }
  store(key, inputHash, response) {
    this._sweep();
    this.map.set(key, { response, inputHash, expiresAt: Date.now() + this.ttlMs });
  }
  get size() { return this.map.size; }
}
