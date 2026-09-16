import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReadThreadMcpWiring,
  TOOL_NAME,
  TOOL_SCHEMA,
  CONNECTION_STATES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../src/mcp-read-thread-wiring.mjs';

/** Controllable clock: now() reads `t`. delay() resolves without moving the
 * clock — only explicit advance() moves it, so timeouts stay deterministic. */
function makeClock(start = 1_000_000) {
  const state = { t: start };
  return {
    clock: () => state.t,
    delay: async (ms) => {
      void ms;
    },
    advance: (ms) => {
      state.t += ms;
    },
    now: () => state.t,
  };
}

function makeTransport() {
  const calls = [];
  return {
    calls,
    async connect() {
      calls.push('connect');
    },
    async disconnect() {
      calls.push('disconnect');
    },
  };
}

/** Fake backend over an in-memory thread store. */
function makeBackend(threads = {}) {
  const calls = [];
  return {
    calls,
    async readThread({ threadId, limit, before, after }) {
      calls.push({ threadId, limit, before, after });
      const thread = threads[threadId];
      if (!thread) {
        const err = new Error(`unknown thread ${threadId}`);
        err.code = 'THREAD_NOT_FOUND';
        throw err;
      }
      let messages = [...thread];
      if (after !== undefined) {
        const idx = messages.findIndex((m) => m.id === after);
        messages = idx === -1 ? [] : messages.slice(idx + 1);
      }
      if (before !== undefined) {
        const idx = messages.findIndex((m) => m.id === before);
        messages = idx === -1 ? [] : messages.slice(0, idx);
      }
      const page = messages.slice(0, limit);
      return { messages: page, hasMore: messages.length > page.length };
    },
  };
}

const MESSAGES = [
  { id: 'm1', body: 'hello' },
  { id: 'm2', body: 'world' },
  { id: 'm3', body: 'again' },
];

function makeWiring(overrides = {}) {
  const { deps = {}, ...rest } = overrides;
  const fake = makeClock();
  const wiring = createReadThreadMcpWiring({
    clock: fake.clock,
    delay: fake.delay,
    transport: makeTransport(),
    threadBackend: makeBackend({ t1: MESSAGES }),
    ...deps,
    ...rest,
  });
  return { wiring, fake };
}

async function connectedWiring(overrides = {}) {
  const ctx = makeWiring(overrides);
  await ctx.wiring.connect();
  return ctx;
}

/** Assert the thrown error carries a coded contract: Error + string `code`. */
async function assertCoded(fn, expectedCode) {
  const err = await fn().then(
    () => assert.fail('expected a throw'),
    (e) => e,
  );
  assert.ok(err instanceof Error, 'must throw an Error');
  assert.equal(typeof err.code, 'string', 'error must carry a string code');
  if (expectedCode !== undefined) assert.equal(err.code, expectedCode);
  return err;
}

// ---------------------------------------------------------------- lifecycle

test('lifecycle: disconnected → connecting → connected, reconnect, close, reconnect-from-closed', async () => {
  const { wiring } = makeWiring();
  assert.equal(wiring.state, 'disconnected');

  await wiring.connect();
  assert.equal(wiring.state, 'connected');

  await wiring.reconnect();
  assert.equal(wiring.state, 'connected');

  await wiring.disconnect();
  assert.equal(wiring.state, 'closed');

  // closed may connect again
  await wiring.connect();
  assert.equal(wiring.state, 'connected');
});

test('lifecycle: illegal transitions throw MCP_INVALID_STATE', async () => {
  const { wiring } = makeWiring();
  await wiring.connect();
  await assertCoded(() => wiring.connect(), 'MCP_INVALID_STATE');

  const { wiring: w2 } = makeWiring();
  await assertCoded(() => w2.reconnect(), 'MCP_INVALID_STATE');
  await assertCoded(() => w2.disconnect().then(() => w2.reconnect()), 'MCP_INVALID_STATE');
});

test('lifecycle: transport connect failure drops back to disconnected with MCP_TRANSPORT_ERROR', async () => {
  const fake = makeClock();
  const badTransport = {
    async connect() {
      throw new Error('dial refused');
    },
  };
  const wiring = createReadThreadMcpWiring({ clock: fake.clock, transport: badTransport });
  await assertCoded(() => wiring.connect(), 'MCP_TRANSPORT_ERROR');
  assert.equal(wiring.state, 'disconnected');
});

test('lifecycle: reads are refused before connect with MCP_NOT_CONNECTED', async () => {
  const { wiring } = makeWiring();
  await assertCoded(() => wiring.handleRequest({ threadId: 't1' }), 'MCP_NOT_CONNECTED');
});

// ---------------------------------------------------------------- tool schema

test('tool schema: register exposes the exact room.read-thread schema', () => {
  const { wiring } = makeWiring();
  assert.equal(TOOL_NAME, 'room.read-thread');
  assert.equal(wiring.toolSchema.name, 'room.read-thread');
  assert.deepEqual(Object.keys(wiring.toolSchema.inputSchema.properties), [
    'threadId',
    'limit',
    'before',
    'after',
  ]);
  assert.ok(wiring.toolSchema.inputSchema.required.includes('threadId'));
  assert.equal(TOOL_SCHEMA.name, 'room.read-thread');
  assert.ok(Object.isFrozen(TOOL_SCHEMA));
});

test('tool schema: register wires the schema to a handler', async () => {
  const ctx = await connectedWiring();
  const { wiring } = ctx;
  let seen = null;
  const ret = ctx.wiring.register((schema, handler) => {
    seen = { schema, handler };
    return 'registered';
  });
  assert.equal(ret, 'registered');
  assert.equal(seen.schema, TOOL_SCHEMA);
  assert.equal(typeof seen.handler, 'function');

  const result = await seen.handler({ threadId: 't1', limit: 2 }, { agentId: 'a1' });
  assert.equal(result.threadId, 't1');
  assert.equal(result.messages.length, 2);
  assert.equal(wiring.state, 'connected');
});

test('tool schema: register with a non-function throws MCP_TRANSPORT_ERROR', () => {
  const { wiring } = makeWiring();
  assert.throws(() => wiring.register(null), (err) => err.code === 'MCP_TRANSPORT_ERROR');
});

// ---------------------------------------------------------------- valid read round-trip + pagination

test('read: valid round-trip returns {threadId, messages[], hasMore} with cursors', async () => {
  const { wiring } = await connectedWiring();
  const result = await wiring.handleRequest({ threadId: 't1' }, { agentId: 'reader' });
  assert.equal(result.threadId, 't1');
  assert.equal(result.messages.length, 3);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.messages.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.equal(result.cursors.before, 'm1');
  assert.equal(result.cursors.after, 'm3');
  assert.ok(Object.isFrozen(result));
});

test('read: pagination — limit trims the page, after/before cursors page through', async () => {
  const { wiring } = await connectedWiring();
  const first = await wiring.handleRequest({ threadId: 't1', limit: 2 }, { agentId: 'reader' });
  assert.equal(first.messages.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.cursors.after, 'm2');

  const second = await wiring.handleRequest(
    { threadId: 't1', limit: 2, after: first.cursors.after },
    { agentId: 'reader' },
  );
  assert.deepEqual(second.messages.map((m) => m.id), ['m3']);
  assert.equal(second.hasMore, false);

  const before = await wiring.handleRequest(
    { threadId: 't1', before: 'm3' },
    { agentId: 'reader' },
  );
  assert.deepEqual(before.messages.map((m) => m.id), ['m1', 'm2']);
});

test('read: audit log records received + ok phases for every request', async () => {
  const { wiring, fake } = await connectedWiring();
  await wiring.handleRequest({ threadId: 't1', limit: 1 }, { agentId: 'auditee' });
  const entries = wiring.audit.filter((e) => e.kind === 'request');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].phase, 'received');
  assert.equal(entries[0].agentId, 'auditee');
  assert.equal(entries[0].requestId, entries[1].requestId);
  assert.equal(entries[1].phase, 'ok');
  assert.equal(entries[1].detail.messageCount, 1);
  assert.ok(entries.every((e) => typeof e.at === 'number' && e.at >= fake.now() - 1000));
  // append-only: the returned array is a copy
  const copy = wiring.audit;
  copy.length = 0;
  assert.ok(wiring.audit.length > 0);
});

// ---------------------------------------------------------------- invalid input

test('read: invalid inputs throw MCP_READ_INVALID (never silent)', async () => {
  const { wiring } = await connectedWiring();
  const bad = [
    undefined,
    null,
    't1',
    [],
    {},
    { threadId: '' },
    { threadId: '   ' },
    { threadId: 42 },
    { limit: 0 },
    { threadId: 't1', limit: 0 },
    { threadId: 't1', limit: -3 },
    { threadId: 't1', limit: MAX_LIMIT + 1 },
    { threadId: 't1', limit: 2.5 },
    { threadId: 't1', limit: '10' },
    { threadId: 't1', before: '' },
    { threadId: 't1', after: 7 },
  ];
  for (const input of bad) {
    await assertCoded(() => wiring.handleRequest(input, { agentId: 'reader' }), 'MCP_READ_INVALID');
  }
  // boundary limits are accepted
  for (const limit of [1, DEFAULT_LIMIT, MAX_LIMIT]) {
    const r = await wiring.handleRequest({ threadId: 't1', limit }, { agentId: 'reader' });
    assert.ok(r.messages.length <= limit);
  }
  // invalid requests never reach the backend
  const backend = { calls: 0, async readThread() { this.calls += 1; return { messages: [], hasMore: false }; } };
  const w3 = createReadThreadMcpWiring({
    transport: makeTransport(),
    threadBackend: backend,
  });
  await w3.connect();
  await assertCoded(() => w3.handleRequest({}), 'MCP_READ_INVALID');
  assert.equal(backend.calls, 0);
});

// ---------------------------------------------------------------- thread not found

test('read: unknown thread propagates as MCP_THREAD_NOT_FOUND', async () => {
  const { wiring } = await connectedWiring();
  const err = await assertCoded(
    () => wiring.handleRequest({ threadId: 'nope' }, { agentId: 'reader' }),
    'MCP_THREAD_NOT_FOUND',
  );
  assert.equal(err.detail.threadId, 'nope');
  const entries = wiring.audit.filter((e) => e.kind === 'request' && e.phase === 'error');
  assert.ok(entries.some((e) => e.code === 'MCP_THREAD_NOT_FOUND'));
});

test('read: backend failures wrap as MCP_BACKEND_ERROR', async () => {
  const fake = makeClock();
  const backend = {
    async readThread() {
      throw new Error('disk exploded');
    },
  };
  const wiring = createReadThreadMcpWiring({
    clock: fake.clock,
    delay: fake.delay,
    transport: makeTransport(),
    threadBackend: backend,
  });
  await wiring.connect();
  await assertCoded(() => wiring.handleRequest({ threadId: 't1' }), 'MCP_BACKEND_ERROR');
});

// ---------------------------------------------------------------- timeout

test('read: backend slower than requestTimeoutMs throws MCP_TIMEOUT', async () => {
  const fake = makeClock();
  // Backend advances the injected clock past the deadline, then answers —
  // the clock re-check after the backend settles trips the timeout.
  const backend = {
    async readThread() {
      fake.advance(DEFAULT_REQUEST_TIMEOUT_MS + 1);
      return { messages: [], hasMore: false };
    },
  };
  const wiring = createReadThreadMcpWiring({
    clock: fake.clock,
    delay: fake.delay,
    transport: makeTransport(),
    threadBackend: backend,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  });
  await wiring.connect();
  const err = await assertCoded(
    () => wiring.handleRequest({ threadId: 't1' }),
    'MCP_TIMEOUT',
  );
  assert.equal(err.detail.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
});

test('read: never-resolving backend trips the wall-clock race with MCP_TIMEOUT', async () => {
  const wiring = createReadThreadMcpWiring({
    transport: makeTransport(),
    threadBackend: { readThread: () => new Promise(() => {}) },
    requestTimeoutMs: 20,
  });
  await wiring.connect();
  await assertCoded(() => wiring.handleRequest({ threadId: 't1' }), 'MCP_TIMEOUT');
});

// ---------------------------------------------------------------- scope denial

test('read: scope denial throws MCP_SCOPE_DENIED and never touches the backend', async () => {
  const fake = makeClock();
  let backendCalls = 0;
  const backend = {
    async readThread() {
      backendCalls += 1;
      return { messages: [], hasMore: false };
    },
  };
  const wiring = createReadThreadMcpWiring({
    clock: fake.clock,
    delay: fake.delay,
    transport: makeTransport(),
    threadBackend: backend,
    scopeChecker: async ({ agentId, tool }) => {
      assert.equal(tool, TOOL_NAME);
      return agentId === 'allowed-agent';
    },
  });
  await wiring.connect();
  await assertCoded(
    () => wiring.handleRequest({ threadId: 't1' }, { agentId: 'blocked-agent' }),
    'MCP_SCOPE_DENIED',
  );
  assert.equal(backendCalls, 0);

  const ok = await wiring.handleRequest({ threadId: 't1' }, { agentId: 'allowed-agent' });
  assert.equal(ok.threadId, 't1');
  assert.equal(backendCalls, 1);
});

test('read: scopeChecker throwing is treated as denial (MCP_SCOPE_DENIED)', async () => {
  const { wiring } = await connectedWiring({
    deps: {
      scopeChecker: () => {
        throw new Error('policy service down');
      },
    },
  });
  await assertCoded(
    () => wiring.handleRequest({ threadId: 't1' }, { agentId: 'reader' }),
    'MCP_SCOPE_DENIED',
  );
});

// ---------------------------------------------------------------- coded-error contract

test('error contract: every failure is an Error with a string code', async () => {
  const { wiring } = await connectedWiring();
  // double-connect is illegal while already connected (check before the
  // disconnect entry below changes the state)
  await assertCoded(() => wiring.connect(), 'MCP_INVALID_STATE');
  const failures = [
    () => wiring.handleRequest({ threadId: 't1' }, { agentId: 'x' }).then(() => wiring.disconnect()).then(() => wiring.handleRequest({ threadId: 't1' })),
    () => wiring.handleRequest({}),
    () => wiring.handleRequest({ threadId: 'missing' }),
    () => Promise.resolve().then(() => wiring.register(42)),
  ];
  for (const fail of failures) {
    const err = await fail().then(
      () => assert.fail('expected a throw'),
      (e) => e,
    );
    assert.ok(err instanceof Error, 'must be an Error');
    assert.equal(typeof err.code, 'string', 'must carry a string code');
    assert.ok(err.code.length > 0);
  }
  // reconnect so subsequent tests on a fresh wiring are unaffected (fresh per test anyway)
  assert.ok(CONNECTION_STATES.includes(wiring.state));
});

test('error contract: exported constants are frozen and sane', () => {
  assert.deepEqual([...CONNECTION_STATES], [
    'disconnected',
    'connecting',
    'connected',
    'reconnecting',
    'closed',
  ]);
  assert.ok(Object.isFrozen(CONNECTION_STATES));
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(DEFAULT_LIMIT, 50);
  assert.equal(MAX_LIMIT, 200);
});
