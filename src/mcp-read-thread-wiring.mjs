/**
 * mcp-read-thread-wiring.mjs — Pure MCP tool wiring for `room.read-thread`.
 *
 * Registers the `room.read-thread` tool on an injected MCP transport and routes
 * tool calls to an injected thread backend. Nothing here touches the network,
 * the DOM, localStorage, or any secret — the transport, clock, id generator,
 * scope checker and thread backend are all injected, so the wiring is a pure
 * adapter/state machine and is fully testable with fakes.
 *
 * Connection lifecycle:
 *   disconnected → connecting → connected → (reconnecting → connected) → closed
 *   `closed` may connect again (→ connecting → connected).
 *
 * Tool schema (registered verbatim):
 *   { name: 'room.read-thread',
 *     inputSchema: { threadId, limit?, before?, after? } }
 *   - threadId: required, non-empty string — the thread to read.
 *   - limit:    optional integer, 1..200 (default 50).
 *   - before:   optional message-id string — return messages before this id.
 *   - after:    optional message-id string — return messages after this id.
 *
 * Successful reads return { threadId, messages[], hasMore, cursors } where
 * `cursors.before` / `cursors.after` are message ids usable for paging.
 *
 * Dependency injection (all via the `deps` parameter of createReadThreadMcpWiring):
 *   - clock:           () => number  (ms epoch; default: Date.now)
 *   - id:              () => string  (request id generator; default: per-wiring counter)
 *   - delay:           (ms: number) => Promise<void> (default: real setTimeout)
 *   - transport:       { connect?, disconnect? } | null (MCP transport; default: null)
 *   - threadBackend:   { readThread({threadId, limit, before, after}) } (required for reads)
 *   - scopeChecker:    (scope: {agentId, tool, input}) => boolean | Promise<boolean>
 *                      (default: allow all — production MUST inject a real checker)
 *   - requestTimeoutMs:number        (default: 30_000)
 *   - defaultLimit:    number        (default: 50)
 *
 * The injected `delay` + `clock` together enforce the request timeout: a real
 * timer races the backend for wall-clock enforcement, and the injected clock
 * re-checks the deadline after the backend settles (so a fake clock that the
 * backend advances also trips the timeout deterministically).
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   MCP_NOT_CONNECTED   — read attempted while not connected
 *   MCP_INVALID_STATE   — connect/disconnect/reconnect from a wrong state
 *   MCP_READ_INVALID    — input failed validation (missing threadId, bad limit, ...)
 *   MCP_SCOPE_DENIED    — injected scopeChecker refused the call
 *   MCP_THREAD_NOT_FOUND— threadBackend reported an unknown thread
 *   MCP_TIMEOUT         — backend did not answer within requestTimeoutMs
 *   MCP_BACKEND_ERROR   — threadBackend threw a non-timeout, non-not-found error
 *   MCP_TRANSPORT_ERROR — register/connect/disconnect on the transport failed
 * Failures are never silent.
 */

export const TOOL_NAME = 'room.read-thread';

export const CONNECTION_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'closed',
]);

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const MIN_LIMIT = 1;

/** Tool schema registered on the transport, verbatim. */
export const TOOL_SCHEMA = Object.freeze({
  name: TOOL_NAME,
  inputSchema: Object.freeze({
    type: 'object',
    required: ['threadId'],
    properties: Object.freeze({
      threadId: { type: 'string', description: 'Thread to read' },
      limit: { type: 'integer', minimum: MIN_LIMIT, maximum: MAX_LIMIT, description: 'Max messages (default 50)' },
      before: { type: 'string', description: 'Return messages before this message id' },
      after: { type: 'string', description: 'Return messages after this message id' },
    }),
  }),
});

/** Throw a coded MCP wiring error (never silent failures). */
function mcpError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Create the read-thread MCP wiring adapter.
 * @param {object} [deps]
 */
export function createReadThreadMcpWiring(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const transport = deps.transport ?? null;
  const threadBackend = deps.threadBackend ?? null;
  const scopeChecker = deps.scopeChecker ?? (() => true);
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const defaultLimit = deps.defaultLimit ?? DEFAULT_LIMIT;

  let idCounter = 0;
  const newId = deps.id ?? (() => `rt-${(idCounter += 1)}`);

  let state = 'disconnected';

  /** Append-only audit log of tool requests: never mutated, never removed. */
  const audit = [];

  function record(entry) {
    const frozen = Object.freeze({ at: clock(), ...entry });
    audit.push(frozen);
    return frozen;
  }

  function setState(next, detail) {
    const from = state;
    state = next;
    record({ kind: 'state', from, to: next, ...(detail ?? {}) });
    return next;
  }

  function assertState(allowed, op) {
    if (!allowed.includes(state)) {
      throw mcpError(
        'MCP_INVALID_STATE',
        `Cannot ${op} from connection state '${state}'`,
        { state, op },
      );
    }
  }

  async function withTransport(op, fn) {
    if (!transport) {
      throw mcpError(
        'MCP_TRANSPORT_ERROR',
        `Cannot ${op}: no transport was injected`,
        { op },
      );
    }
    try {
      return await fn(transport);
    } catch (err) {
      if (err && err.code && String(err.code).startsWith('MCP_')) throw err;
      throw mcpError(
        'MCP_TRANSPORT_ERROR',
        `Transport ${op} failed: ${err?.message ?? String(err)}`,
        { op },
      );
    }
  }

  /** Validate raw tool input; returns normalized {threadId, limit, before, after}. */
  function validateInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw mcpError('MCP_READ_INVALID', 'Input must be an object', { input });
    }
    const { threadId, limit, before, after } = input;
    if (typeof threadId !== 'string' || threadId.trim() === '') {
      throw mcpError('MCP_READ_INVALID', 'threadId is required and must be a non-empty string', {
        threadId,
      });
    }
    let normalizedLimit = defaultLimit;
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
        throw mcpError(
          'MCP_READ_INVALID',
          `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
          { limit },
        );
      }
      normalizedLimit = limit;
    }
    for (const [key, value] of [
      ['before', before],
      ['after', after],
    ]) {
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        throw mcpError('MCP_READ_INVALID', `${key} must be a non-empty message id string`, {
          [key]: value,
        });
      }
    }
    return {
      threadId,
      limit: normalizedLimit,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    };
  }

  /** Normalize the backend result into {threadId, messages[], hasMore, cursors}. */
  function normalizeResult(threadId, raw) {
    const messages = Array.isArray(raw?.messages) ? raw.messages : [];
    const hasMore = raw?.hasMore === true;
    const first = messages[0];
    const last = messages[messages.length - 1];
    const idOf = (m) => (m && (m.id ?? m.messageId)) ?? null;
    return Object.freeze({
      threadId,
      messages: Object.freeze([...messages]),
      hasMore,
      cursors: Object.freeze({
        before: hasMore || messages.length > 0 ? idOf(first) : null,
        after: hasMore || messages.length > 0 ? idOf(last) : null,
      }),
    });
  }

  const wiring = {
    /** Current connection state. */
    get state() {
      return state;
    },

    /** Append-only audit trail of state changes and tool requests. */
    get audit() {
      return [...audit];
    },

    get requestTimeoutMs() {
      return requestTimeoutMs;
    },

    /** The tool schema registered on the transport (frozen). */
    get toolSchema() {
      return TOOL_SCHEMA;
    },

    /**
     * Open the connection: disconnected|closed → connecting → connected.
     * If the injected transport exposes connect(), it is awaited.
     */
    async connect() {
      assertState(['disconnected', 'closed'], 'connect');
      setState('connecting');
      try {
        await withTransport('connect', async (t) =>
          typeof t.connect === 'function' ? t.connect() : undefined,
        );
      } catch (err) {
        setState('disconnected', { reason: 'connect failed' });
        throw err;
      }
      return setState('connected');
    },

    /**
     * Re-establish the connection: connected → reconnecting → connected.
     */
    async reconnect() {
      assertState(['connected'], 'reconnect');
      setState('reconnecting');
      try {
        await withTransport('reconnect', async (t) =>
          typeof t.connect === 'function' ? t.connect() : undefined,
        );
      } catch (err) {
        setState('connected', { reason: 'reconnect failed, still connected' });
        throw err;
      }
      return setState('connected');
    },

    /**
     * Close the connection from any state: → closed.
     */
    async disconnect() {
      if (state === 'closed') return state;
      const from = state;
      setState('closed', { from });
      await withTransport('disconnect', async (t) =>
        typeof t.disconnect === 'function' ? t.disconnect() : undefined,
      ).catch(() => {
        // Closing is best-effort: the state transition itself is already
        // recorded; transport errors on teardown must not reopen the link.
      });
      return state;
    },

    /**
     * Register the `room.read-thread` tool on the transport.
     * @param {(schema: object, handler: Function) => any} registerFn
     */
    register(registerFn) {
      if (typeof registerFn !== 'function') {
        throw mcpError('MCP_TRANSPORT_ERROR', 'register requires a register function', {});
      }
      try {
        return registerFn(TOOL_SCHEMA, (input, context) => wiring.handleRequest(input, context));
      } catch (err) {
        if (err && err.code && String(err.code).startsWith('MCP_')) throw err;
        throw mcpError(
          'MCP_TRANSPORT_ERROR',
          `Tool registration failed: ${err?.message ?? String(err)}`,
          {},
        );
      }
    },

    /**
     * Handle one `room.read-thread` tool call.
     * @param {object} input   raw tool input
     * @param {object} [context] { agentId }
     */
    async handleRequest(input, context = {}) {
      const requestId = newId();
      const agentId = context?.agentId ?? 'anonymous';

      if (state !== 'connected') {
        const err = mcpError(
          'MCP_NOT_CONNECTED',
          `Cannot handle ${TOOL_NAME} while connection state is '${state}'`,
          { requestId, agentId, state },
        );
        record({ kind: 'request', requestId, agentId, phase: 'error', code: err.code });
        throw err;
      }

      let normalized;
      try {
        normalized = validateInput(input);
      } catch (err) {
        record({
          kind: 'request',
          requestId,
          agentId,
          phase: 'error',
          code: err.code,
          detail: { input },
        });
        throw err;
      }

      record({
        kind: 'request',
        requestId,
        agentId,
        phase: 'received',
        detail: { ...normalized },
      });

      // Per-agent scope check (injected; default allows all).
      let allowed;
      try {
        allowed = await scopeChecker({ agentId, tool: TOOL_NAME, input: normalized });
      } catch (err) {
        const scopeErr = mcpError(
          'MCP_SCOPE_DENIED',
          `Scope check for agent '${agentId}' failed: ${err?.message ?? String(err)}`,
          { requestId, agentId },
        );
        record({ kind: 'request', requestId, agentId, phase: 'error', code: scopeErr.code });
        throw scopeErr;
      }
      if (!allowed) {
        const denied = mcpError(
          'MCP_SCOPE_DENIED',
          `Agent '${agentId}' is not scoped for ${TOOL_NAME}`,
          { requestId, agentId, tool: TOOL_NAME },
        );
        record({ kind: 'request', requestId, agentId, phase: 'error', code: denied.code });
        throw denied;
      }

      if (!threadBackend || typeof threadBackend.readThread !== 'function') {
        const missing = mcpError(
          'MCP_BACKEND_ERROR',
          'No threadBackend.readThread was injected',
          { requestId, agentId },
        );
        record({ kind: 'request', requestId, agentId, phase: 'error', code: missing.code });
        throw missing;
      }

      // Request timeout: wall-clock race via injected `delay`, plus a
      // deadline re-check with the injected `clock` after the backend settles.
      const startedAt = clock();
      const deadline = startedAt + requestTimeoutMs;
      const timeoutError = () =>
        mcpError('MCP_TIMEOUT', `${TOOL_NAME} timed out after ${requestTimeoutMs}ms`, {
          requestId,
          agentId,
          threadId: normalized.threadId,
          requestTimeoutMs,
        });

      const backendPromise = (async () => {
        try {
          const raw = await threadBackend.readThread(normalized);
          if (clock() >= deadline) throw timeoutError();
          return normalizeResult(normalized.threadId, raw);
        } catch (err) {
          if (err && err.code === 'MCP_TIMEOUT') throw err;
          const code = err?.code;
          if (code === 'THREAD_NOT_FOUND' || code === 'MCP_THREAD_NOT_FOUND') {
            throw mcpError('MCP_THREAD_NOT_FOUND', `Thread not found: ${normalized.threadId}`, {
              requestId,
              agentId,
              threadId: normalized.threadId,
            });
          }
          throw mcpError(
            'MCP_BACKEND_ERROR',
            `threadBackend.readThread failed: ${err?.message ?? String(err)}`,
            { requestId, agentId, threadId: normalized.threadId },
          );
        }
      })();

      let result;
      try {
        result = await Promise.race([
          backendPromise,
          delay(requestTimeoutMs).then(() => {
            throw timeoutError();
          }),
        ]);
      } catch (err) {
        record({
          kind: 'request',
          requestId,
          agentId,
          phase: 'error',
          code: err?.code ?? 'MCP_BACKEND_ERROR',
          detail: { threadId: normalized.threadId },
        });
        throw err;
      }

      record({
        kind: 'request',
        requestId,
        agentId,
        phase: 'ok',
        detail: { threadId: result.threadId, messageCount: result.messages.length, hasMore: result.hasMore },
      });
      return result;
    },
  };

  return Object.freeze(wiring);
}
