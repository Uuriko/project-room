/**
 * unified-contact-thread.mjs — Pure per-contact unified thread model merging
 * messages from three channels (email, telegram, whatsapp) into one
 * chronological view.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * it is a pure in-memory model/planner. Channel adapters are responsible for
 * fetching and normalizing raw channel payloads into the message shape below.
 *
 * Message identity:
 *   - Within one channel: `channel` + `channelMessageId` (duplicate adds throw).
 *   - Across channels: the injected `hash` of the canonical content dedupes
 *     the same content arriving on two channels (e.g. a forwarded email
 *     reposted in Telegram) into a single thread entry that records every
 *     channel identity in `aliases`.
 *
 * Ordering: ascending `ts` (ms epoch), stable tie-break by channel rank
 * (email < telegram < whatsapp), then by internal insertion sequence.
 *
 * Dependency injection (all via the `deps` parameter of
 * createUnifiedContactThread):
 *   - clock: () => number  (ms epoch; default: Date.now) — records receivedAt
 *   - id:    () => string  (thread-internal message id; default: per-thread counter)
 *   - hash:  (content: string) => string  (content identity for cross-channel
 *             dedupe; default: FNV-1a hex — deterministic but NOT
 *             collision-resistant; production wiring MUST inject a
 *             cryptographic hash, e.g. sha256 hex)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   THREAD_INVALID_CHANNEL     — channel not one of email|telegram|whatsapp
 *   THREAD_INVALID_MESSAGE     — message missing/invalid required fields
 *   THREAD_MESSAGE_NOT_FOUND   — unknown thread-internal message id
 *   THREAD_DUPLICATE_CHANNEL_ID — same channelMessageId already on this thread
 *   THREAD_INVALID_QUERY       — query options malformed
 * Failures are never silent.
 */

export const CHANNELS = Object.freeze(['email', 'telegram', 'whatsapp']);

/** Stable per-channel ordering rank used as the timestamp tie-break. */
export const CHANNEL_RANK = Object.freeze({
  email: 0,
  telegram: 1,
  whatsapp: 2,
});

/**
 * Per-channel capability flags. Capabilities are static facts about what each
 * channel can express — adapters and renderers consult these before assuming
 * a feature exists (e.g. never expect a subject on whatsapp, never expect
 * read-receipt history on old telegram messages).
 */
export const CHANNEL_CAPABILITIES = Object.freeze({
  email: Object.freeze({
    subject: true,
    readReceipts: true,
    edit: true,
    richFormatting: true,
  }),
  telegram: Object.freeze({
    subject: false,
    readReceipts: false, // telegram exposes no read receipts for old messages
    edit: true,
    richFormatting: true,
  }),
  whatsapp: Object.freeze({
    subject: false,
    readReceipts: true,
    edit: false,
    richFormatting: false,
  }),
});

export const DIRECTIONS = Object.freeze(['inbound', 'outbound']);

/** Throw a coded thread error (never silent failures). */
function threadError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Default content hash: FNV-1a (32-bit), hex. Deterministic, non-crypto. */
function fnv1aHex(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonical serialization of the channel-independent content identity.
 * Fixed field order; whitespace-trimmed so trailing-space reposts dedupe.
 */
function canonicalContent({ direction, from, subject, body }) {
  return JSON.stringify({
    direction,
    from: String(from ?? '').trim().toLowerCase(),
    subject: String(subject ?? '').trim(),
    body: String(body ?? '').trim(),
  });
}

/**
 * Create a new unified per-contact thread for one contact.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(content: string) => string} [deps.hash]
 */
export function createUnifiedContactThread(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const hash = deps.hash ?? fnv1aHex;

  let idCounter = 0;
  const newId = deps.id ?? (() => `msg-${(idCounter += 1)}`);
  let seqCounter = 0;

  /** Internal message records, keyed by thread-internal id. */
  const messages = new Map();
  /** Per-channel id index: `${channel}:${channelMessageId}` -> internal id. */
  const channelIdIndex = new Map();
  /** Content-hash index for cross-channel dedupe: hash -> internal id. */
  const hashIndex = new Map();

  function assertChannel(channel) {
    if (!CHANNELS.includes(channel)) {
      throw threadError(
        'THREAD_INVALID_CHANNEL',
        `Unknown channel '${channel}': expected one of ${CHANNELS.join(', ')}`,
        { channel },
      );
    }
  }

  function getMessageOrThrow(id) {
    const msg = messages.get(id);
    if (!msg) {
      throw threadError('THREAD_MESSAGE_NOT_FOUND', `Unknown message id: ${id}`, {
        messageId: id,
      });
    }
    return msg;
  }

  function snapshot(msg) {
    return Object.freeze({
      id: msg.id,
      channel: msg.channel,
      channelMessageId: msg.channelMessageId,
      ts: msg.ts,
      receivedAt: msg.receivedAt,
      direction: msg.direction,
      from: msg.from,
      subject: msg.subject,
      body: msg.body,
      read: msg.read,
      aliases: Object.freeze(msg.aliases.map((a) => Object.freeze({ ...a }))),
    });
  }

  function compareMessages(a, b) {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (CHANNEL_RANK[a.channel] !== CHANNEL_RANK[b.channel]) {
      return CHANNEL_RANK[a.channel] - CHANNEL_RANK[b.channel];
    }
    return a.seq - b.seq;
  }

  function sortedMessages() {
    return [...messages.values()].sort(compareMessages);
  }

  const thread = {
    /**
     * Add a message from a channel. Required fields: channel, channelMessageId
     * (string), ts (number, ms epoch), direction ('inbound'|'outbound'), from
     * (string), body (string). subject is optional (ignored on channels whose
     * capability flags say they have none, but still accepted and stored).
     *
     * If the same content-hash already exists on the thread, the incoming
     * channel identity is recorded as an alias on the existing message and no
     * new entry is created. Same channelMessageId on the same channel throws
     * THREAD_DUPLICATE_CHANNEL_ID.
     */
    addMessage(message, { read = false } = {}) {
      const channel = message?.channel;
      assertChannel(channel);

      const channelMessageId = message?.channelMessageId;
      const ts = message?.ts;
      const direction = message?.direction;
      const from = message?.from;
      const body = message?.body;
      const problems = [];
      if (typeof channelMessageId !== 'string' || channelMessageId === '') {
        problems.push('channelMessageId must be a non-empty string');
      }
      if (typeof ts !== 'number' || !Number.isFinite(ts)) {
        problems.push('ts must be a finite number (ms epoch)');
      }
      if (!DIRECTIONS.includes(direction)) {
        problems.push(`direction must be one of ${DIRECTIONS.join(', ')}`);
      }
      if (typeof from !== 'string' || from === '') {
        problems.push('from must be a non-empty string');
      }
      if (typeof body !== 'string') {
        problems.push('body must be a string');
      }
      if (problems.length > 0) {
        throw threadError('THREAD_INVALID_MESSAGE', `Invalid message: ${problems.join('; ')}`, {
          problems,
        });
      }

      const channelKey = `${channel}:${channelMessageId}`;
      if (channelIdIndex.has(channelKey)) {
        throw threadError(
          'THREAD_DUPLICATE_CHANNEL_ID',
          `Message ${channelMessageId} already exists on channel '${channel}'`,
          { channel, channelMessageId },
        );
      }

      const subject = message?.subject ?? null;
      const contentHash = hash(
        canonicalContent({ direction, from, subject, body }),
      );

      const existingId = hashIndex.get(contentHash);
      if (existingId !== undefined) {
        // Cross-channel dedupe: same content already on the thread.
        const existing = messages.get(existingId);
        existing.aliases.push({ channel, channelMessageId });
        channelIdIndex.set(channelKey, existingId);
        return { deduped: true, message: snapshot(existing) };
      }

      const msg = {
        id: newId(),
        channel,
        channelMessageId,
        ts,
        receivedAt: clock(),
        direction,
        from,
        subject,
        body,
        read: Boolean(read),
        aliases: [],
        seq: (seqCounter += 1),
        contentHash,
      };
      messages.set(msg.id, msg);
      channelIdIndex.set(channelKey, msg.id);
      hashIndex.set(contentHash, msg.id);
      return { deduped: false, message: snapshot(msg) };
    },

    /**
     * Remove a message by its thread-internal id. Returns the removed
     * snapshot. THREAD_MESSAGE_NOT_FOUND when unknown.
     */
    removeMessage(id) {
      const msg = getMessageOrThrow(id);
      messages.delete(msg.id);
      channelIdIndex.delete(`${msg.channel}:${msg.channelMessageId}`);
      for (const alias of msg.aliases) {
        channelIdIndex.delete(`${alias.channel}:${alias.channelMessageId}`);
      }
      hashIndex.delete(msg.contentHash);
      return snapshot(msg);
    },

    /**
     * Mark messages read. With `{ channel }` only that channel is marked;
     * with no channel every message is marked. Returns the number marked.
     */
    markRead({ channel } = {}) {
      if (channel !== undefined) assertChannel(channel);
      let marked = 0;
      for (const msg of messages.values()) {
        if (channel !== undefined && msg.channel !== channel) continue;
        if (!msg.read) {
          msg.read = true;
          marked += 1;
        }
      }
      return marked;
    },

    /**
     * Query the thread. Options: channel (one of CHANNELS), sinceMs / untilMs
     * (inclusive ms-epoch bounds), unreadFirst (boolean — unread messages
     * first, chronological within each group), limit (max results, >= 0).
     * Returns frozen chronological snapshots.
     */
    query({ channel, sinceMs, untilMs, unreadFirst = false, limit } = {}) {
      if (channel !== undefined) assertChannel(channel);
      if (sinceMs !== undefined && (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs))) {
        throw threadError('THREAD_INVALID_QUERY', 'sinceMs must be a finite number', { sinceMs });
      }
      if (untilMs !== undefined && (typeof untilMs !== 'number' || !Number.isFinite(untilMs))) {
        throw threadError('THREAD_INVALID_QUERY', 'untilMs must be a finite number', { untilMs });
      }
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
        throw threadError('THREAD_INVALID_QUERY', 'limit must be a non-negative integer', { limit });
      }

      let result = sortedMessages();
      if (channel !== undefined) result = result.filter((m) => m.channel === channel);
      if (sinceMs !== undefined) result = result.filter((m) => m.ts >= sinceMs);
      if (untilMs !== undefined) result = result.filter((m) => m.ts <= untilMs);
      if (unreadFirst) {
        const unread = result.filter((m) => !m.read);
        const read = result.filter((m) => m.read);
        result = [...unread, ...read];
      }
      if (limit !== undefined) result = result.slice(0, limit);
      return Object.freeze(result.map(snapshot));
    },

    /**
     * Thread summary: totals, per-channel counts, unread per channel, and
     * first/last activity timestamps (null when the thread is empty).
     */
    summary() {
      const perChannel = { email: 0, telegram: 0, whatsapp: 0 };
      const unreadPerChannel = { email: 0, telegram: 0, whatsapp: 0 };
      let firstActivityTs = null;
      let lastActivityTs = null;
      for (const msg of messages.values()) {
        perChannel[msg.channel] += 1;
        if (!msg.read) unreadPerChannel[msg.channel] += 1;
        if (firstActivityTs === null || msg.ts < firstActivityTs) firstActivityTs = msg.ts;
        if (lastActivityTs === null || msg.ts > lastActivityTs) lastActivityTs = msg.ts;
      }
      return Object.freeze({
        total: messages.size,
        perChannel: Object.freeze({ ...perChannel }),
        unreadTotal: Object.values(unreadPerChannel).reduce((a, b) => a + b, 0),
        unreadPerChannel: Object.freeze({ ...unreadPerChannel }),
        firstActivityTs,
        lastActivityTs,
      });
    },

    /** All messages as frozen chronological snapshots. */
    all() {
      return Object.freeze(sortedMessages().map(snapshot));
    },

    /** Read-only snapshot of one message (null if unknown). */
    get(id) {
      const msg = messages.get(id);
      return msg ? snapshot(msg) : null;
    },

    /** Number of messages currently on the thread. */
    get size() {
      return messages.size;
    },
  };

  return Object.freeze(thread);
}
