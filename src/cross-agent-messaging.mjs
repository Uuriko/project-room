/**
 * cross-agent-messaging.mjs — Pure agent-to-agent message thread store.
 *
 * Agents exchange direct messages without any network, DOM, localStorage, or
 * secret access in this module. It is a pure state machine over an in-memory
 * message store; actual delivery is delegated to an injected `transport`
 * dependency (duck-typed `{ send, receive }` — do NOT import the B031-2
 * module; any duck-typed transport works).
 *
 * Message shape:
 *   { id, from, to, threadId?, body, sentAt, state }
 *
 * States:
 *   queued → sent → delivered → read
 *   Side state: failed (transport failure; retryable via retryFailed)
 *
 * Dependency injection (all via the `deps` parameter of createMessaging):
 *   - clock:     () => number  (ms epoch; default: Date.now)
 *   - id:        () => string  (message id generator; default: per-store counter)
 *   - transport: { send(msg) => any, receive(handler) => unsubscribe? }
 *                duck-typed delivery channel. `send` must throw (or return a
 *                rejected promise — not awaited here) on failure. `receive`
 *                registers an inbound envelope handler. If no transport is
 *                injected, sending throws CAM_NO_TRANSPORT (never silent).
 *
 * sendMessage flow: validate → record in `queued` → transport.send →
 * `sent`. A transport failure moves the message to `failed` and throws
 * CAM_UNDELIVERABLE, so failures are never silent.
 *
 * Inbound flow: onInbound(handler) wires transport.receive; each inbound
 * envelope is validated, recorded in `delivered`, and passed to the handler.
 *
 * Delivery receipts: receipt(id, { status, actor }) moves sent → delivered
 * (status 'delivered') or delivered → read (status 'read', recipient-only).
 * markRead(id, agentId) is the recipient-only delivered → read path.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   CAM_NOT_FOUND        — unknown message id or thread id
 *   CAM_INVALID_MSG      — invalid message fields (empty/oversized body,
 *                          missing or self from/to, bad threadId)
 *   CAM_INVALID_TRANSITION — operation not allowed from the current state
 *   CAM_NOT_RECIPIENT    — markRead/read-receipt by someone other than `to`
 *   CAM_UNDELIVERABLE    — transport.send failed (message kept in `failed`)
 *   CAM_NO_TRANSPORT     — send/inbound attempted without a usable transport
 *   CAM_INVALID_STATE    — unknown state value passed to a filter
 *   CAM_INVALID_RECEIPT  — unknown receipt status
 *   CAM_INVALID_ARG      — invalid non-message argument (e.g. bad handler)
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
]);

const STATE_SET = new Set(STATES);

export const MIN_BODY_LENGTH = 1;
export const MAX_BODY_LENGTH = 5000;

/** Throw a coded messaging error (never silent failures). */
function camError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Create a new agent-to-agent message store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ send: (msg: object) => any, receive: (handler: (env: object) => void) => any }} [deps.transport]
 */
export function createMessaging(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const transport = deps.transport ?? null;

  let idCounter = 0;
  const newId = deps.id ?? (() => `msg-${(idCounter += 1)}`);

  /** Monotonic insertion sequence for stable ordering of equal sentAt values. */
  let seqCounter = 0;

  /** Internal message records, keyed by id (insertion order). */
  const messages = new Map();

  /** Thread membership: threadId → array of message ids (insertion order). */
  const threads = new Map();

  /** Append-only audit log: every state change lands here, never removed. */
  const audit = [];

  function record({ at, messageId, from, to, actor, detail }) {
    const entry = Object.freeze({
      at,
      messageId,
      from,
      to,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function snapshot(msg) {
    return Object.freeze({
      id: msg.id,
      from: msg.from,
      to: msg.to,
      threadId: msg.threadId,
      body: msg.body,
      sentAt: msg.sentAt,
      state: msg.state,
    });
  }

  function transition(msg, to, actor, detail) {
    const from = msg.state;
    msg.state = to;
    record({
      at: clock(),
      messageId: msg.id,
      from,
      to,
      actor,
      detail,
    });
    return snapshot(msg);
  }

  function getMessageOrThrow(id) {
    const msg = messages.get(id);
    if (!msg) {
      throw camError('CAM_NOT_FOUND', `Unknown message id: ${id}`, {
        messageId: id,
      });
    }
    return msg;
  }

  /** Validate outbound/inbound message fields; throws CAM_INVALID_MSG. */
  function validateFields({ from, to, body, threadId }) {
    if (typeof from !== 'string' || from.trim() === '') {
      throw camError('CAM_INVALID_MSG', 'Message requires a non-empty `from` agent id', {
        field: 'from',
      });
    }
    if (typeof to !== 'string' || to.trim() === '') {
      throw camError('CAM_INVALID_MSG', 'Message requires a non-empty `to` agent id', {
        field: 'to',
      });
    }
    if (from === to) {
      throw camError(
        'CAM_INVALID_MSG',
        `Message from '${from}' cannot be addressed to itself`,
        { field: 'to' },
      );
    }
    if (typeof body !== 'string' || body.length < MIN_BODY_LENGTH) {
      throw camError('CAM_INVALID_MSG', 'Message body must be a non-empty string', {
        field: 'body',
      });
    }
    if (body.length > MAX_BODY_LENGTH) {
      throw camError(
        'CAM_INVALID_MSG',
        `Message body exceeds ${MAX_BODY_LENGTH} characters (${body.length})`,
        { field: 'body', length: body.length },
      );
    }
    if (threadId !== undefined && threadId !== null) {
      if (typeof threadId !== 'string' || threadId.trim() === '') {
        throw camError('CAM_INVALID_MSG', 'threadId must be a non-empty string when provided', {
          field: 'threadId',
        });
      }
    }
    return {
      from: from.trim(),
      to: to.trim(),
      body,
      threadId: threadId ?? null,
    };
  }

  function storeMessage({ from, to, threadId, body, state, sentAt }) {
    const msg = {
      id: newId(),
      seq: (seqCounter += 1),
      from,
      to,
      threadId,
      body,
      sentAt,
      state,
    };
    messages.set(msg.id, msg);
    if (threadId != null) {
      if (!threads.has(threadId)) threads.set(threadId, []);
      threads.get(threadId).push(msg.id);
    }
    record({
      at: clock(),
      messageId: msg.id,
      from: null,
      to: state,
      actor: from,
      detail: { threadId, to },
    });
    return msg;
  }

  /**
   * Deliver a queued message through the transport. On success the message
   * moves queued → sent; on transport failure it moves to failed and the
   * CAM_UNDELIVERABLE error is rethrown (never silent).
   */
  function deliver(msg) {
    if (!transport || typeof transport.send !== 'function') {
      throw camError(
        'CAM_NO_TRANSPORT',
        `Cannot deliver message ${msg.id}: no usable transport injected`,
        { messageId: msg.id },
      );
    }
    try {
      transport.send(snapshot(msg));
    } catch (err) {
      transition(msg, 'failed', 'system', {
        reason: 'transport.send threw',
        transportError: err?.message ?? String(err),
      });
      throw camError(
        'CAM_UNDELIVERABLE',
        `Message ${msg.id} from ${msg.from} to ${msg.to} could not be delivered`,
        { messageId: msg.id, transportError: err?.message ?? String(err) },
      );
    }
    return transition(msg, 'sent', 'system', { via: 'transport' });
  }

  const messaging = {
    /** Append-only audit trail: {at, messageId, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    /** Read-only snapshot of a message (null if unknown). */
    get(id) {
      const msg = messages.get(id);
      return msg ? snapshot(msg) : null;
    },

    /**
     * Send a message to another agent. Validates fields (body 1..5000 chars,
     * from !== to), records the message as `queued`, then attempts delivery
     * via the injected transport: success → `sent`; transport failure →
     * `failed` and a thrown CAM_UNDELIVERABLE (never silent).
     */
    sendMessage({ from, to, body, threadId } = {}) {
      const fields = validateFields({ from, to, body, threadId });
      const msg = storeMessage({
        ...fields,
        state: 'queued',
        sentAt: clock(),
      });
      return deliver(msg);
    },

    /**
     * Wire an inbound handler through transport.receive. Each inbound
     * envelope is validated and recorded in `delivered` before the handler
     * runs; invalid envelopes throw CAM_INVALID_MSG. Returns the transport's
     * unsubscribe value (if any).
     */
    onInbound(handler) {
      if (typeof handler !== 'function') {
        throw camError('CAM_INVALID_ARG', 'onInbound requires a handler function', {
          arg: 'handler',
        });
      }
      if (!transport || typeof transport.receive !== 'function') {
        throw camError(
          'CAM_NO_TRANSPORT',
          'Cannot wire inbound messages: injected transport has no receive()',
          {},
        );
      }
      const wrapped = (envelope) => {
        const fields = validateFields({
          from: envelope?.from,
          to: envelope?.to,
          body: envelope?.body,
          threadId: envelope?.threadId,
        });
        const msg = storeMessage({
          ...fields,
          state: 'delivered',
          sentAt: envelope?.sentAt ?? clock(),
        });
        handler(snapshot(msg));
      };
      return transport.receive(wrapped);
    },

    /**
     * All messages in a thread, ordered by sentAt (ties by insertion order).
     * Unknown threadId throws CAM_NOT_FOUND.
     */
    thread(threadId) {
      if (!threads.has(threadId)) {
        throw camError('CAM_NOT_FOUND', `Unknown thread id: ${threadId}`, {
          threadId,
        });
      }
      const ordered = threads
        .get(threadId)
        .map((id) => messages.get(id))
        .filter(Boolean)
        .sort((a, b) => a.sentAt - b.sentAt || (a.seq - b.seq));
      return ordered.map(snapshot);
    },

    /**
     * Mark a delivered message as read. Recipient-only: only the `to` agent
     * may mark it read. Idempotent when already read.
     */
    markRead(messageId, agentId) {
      const msg = getMessageOrThrow(messageId);
      if (msg.to !== agentId) {
        throw camError(
          'CAM_NOT_RECIPIENT',
          `Agent '${agentId}' is not the recipient of message ${messageId}`,
          { messageId, recipient: msg.to, agentId },
        );
      }
      if (msg.state === 'read') return snapshot(msg);
      if (msg.state !== 'delivered') {
        throw camError(
          'CAM_INVALID_TRANSITION',
          `Cannot mark message ${messageId} read from state '${msg.state}'`,
          { messageId, state: msg.state },
        );
      }
      return transition(msg, 'read', agentId, { via: 'markRead' });
    },

    /**
     * Latest message per counterpart for an agent, newest first. Counterpart
     * is the other side of each message the agent sent or received.
     */
    conversations(agentId) {
      const latest = new Map();
      for (const msg of messages.values()) {
        if (msg.from !== agentId && msg.to !== agentId) continue;
        const counterpart = msg.from === agentId ? msg.to : msg.from;
        const prev = latest.get(counterpart);
        if (!prev || msg.sentAt > prev.sentAt || (msg.sentAt === prev.sentAt && msg.seq > prev.seq)) {
          latest.set(counterpart, msg);
        }
      }
      return [...latest.values()]
        .sort((a, b) => b.sentAt - a.sentAt)
        .map((msg) => ({ counterpart: msg.from === agentId ? msg.to : msg.from, message: snapshot(msg) }));
    },

    /**
     * Retry a failed message: failed → queued → transport.send →
     * sent (or failed again with CAM_UNDELIVERABLE on another failure).
     */
    retryFailed(messageId, actor = 'agent') {
      const msg = getMessageOrThrow(messageId);
      if (msg.state !== 'failed') {
        throw camError(
          'CAM_INVALID_TRANSITION',
          `Cannot retry message ${messageId} from state '${msg.state}' (must be 'failed')`,
          { messageId, state: msg.state },
        );
      }
      transition(msg, 'queued', actor, { via: 'retry' });
      return deliver(msg);
    },

    /**
     * Outbound messages sent by an agent, optionally filtered by state,
     * ordered by sentAt. Unknown state values throw CAM_INVALID_STATE.
     */
    outbox(agentId, { state } = {}) {
      if (state !== undefined && !STATE_SET.has(state)) {
        throw camError('CAM_INVALID_STATE', `Unknown message state: ${state}`, {
          state,
        });
      }
      const rows = [];
      for (const msg of messages.values()) {
        if (msg.from !== agentId) continue;
        if (state !== undefined && msg.state !== state) continue;
        rows.push(msg);
      }
      rows.sort((a, b) => a.sentAt - b.sentAt || (a.seq - b.seq));
      return rows.map(snapshot);
    },

    /**
     * Apply a delivery receipt from the transport (or the peer):
     *   status 'delivered' — sent → delivered
     *   status 'read'      — delivered → read (recipient-only)
     * Anything else throws CAM_INVALID_RECEIPT; wrong states throw
     * CAM_INVALID_TRANSITION.
     */
    receipt(messageId, { status, actor } = {}) {
      const msg = getMessageOrThrow(messageId);
      if (status === 'delivered') {
        if (msg.state !== 'sent') {
          throw camError(
            'CAM_INVALID_TRANSITION',
            `Cannot apply 'delivered' receipt to message ${messageId} from state '${msg.state}'`,
            { messageId, state: msg.state, status },
          );
        }
        return transition(msg, 'delivered', actor ?? 'system', { via: 'receipt' });
      }
      if (status === 'read') {
        if (actor !== msg.to) {
          throw camError(
            'CAM_NOT_RECIPIENT',
            `Agent '${actor}' is not the recipient of message ${messageId}`,
            { messageId, recipient: msg.to, agentId: actor },
          );
        }
        if (msg.state === 'read') return snapshot(msg);
        if (msg.state !== 'delivered') {
          throw camError(
            'CAM_INVALID_TRANSITION',
            `Cannot apply 'read' receipt to message ${messageId} from state '${msg.state}'`,
            { messageId, state: msg.state, status },
          );
        }
        return transition(msg, 'read', actor, { via: 'receipt' });
      }
      throw camError('CAM_INVALID_RECEIPT', `Unknown receipt status: ${status}`, {
        messageId,
        status,
      });
    },
  };

  return Object.freeze(messaging);
}
