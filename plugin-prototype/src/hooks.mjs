// hooks.mjs — fan-out dispatch of hook events to enabled plugins.
//
// Errors are isolated per plugin: a throwing or timing-out handler is
// reported in its result entry and never breaks other plugins. A timeout
// also triggers onTimeout(name) so the registry can fail-closed
// (auto-disable the offender).

import { SandboxTimeoutError } from './sandbox.mjs';

export class HookBus {
  constructor() {
    this.plugins = new Map(); // name -> { sandbox, hooks:Set }
  }

  register(name, sandbox, hooks) {
    if (this.plugins.has(name)) throw new Error(`plugin "${name}" already registered on hook bus`);
    this.plugins.set(name, { sandbox, hooks: new Set(hooks) });
  }

  unregister(name) {
    this.plugins.delete(name);
  }

  has(name) {
    return this.plugins.has(name);
  }

  /**
   * Dispatch `payload` (JSON) to every plugin that declared `hook`.
   * Returns [{ plugin, ok, result?, error?, timedOut? }].
   */
  dispatch(hook, payload, { onTimeout } = {}) {
    const results = [];
    for (const [name, { sandbox, hooks }] of this.plugins) {
      if (!hooks.has(hook)) continue;
      try {
        const result = sandbox.dispatch(hook, payload);
        results.push({ plugin: name, ok: true, result });
      } catch (e) {
        const timedOut = e instanceof SandboxTimeoutError;
        results.push({ plugin: name, ok: false, error: e.message, timedOut });
        if (timedOut && typeof onTimeout === 'function') {
          try { onTimeout(name); } catch {}
        }
      }
    }
    return results;
  }
}
