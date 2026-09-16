/**
 * mcp-search-wiring.mjs — Pure MCP tool wiring for the `room.search` tool.
 *
 * An adapter between the room's search backend and an injected MCP transport.
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * the MCP transport is an injected dependency, so this module is pure wiring
 * and state machine.
 *
 * Connection lifecycle:
 *   disconnected → connecting → connected → (reconnecting | closed)
 * A failed `connect()` attempt moves the machine to `reconnecting` and retries
 * with the injected backoff delays; when the delays are exhausted the machine
 * lands on `closed` and `connect()` throws MCP_CONNECT_FAILED.
 *
 * Tool schema registered on the transport at connect time:
 *   { name: 'room.search',
 *     inputSchema: { query, limit, channel? } }
 *
 * handleRequest(agentId, input) flow:
 *   1. require state === 'connected'                      (else MCP_NOT_CONNECTED)
 *   2. validate input: non-empty query, limit 1..100      (else MCP_SEARCH_INVALID)
 *   3. per-agent scope check via injected scopeChecker    (else MCP_SCOPE_DENIED)
 *   4. delegate to the injected searchBackend with a request timeout driven
 *      by the injected clock (default 30s)                (else MCP_TIMEOUT /
 *                                                          MCP_BACKEND_ERROR)
 *   5. return { results, total, tookMs }
 *
 * Dependency injection (all via the `deps` parameter of createMcpSearchWiring):
 *   - clock:             () => number  (ms epoch; default: Date.now)
 *   - id:                () => string  (request id generator; default: per-wiring counter)
 *   - transport:         injected MCP transport:
 *                          { connect(), disconnect(), registerTool?(schema) }
 *                        each may return a promise or a plain value.
 *                        Default: a no-op transport (production MUST inject a real one).
 *   - searchBackend:     async ({ query, limit, channel }) => { results, total }
 *                        Default: throws MCP_BACKEND_ERROR (fail closed — a search
 *                        tool with no backend must never pretend to work).
 *   - scopeChecker:      (agentId, toolName) => boolean | Promise<boolean>
 *                        Default: allow-all (production MUST inject a real one).
 *   - timeoutMs:         number  (request timeout; default: 30_000)
 *   - reconnectDelaysMs: number[] (backoff between connect retries; default: [1000, 2000, 5000])
 *   - schedule:          (fn, ms) => handle  (timer injection; default: setTimeout)
 *   - unschedule:        (handle) => void    (timer injection; default: clearTimeout)
 *
 * The audit log records every lifecycle transition and every request/response/
 * error. Queries are not secrets, so they are kept — only their length is
 * capped (MAX_AUDIT_QUERY_CHARS) to bound log growth.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   MCP_NOT_CONNECTED   — handleRequest called while not connected
 *   MCP_INVALID_STATE   — connect() called while connecting/reconnecting
 *   MCP_SEARCH_INVALID  — bad tool input (empty query, limit out of 1..100, bad channel)
 *   MCP_SCOPE_DENIED    — scopeChecker refused the agent for room.search
 *   MCP_TIMEOUT         — searchBackend did not settle within timeoutMs
 *   MCP_BACKEND_ERROR   — searchBackend threw or returned a malformed result
 *   MCP_CONNECT_FAILED  — transport.connect() failed through the whole backoff
 * Failures are never silent.
 */

export const TOOL_NAME = 'room.search';

export const CONNECTION_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'closed',
]);

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 5000]);
export const DEFAULT_SEARCH_LIMIT = 20;
export const MIN_SEARCH_LIMIT = 1;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_AUDIT_QUERY_CHARS = 200;

/** The tool schema registered on the MCP transport at connect time. */
export const TOOL_SCHEMA = Object.freeze({
  name: TOOL_NAME,
  description:
    'Search room content (messages, files, work items). ' +
    'Returns matching results with a total count.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      query: Object.freeze({
        type: 'string',
        minLength: 1,
        description: 'Search query; must be a non-empty string.',
      }),
      limit: Object.freeze({
        type: 'integer',
        minimum: MIN_SEARCH_LIMIT,
        maximum: MAX_SEARCH_LIMIT,
        default: DEFAULT_SEARCH_LIMIT,
        description: `Max results to return (${MIN_SEARCH_LIMIT}..${MAX_SEARCH_LIMIT}).`,
      }),
      channel: Object.freeze({
        type: 'string',
        description: 'Optional channel to scope the search to.',
      }),
    }),
    required: Object.freeze(['query']),
    additionalProperties: false,
  }),
});

/** Throw a coded wiring error (never silent failures). */
function mcpError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Queries are not secrets: keep them in the audit log, but cap the length. */
function capQuery(query) {
  if (typeof query !== 'string') return query;
  return query.length > MAX_AUDIT_QUERY_CHARS
    ? query.slice(0, MAX_AUDIT_QUERY_CHARS)
    : query;
}

/**
 * Create the room.search MCP wiring.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {object} [deps.transport]
 * @param {(args: object) => Promise<object>} [deps.searchBackend]
 * @param {(agentId: string, toolName: string) => boolean | Promise<boolean>} [deps.scopeChecker]
 * @param {number} [deps.timeoutMs]
 * @param {number[]} [deps.reconnectDelaysMs]
 * @param {(fn: () => void, ms: number) => unknown} [deps.schedule]
 * @param {(handle: unknown) => void} [deps.unschedule]
 */
export function createMcpSearchWiring(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reconnectDelaysMs = deps.reconnectDelaysMs ?? [...DEFAULT_RECONNECT_DELAYS_MS];
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule = deps.unschedule ?? ((handle) => clearTimeout(handle));

  const transport = deps.transport ?? {
    connect: () => {},
    disconnect: () => {},
  };

  // Fail closed: a search tool with no backend must never pretend to work.
  const searchBackend =
    deps.searchBackend ??
    (() => {
      throw mcpError(
        'MCP_BACKEND_ERROR',
        'No searchBackend injected for room.search',
        { tool: TOOL_NAME },
      );
    });

  // Default allow-all; production MUST inject a real per-agent scope check.
  const scopeChecker = deps.scopeChecker ?? (() => true);

  let idCounter = 0;
  const newId = deps.id ?? (() => `req-${(idCounter += 1)}`);

  let state = 'disconnected';

  /** Append-only audit log: lifecycle transitions + request/response/error records. */
  const audit = [];

  function record(entry) {
    audit.push(Object.freeze({ at: clock(), ...entry }));
  }

  function transition(to, actor, detail) {
    const from = state;
    state = to;
    record({
      kind: 'lifecycle',
      from,
      to,
      actor,
      detail: detail === undefined ? null : detail,
    });
    return to;
  }

  function assertAgentId(agentId) {
    if (typeof agentId !== 'string' || agentId.trim() === '') {
      throw mcpError('MCP_SCOPE_DENIED', 'room.search requires an identified agent', {
        tool: TOOL_NAME,
        agentId: agentId ?? null,
      });
    }
    return agentId.trim();
  }

  function validateInput(input, requestId) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw mcpError('MCP_SEARCH_INVALID', 'room.search input must be an object', {
        requestId,
        tool: TOOL_NAME,
      });
    }
    const query = input.query;
    if (typeof query !== 'string' || query.trim() === '') {
      throw mcpError('MCP_SEARCH_INVALID', 'room.search requires a non-empty query string', {
        requestId,
        tool: TOOL_NAME,
      });
    }
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    if (!Number.isInteger(limit) || limit < MIN_SEARCH_LIMIT || limit > MAX_SEARCH_LIMIT) {
      throw mcpError(
        'MCP_SEARCH_INVALID',
        `room.search limit must be an integer ${MIN_SEARCH_LIMIT}..${MAX_SEARCH_LIMIT}`,
        { requestId, tool: TOOL_NAME, limit: input.limit ?? null },
      );
    }
    let channel;
    if (input.channel !== undefined) {
      if (typeof input.channel !== 'string' || input.channel.trim() === '') {
        throw mcpError(
          'MCP_SEARCH_INVALID',
          'room.search channel, when provided, must be a non-empty string',
          { requestId, tool: TOOL_NAME },
        );
      }
      channel = input.channel.trim();
    }
    return { query: query.trim(), limit, channel };
  }

  function normalizeBackendResult(result, requestId) {
    if (result === null || typeof result !== 'object' || !Array.isArray(result.results)) {
      throw mcpError(
        'MCP_BACKEND_ERROR',
        'room.search backend returned a malformed result (expected { results: [], total? })',
        { requestId, tool: TOOL_NAME },
      );
    }
    const total =
      result.total === undefined ? result.results.length : result.total;
    if (!Number.isInteger(total) || total < 0) {
      throw mcpError(
        'MCP_BACKEND_ERROR',
        'room.search backend returned a malformed total (expected a non-negative integer)',
        { requestId, tool: TOOL_NAME },
      );
    }
    return { results: result.results, total };
  }

  /** Race the backend against the injected-clock deadline. */
  function withTimeout(backendPromise, requestId) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = schedule(() => {
        reject(
          mcpError('MCP_TIMEOUT', `room.search timed out after ${timeoutMs}ms`, {
            requestId,
            tool: TOOL_NAME,
            timeoutMs,
          }),
        );
      }, timeoutMs);
    });
    // Attach a no-op catch so a late backend rejection after a timeout win is
    // never an unhandled rejection; the race still observes the real outcome.
    backendPromise.catch(() => {});
    return Promise.race([backendPromise, deadline]).finally(() => {
      unschedule(timer);
    });
  }

  async function tryConnectOnce() {
    await transport.connect();
    if (typeof transport.registerTool === 'function') {
      await transport.registerTool(TOOL_SCHEMA);
    }
  }

  const wiring = {
    /** Current connection lifecycle state. */
    get state() {
      return state;
    },

    /** The tool schema registered on the transport at connect time. */
    get toolSchema() {
      return TOOL_SCHEMA;
    },

    get timeoutMs() {
      return timeoutMs;
    },

    get reconnectDelaysMs() {
      return [...reconnectDelaysMs];
    },

    /** Append-only audit trail of lifecycle transitions and requests. */
    get audit() {
      return [...audit];
    },

    /**
     * Connect the transport and register the room.search tool schema.
     * Retries through the injected backoff delays; throws MCP_CONNECT_FAILED
     * (landing on `closed`) when every attempt fails.
     */
    async connect(actor = 'agent') {
      if (state === 'connected') return state;
      if (state === 'connecting' || state === 'reconnecting') {
        throw mcpError(
          'MCP_INVALID_STATE',
          `Cannot connect while '${state}'`,
          { state, tool: TOOL_NAME },
        );
      }
      transition('connecting', actor, { tool: TOOL_NAME });

      const delays = [...reconnectDelaysMs]; // delays[n] waits before attempt n+2
      const totalAttempts = 1 + delays.length;
      let lastError = null;

      async function attempt(n) {
        if (n > 0) {
          transition('reconnecting', actor, { tool: TOOL_NAME, attempt: n + 1, delayMs: delays[n - 1] });
          await new Promise((resolve) => {
            schedule(resolve, delays[n - 1]);
          });
          transition('connecting', actor, { tool: TOOL_NAME, attempt: n + 1 });
        }
        try {
          await tryConnectOnce();
        } catch (err) {
          lastError = err;
          if (n + 1 < totalAttempts) return attempt(n + 1);
          return false;
        }
        return true;
      }

      if (await attempt(0)) {
        transition('connected', actor, { tool: TOOL_NAME });
        return state;
      }

      transition('closed', actor, {
        tool: TOOL_NAME,
        reason: 'connect retries exhausted',
      });
      throw mcpError(
        'MCP_CONNECT_FAILED',
        `room.search failed to connect after ${totalAttempts} attempt(s)`,
        {
          tool: TOOL_NAME,
          attempts: totalAttempts,
          cause: lastError instanceof Error ? lastError.message : String(lastError),
        },
      );
    },

    /** Disconnect the transport. Idempotent; always ends on `closed`. */
    async disconnect(actor = 'agent') {
      if (state === 'closed') return state;
      if (state === 'connected' || state === 'connecting' || state === 'reconnecting') {
        try {
          await transport.disconnect();
        } catch (err) {
          // Disconnect must still land on closed; the failure is recorded, not silent.
          transition('closed', actor, {
            tool: TOOL_NAME,
            reason: 'transport disconnect threw',
            cause: err instanceof Error ? err.message : String(err),
          });
          return state;
        }
      }
      transition('closed', actor, { tool: TOOL_NAME });
      return state;
    },

    /**
     * Handle one room.search tool call: scope-check, validate, delegate to the
     * injected searchBackend with a timeout, and return { results, total, tookMs }.
     */
    async handleRequest(input, agentId, actor = agentId) {
      const requestId = newId();
      const startedAt = clock();
      const agent = (() => {
        try {
          return assertAgentId(agentId);
        } catch (err) {
          record({
            kind: 'request',
            phase: 'error',
            requestId,
            agent: agentId ?? null,
            tool: TOOL_NAME,
            input: { query: capQuery(input?.query) },
            errorCode: err.code,
            detail: err.detail ?? null,
          });
          throw err;
        }
      })();

      record({
        kind: 'request',
        phase: 'request',
        requestId,
        agent,
        tool: TOOL_NAME,
        input: { query: capQuery(input?.query), limit: input?.limit, channel: input?.channel },
      });

      try {
        if (state !== 'connected') {
          throw mcpError('MCP_NOT_CONNECTED', `room.search is not connected (state: '${state}')`, {
            requestId,
            tool: TOOL_NAME,
            state,
          });
        }

        const { query, limit, channel } = validateInput(input, requestId);

        const allowed = await scopeChecker(agent, TOOL_NAME);
        if (!allowed) {
          throw mcpError('MCP_SCOPE_DENIED', `Agent '${agent}' is not scoped for ${TOOL_NAME}`, {
            requestId,
            tool: TOOL_NAME,
            agent,
          });
        }

        let backendPromise;
        try {
          backendPromise = Promise.resolve(searchBackend({ query, limit, channel }));
        } catch (err) {
          throw mcpError('MCP_BACKEND_ERROR', 'room.search searchBackend threw synchronously', {
            requestId,
            tool: TOOL_NAME,
            cause: err instanceof Error ? err.message : String(err),
          });
        }

        const raw = await withTimeout(backendPromise, requestId);
        const { results, total } = normalizeBackendResult(raw, requestId);
        const tookMs = clock() - startedAt;

        const response = Object.freeze({
          requestId,
          results: Object.freeze([...results]),
          total,
          tookMs,
        });
        record({
          kind: 'request',
          phase: 'response',
          requestId,
          agent,
          tool: TOOL_NAME,
          input: { query: capQuery(query), limit, channel },
          output: { total, tookMs, resultCount: results.length },
        });
        return response;
      } catch (err) {
        if (!err.code) {
          // Never let an uncoded error escape: wrap it as a backend error.
          const wrapped = mcpError('MCP_BACKEND_ERROR', 'room.search failed', {
            requestId,
            tool: TOOL_NAME,
            cause: err instanceof Error ? err.message : String(err),
          });
          record({
            kind: 'request',
            phase: 'error',
            requestId,
            agent,
            tool: TOOL_NAME,
            errorCode: wrapped.code,
            detail: wrapped.detail,
          });
          throw wrapped;
        }
        record({
          kind: 'request',
          phase: 'error',
          requestId,
          agent,
          tool: TOOL_NAME,
          errorCode: err.code,
          detail: err.detail ?? null,
        });
        throw err;
      }
    },
  };

  return Object.freeze(wiring);
}
