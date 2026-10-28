import { AsyncLocalStorage } from 'node:async_hooks';

// Fixed vocabulary; unknown caller labels collapse rather than entering logs.
const kinds = new Set(['request', 'job', 'background', 'scheduler', 'readiness', 'cold-start']);
const operations = new Set(['mcp', 'work-claims', 'work-context', 'room-view', 'operator', 'other',
  'patrol', 'retention', 'integrity', 'webhooks', 'job-eligibility', 'storage-probe',
  'gmail-sync', 'channel-drain', 'webhook-dispatch', 'land-queue', 'claim-prs', 'public-read-model',
  'public-work-reseed', 'escrow-epochs', 'room-backup', 'growth-watch', 'project-map', 'store-growth']);
const counters = () => ({ statements: 0, rowsRead: 0, rowsWritten: 0, sqlErrors: 0, unknownRowCosts: 0 });
const add = (target, source) => {
  for (const key of Object.keys(target)) target[key] = Math.min(Number.MAX_SAFE_INTEGER, target[key] + source[key]);
};

// Per-statement ownership, never global-counter subtraction. Unscoped and late
// work accumulates in bounded buckets, explicitly drained by the embedding host.
// Late work is NOT added to an already-emitted parent summary.
export class SqlCostScopes {
  #context = new AsyncLocalStorage();
  #emit;
  #unscoped = counters();
  #late = counters();
  constructor({ emit = () => {} } = {}) { this.#emit = emit; }
  #write(value) { try { this.#emit(value); } catch { /* diagnostic only */ } }
  observeStatement = () => {
    const scope = this.#context.getStore();
    if (scope && !scope.closed) scope.pending++;
    const owned = scope && !scope.closed ? scope : null;
    // A callback inherited from a closed async scope is explicitly late.
    const orphan = scope ? this.#late : this.#unscoped;
    let finished = false;
    return ({ rowsRead, rowsWritten, failed }) => {
      if (finished) return;
      finished = true;
      const value = { statements: 1, rowsRead: rowsRead ?? 0, rowsWritten: rowsWritten ?? 0,
        sqlErrors: failed ? 1 : 0, unknownRowCosts: rowsRead === null || rowsWritten === null ? 1 : 0 };
      if (owned) owned.pending--;
      add(owned && !owned.closed ? owned.counts : orphan, value);
    };
  };
  run(kind, operation, fn, { partial = false } = {}) {
    const scope = { kind: kinds.has(kind) ? kind : 'other', operation: operations.has(operation) ? operation : 'other',
      counts: counters(), pending: 0, closed: false };
    const close = failed => {
      scope.closed = true;
      this.#write({ event: 'room.sql_cost', coverage: 'adapter-observed', scopeKind: scope.kind, operation: scope.operation,
        ...scope.counts, pendingStatements: scope.pending, complete: !partial && !scope.pending && !scope.counts.unknownRowCosts,
        outcome: failed ? 'failed' : 'completed' });
    };
    return this.#context.run(scope, () => {
      let result;
      try { result = fn(); }
      catch (error) { close(true); throw error; }
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(
        value => { close(false); return value; }, error => { close(true); throw error; });
      close(false); return result;
    });
  }
  flushUnattributed() {
    for (const [scopeKind, counts] of [['unscoped', this.#unscoped], ['late', this.#late]]) {
      if (counts.statements) this.#write({ event: 'room.sql_cost', coverage: 'adapter-observed', scopeKind,
        operation: 'other', ...counts, complete: false });
      for (const key of Object.keys(counts)) counts[key] = 0;
    }
  }
}

// Never return URL input, even for unknown or malformed paths.
export function sqlCostOperation(url) {
  let path;
  try { path = new URL(url).pathname.replace(/^\/room(?=\/)/, ''); } catch { return 'other'; }
  if (path === '/mcp') return 'mcp';
  if (/^\/api\/rooms\/[^/]+\/work-claims(?:\/[^/]+)?$/.test(path) || /^\/api\/rooms\/[^/]+\/work-claims-read$/.test(path)) return 'work-claims';
  if (/^\/api\/rooms\/[^/]+\/work-context$/.test(path)) return 'work-context';
  if (/^\/api\/rooms\/[^/]+$/.test(path)) return 'room-view';
  if (/^\/api\/operator\/(?:export|restore|restore-from-backup)$/.test(path)) return 'operator';
  return 'other';
}
