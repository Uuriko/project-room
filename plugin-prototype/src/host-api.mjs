// host-api.mjs — builds the capability-gated `api` object handed to a plugin.
//
// Each member is a narrow host function; no host objects leak through.
// Backends are injected (fakes in tests, real adapters in production):
//   logSink(level, pluginName, args[])  — captures log lines
//   store                               — { get(k), set(k,v), del(k), keys(prefix) } string KV
//   maxTimerMs                          — upper bound for plugin timers

function formatArg(a) {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Strip the function's prototype chain so `api.fn.constructor` cannot reach
// the host Function constructor (closes the constructor-oracle escape).
function harden(fn) {
  Object.setPrototypeOf(fn, null);
  return Object.freeze(fn);
}

export function buildPluginApi(manifest, { logSink, store, maxTimerMs = 30_000 } = {}) {
  const caps = new Set(manifest.capabilities);
  const api = {};

  if (caps.has('log')) {
    api.log = harden((level, ...args) => {
      const lvl = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
      logSink(lvl, manifest.name, args.map(formatArg).join(' '));
    });
  }

  if (caps.has('storage.kv')) {
    if (!store) throw new Error('storage.kv capability requires a store backend');
    const ns = `plugin:${manifest.name}:`;
    const checkKey = (k) => {
      if (typeof k !== 'string' || k.length === 0 || k.length > 256 || k.includes(':')) {
        throw new TypeError('storage key must be a non-empty string ≤256 chars without ":"');
      }
    };
    const checkValue = (v) => {
      try { structuredClone(v); } catch { throw new TypeError('storage value must be structured-cloneable'); }
      const s = JSON.stringify(v);
      if (s.length > 1_000_000) throw new RangeError('storage value exceeds 1MB');
    };
    api.storage = Object.freeze({
      get: harden((k) => { checkKey(k); return store.get(ns + k); }),
      set: harden((k, v) => { checkKey(k); checkValue(v); store.set(ns + k, structuredClone(v)); }),
      del: harden((k) => { checkKey(k); store.del(ns + k); }),
      keys: harden(() => store.keys(ns).map((k) => k.slice(ns.length))),
    });
  }

  if (caps.has('timers')) {
    api.timers = Object.freeze({
      setTimeout: harden((fn, ms) => {
        if (typeof fn !== 'function') throw new TypeError('setTimeout requires a function');
        const bounded = Math.min(Math.max(0, Number(ms) || 0), maxTimerMs);
        return setTimeout(fn, bounded);
      }),
      clearTimeout: harden((id) => clearTimeout(id)),
    });
  }

  return Object.freeze(api);
}
