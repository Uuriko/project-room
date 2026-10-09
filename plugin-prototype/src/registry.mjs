// registry.mjs — plugin lifecycle: install / enable / disable / uninstall.
//
// The registry is pure orchestration; all I/O goes through the injected
// `files` backend ({ readFile, writeFile, removeDir, listFiles }) and all
// plugin state through the injected `store`/`logSink`. Ship with fakes;
// production adapters implement the same interfaces.

import { parseManifest } from './manifest.mjs';
import { Sandbox, SandboxTimeoutError } from './sandbox.mjs';
import { buildPluginApi } from './host-api.mjs';
import { HookBus } from './hooks.mjs';

export class LifecycleError extends Error {
  constructor(message) { super(message); this.name = 'LifecycleError'; }
}
export class NotFoundError extends Error {
  constructor(name) { super(`plugin "${name}" not installed`); this.name = 'NotFoundError'; }
}
export class AlreadyInstalledError extends Error {
  constructor(name) { super(`plugin "${name}" already installed`); this.name = 'AlreadyInstalledError'; }
}

export const STATES = Object.freeze({
  INSTALLED: 'installed',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
});

export class PluginRegistry {
  #autoDisabling;
  /**
   * @param {object} files  { readFile(path)->string, writeFile(path,content), removeDir(path), listFiles(dir)->string[] }
   * @param {object} backends { logSink(level,name,line), store, maxTimerMs, sandboxLimits }
   */
  constructor(files, backends = {}) {
    this.files = files;
    this.backends = backends;
    this.records = new Map(); // name -> { manifest, state, installedAt, enabledAt }
    this.sandboxes = new Map(); // name -> Sandbox (only while enabled)
    this.bus = new HookBus();
    this.journal = [];
    this.#autoDisabling = new Set(); // re-entrancy guard for timeout auto-disable
  }

  /**
   * Install from an in-memory source tree: { 'plugin.json': text, 'index.js': code, ... }.
   * No plugin code runs at install time.
   */
  install(sourceTree) {
    if (!sourceTree || typeof sourceTree['plugin.json'] !== 'string') {
      throw new LifecycleError('install requires a source tree containing plugin.json');
    }
    const manifest = parseManifest(sourceTree['plugin.json']);
    if (this.records.has(manifest.name)) throw new AlreadyInstalledError(manifest.name);
    const entryCode = sourceTree[manifest.entry];
    if (typeof entryCode !== 'string') {
      throw new LifecycleError(`entry file "${manifest.entry}" missing from source tree`);
    }
    const base = `plugins/${manifest.name}/`;
    for (const [rel, content] of Object.entries(sourceTree)) {
      if (typeof content !== 'string') throw new LifecycleError(`file "${rel}" must be text`);
      if (rel.includes('..')) throw new LifecycleError(`file "${rel}" escapes plugin dir`);
      this.files.writeFile(base + rel, content);
    }
    this.records.set(manifest.name, {
      manifest,
      state: STATES.INSTALLED,
      installedAt: new Date().toISOString(),
      enabledAt: null,
    });
    this.#journal('install', manifest.name, null, STATES.INSTALLED);
    return manifest;
  }

  enable(name) {
    const rec = this.#require(name);
    if (rec.state === STATES.ENABLED) throw new LifecycleError(`plugin "${name}" already enabled`);
    if (rec.state !== STATES.INSTALLED && rec.state !== STATES.DISABLED) {
      throw new LifecycleError(`cannot enable from state "${rec.state}"`);
    }
    const from = rec.state;
    const base = `plugins/${name}/`;
    const code = this.files.readFile(base + rec.manifest.entry);
    const api = buildPluginApi(rec.manifest, this.backends);
    const sandbox = new Sandbox(rec.manifest, api, this.backends.sandboxLimits);
    try {
      sandbox.loadEntry(code, `${name}/${rec.manifest.entry}`);
      this.bus.register(name, sandbox, rec.manifest.hooks);
    } catch (e) {
      try { this.bus.unregister(name); } catch {}
      sandbox.destroy();
      throw e;
    }
    this.sandboxes.set(name, sandbox);
    rec.state = STATES.ENABLED;
    rec.enabledAt = new Date().toISOString();
    this.#journal('enable', name, from, STATES.ENABLED);
    this.dispatch('plugin.enabled', { plugin: name, version: rec.manifest.version });
    return rec.manifest;
  }

  disable(name) {
    const rec = this.#require(name);
    if (rec.state !== STATES.ENABLED) throw new LifecycleError(`cannot disable from state "${rec.state}"`);
    this.dispatch('plugin.disabled', { plugin: name });
    this.bus.unregister(name);
    this.sandboxes.get(name)?.destroy();
    this.sandboxes.delete(name);
    rec.state = STATES.DISABLED;
    rec.enabledAt = null;
    this.#journal('disable', name, STATES.ENABLED, STATES.DISABLED);
  }

  uninstall(name) {
    const rec = this.#require(name);
    if (rec.state === STATES.ENABLED) this.disable(name);
    this.files.removeDir(`plugins/${name}/`);
    this.records.delete(name);
    this.#journal('uninstall', name, rec.state, null);
  }

  /** Fan-out a hook event to all enabled plugins; failures isolated per plugin. */
  dispatch(hook, payload) {
    return this.bus.dispatch(hook, payload, {
      onTimeout: (offender) => {
        // Fail closed: a plugin that wedges the CPU is disabled, not retried.
        // Guard: disable() itself dispatches while state is still ENABLED.
        if (this.#autoDisabling.has(offender)) return;
        const rec = this.records.get(offender);
        if (!rec || rec.state !== STATES.ENABLED) return;
        this.#autoDisabling.add(offender);
        try {
          this.disable(offender);
        } catch {
          // fall through to journal
        } finally {
          this.#autoDisabling.delete(offender);
        }
        this.#journal('auto-disable', offender, STATES.ENABLED, STATES.DISABLED);
      },
    });
  }

  get(name) {
    const rec = this.#require(name);
    return { name, state: rec.state, manifest: rec.manifest, installedAt: rec.installedAt };
  }

  list() {
    return [...this.records.keys()].map((n) => this.get(n));
  }

  #require(name) {
    const rec = this.records.get(name);
    if (!rec) throw new NotFoundError(name);
    return rec;
  }

  #journal(action, name, from, to) {
    this.journal.push({ ts: new Date().toISOString(), action, plugin: name, from, to });
  }
}

export { SandboxTimeoutError };
