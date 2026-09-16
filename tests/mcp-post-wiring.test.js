/**
 * mcp-post-wiring.test.js — tests for the room.post MCP wiring.
 *
 * Covers: lifecycle transitions, tool schema, valid post round-trip, invalid
 * input rejection, rate-limit enforcement + window reset, idempotency dedupe,
 * scope denial, backend timeout, reconnect semantics, and the coded-error
 * contract.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMcpPostWiring,
  toolSchema,
  TOOL_NAME,
  STATES,
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_TEXT_LENGTH,
} from '../src/mcp-post-wiring.mjs';

/** Controllable clock: { clock(), advance(ms) }. */
function fakeClock(start = 1_000_000) {
  const box = { now: start };
  return {
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/** Fake MCP transport recording connect/disconnect/registerTool calls. */
function fakeTransport({ failConnect = false } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      calls.push('connect');
      if (failConnect) throw new Error('boom: transport down');
    },
    async disconnect() {
      calls.push('disconnect');
    },
    async registerTool(schema) {
      calls.push(['registerTool', schema]);
    },
  };
}

/** Fake post backend; records payloads, resolves with {messageId, postedAt}. */
function fakeBackend() {
  const calls = [];
  let n = 0;
  return {
    calls,
    backend: async (payload) => {
      calls.push(payload);
      n += 1;
      return { messageId: `backend-msg-${n}`, postedAt: 9_999_999 };
    },
  };
}

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

const VALID_INPUT = () => ({ channel: '#general', text: 'hello room' });

describe('mcp-post-wiring', () => {
  let clock;
  let transport;
  let backend;

  beforeEach(() => {
    clock = fakeClock();
    transport = fakeTransport();
    backend = fakeBackend();
  });

  function wiring(deps = {}) {
    return createMcpPostWiring({
      clock: clock.clock,
      transport,
      postBackend: backend.backend,
      ...deps,
    });
  }

  it('exposes lifecycle states and constants', () => {
    assert.deepEqual([...STATES], ['disconnected', 'connecting', 'connected', 'reconnecting', 'closed']);
    assert.equal(TOOL_NAME, 'room.post');
    assert.equal(DEFAULT_RATE_LIMIT_PER_MIN, 30);
    assert.equal(DEFAULT_IDEMPOTENCY_TTL_MS, 10 * 60 * 1000);
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30_000);
    assert.equal(MAX_TEXT_LENGTH, 10_000);
    assert.equal(wiring().state, 'disconnected');
  });

  it('lifecycle: disconnected → connecting → connected → closed', async () => {
    const w = wiring();
    assert.equal(w.state, 'disconnected');
    await w.connect('agent-a');
    assert.equal(w.state, 'connected');
    assert.deepEqual(transport.calls, ['connect']);
    await w.disconnect('agent-a');
    assert.equal(w.state, 'closed');
    assert.deepEqual(transport.calls, ['connect', 'disconnect']);
    // closed → connect is allowed again
    await w.connect('agent-a');
    assert.equal(w.state, 'connected');
  });

  it('connect from connected throws MCP_INVALID_LIFECYCLE', async () => {
    const w = wiring();
    await w.connect();
    await expectMcpError(w.connect(), 'MCP_INVALID_LIFECYCLE');
    assert.equal(w.state, 'connected');
  });

  it('connect failure throws MCP_CONNECT_FAILED and returns to disconnected', async () => {
    const bad = fakeTransport({ failConnect: true });
    const w = createMcpPostWiring({ clock: clock.clock, transport: bad, postBackend: backend.backend });
    await expectMcpError(w.connect(), 'MCP_CONNECT_FAILED');
    assert.equal(w.state, 'disconnected');
  });

  it('reconnect: connected → reconnecting → connected; failure stays reconnecting', async () => {
    const w = wiring();
    await w.connect();
    await w.reconnect();
    assert.equal(w.state, 'connected');

    const flaky = fakeTransport();
    const w2 = createMcpPostWiring({ clock: clock.clock, transport: flaky, postBackend: backend.backend });
    await w2.connect();
    flaky.connect = async () => {
      throw new Error('network blip');
    };
    await expectMcpError(w2.reconnect(), 'MCP_CONNECT_FAILED');
    assert.equal(w2.state, 'reconnecting');
  });

  it('tool schema matches the room.post contract', async () => {
    const schema = toolSchema();
    assert.equal(schema.name, 'room.post');
    assert.deepEqual(schema.inputSchema.required, ['channel', 'text']);
    assert.ok(schema.inputSchema.properties.channel);
    assert.ok(schema.inputSchema.properties.text);
    assert.ok(schema.inputSchema.properties.threadId);
    assert.ok(schema.inputSchema.properties.attachments);
    assert.equal(schema.inputSchema.properties.text.maxLength, MAX_TEXT_LENGTH);
    assert.deepEqual(schema.inputSchema.properties.attachments.items.required, ['filename', 'mimeType']);

    const w = wiring();
    await w.connect();
    const registered = await w.registerTool();
    assert.deepEqual(registered, schema);
    assert.equal(transport.calls[1][0], 'registerTool');
    assert.deepEqual(transport.calls[1][1], schema);
    assert.ok(w.audit.some((e) => e.action === 'tool-registered'));
  });

  it('valid post round-trip returns {messageId, postedAt}', async () => {
    const w = wiring();
    await w.connect();
    const result = await w.handleRequest('room.post', VALID_INPUT(), { agentId: 'agent-a' });
    assert.equal(result.messageId, 'backend-msg-1');
    assert.equal(result.postedAt, 9_999_999);
    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0].channel, '#general');
    assert.equal(backend.calls[0].text, 'hello room');
    assert.equal(backend.calls[0].agentId, 'agent-a');
    assert.ok(w.audit.some((e) => e.action === 'post-succeeded'));
  });

  it('handleRequest before connect throws MCP_NOT_CONNECTED', async () => {
    const w = wiring();
    await expectMcpError(w.handleRequest('room.post', VALID_INPUT(), { agentId: 'a' }), 'MCP_NOT_CONNECTED');
    assert.equal(backend.calls.length, 0);
  });

  it('unknown tool throws MCP_UNKNOWN_TOOL', async () => {
    const w = wiring();
    await w.connect();
    await expectMcpError(w.handleRequest('room.delete', VALID_INPUT(), { agentId: 'a' }), 'MCP_UNKNOWN_TOOL');
    assert.equal(backend.calls.length, 0);
  });

  it('invalid input throws MCP_POST_INVALID (never reaches the backend)', async () => {
    const w = wiring();
    await w.connect();
    const badInputs = [
      {}, // missing channel + text
      { channel: '', text: 'x' }, // empty channel
      { channel: '   ', text: 'x' }, // blank channel
      { channel: '#g' }, // missing text
      { channel: '#g', text: '' }, // empty text
      { channel: '#g', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }, // too long
      { channel: '#g', text: 'x', threadId: 42 }, // bad threadId
      { channel: '#g', text: 'x', attachments: 'nope' }, // bad attachments
      { channel: '#g', text: 'x', attachments: [{ filename: 'a.exe' }] }, // missing mimeType
      { channel: '#g', text: 'x', attachments: [{ filename: 'a.exe', mimeType: 'application/x-msdownload' }] },
      { channel: '#g', text: 'x', attachments: [{ filename: 'run.sh', mimeType: 'text/x-shellscript' }] },
      { channel: '#g', text: 'x', attachments: [{ filename: 'p', mimeType: 'application/x-mach-binary' }] },
    ];
    for (const input of badInputs) {
      await expectMcpError(
        w.handleRequest('room.post', input, { agentId: 'a' }),
        'MCP_POST_INVALID',
      );
    }
    assert.equal(backend.calls.length, 0);
  });

  it('accepts benign attachments and optional threadId', async () => {
    const w = wiring();
    await w.connect();
    const result = await w.handleRequest(
      'room.post',
      {
        channel: '#g',
        text: 'with files',
        threadId: 't-1',
        attachments: [{ filename: 'pic.png', mimeType: 'image/png' }],
      },
      { agentId: 'a' },
    );
    assert.ok(result.messageId);
    assert.equal(backend.calls[0].threadId, 't-1');
    assert.deepEqual(backend.calls[0].attachments, [{ filename: 'pic.png', mimeType: 'image/png' }]);
  });

  it('rate limit: excess posts throw MCP_RATE_LIMITED; window reset re-allows', async () => {
    const w = wiring({ rateLimitPerMin: 2 });
    await w.connect();
    await w.handleRequest('room.post', VALID_INPUT(), { agentId: 'agent-a' });
    await w.handleRequest('room.post', VALID_INPUT(), { agentId: 'agent-a' });
    await expectMcpError(
      w.handleRequest('room.post', VALID_INPUT(), { agentId: 'agent-a' }),
      'MCP_RATE_LIMITED',
    );
    // Never silently dropped: the audit records the rejection.
    assert.ok(w.audit.some((e) => e.action === 'rate-limited'));
    assert.equal(backend.calls.length, 2);

    // A different agent still has its own budget.
    await w.handleRequest('room.post', VALID_INPUT(), { agentId: 'agent-b' });
    assert.equal(backend.calls.length, 3);

    // After the 60s window slides, the budget resets.
    clock.advance(61_000);
    await w.handleRequest('room.post', VALID_INPUT(), { agentId: 'agent-a' });
    assert.equal(backend.calls.length, 4);
  });

  it('idempotency: same clientToken within 10 min returns original result, no duplicate post', async () => {
    const w = wiring();
    await w.connect();
    const ctx = { agentId: 'a', clientToken: 'tok-123' };
    const first = await w.handleRequest('room.post', VALID_INPUT(), ctx);
    const second = await w.handleRequest('room.post', VALID_INPUT(), ctx);
    assert.deepEqual(second, first);
    assert.equal(backend.calls.length, 1);
    assert.ok(w.audit.some((e) => e.action === 'idempotent-replay'));

    // A different token is a different post.
    const third = await w.handleRequest('room.post', VALID_INPUT(), { agentId: 'a', clientToken: 'tok-456' });
    assert.notEqual(third.messageId, first.messageId);
    assert.equal(backend.calls.length, 2);

    // After the TTL the token expires and the post runs again.
    clock.advance(DEFAULT_IDEMPOTENCY_TTL_MS + 1);
    const fourth = await w.handleRequest('room.post', VALID_INPUT(), ctx);
    assert.notEqual(fourth.messageId, first.messageId);
    assert.equal(backend.calls.length, 3);
  });

  it('scope denial throws MCP_SCOPE_DENIED and never calls the backend', async () => {
    const w = wiring({ scopeChecker: (agentId, tool) => agentId !== 'blocked-bot' });
    await w.connect();
    await expectMcpError(
      w.handleRequest('room.post', VALID_INPUT(), { agentId: 'blocked-bot' }),
      'MCP_SCOPE_DENIED',
    );
    assert.equal(backend.calls.length, 0);
    // Allowed agent still posts fine.
    const ok = await w.handleRequest('room.post', VALID_INPUT(), { agentId: 'good-bot' });
    assert.ok(ok.messageId);
    assert.equal(backend.calls.length, 1);
  });

  it('backend timeout throws MCP_TIMEOUT', async () => {
    const hanging = { calls: [], backend: () => new Promise(() => {}) };
    const w = createMcpPostWiring({
      clock: clock.clock,
      transport,
      postBackend: hanging.backend,
      requestTimeoutMs: 25,
    });
    await w.connect();
    await expectMcpError(
      w.handleRequest('room.post', VALID_INPUT(), { agentId: 'a' }),
      'MCP_TIMEOUT',
    );
  });

  it('backend throw is wrapped as MCP_BACKEND_FAILED (never silent)', async () => {
    const failing = { backend: async () => { throw new Error('db gone'); } };
    const w = createMcpPostWiring({
      clock: clock.clock,
      transport,
      postBackend: failing.backend,
    });
    await w.connect();
    await assert.rejects(
      w.handleRequest('room.post', VALID_INPUT(), { agentId: 'a' }),
      (err) => {
        assert.equal(err.code, 'MCP_BACKEND_FAILED');
        assert.match(err.detail.cause, /db gone/);
        return true;
      },
    );
  });

  it('coded-error contract: every failure carries a code', async () => {
    const w = wiring();
    // handleRequest while disconnected
    await assert.rejects(w.handleRequest('room.post', VALID_INPUT()), (err) => {
      assert.ok(err instanceof Error && typeof err.code === 'string');
      assert.equal(err.code, 'MCP_NOT_CONNECTED');
      return true;
    });
    // validation failure carries its code too
    await w.connect();
    await assert.rejects(
      w.handleRequest('room.post', { channel: '#g' }, { agentId: 'a' }),
      (err) => err instanceof Error && err.code === 'MCP_POST_INVALID',
    );
  });

  it('audit log records lifecycle + post outcomes in order', async () => {
    const w = wiring();
    await w.connect('op');
    await w.registerTool('op');
    await w.handleRequest('room.post', VALID_INPUT(), { agentId: 'a' });
    await w.disconnect('op');
    const actions = w.audit.map((e) => e.action);
    assert.deepEqual(actions, [
      'lifecycle', // → connecting
      'lifecycle', // → connected
      'tool-registered',
      'post-validated',
      'post-succeeded',
      'lifecycle', // → closed
    ]);
    assert.ok(w.audit.every((e) => typeof e.at === 'number' && typeof e.actor === 'string'));
  });
});
