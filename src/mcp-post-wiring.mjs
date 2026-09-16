/**
 * mcp-post-wiring.mjs — Pure MCP wiring for the `room.post` tool.
 *
 * Adapter between an injected MCP transport and an injected posting backend.
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * the transport (`deps.transport`) and the posting backend (`deps.postBackend`)
 * are injected dependencies; this module is only state machine + validation +
 * policy wiring.
 *
 * Connection lifecycle:
 *   disconnected → connecting → connected → (reconnecting | closed)
 *   `connect()`    : disconnected | closed → connecting → connected
 *   `reconnect()`  : connected | reconnecting → reconnecting → connected
 *   `disconnect()` : any non-closed state → closed
 *
 * Tool schema registered on the transport:
 *   { name: 'room.post',
 *     inputSchema: { channel, text, threadId?, attachments? } }
 *
 * Dependency injection (all via the `deps` parameter of createMcpPostWiring):
 *   - clock:             () => number  (ms epoch; default: Date.now)
 *   - id:                () => string  (message id generator; default: counter)
 *   - transport:         { connect(), disconnect(), registerTool(schema) }
 *                        (required — the MCP transport; may be sync or async)
 *   - postBackend:       (payload) => ({messageId?, postedAt?} | Promise<...>)
 *                        (required — performs the actual post; may be async)
 *   - scopeChecker:      (agentId, toolName) => boolean | Promise<boolean>
 *                        (default: always true)
 *   - rateLimitPerMin:   number        (default: 30 posts/min/agent)
 *   - idempotencyTtlMs:  number        (clientToken dedupe window; default: 10 min)
 *   - requestTimeoutMs:  number        (backend timeout; default: 30_000)
 *
 * Policies (all enforced, never silent):
 *   - Input validation: channel required (non-empty string), text 1..10000
 *     chars, attachments optional array of {filename, mimeType} with an
 *     executable-mime blocklist → MCP_POST_INVALID.
 *   - Per-agent scope check via scopeChecker → MCP_SCOPE_DENIED.
 *   - Per-agent rate limit (sliding 60s window on the injected clock) →
 *     MCP_RATE_LIMITED on excess. Rate limiting never drops work silently;
 *     the caller gets a coded error and retries.
 *   - Idempotency: a `clientToken` in the request context dedupes for
 *     idempotencyTtlMs — a repeat within the window returns the ORIGINAL
 *     result without calling the backend again.
 *   - Backend calls are raced against requestTimeoutMs → MCP_TIMEOUT.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   MCP_INVALID_LIFECYCLE — operation not allowed from the current state
 *   MCP_CONNECT_FAILED    — transport.connect() threw
 *   MCP_REGISTER_FAILED   — transport.registerTool() threw
 *   MCP_NOT_CONNECTED     — handleRequest called while not connected
 *   MCP_UNKNOWN_TOOL      — tool name !== 'room.post'
 *   MCP_POST_INVALID      — input validation failed (channel/text/attachments)
 *   MCP_SCOPE_DENIED      — scopeChecker refused the agent for room.post
 *   MCP_RATE_LIMITED      — per-agent posts/min budget exhausted
 *   MCP_TIMEOUT           — postBackend did not settle within requestTimeoutMs
 *   MCP_BACKEND_FAILED    — postBackend threw (wrapped, original in .detail)
 * Failures are never silent.
 */

export const TOOL_NAME = 'room.post';

export const STATES = Object.freeze([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'closed',
]);

export const DEFAULT_RATE_LIMIT_PER_MIN = 30;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export const MAX_TEXT_LENGTH = 10_000;

/**
 * Mime types (and prefixes) that attachments must never carry — executables
 * and script payloads are rejected at validation time.
 */
const BLOCKED_MIME_EXACT = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-sh',
  'application/x-bat',
  'application/x-csh',
]);

const BLOCKED_MIME_PREFIXES = ['application/x-ms', 'application/x-dos'];

/** True when the mime type is on the executable blocklist. */
function isBlockedMime(mime) {
  const m = String(mime).toLowerCase().trim();
  if (BLOCKED_MIME_EXACT.has(m)) return true;
  if (m === 'text/x-shellscript') return true;
  return BLOCKED_MIME_PREFIXES.some((prefix) => m.startsWith(prefix));
}

/** Throw a coded MCP wiring error (never silent failures). */
function mcpError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** The JSON-schema-ish tool description registered on the transport. */
export function toolSchema() {
  return Object.freeze({
    name: TOOL_NAME,
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        channel: { type: 'string', description: 'Target channel (required)' },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_TEXT_LENGTH,
          description: 'Message text, 1..10000 chars (required)',
        },
        threadId: { type: 'string', description: 'Optional thread to reply in' },
        attachments: {
          type: 'array',
          description: 'Optional attachments; executable mimes are blocked',
          items: Object.freeze({
            type: 'object',
            properties: Object.freeze({
              filename: { type: 'string' },
              mimeType: { type: 'string' },
            }),
            required: Object.freeze(['filename', 'mimeType']),
          }),
        },
      }),
      required: Object.freeze(['channel', 'text']),
    }),
  });
}

/**
 * Create the room.post MCP wiring.
 * @param {object} deps
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {object} deps.transport — { connect(), disconnect(), registerTool(schema) }
 * @param {(payload: object) => object | Promise<object>} deps.postBackend
 * @param {(agentId: string, toolName: string) => boolean | Promise<boolean>} [deps.scopeChecker]
 * @param {number} [deps.rateLimitPerMin]
 * @param {number} [deps.idempotencyTtlMs]
 * @param {number} [deps.requestTimeoutMs]
 */
export function createMcpPostWiring(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const transport = deps.transport;
  const postBackend = deps.postBackend;
  const scopeChecker = deps.scopeChecker ?? (() => true);
  const rateLimitPerMin = deps.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;
  const idempotencyTtlMs = deps.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  if (!transport || typeof transport.connect !== 'function') {
    throw mcpError('MCP_INVALID_LIFECYCLE', 'createMcpPostWiring requires deps.transport with a connect() function');
  }
  if (typeof postBackend !== 'function') {
    throw mcpError('MCP_INVALID_LIFECYCLE', 'createMcpPostWiring requires deps.postBackend to be a function');
  }

  let idCounter = 0;
  const newId = deps.id ?? (() => `msg-${(idCounter += 1)}`);

  let state = 'disconnected';

  /** Append-only audit log: every lifecycle transition and post outcome. */
  const audit = [];

  /** Per-agent post timestamps (ms) for the sliding-window rate limiter. */
  const rateWindows = new Map();

  /** clientToken → { result, at } for idempotent replays. */
  const idempotency = new Map();

  function record({ at, actor, action, detail }) {
    const entry = Object.freeze({
      at: at ?? clock(),
      actor: actor ?? 'system',
      action,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function setState(to, actor, detail) {
    const from = state;
    state = to;
    record({ actor, action: 'lifecycle', detail: { from, to, ...(detail ?? {}) } });
  }

  function assertState(allowed, op) {
    if (!allowed.includes(state)) {
      throw mcpError(
        'MCP_INVALID_LIFECYCLE',
        `Cannot ${op} while in state '${state}'`,
        { state, op },
      );
    }
  }

  function assertConnected(op) {
    if (state !== 'connected') {
      throw mcpError(
        'MCP_NOT_CONNECTED',
        `Cannot ${op}: wiring is '${state}', expected 'connected'`,
        { state, op },
      );
    }
  }

  /** Validate room.post input; throws MCP_POST_INVALID on any problem. */
  function validateInput(input) {
    const problems = [];
    const channel = input?.channel;
    const text = input?.text;
    if (typeof channel !== 'string' || channel.trim().length === 0) {
      problems.push('channel is required and must be a non-empty string');
    }
    if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT_LENGTH) {
      problems.push(`text must be a string of 1..${MAX_TEXT_LENGTH} chars`);
    }
    const threadId = input?.threadId;
    if (threadId !== undefined && typeof threadId !== 'string') {
      problems.push('threadId must be a string when present');
    }
    const attachments = input?.attachments;
    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) {
        problems.push('attachments must be an array when present');
      } else {
        attachments.forEach((att, i) => {
          if (!att || typeof att.filename !== 'string' || att.filename.length === 0) {
            problems.push(`attachments[${i}].filename must be a non-empty string`);
          }
          if (!att || typeof att.mimeType !== 'string' || att.mimeType.length === 0) {
            problems.push(`attachments[${i}].mimeType must be a non-empty string`);
          } else if (isBlockedMime(att.mimeType)) {
            problems.push(`attachments[${i}].mimeType '${att.mimeType}' is blocked (executable)`);
          }
        });
      }
    }
    if (problems.length > 0) {
      throw mcpError('MCP_POST_INVALID', `Invalid room.post input: ${problems.join('; ')}`, {
        problems,
      });
    }
    return {
      channel: channel.trim(),
      text,
      threadId,
      attachments: attachments === undefined ? undefined : [...attachments],
    };
  }

  /** Sliding 60s window on the injected clock; throws MCP_RATE_LIMITED on excess. */
  function checkRateLimit(agentId) {
    const now = clock();
    const windowStart = now - 60_000;
    const stamps = (rateWindows.get(agentId) ?? []).filter((t) => t > windowStart);
    if (stamps.length >= rateLimitPerMin) {
      record({
        actor: agentId,
        action: 'rate-limited',
        detail: { tool: TOOL_NAME, limitPerMin: rateLimitPerMin },
      });
      throw mcpError(
        'MCP_RATE_LIMITED',
        `Agent '${agentId}' exceeded ${rateLimitPerMin} room.post calls/min`,
        { agentId, tool: TOOL_NAME, limitPerMin: rateLimitPerMin },
      );
    }
    stamps.push(now);
    rateWindows.set(agentId, stamps);
  }

  /** Look up an idempotent replay; prunes expired tokens. Returns null on miss. */
  function idempotentReplay(clientToken) {
    if (clientToken == null || clientToken === '') return null;
    const now = clock();
    for (const [token, entry] of idempotency) {
      if (now - entry.at > idempotencyTtlMs) idempotency.delete(token);
    }
    const entry = idempotency.get(clientToken);
    if (!entry) return null;
    if (now - entry.at > idempotencyTtlMs) {
      idempotency.delete(clientToken);
      return null;
    }
    return entry.result;
  }

  /** Race the backend against requestTimeoutMs; MCP_TIMEOUT on expiry. */
  async function callBackend(payload, agentId) {
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => postBackend(payload)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              mcpError('MCP_TIMEOUT', `room.post backend timed out after ${requestTimeoutMs}ms`, {
                agentId,
                tool: TOOL_NAME,
                requestTimeoutMs,
              }),
            );
          }, requestTimeoutMs);
        }),
      ]);
      return result;
    } catch (err) {
      if (err instanceof Error && err.code === 'MCP_TIMEOUT') throw err;
      throw mcpError('MCP_BACKEND_FAILED', `room.post backend failed: ${err?.message ?? err}`, {
        agentId,
        tool: TOOL_NAME,
        cause: err?.message ?? String(err),
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  const wiring = {
    get state() {
      return state;
    },

    /** Append-only audit trail: {at, actor, action, detail}. */
    get audit() {
      return [...audit];
    },

    get toolName() {
      return TOOL_NAME;
    },

    get rateLimitPerMin() {
      return rateLimitPerMin;
    },

    /** disconnected | closed → connecting → connected. */
    async connect(actor = 'system') {
      assertState(['disconnected', 'closed'], 'connect');
      setState('connecting', actor);
      try {
        await transport.connect();
      } catch (err) {
        setState('disconnected', actor, { reason: 'connect failed', error: err?.message });
        throw mcpError('MCP_CONNECT_FAILED', `MCP transport connect failed: ${err?.message ?? err}`, {
          cause: err?.message ?? String(err),
        });
      }
      setState('connected', actor);
      return state;
    },

    /** connected | reconnecting → reconnecting → connected (stays on failure). */
    async reconnect(actor = 'system') {
      assertState(['connected', 'reconnecting'], 'reconnect');
      setState('reconnecting', actor);
      try {
        await transport.connect();
      } catch (err) {
        record({
          actor,
          action: 'reconnect-failed',
          detail: { state, error: err?.message ?? String(err) },
        });
        throw mcpError('MCP_CONNECT_FAILED', `MCP transport reconnect failed: ${err?.message ?? err}`, {
          cause: err?.message ?? String(err),
        });
      }
      setState('connected', actor);
      return state;
    },

    /** Any non-closed state → closed. Transport disconnect is best-effort. */
    async disconnect(actor = 'system') {
      if (state === 'closed') return state;
      if (typeof transport.disconnect === 'function') {
        try {
          await transport.disconnect();
        } catch (err) {
          record({
            actor,
            action: 'disconnect-transport-error',
            detail: { error: err?.message ?? String(err) },
          });
        }
      }
      setState('closed', actor);
      return state;
    },

    /** Register the room.post tool schema on the transport (must be connected). */
    async registerTool(actor = 'system') {
      assertConnected('registerTool');
      const schema = toolSchema();
      try {
        await transport.registerTool?.(schema);
      } catch (err) {
        record({ actor, action: 'register-failed', detail: { error: err?.message ?? String(err) } });
        throw mcpError('MCP_REGISTER_FAILED', `Failed to register ${TOOL_NAME}: ${err?.message ?? err}`, {
          cause: err?.message ?? String(err),
        });
      }
      record({ actor, action: 'tool-registered', detail: { tool: TOOL_NAME } });
      return schema;
    },

    /**
     * Handle a room.post tool call.
     * @param {string} toolName — must be 'room.post'
     * @param {object} input — { channel, text, threadId?, attachments? }
     * @param {object} [ctx] — { agentId, clientToken? }
     * @returns {Promise<{messageId: string, postedAt: number}>}
     */
    async handleRequest(toolName, input, ctx = {}) {
      assertConnected('handleRequest');
      const agentId = ctx.agentId ?? 'unknown';
      if (toolName !== TOOL_NAME) {
        record({ actor: agentId, action: 'unknown-tool', detail: { toolName } });
        throw mcpError('MCP_UNKNOWN_TOOL', `Unknown tool: ${toolName}`, { toolName });
      }

      // Idempotent replay: same clientToken within the window returns the
      // ORIGINAL result — no duplicate post, no backend call, no quota burn.
      const replay = idempotentReplay(ctx.clientToken);
      if (replay) {
        record({ actor: agentId, action: 'idempotent-replay', detail: { clientToken: ctx.clientToken } });
        return replay;
      }

      const valid = validateInput(input);
      record({ actor: agentId, action: 'post-validated', detail: { channel: valid.channel } });

      const allowed = await scopeChecker(agentId, TOOL_NAME);
      if (!allowed) {
        record({ actor: agentId, action: 'scope-denied', detail: { tool: TOOL_NAME } });
        throw mcpError('MCP_SCOPE_DENIED', `Agent '${agentId}' is not scoped for ${TOOL_NAME}`, {
          agentId,
          tool: TOOL_NAME,
        });
      }

      checkRateLimit(agentId);

      const payload = {
        tool: TOOL_NAME,
        agentId,
        channel: valid.channel,
        text: valid.text,
        ...(valid.threadId !== undefined ? { threadId: valid.threadId } : {}),
        ...(valid.attachments !== undefined ? { attachments: valid.attachments } : {}),
      };

      const backendResult = await callBackend(payload, agentId);
      const result = Object.freeze({
        messageId: backendResult?.messageId ?? newId(),
        postedAt: backendResult?.postedAt ?? clock(),
      });

      if (ctx.clientToken != null && ctx.clientToken !== '') {
        idempotency.set(ctx.clientToken, { result, at: clock() });
      }
      record({
        actor: agentId,
        action: 'post-succeeded',
        detail: { messageId: result.messageId, channel: valid.channel },
      });
      return result;
    },
  };

  return Object.freeze(wiring);
}
