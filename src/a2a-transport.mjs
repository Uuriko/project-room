/**
 * a2a-transport.mjs — Pure A2A message transport wiring between agents.
 *
 * No real network here: the wire is an injected `channel` dependency. The
 * transport validates envelopes, correlates request/response pairs, drops
 * TTL-stale inbound, dead-letters the undeliverable, and tracks reconnect
 * backoff — all against injected clock/id/channel so it is fully testable.
 *
 * Envelope shape:
 *   { id, from, to, type, payload, sentAt, ttlMs?, inReplyTo? }
 *   - id / sentAt are stamped by the transport when absent.
 *   - inReplyTo marks a response envelope answering a request envelope.
 *
 * Dependency injection (all via the `deps` parameter of createA2ATransport):
 *   - clock:            () => number  (ms epoch; default: Date.now)
 *   - id:               () => string  (envelope id generator; default: msg-N counter)
 *   - channel:          { send(envelope), onInbound(cb)? } | null
 *                       The wire. send() carries an outbound envelope and may
 *                       throw on transport failure; onInbound(cb) registers the
 *                       channel-side inbound callback (optional). Production
 *                       wiring injects the real A2A channel here.
 *   - requestTimeoutMs: number        (default request timeout; default: 30_000)
 *   - reconnectBaseMs:  number        (backoff base; default: 1_000)
 *   - reconnectMaxMs:   number        (backoff cap; default: 30_000)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   AT_NOT_CONNECTED    — send/request/receive attempted while disconnected
 *   AT_INVALID_ENVELOPE  — envelope missing from/to/type, or bad ttlMs
 *   AT_TIMEOUT           — request() exceeded its timeout (injected clock)
 *   AT_ROUTE_FAILED      — no local route and channel missing or channel.send threw
 * Failures are never silent.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_MS = 30_000;

/** Throw a coded transport error (never silent failures). */
function transportError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Create a new A2A transport.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ send: (envelope: object) => void, onInbound?: (cb: (envelope: object) => void) => (() => void) | void } | null} [deps.channel]
 * @param {number} [deps.requestTimeoutMs]
 * @param {number} [deps.reconnectBaseMs]
 * @param {number} [deps.reconnectMaxMs]
 */
export function createA2ATransport(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const channel = deps.channel ?? null;
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconnectBaseMs = deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;

  let idCounter = 0;
  const newId = deps.id ?? (() => `msg-${(idCounter += 1)}`);

  let connected = false;
  let agentId = null;
  let handler = null;
  let channelUnsubscribe = null;

  /** Pending request/response pairs: requestId -> { resolve, reject, deadline, to, type }. */
  const pending = new Map();

  /** Local route table: agentId -> deliver(envelope). Local delivery skips the channel. */
  const routes = new Map();

  /** Dead-letter queue: undeliverable or invalid inbound envelopes, never dropped silently. */
  const deadLetters = [];

  /** Append-only audit log: every send/receive/drop/dead-letter lands here. */
  const audit = [];

  /** Consecutive channel failures; drives reconnect backoff. Reset on connect(). */
  let reconnectAttempts = 0;

  function record(op, detail) {
    const entry = Object.freeze({
      at: clock(),
      op,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function deadLetter(envelope, reason, code) {
    const entry = Object.freeze({
      at: clock(),
      envelope: Object.freeze({ ...envelope }),
      reason,
      code,
    });
    deadLetters.push(entry);
    record('dead-letter', { envelopeId: envelope?.id ?? null, reason, code });
    return entry;
  }

  function validateEnvelopeShape(envelope) {
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw transportError('AT_INVALID_ENVELOPE', 'Envelope must be an object', { envelope });
    }
    for (const field of ['from', 'to', 'type']) {
      if (!isNonEmptyString(envelope[field])) {
        throw transportError(
          'AT_INVALID_ENVELOPE',
          `Envelope field '${field}' is required and must be a non-empty string`,
          { field, envelope: { ...envelope } },
        );
      }
    }
    if (envelope.ttlMs !== undefined) {
      if (
        typeof envelope.ttlMs !== 'number' ||
        !Number.isFinite(envelope.ttlMs) ||
        envelope.ttlMs <= 0
      ) {
        throw transportError(
          'AT_INVALID_ENVELOPE',
          'Envelope ttlMs must be a positive finite number when present',
          { ttlMs: envelope.ttlMs },
        );
      }
    }
    if (envelope.inReplyTo !== undefined && !isNonEmptyString(envelope.inReplyTo)) {
      throw transportError(
        'AT_INVALID_ENVELOPE',
        'Envelope inReplyTo must be a non-empty string when present',
        { inReplyTo: envelope.inReplyTo },
      );
    }
  }

  /** Stamp id/sentAt when absent and freeze a transport-owned copy. */
  function stamp(envelope) {
    return Object.freeze({
      id: envelope.id ?? newId(),
      from: envelope.from,
      to: envelope.to,
      type: envelope.type,
      payload: envelope.payload,
      sentAt: envelope.sentAt ?? clock(),
      ...(envelope.ttlMs !== undefined ? { ttlMs: envelope.ttlMs } : {}),
      ...(envelope.inReplyTo !== undefined ? { inReplyTo: envelope.inReplyTo } : {}),
    });
  }

  function assertConnected(op) {
    if (!connected) {
      throw transportError(
        'AT_NOT_CONNECTED',
        `Cannot ${op}: transport is not connected`,
        { op, agentId },
      );
    }
  }

  function backoffDelay(attempts) {
    if (attempts <= 0) return 0;
    const delay = reconnectBaseMs * 2 ** (attempts - 1);
    return Math.min(delay, reconnectMaxMs);
  }

  /** Record a channel failure and return the backoff delay for the next attempt. */
  function recordChannelFailure(reason) {
    reconnectAttempts += 1;
    const delayMs = backoffDelay(reconnectAttempts);
    record('channel-failed', { attempts: reconnectAttempts, backoffMs: delayMs, reason });
    return delayMs;
  }

  /**
   * Inbound pipeline shared by the channel callback and local routes.
   * Returns { delivered: boolean, reason?: string }.
   */
  function ingest(envelope) {
    try {
      validateEnvelopeShape(envelope);
    } catch (err) {
      deadLetter(envelope, 'invalid inbound envelope', err.code);
      record('inbound-invalid', { code: err.code, detail: err.detail ?? null });
      return { delivered: false, reason: 'invalid-envelope' };
    }
    const stamped = stamp(envelope);

    // TTL expiry: stale inbound is dropped and audited, never delivered.
    if (stamped.ttlMs !== undefined && clock() - stamped.sentAt > stamped.ttlMs) {
      record('ttl-expired', {
        envelopeId: stamped.id,
        from: stamped.from,
        ageMs: clock() - stamped.sentAt,
        ttlMs: stamped.ttlMs,
      });
      return { delivered: false, reason: 'ttl-expired' };
    }

    // Request/response correlation: a response answers the oldest pending
    // request whose id matches inReplyTo.
    if (stamped.inReplyTo !== undefined) {
      const waiter = pending.get(stamped.inReplyTo);
      if (waiter) {
        pending.delete(stamped.inReplyTo);
        record('response', {
          requestId: stamped.inReplyTo,
          responseId: stamped.id,
          from: stamped.from,
        });
        waiter.resolve(stamped);
        return { delivered: true, reason: 'response' };
      }
    }

    if (handler) {
      record('inbound', {
        envelopeId: stamped.id,
        from: stamped.from,
        type: stamped.type,
      });
      try {
        handler(stamped);
      } catch (err) {
        record('handler-error', { envelopeId: stamped.id, error: String(err?.message ?? err) });
        throw err;
      }
      return { delivered: true, reason: 'handler' };
    }

    // No handler registered: not deliverable, but never silently dropped.
    deadLetter(stamped, 'no receive handler registered', 'AT_ROUTE_FAILED');
    return { delivered: false, reason: 'no-handler' };
  }

  function deliverOutbound(envelope) {
    const route = routes.get(envelope.to);
    if (route) {
      record('route-local', {
        envelopeId: envelope.id,
        from: envelope.from,
        to: envelope.to,
      });
      route(envelope);
      return;
    }
    if (!channel) {
      deadLetter(envelope, `no local route for '${envelope.to}' and no channel injected`, 'AT_ROUTE_FAILED');
      throw transportError(
        'AT_ROUTE_FAILED',
        `No route for agent '${envelope.to}' and no channel injected`,
        { to: envelope.to, envelopeId: envelope.id },
      );
    }
    try {
      channel.send(envelope);
    } catch (err) {
      const backoffMs = recordChannelFailure(String(err?.message ?? err));
      deadLetter(envelope, `channel.send threw: ${err?.message ?? err}`, 'AT_ROUTE_FAILED');
      throw transportError(
        'AT_ROUTE_FAILED',
        `Channel send failed for envelope ${envelope.id}: ${err?.message ?? err}`,
        { envelopeId: envelope.id, to: envelope.to, backoffMs },
      );
    }
    record('send', { envelopeId: envelope.id, from: envelope.from, to: envelope.to, type: envelope.type });
  }

  const transport = {
    /** Append-only audit trail of every transport event. */
    get audit() {
      return [...audit];
    },

    /** Copy of the dead-letter queue. */
    get deadLetters() {
      return [...deadLetters];
    },

    get connected() {
      return connected;
    },

    get agentId() {
      return agentId;
    },

    get pendingRequestCount() {
      return pending.size;
    },

    /** Current reconnect backoff delay (ms) after recorded channel failures. */
    get reconnectDelayMs() {
      return backoffDelay(reconnectAttempts);
    },

    get reconnectAttempts() {
      return reconnectAttempts;
    },

    /**
     * Connect as agentId. Registers the channel inbound callback when the
     * channel supports onInbound. Resets reconnect backoff.
     */
    connect(id) {
      if (!isNonEmptyString(id)) {
        throw transportError('AT_INVALID_ENVELOPE', 'connect() requires a non-empty agent id', {
          agentId: id,
        });
      }
      agentId = id;
      connected = true;
      reconnectAttempts = 0;
      if (channel && typeof channel.onInbound === 'function') {
        const unsub = channel.onInbound((envelope) => ingest(envelope));
        channelUnsubscribe = typeof unsub === 'function' ? unsub : null;
      }
      record('connect', { agentId: id });
      return Object.freeze({ agentId: id, connected: true });
    },

    /**
     * Disconnect. Rejects all pending requests with AT_NOT_CONNECTED (never
     * left hanging), unregisters the channel inbound callback.
     */
    disconnect() {
      const wasAgent = agentId;
      if (channelUnsubscribe) {
        try {
          channelUnsubscribe();
        } catch {
          // Best-effort unsubscribe; disconnect must not fail.
        }
        channelUnsubscribe = null;
      }
      for (const [requestId, waiter] of pending) {
        pending.delete(requestId);
        waiter.reject(
          transportError('AT_NOT_CONNECTED', `Request ${requestId} aborted: transport disconnected`, {
            requestId,
          }),
        );
      }
      connected = false;
      agentId = null;
      record('disconnect', { agentId: wasAgent });
      return Object.freeze({ connected: false });
    },

    /**
     * Register the inbound message handler. Replaces any previous handler
     * (audited). Returns an unregister function.
     */
    receive(nextHandler) {
      assertConnected('receive');
      if (typeof nextHandler !== 'function') {
        throw transportError('AT_INVALID_ENVELOPE', 'receive() requires a handler function', {});
      }
      const replaced = handler !== null;
      handler = nextHandler;
      record('receive-registered', { replaced });
      return () => {
        if (handler === nextHandler) {
          handler = null;
          record('receive-unregistered', {});
        }
      };
    },

    /**
     * Send an envelope. Validates shape (from/to/type required, ttlMs
     * positive), stamps id/sentAt when absent, delivers via the local route
     * table when a route exists, otherwise via the injected channel. Failure
     * dead-letters the envelope and throws AT_ROUTE_FAILED.
     */
    send(envelope) {
      assertConnected('send');
      validateEnvelopeShape(envelope);
      const stamped = stamp(envelope);
      deliverOutbound(stamped);
      return stamped;
    },

    /**
     * Request/response: sends a request envelope and resolves with the
     * response envelope whose inReplyTo matches the request id. The promise
     * rejects with AT_TIMEOUT after timeoutMs (injected clock; see sweep()),
     * or with AT_NOT_CONNECTED / AT_ROUTE_FAILED / AT_INVALID_ENVELOPE when
     * the send itself cannot proceed.
     */
    request(to, type, payload, options = {}) {
      const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
      return new Promise((resolve, reject) => {
        let stamped;
        try {
          assertConnected('request');
          if (!isNonEmptyString(to) || !isNonEmptyString(type)) {
            throw transportError(
              'AT_INVALID_ENVELOPE',
              'request() requires non-empty to and type',
              { to, type },
            );
          }
          stamped = stamp({ from: agentId, to, type, payload });
        } catch (err) {
          reject(err);
          return;
        }
        // Register the waiter BEFORE delivering: local routes deliver
        // synchronously, and the response must find its pending request.
        pending.set(stamped.id, {
          resolve,
          reject,
          deadline: clock() + timeoutMs,
          to,
          type,
          timeoutMs,
        });
        try {
          deliverOutbound(stamped);
        } catch (err) {
          pending.delete(stamped.id);
          reject(err);
          return;
        }
        record('request', {
          requestId: stamped.id,
          to,
          type,
          timeoutMs,
          deadline: clock() + timeoutMs,
        });
      });
    },

    /**
     * Build a response envelope answering `requestEnvelope` (sets inReplyTo).
     * Send it with send().
     */
    replyTo(requestEnvelope, payload, type) {
      if (requestEnvelope === null || typeof requestEnvelope !== 'object') {
        throw transportError('AT_INVALID_ENVELOPE', 'replyTo() requires the request envelope', {});
      }
      if (!isNonEmptyString(requestEnvelope.id)) {
        throw transportError('AT_INVALID_ENVELOPE', 'replyTo() requires the request envelope id', {});
      }
      return {
        from: agentId,
        to: requestEnvelope.from,
        type: type ?? `${requestEnvelope.type ?? 'message'}.response`,
        payload,
        inReplyTo: requestEnvelope.id,
      };
    },

    /**
     * Inject an inbound envelope into this transport's receive pipeline
     * (used by the channel callback and by local routes).
     */
    ingest(envelope) {
      assertConnected('ingest');
      return ingest(envelope);
    },

    /**
     * Register a local route: envelopes addressed to `id` are delivered
     * locally without touching the channel. `target` is either a deliver
     * function or another transport (its ingest is used).
     */
    registerRoute(id, target) {
      assertConnected('registerRoute');
      if (!isNonEmptyString(id)) {
        throw transportError('AT_INVALID_ENVELOPE', 'registerRoute() requires a non-empty agent id', {
          agentId: id,
        });
      }
      const deliver =
        typeof target === 'function'
          ? target
          : (envelope) => target.ingest(envelope);
      if (typeof target !== 'function' && (target === null || typeof target?.ingest !== 'function')) {
        throw transportError('AT_INVALID_ENVELOPE', 'registerRoute() target must be a function or a transport with ingest()', {
          agentId: id,
        });
      }
      routes.set(id, deliver);
      record('route-registered', { agentId: id });
      return () => {
        if (routes.get(id) === deliver) {
          routes.delete(id);
          record('route-unregistered', { agentId: id });
        }
      };
    },

    /** Expire timed-out requests (AT_TIMEOUT) using the injected clock. Returns expired request ids. */
    sweep() {
      const now = clock();
      const expired = [];
      for (const [requestId, waiter] of pending) {
        if (now >= waiter.deadline) {
          pending.delete(requestId);
          expired.push(requestId);
          record('request-timeout', { requestId, to: waiter.to, type: waiter.type, timeoutMs: waiter.timeoutMs });
          waiter.reject(
            transportError('AT_TIMEOUT', `Request ${requestId} timed out after ${waiter.timeoutMs}ms`, {
              requestId,
              to: waiter.to,
              type: waiter.type,
              timeoutMs: waiter.timeoutMs,
            }),
          );
        }
      }
      return expired;
    },

    /**
     * Record a channel failure and get the reconnect backoff delay (ms) for
     * the next attempt. Exponential: base * 2^(attempts-1), capped at max.
     * Reset by connect().
     */
    reconnect() {
      return recordChannelFailure('manual reconnect tick');
    },

    /** Empty the dead-letter queue. Returns the cleared entries. */
    clearDeadLetters() {
      const cleared = [...deadLetters];
      deadLetters.length = 0;
      record('dead-letters-cleared', { count: cleared.length });
      return cleared;
    },

    /** Read-only status snapshot. */
    status() {
      return Object.freeze({
        connected,
        agentId,
        pendingRequests: pending.size,
        routes: [...routes.keys()],
        deadLetters: deadLetters.length,
        reconnectAttempts,
        reconnectDelayMs: backoffDelay(reconnectAttempts),
      });
    },
  };

  return Object.freeze(transport);
}
