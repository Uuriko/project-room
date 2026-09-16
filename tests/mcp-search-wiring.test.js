/**
 * mcp-search-wiring.test.js — tests for the room.search MCP wiring.
 *
 * Covers: connection lifecycle, tool schema registration, valid round-trip,
 * input validation, backend error propagation, timeout, scope denial,
 * reconnect backoff, the coded-error contract, and the audit log.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMcpSearchWiring,
  TOOL_NAME,
  TOOL_SCHEMA,
  CONNECTION_STATES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_AUDIT_QUERY_CHARS,
} from '../src/mcp-search-wiring.mjs';

/** Controllable clock: { now, clock(), advance(ms) }. */
function fakeClock(start = 1_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/** Transport double with scripted connect() outcomes. */
function fakeTransport({ connectOutcomes = [null], onRegisterTool } = {}) {
  const calls = { connect: 0, disconnect: 0, registerTool: 0 };
  const schemas = [];
  let disconnectError = null;
  const transport = {
    calls,
    schemas,
    failDisconnectWith(err) {
      disconnectError = err;
    },
    async connect() {
      calls.connect += 1;
      const outcome = connectOutcomes[Math.min(calls.connect - 1, connectOutcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
    },
    async disconnect() {
      calls.disconnect += 1;
      if (disconnectError) throw disconnectError;
    },
    async registerTool(schema) {
      calls.registerTool += 1;
      schemas.push(schema);
      if (onRegisterTool) onRegisterTool(schema);
    },
  };
  return transport;
}

const BACKEND_RESULT = () => ({
  results: [
    { id: 'm1', text: 'hello world' },
    { id: 'm2', text: 'hello again' },
  ],
  total: 2,
});

function expectMcpError(promiseOrFn, code) {
  const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
  return assert.rejects(
    p,
    (err) => {
      assert.ok(err instanceof Error, 'expected an Error');
      assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
      return true;
    },
  );
}

/** A connected wiring with a working backend and permissive scope. */
async function connectedWiring(overrides = {}) {
  const transport = overrides.transport ?? fakeTransport();
  const wiring = createMcpSearchWiring({
    transport,
    searchBackend: overrides.searchBackend ?? (async () => BACKEND_RESULT()),
    scopeChecker: overrides.scopeChecker ?? (() => true),
    ...overrides.deps,
  });
  await wiring.connect('agent');
  return { wiring, transport };
}

describe('mcp-search-wiring', () => {
  it('starts disconnected and connects: disconnected → connecting → connected', async () => {
    const transport = fakeTransport();
    const wiring = createMcpSearchWiring({ transport });
    assert.equal(wiring.state, 'disconnected');

    await wiring.connect('agent');
    assert.equal(wiring.state, 'connected');

    const transitions = wiring.audit
      .filter((e) => e.kind === 'lifecycle')
      .map((e) => `${e.from}->${e.to}`);
    assert.deepEqual(transitions, ['disconnected->connecting', 'connecting->connected']);
  });

  it('registers the room.search tool schema on the transport at connect', async () => {
    const transport = fakeTransport();
    const wiring = createMcpSearchWiring({ transport });
    await wiring.connect('agent');
    assert.equal(transport.calls.registerTool, 1);
    assert.equal(transport.schemas[0], TOOL_SCHEMA);
    assert.equal(wiring.toolSchema.name, 'room.search');
  });

  it('connect works when the transport has no registerTool', async () => {
    const transport = { connect: async () => {}, disconnect: async () => {} };
    const wiring = createMcpSearchWiring({ transport });
    await wiring.connect('agent');
    assert.equal(wiring.state, 'connected');
  });

  it('disconnect: connected → closed, and is idempotent', async () => {
    const { wiring, transport } = await connectedWiring();
    await wiring.disconnect('agent');
    assert.equal(wiring.state, 'closed');
    assert.equal(transport.calls.disconnect, 1);

    // Second disconnect is a quiet no-op.
    await wiring.disconnect('agent');
    assert.equal(wiring.state, 'closed');
    assert.equal(transport.calls.disconnect, 1);
  });

  it('disconnect from disconnected lands on closed without touching the transport', async () => {
    const transport = fakeTransport();
    const wiring = createMcpSearchWiring({ transport });
    await wiring.disconnect('agent');
    assert.equal(wiring.state, 'closed');
    assert.equal(transport.calls.disconnect, 0);
  });

  it('disconnect still lands on closed when transport.disconnect throws', async () => {
    const transport = fakeTransport();
    transport.failDisconnectWith(new Error('boom'));
    const wiring = createMcpSearchWiring({ transport });
    await wiring.connect('agent');
    await wiring.disconnect('agent');
    assert.equal(wiring.state, 'closed');
    const last = wiring.audit.at(-1);
    assert.equal(last.to, 'closed');
    assert.match(last.detail.reason, /threw/);
  });

  it('connect is a no-op when already connected', async () => {
    const { wiring, transport } = await connectedWiring();
    await wiring.connect('agent');
    assert.equal(wiring.state, 'connected');
    assert.equal(transport.calls.connect, 1);
  });

  it('connect while connecting throws MCP_INVALID_STATE', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const transport = fakeTransport();
    transport.connect = async () => {
      transport.calls.connect += 1;
      await gate;
    };
    const wiring = createMcpSearchWiring({ transport });
    const first = wiring.connect('agent');
    await expectMcpError(() => wiring.connect('agent'), 'MCP_INVALID_STATE');
    release();
    await first;
    assert.equal(wiring.state, 'connected');
  });

  it('reconnects with the injected backoff delays, then registers once', async () => {
    const transport = fakeTransport({
      connectOutcomes: [new Error('net down'), new Error('still down'), null],
    });
    const { clock } = fakeClock();
    const wiring = createMcpSearchWiring({
      clock,
      transport,
      reconnectDelaysMs: [0, 5],
    });
    await wiring.connect('agent');

    assert.equal(wiring.state, 'connected');
    assert.equal(transport.calls.connect, 3);
    assert.equal(transport.calls.registerTool, 1);

    const transitions = wiring.audit
      .filter((e) => e.kind === 'lifecycle')
      .map((e) => `${e.from}->${e.to}`);
    assert.deepEqual(transitions, [
      'disconnected->connecting',
      'connecting->reconnecting',
      'reconnecting->connecting',
      'connecting->reconnecting',
      'reconnecting->connecting',
      'connecting->connected',
    ]);

    const reconnects = wiring.audit.filter((e) => e.to === 'reconnecting');
    assert.deepEqual(
      reconnects.map((e) => e.detail.delayMs),
      [0, 5],
    );
  });

  it('lands on closed and throws MCP_CONNECT_FAILED when retries are exhausted', async () => {
    const outcomes = [new Error('down')];
    const transport = fakeTransport({ connectOutcomes: outcomes });
    const wiring = createMcpSearchWiring({ transport, reconnectDelaysMs: [0, 0] });
    await expectMcpError(() => wiring.connect('agent'), 'MCP_CONNECT_FAILED');
    assert.equal(wiring.state, 'closed');
    assert.equal(transport.calls.connect, 3); // 1 initial + 2 backoff retries
    assert.equal(transport.calls.registerTool, 0);

    // A fresh connect from closed is allowed.
    outcomes.length = 0;
    outcomes.push(null);
    await wiring.connect('agent');
    assert.equal(wiring.state, 'connected');
  });

  it('valid search round-trip returns { results, total, tookMs }', async () => {
    const { clock, advance } = fakeClock();
    const seen = [];
    const { wiring } = await connectedWiring({
      deps: { clock },
      searchBackend: async (args) => {
        seen.push(args);
        advance(123);
        return BACKEND_RESULT();
      },
    });

    const res = await wiring.handleRequest({ query: 'hello', limit: 10 }, 'agent-1');
    assert.equal(res.requestId, 'req-1');
    assert.deepEqual([...res.results], BACKEND_RESULT().results);
    assert.equal(res.total, 2);
    assert.equal(res.tookMs, 123);
    assert.ok(Object.isFrozen(res));

    // Backend received the normalized args.
    assert.deepEqual(seen, [{ query: 'hello', limit: 10, channel: undefined }]);
  });

  it('defaults limit to 20 and passes channel through', async () => {
    const seen = [];
    const { wiring } = await connectedWiring({
      searchBackend: async (args) => {
        seen.push(args);
        return { results: [], total: 0 };
      },
    });
    const res = await wiring.handleRequest({ query: 'q', channel: 'general' }, 'agent-1');
    assert.equal(res.total, 0);
    assert.deepEqual(res.results, []);
    assert.deepEqual(seen, [{ query: 'q', limit: DEFAULT_SEARCH_LIMIT, channel: 'general' }]);
  });

  it('accepts limit boundaries 1 and 100', async () => {
    const { wiring } = await connectedWiring();
    for (const limit of [MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT]) {
      const res = await wiring.handleRequest({ query: 'q', limit }, 'agent-1');
      assert.equal(res.total, 2);
    }
  });

  it('rejects invalid input with MCP_SEARCH_INVALID', async () => {
    const { wiring } = await connectedWiring();
    const badInputs = [
      null,
      undefined,
      42,
      'query',
      [],
      {},
      { query: '' },
      { query: '   ' },
      { query: 42 },
      { query: 'q', limit: 0 },
      { query: 'q', limit: 101 },
      { query: 'q', limit: 1.5 },
      { query: 'q', limit: '10' },
      { query: 'q', limit: NaN },
      { query: 'q', channel: '' },
      { query: 'q', channel: 42 },
    ];
    for (const input of badInputs) {
      await expectMcpError(
        () => wiring.handleRequest(input, 'agent-1'),
        'MCP_SEARCH_INVALID',
      );
    }
  });

  it('rejects handleRequest while not connected with MCP_NOT_CONNECTED', async () => {
    const wiring = createMcpSearchWiring({ transport: fakeTransport() });
    await expectMcpError(
      () => wiring.handleRequest({ query: 'q' }, 'agent-1'),
      'MCP_NOT_CONNECTED',
    );

    await wiring.connect('agent');
    await wiring.disconnect('agent');
    await expectMcpError(
      () => wiring.handleRequest({ query: 'q' }, 'agent-1'),
      'MCP_NOT_CONNECTED',
    );
  });

  it('denies unscoped agents with MCP_SCOPE_DENIED', async () => {
    const { wiring } = await connectedWiring({
      scopeChecker: (agentId, tool) => {
        assert.equal(tool, TOOL_NAME);
        return agentId === 'agent-1';
      },
    });
    const ok = await wiring.handleRequest({ query: 'q' }, 'agent-1');
    assert.equal(ok.total, 2);
    await expectMcpError(() => wiring.handleRequest({ query: 'q' }, 'agent-2'), 'MCP_SCOPE_DENIED');
  });

  it('denies missing agent ids with MCP_SCOPE_DENIED', async () => {
    const { wiring } = await connectedWiring();
    for (const agentId of [undefined, null, '', '   ']) {
      await expectMcpError(
        () => wiring.handleRequest({ query: 'q' }, agentId),
        'MCP_SCOPE_DENIED',
      );
    }
  });

  it('propagates backend failures as MCP_BACKEND_ERROR (never silent)', async () => {
    const boom = new Error('index exploded');
    const { wiring } = await connectedWiring({
      searchBackend: async () => {
        throw boom;
      },
    });
    await expectMcpError(() => wiring.handleRequest({ query: 'q' }, 'a1'), 'MCP_BACKEND_ERROR');

    const { wiring: syncWiring } = await connectedWiring({
      searchBackend: () => {
        throw boom;
      },
    });
    await expectMcpError(() => syncWiring.handleRequest({ query: 'q' }, 'a1'), 'MCP_BACKEND_ERROR');

    // Malformed backend results are backend errors too.
    for (const malformed of [
      null,
      { results: 'nope' },
      { results: [], total: -1 },
      { results: [], total: 1.5 },
    ]) {
      const { wiring: badWiring } = await connectedWiring({
        searchBackend: async () => malformed,
      });
      await expectMcpError(
        () => badWiring.handleRequest({ query: 'q' }, 'a1'),
        'MCP_BACKEND_ERROR',
      );
    }
  });

  it('fails closed when no searchBackend is injected', async () => {
    const wiring = createMcpSearchWiring({ transport: fakeTransport() });
    await wiring.connect('agent');
    await expectMcpError(() => wiring.handleRequest({ query: 'q' }, 'a1'), 'MCP_BACKEND_ERROR');
  });

  it('times out via the injected clock deadline and reports MCP_TIMEOUT', async () => {
    const { clock } = fakeClock();
    const { wiring } = await connectedWiring({
      deps: { clock, timeoutMs: 25 },
      searchBackend: () => new Promise(() => {}), // never settles
    });
    await expectMcpError(() => wiring.handleRequest({ query: 'q' }, 'a1'), 'MCP_TIMEOUT');

    const errorEntry = wiring.audit.filter((e) => e.phase === 'error').at(-1);
    assert.equal(errorEntry.errorCode, 'MCP_TIMEOUT');
    assert.equal(errorEntry.detail.timeoutMs, 25);
  });

  it('a slow-but-in-time backend does not time out', async () => {
    const { clock } = fakeClock();
    const { wiring } = await connectedWiring({
      deps: { clock, timeoutMs: 50 },
      searchBackend: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(BACKEND_RESULT()), 10);
        }),
    });
    const res = await wiring.handleRequest({ query: 'q' }, 'a1');
    assert.equal(res.total, 2);
  });

  it('audit log records request, response, and error phases', async () => {
    const { clock, advance } = fakeClock();
    let scopeCalls = 0;
    const { wiring } = await connectedWiring({
      deps: { clock },
      searchBackend: async () => BACKEND_RESULT(),
      scopeChecker: () => {
        scopeCalls += 1;
        return scopeCalls === 1; // allow the first request, deny the rest
      },
    });

    advance(7);
    const res = await wiring.handleRequest({ query: 'hello' }, 'agent-1');
    advance(3);
    await expectMcpError(() => wiring.handleRequest({ query: 'nope' }, 'agent-1'), 'MCP_SCOPE_DENIED');

    const reqs = wiring.audit.filter((e) => e.kind === 'request');
    assert.deepEqual(
      reqs.map((e) => e.phase),
      ['request', 'response', 'request', 'error'],
    );

    const [requestEntry, responseEntry] = reqs;
    assert.equal(requestEntry.requestId, res.requestId);
    assert.equal(requestEntry.agent, 'agent-1');
    assert.equal(requestEntry.tool, TOOL_NAME);
    assert.deepEqual(requestEntry.input, { query: 'hello', limit: undefined, channel: undefined });
    assert.ok(typeof requestEntry.at === 'number');

    assert.equal(responseEntry.requestId, res.requestId);
    assert.equal(responseEntry.output.total, 2);
    assert.equal(responseEntry.output.resultCount, 2);

    const errorEntry = reqs.at(-1);
    assert.equal(errorEntry.errorCode, 'MCP_SCOPE_DENIED');

    // Append-only: earlier entries are never disturbed by later activity.
    const snapshot = wiring.audit.map((e) => `${e.kind}:${e.phase ?? `${e.from}->${e.to}`}`);
    await wiring.handleRequest({ query: 'again' }, 'agent-1').catch(() => {});
    assert.ok(wiring.audit.length > snapshot.length);
    assert.deepEqual(
      wiring.audit.slice(0, snapshot.length).map((e) => `${e.kind}:${e.phase ?? `${e.from}->${e.to}`}`),
      snapshot,
    );
  });

  it('caps long queries in the audit log at 200 chars', async () => {
    const { wiring } = await connectedWiring();
    const longQuery = 'x'.repeat(250);
    const res = await wiring.handleRequest({ query: longQuery }, 'agent-1');
    assert.equal(res.total, 2);

    const requestEntry = wiring.audit.find(
      (e) => e.kind === 'request' && e.phase === 'request',
    );
    assert.equal(requestEntry.input.query.length, MAX_AUDIT_QUERY_CHARS);
    assert.equal(requestEntry.input.query, 'x'.repeat(MAX_AUDIT_QUERY_CHARS));
  });

  it('every failure carries a coded error', async () => {
    const { wiring } = await connectedWiring({
      searchBackend: async () => {
        throw new Error('uncoded backend failure');
      },
    });
    const codes = new Set();
    const attempts = [
      () => wiring.handleRequest({ query: '' }, 'a1'),
      () => wiring.handleRequest({ query: 'q' }, 'a1'),
      () => wiring.handleRequest({ query: 'q' }, ''),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
        assert.fail('expected a throw');
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok(typeof err.code === 'string' && err.code.length > 0, 'error must have a code');
        assert.ok(err.code.startsWith('MCP_'), `code should be MCP_*, got ${err.code}`);
        codes.add(err.code);
      }
    }
    assert.deepEqual([...codes].sort(), ['MCP_BACKEND_ERROR', 'MCP_SCOPE_DENIED', 'MCP_SEARCH_INVALID']);

    // Not-connected path is coded too.
    const fresh = createMcpSearchWiring({ transport: fakeTransport() });
    await assert.rejects(() => fresh.handleRequest({ query: 'q' }, 'a1'), (err) => {
      assert.equal(err.code, 'MCP_NOT_CONNECTED');
      return true;
    });
  });

  it('uses the injected id generator for request ids', async () => {
    const { wiring } = await connectedWiring({ deps: { id: () => 'custom-id-7' } });
    const res = await wiring.handleRequest({ query: 'q' }, 'a1');
    assert.equal(res.requestId, 'custom-id-7');
  });

  it('CONNECTION_STATES covers the lifecycle and defaults are sane', () => {
    assert.deepEqual([...CONNECTION_STATES].sort(), [
      'closed',
      'connected',
      'connecting',
      'disconnected',
      'reconnecting',
    ]);
    assert.equal(TOOL_NAME, 'room.search');
    assert.equal(DEFAULT_TIMEOUT_MS, 30_000);

    const wiring = createMcpSearchWiring();
    assert.equal(wiring.timeoutMs, 30_000);
    assert.deepEqual(wiring.reconnectDelaysMs, [1000, 2000, 5000]);
    assert.equal(wiring.state, 'disconnected');
  });
});
