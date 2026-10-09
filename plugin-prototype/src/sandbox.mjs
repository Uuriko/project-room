// sandbox.mjs — sandboxed plugin execution via node:vm.
//
// A Sandbox owns one vm context per enabled plugin. The plugin entry is
// compiled once by the host and evaluated with a CPU timeout. Hook handlers
// registered via plugin.on() are invoked through __dispatch with a per-call
// timeout so an infinite loop can never wedge the host.
//
// Denied inside the context: process, require, module, fetch, fs,
// child_process, eval/Function-constructor escapes to host scope,
// WebAssembly, and any host object reference. Payloads and results cross the
// boundary by structured clone only.
//
// NOTE (threat model, see docs/SPEC.md): node:vm is an isolation boundary
// for untrusted-but-not-adversarial code, not a hardened security sandbox
// against V8 0-days. The Sandbox class is the seam: a worker-thread or
// subprocess backend can replace it without touching the registry.

import vm from 'node:vm';

export class SandboxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxError';
  }
}

export class SandboxTimeoutError extends SandboxError {
  constructor(where) {
    super(`plugin CPU timeout during ${where}`);
    this.name = 'SandboxTimeoutError';
    this.where = where;
  }
}

const DEFAULT_LIMITS = Object.freeze({
  entryTimeoutMs: 1000,
  hookTimeoutMs: 250,
  maxTimerMs: 30_000,
});

// Runs inside every plugin context BEFORE the entry: hardens primordials and
// installs the `plugin` global. __manifest / __api / __hostTimers are injected
// by the host as context globals first.
const SETUP_SCRIPT = `
'use strict';
const __mf = __manifest; // closure snapshot; globalThis.__manifest is deleted below
const __handlers = new Map();
// Harden shared intrinsics so a plugin cannot poison host builtins.
for (const n of ['Object','Array','Function','String','Number','Boolean','Map','Set','WeakMap','Promise','JSON','Math','Reflect','Symbol','BigInt','Date','RegExp','Error','ArrayBuffer','DataView','URL','URLSearchParams','Intl']) {
  const v = globalThis[n];
  if (v && v.prototype) { try { Object.freeze(v.prototype); } catch {} }
  if (v) { try { Object.freeze(v); } catch {} }
}
if (globalThis.__api && globalThis.__api.timers) {
  globalThis.setTimeout = globalThis.__api.timers.setTimeout;
  globalThis.clearTimeout = globalThis.__api.timers.clearTimeout;
}
globalThis.console = Object.freeze({
  log: (...a) => globalThis.__api.log('info', ...a),
  info: (...a) => globalThis.__api.log('info', ...a),
  warn: (...a) => globalThis.__api.log('warn', ...a),
  error: (...a) => globalThis.__api.log('error', ...a),
  debug: (...a) => globalThis.__api.log('debug', ...a),
});
globalThis.plugin = Object.freeze({
  name: __mf.name,
  version: __mf.version,
  config: __mf.config,
  api: globalThis.__api,
  on(hook, fn) {
    if (typeof hook !== 'string' || typeof fn !== 'function') throw new TypeError('plugin.on(hook, fn)');
    if (!__mf.hooks.includes(hook)) throw new Error('hook "' + hook + '" not declared in manifest');
    if (__handlers.has(hook)) throw new Error('handler already registered for "' + hook + '"');
    __handlers.set(hook, fn);
  },
});
globalThis.__dispatch = (hook) => {
  const fn = __handlers.get(hook);
  if (!fn) return { ok: false, error: 'no handler registered for ' + hook };
  return fn(globalThis.__payload);
};
`;

export class Sandbox {
  constructor(manifest, api, limits = {}) {
    this.manifest = manifest;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.timerIds = new Set();
    this.destroyed = false;

    const ctx = {
      __manifest: {
        name: manifest.name,
        version: manifest.version,
        hooks: [...manifest.hooks],
        config: manifest.config,
      },
      __api: api,
      __payload: undefined,
      // Explicitly denied intrinsics that Node injects into vm contexts.
      WebAssembly: undefined,
    };
    // Timers are host-implemented so disable() can always kill them.
    // Wrappers get null prototypes so fn.constructor can't reach host Function.
    if (api.timers) {
      const self = this;
      const rawTimers = api.timers;
      const wrap = (fn) => Object.freeze(Object.setPrototypeOf(fn, null));
      ctx.__api = {
        ...api,
        timers: {
          setTimeout: wrap((fn, ms, ...args) => {
            if (typeof fn !== 'function') throw new TypeError('setTimeout requires a function');
            const id = rawTimers.setTimeout(() => { self.timerIds.delete(id); fn(...args); }, ms);
            self.timerIds.add(id);
            return id;
          }),
          clearTimeout: wrap((id) => {
            self.timerIds.delete(id);
            rawTimers.clearTimeout(id);
          }),
        },
      };
    }
    this.context = vm.createContext(ctx);
    vm.runInContext(SETUP_SCRIPT, this.context, { filename: 'plugin-setup.js' });
    // Remove host-only channels from the plugin-visible surface.
    vm.runInContext('delete globalThis.__manifest;', this.context);
  }

  /** Evaluate the plugin entry file. Throws SandboxTimeoutError on overrun. */
  loadEntry(code, filename) {
    this.#assertLive();
    try {
      vm.runInContext(code, this.context, {
        filename,
        timeout: this.limits.entryTimeoutMs,
        microtaskMode: 'afterEvaluate',
      });
    } catch (e) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new SandboxTimeoutError('entry evaluation');
      throw new SandboxError(`entry failed: ${e && e.message}`);
    }
  }

  /**
   * Invoke the registered handler for `hook` with a JSON payload.
   * Returns a host-detached (structured-cloned) result.
   */
  dispatch(hook, payload) {
    this.#assertLive();
    this.context.__payload = structuredClone(payload);
    try {
      const raw = vm.runInContext(`__dispatch(${JSON.stringify(hook)})`, this.context, {
        filename: `hook:${hook}`,
        timeout: this.limits.hookTimeoutMs,
        microtaskMode: 'afterEvaluate',
      });
      return structuredClone(raw);
    } catch (e) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new SandboxTimeoutError(`hook "${hook}"`);
      throw new SandboxError(`hook "${hook}" threw: ${e && e.message}`);
    } finally {
      this.context.__payload = undefined;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const id of this.timerIds) {
      try { clearTimeout(id); } catch {}
    }
    this.timerIds.clear();
    this.context = null;
  }

  #assertLive() {
    if (this.destroyed) throw new SandboxError('sandbox destroyed');
  }
}
