/**
 * connection-manager.mjs — Pure channel connection manager.
 *
 * Manages the lifecycle of channel connections (telegram / whatsapp / email /
 * sms, or any named channel). Channels are injected as `connector` objects —
 * nothing here touches the network, the DOM, or any secret; it is a pure
 * state machine over injected connectors.
 *
 * A connector is expected to expose:
 *   - connect()    — bring the channel up; may throw or return a rejected
 *                    promise on failure (may also return `false`)
 *   - disconnect() — take the channel down; may throw on failure
 *
 * Connection record:
 *   { channel, state, connector, lastError?, connectedAt?, reconnectAttempts }
 *
 * States:
 *   disconnected → connecting → connected
 *   connected → disconnecting? (no — disconnect is direct: → disconnected)
 *   connected/connecting → failed (on connect failure)
 *   failed/disconnected → reconnecting → connecting → connected | failed
 *
 * Dependency injection (all via the `deps` parameter of createConnectionManager):
 *   - clock:          () => number  (ms epoch; default: Date.now)
 *   - backoffBaseMs:  number        (base for reconnect backoff; default: 1_000)
 *   - backoffCapMs:   number        (cap for reconnect backoff; default: 60_000)
 *   - scheduler:      (fn: () => void, delayMs: number) => void
 *                     (optional — schedules a reconnect callback; default: none,
 *                      so no real timers run unless the caller injects one)
 *
 * Auto-reconnect model: markFailed(channel, err) marks the channel `failed`
 * and, when a scheduler is injected, schedules reconnect() after the current
 * exponential backoff delay. Without a scheduler there are no real timers —
 * the caller drives recovery explicitly via reconnect(), and the manager keeps
 * the attempts counter + next-retry bookkeeping (lastReconnectDelayMs,
 * nextReconnectAt) so the caller knows when to retry.
 *
 * Backoff: delayMs(attempt n) = min(backoffBaseMs * 2^(n-1), backoffCapMs),
 * where n = reconnectAttempts after increment. A successful connect() resets
 * reconnectAttempts to 0.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   CM_NOT_FOUND          — unknown channel
 *   CM_ALREADY_REGISTERED — register() on an already-registered channel
 *   CM_ALREADY_CONNECTED  — connect()/reconnect() while already up
 *   CM_INVALID_STATE      — operation not allowed from the current state
 *   CM_CONNECT_FAILED     — connector.connect() threw / rejected / returned false
 *   CM_DISCONNECT_FAILED  — connector.disconnect() threw / rejected
 *   CM_RECONNECT_FAILED   — reconnect attempt's connect() failed
 *   CM_REMOVE_WHILE_ACTIVE — remove() on a channel that is not disconnected
 * Failures are never silent.
 */

export const CHANNEL_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
]);

export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_CAP_MS = 60_000;

/** Throw a coded connection-manager error (never silent failures). */
function cmError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Create a new channel connection manager.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {number} [deps.backoffBaseMs]
 * @param {number} [deps.backoffCapMs]
 * @param {(fn: () => void, delayMs: number) => void} [deps.scheduler]
 */
export function createConnectionManager(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCapMs = deps.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const scheduler = deps.scheduler ?? null;

  /** Internal connection records, keyed by channel name. */
  const connections = new Map();

  /** State-change listeners, keyed by channel name: Set<listener>. */
  const listeners = new Map();

  /** Append-only event log: every state transition lands here, never removed. */
  const events = [];

  function record({ at, channel, from, to, detail }) {
    const entry = Object.freeze({
      at,
      channel,
      from,
      to,
      detail: detail === undefined ? null : detail,
    });
    events.push(entry);
    return entry;
  }

  function getConnOrThrow(channel) {
    const conn = connections.get(channel);
    if (!conn) {
      throw cmError('CM_NOT_FOUND', `Unknown channel: ${channel}`, { channel });
    }
    return conn;
  }

  function snapshot(conn) {
    return Object.freeze({
      channel: conn.channel,
      state: conn.state,
      lastError: conn.lastError,
      connectedAt: conn.connectedAt,
      reconnectAttempts: conn.reconnectAttempts,
      lastReconnectDelayMs: conn.lastReconnectDelayMs,
      nextReconnectAt: conn.nextReconnectAt,
    });
  }

  function notify(conn, from, to, at, detail) {
    const set = listeners.get(conn.channel);
    if (!set || set.size === 0) return;
    const payload = Object.freeze({
      channel: conn.channel,
      from,
      to,
      at,
      detail: detail === undefined ? null : detail,
    });
    for (const listener of [...set]) {
      listener(payload);
    }
  }

  function transition(conn, to, detail) {
    const from = conn.state;
    const at = clock();
    conn.state = to;
    record({ at, channel: conn.channel, from, to, detail });
    notify(conn, from, to, at, detail);
    return snapshot(conn);
  }

  /** Exponential backoff for the given (1-based) attempt number. */
  function backoffDelayMs(attempt) {
    return Math.min(backoffBaseMs * 2 ** (attempt - 1), backoffCapMs);
  }

  /**
   * Run the connector's connect() through a connecting → connected|failed
   * transition. Assumes the connection is already in `connecting` state.
   */
  async function finishConnect(conn) {
    const connector = conn.connector;
    if (typeof connector?.connect !== 'function') {
      conn.lastError = 'connector has no connect() function';
      transition(conn, 'failed', { reason: 'missing connector.connect' });
      throw cmError(
        'CM_CONNECT_FAILED',
        `Connect failed for channel ${conn.channel}: connector has no connect() function`,
        { channel: conn.channel },
      );
    }
    try {
      const result = await connector.connect();
      if (result === false) {
        throw new Error('connector.connect() returned false');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      conn.lastError = message;
      transition(conn, 'failed', { reason: message });
      throw cmError(
        'CM_CONNECT_FAILED',
        `Connect failed for channel ${conn.channel}: ${message}`,
        { channel: conn.channel, cause: message },
      );
    }
    conn.lastError = null;
    conn.connectedAt = clock();
    conn.reconnectAttempts = 0;
    conn.lastReconnectDelayMs = null;
    conn.nextReconnectAt = null;
    return transition(conn, 'connected', { connectedAt: conn.connectedAt });
  }

  const manager = {
    /** Append-only log of every state transition: {at, channel, from, to, detail}. */
    get events() {
      return [...events];
    },

    get backoffBaseMs() {
      return backoffBaseMs;
    },

    get backoffCapMs() {
      return backoffCapMs;
    },

    /**
     * Register a channel with its connector. The channel starts `disconnected`.
     * The connector must expose connect() and disconnect() functions.
     */
    register(channel, connector) {
      if (typeof channel !== 'string' || channel === '') {
        throw cmError('CM_INVALID_STATE', 'Channel name must be a non-empty string', {
          channel,
        });
      }
      if (connections.has(channel)) {
        throw cmError(
          'CM_ALREADY_REGISTERED',
          `Channel already registered: ${channel}`,
          { channel },
        );
      }
      const conn = {
        channel,
        state: 'disconnected',
        connector,
        lastError: null,
        connectedAt: null,
        reconnectAttempts: 0,
        lastReconnectDelayMs: null,
        nextReconnectAt: null,
      };
      connections.set(channel, conn);
      record({
        at: clock(),
        channel,
        from: null,
        to: 'disconnected',
        detail: { registered: true },
      });
      return snapshot(conn);
    },

    /**
     * Connect a channel via connector.connect(). Allowed from `disconnected`
     * or `failed`. A connector failure moves the channel to `failed` and
     * throws CM_CONNECT_FAILED — never silent.
     */
    async connect(channel) {
      const conn = getConnOrThrow(channel);
      if (conn.state === 'connected' || conn.state === 'connecting') {
        throw cmError(
          'CM_ALREADY_CONNECTED',
          `Channel ${channel} is already ${conn.state}`,
          { channel, state: conn.state },
        );
      }
      if (conn.state !== 'disconnected' && conn.state !== 'failed') {
        throw cmError(
          'CM_INVALID_STATE',
          `Cannot connect channel ${channel} from state '${conn.state}'`,
          { channel, state: conn.state },
        );
      }
      transition(conn, 'connecting');
      return finishConnect(conn);
    },

    /**
     * Disconnect a channel via connector.disconnect(). Allowed from
     * `connected`, `connecting`, `reconnecting`, or `failed`. A connector
     * failure moves the channel to `failed` and throws CM_DISCONNECT_FAILED.
     */
    async disconnect(channel) {
      const conn = getConnOrThrow(channel);
      if (conn.state === 'disconnected') {
        throw cmError('CM_INVALID_STATE', `Channel ${channel} is already disconnected`, {
          channel,
          state: conn.state,
        });
      }
      const connector = conn.connector;
      if (typeof connector?.disconnect !== 'function') {
        const message = 'connector has no disconnect() function';
        conn.lastError = message;
        transition(conn, 'failed', { reason: message });
        throw cmError(
          'CM_DISCONNECT_FAILED',
          `Disconnect failed for channel ${channel}: ${message}`,
          { channel, cause: message },
        );
      }
      try {
        await connector.disconnect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        conn.lastError = message;
        transition(conn, 'failed', { reason: message });
        throw cmError(
          'CM_DISCONNECT_FAILED',
          `Disconnect failed for channel ${channel}: ${message}`,
          { channel, cause: message },
        );
      }
      conn.lastError = null;
      conn.connectedAt = null;
      return transition(conn, 'disconnected');
    },

    /**
     * Reconnect a channel with exponential backoff. Allowed from `failed`,
     * `disconnected`, or `connected`. Increments reconnectAttempts, records
     * lastReconnectDelayMs / nextReconnectAt, transitions through
     * `reconnecting` → `connecting`, and attempts the connect. A failed
     * attempt throws CM_RECONNECT_FAILED and leaves the channel `failed`;
     * the attempts counter keeps climbing so the next backoff grows.
     */
    async reconnect(channel) {
      const conn = getConnOrThrow(channel);
      if (conn.state === 'connecting' || conn.state === 'reconnecting') {
        throw cmError(
          'CM_ALREADY_CONNECTED',
          `Channel ${channel} is already ${conn.state}`,
          { channel, state: conn.state },
        );
      }
      conn.reconnectAttempts += 1;
      const delayMs = backoffDelayMs(conn.reconnectAttempts);
      conn.lastReconnectDelayMs = delayMs;
      conn.nextReconnectAt = clock() + delayMs;
      transition(conn, 'reconnecting', {
        attempt: conn.reconnectAttempts,
        delayMs,
      });
      transition(conn, 'connecting', { attempt: conn.reconnectAttempts });
      try {
        return await finishConnect(conn);
      } catch (err) {
        // finishConnect already set state `failed` + CM_CONNECT_FAILED; the
        // reconnect-level contract surfaces as CM_RECONNECT_FAILED with the
        // attempts counter intact.
        const message = err instanceof Error ? err.message : String(err);
        throw cmError(
          'CM_RECONNECT_FAILED',
          `Reconnect attempt ${conn.reconnectAttempts} failed for channel ${channel}: ${message}`,
          {
            channel,
            attempt: conn.reconnectAttempts,
            delayMs,
            cause: message,
          },
        );
      }
    },

    /**
     * Mark a channel as failed (e.g. a dropped socket surfaced outside the
     * manager). Records the error, resets connectedAt, and — when a scheduler
     * was injected — schedules reconnect() after the next backoff delay.
     * With no scheduler injected, no timers run: the caller drives recovery
     * explicitly via reconnect(), and nextReconnectAt says when.
     */
    markFailed(channel, err) {
      const conn = getConnOrThrow(channel);
      const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
      conn.lastError = message;
      conn.connectedAt = null;
      // Next-retry bookkeeping (the attempt counter only climbs in
      // reconnect(), so this is the delay for the upcoming attempt n+1).
      const delayMs = backoffDelayMs(conn.reconnectAttempts + 1);
      conn.lastReconnectDelayMs = delayMs;
      conn.nextReconnectAt = clock() + delayMs;
      const snap = transition(conn, 'failed', { reason: message, nextReconnectAt: conn.nextReconnectAt });
      if (scheduler) {
        scheduler(() => {
          manager.reconnect(channel).catch(() => {
            // Failures are never silent: the reconnect attempt itself throws
            // CM_RECONNECT_FAILED to the scheduled context and records the
            // `failed` transition + error in the event log / lastError.
          });
        }, delayMs);
      }
      return snap;
    },

    /** Read-only snapshot of a channel's connection record. */
    status(channel) {
      return snapshot(getConnOrThrow(channel));
    },

    /** Read-only snapshots for every registered channel. */
    statusAll() {
      return [...connections.values()].map(snapshot);
    },

    /**
     * Health roll-up: [{channel, state, uptimeMs?, lastError?}].
     * uptimeMs is present only while connected (clock() - connectedAt).
     */
    health() {
      const now = clock();
      return [...connections.values()].map((conn) => {
        const row = { channel: conn.channel, state: conn.state };
        if (conn.state === 'connected' && conn.connectedAt != null) {
          row.uptimeMs = now - conn.connectedAt;
        }
        if (conn.lastError != null) {
          row.lastError = conn.lastError;
        }
        return Object.freeze(row);
      });
    },

    /**
     * Subscribe to state changes for a channel. The listener receives
     * {channel, from, to, at, detail}. Returns an unsubscribe function.
     */
    onStateChange(channel, listener) {
      getConnOrThrow(channel);
      if (typeof listener !== 'function') {
        throw cmError('CM_INVALID_STATE', 'Listener must be a function', { channel });
      }
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      return () => {
        const current = listeners.get(channel);
        if (current) current.delete(listener);
      };
    },

    /**
     * Remove a channel from the manager. Allowed ONLY from `disconnected` —
     * anything else throws CM_REMOVE_WHILE_ACTIVE (disconnect first).
     */
    remove(channel) {
      const conn = getConnOrThrow(channel);
      if (conn.state !== 'disconnected') {
        throw cmError(
          'CM_REMOVE_WHILE_ACTIVE',
          `Cannot remove channel ${channel} while ${conn.state} — disconnect first`,
          { channel, state: conn.state },
        );
      }
      connections.delete(channel);
      listeners.delete(channel);
      record({
        at: clock(),
        channel,
        from: 'disconnected',
        to: null,
        detail: { removed: true },
      });
      return true;
    },
  };

  return Object.freeze(manager);
}
