// fake-store.mjs — in-memory fakes for the registry's backends.
// FakeFiles:  plugin file tree. FakeKV: namespaced string KV for storage.kv.
// FakeLogSink: captures plugin log lines for assertions.

export class FakeFiles {
  constructor() {
    this.tree = new Map(); // path -> content
  }
  writeFile(path, content) {
    this.tree.set(path, content);
  }
  readFile(path) {
    if (!this.tree.has(path)) throw new Error(`file not found: ${path}`);
    return this.tree.get(path);
  }
  removeDir(dir) {
    for (const k of [...this.tree.keys()]) {
      if (k === dir || k.startsWith(dir)) this.tree.delete(k);
    }
  }
  listFiles(dir) {
    return [...this.tree.keys()].filter((k) => k.startsWith(dir));
  }
}

export class FakeKV {
  constructor() {
    this.map = new Map();
  }
  get(k) {
    return this.map.has(k) ? structuredClone(this.map.get(k)) : undefined;
  }
  set(k, v) {
    this.map.set(k, structuredClone(v));
  }
  del(k) {
    this.map.delete(k);
  }
  keys(prefix) {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

export class FakeLogSink {
  constructor() {
    this.lines = []; // { level, plugin, line, ts }
  }
  sink(level, plugin, line) {
    this.lines.push({ level, plugin, line, ts: new Date().toISOString() });
  }
  forPlugin(name) {
    return this.lines.filter((l) => l.plugin === name);
  }
  clear() {
    this.lines.length = 0;
  }
}

/** Bundle the three fakes into the `backends` shape the registry expects. */
export function makeBackends(overrides = {}) {
  const files = new FakeFiles();
  const store = new FakeKV();
  const logs = new FakeLogSink();
  return {
    files,
    store,
    logs,
    backends: {
      logSink: (level, name, line) => logs.sink(level, name, line),
      store,
      maxTimerMs: 5_000,
      sandboxLimits: { entryTimeoutMs: 1000, hookTimeoutMs: 250 },
      ...overrides,
    },
  };
}
