/**
 * telegram-outbound.mjs — Pure planner/state machine for Telegram outbound
 * sends through the inbox composer.
 *
 * Implements Telegram's outbound contract as a pure state machine. Nothing
 * here touches the network, the DOM, localStorage, or any secret — actual
 * delivery happens through the injected `sender` dependency. All side
 * effects (ids, timestamps, sending, chunking policy) are injected via
 * `deps`, so the planner is fully deterministic under test.
 *
 * States:
 *   compose → validated → queued → sending → sent
 *   Side states: failed, cancelled
 *
 * Telegram enforces a 4096-character limit per message. Long texts are
 * planned into ordered chunks (each ≤ 4096 chars) that preserve paragraph
 * boundaries where possible; a single unbroken token longer than 4096
 * cannot be chunked and fails validation (TG_MSG_TOO_LONG_UNCHUNKABLE).
 *
 * Dependency injection (all via the `deps` parameter of createTelegramOutbound):
 *   - clock:          () => number  (ms epoch; default: Date.now)
 *   - id:             () => string  (message id generator; default: per-planner counter)
 *   - sender:         async ({chatId, text, parseMode, chunkIndex, chunkCount}) => ({ok: true, ...} | {ok: false, error?, transient?})
 *                     The production wiring injects the real Telegram Bot API
 *                     call here. The stub returns {ok: true} for no-op plans.
 *   - chunker:        (text: string, limit: number) => string[]
 *                     Default chunker packs paragraphs greedily and splits
 *                     over-long lines on whitespace. A custom chunker may be
 *                     injected (e.g. entity-aware MarkdownV2 splitting).
 *   - maxPerWindow:   number        (rate budget: max messages per chat per window; default: 20)
 *   - windowMs:       number        (rate window length in ms; default: 60_000)
 *
 * Retry policy: a chunk whose send fails with a transient failure (sender
 * returns {ok: false, transient: true} or throws a coded error whose code is
 * in the transient set — TG_SEND_TRANSIENT by default) is retried exactly
 * once. Any non-transient failure, or a second transient failure, moves the
 * message to `failed`. Retry state is per chunk and tracked on the message.
 *
 * Rate budget: each delivered chunk consumes one unit of the per-chat budget
 * (every chunk is one Telegram API message); overflow stays queued until the
 * window slides.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   TG_INVALID_PARSE_MODE       — parseMode not in the allowlist
 *   TG_INVALID_CHAT             — missing/invalid chatId
 *   TG_EMPTY_TEXT               — text is empty after trimming
 *   TG_NOT_FOUND                — unknown message id
 *   TG_INVALID_TRANSITION       — operation not allowed from the current state
 *   TG_MSG_TOO_LONG_UNCHUNKABLE — a single unbroken token exceeds 4096 chars
 *   TG_SEND_FAILED              — sender failed (details in err.detail)
 *   TG_SEND_TRANSIENT           — transient sender failure (retryable; a chunk
 *                                 may carry this as its lastError while the
 *                                 message as a whole ends in `failed`)
 * Failures are never silent.
 */

export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export const PARSE_MODES = Object.freeze(['none', 'MarkdownV2', 'HTML']);

export const STATES = Object.freeze([
  'compose',
  'validated',
  'queued',
  'sending',
  'sent',
  'failed',
  'cancelled',
]);

export const DEFAULT_MAX_PER_WINDOW = 20;
export const DEFAULT_WINDOW_MS = 60 * 1000;

/** Coded errors that a sender may throw/return to trigger the retry-once path. */
export const TRANSIENT_CODES = Object.freeze(['TG_SEND_TRANSIENT', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

const TERMINAL_STATES = new Set(['sent', 'failed', 'cancelled']);

/** Throw a coded planner error (never silent failures). */
function tgError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Default chunker: greedy paragraph packing with whitespace splitting.
 * - Paragraphs (split on blank lines) are packed into chunks up to `limit`.
 * - A paragraph longer than `limit` is split on single newlines, then on
 *   whitespace runs, packing words greedily.
 * - A single whitespace-free token longer than `limit` cannot be chunked:
 *   throws TG_MSG_TOO_LONG_UNCHUNKABLE.
 * Order is preserved; chunks joined with '\n\n'/'\n'/' ' reconstruct the text.
 */
export function defaultChunker(text, limit = TELEGRAM_MAX_MESSAGE_CHARS) {
  if (typeof text !== 'string') {
    throw tgError('TG_EMPTY_TEXT', 'Cannot chunk a non-string message', { type: typeof text });
  }
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  /** Append a piece to the current chunk with separator, flushing first if needed. */
  const appendPiece = (piece, sep) => {
    if (piece.length > limit) {
      throw tgError(
        'TG_MSG_TOO_LONG_UNCHUNKABLE',
        `Message contains a single unbroken token of ${piece.length} chars; Telegram's ${limit}-char limit cannot be satisfied`,
        { tokenLength: piece.length, limit },
      );
    }
    const candidate = current ? current + sep + piece : piece;
    if (candidate.length > limit) {
      pushCurrent();
      current = piece;
    } else {
      current = candidate;
    }
  };

  /** Split an over-long paragraph into newline/word pieces (all ≤ limit). */
  const splitParagraph = (paragraph) => {
    const lines = paragraph.split('\n');
    const pieces = [];
    for (const line of lines) {
      if (line.length <= limit) {
        pieces.push(line);
        continue;
      }
      // Greedy word packing; a single token over the limit is unchunkable.
      const words = line.split(/(\s+)/);
      let wordChunk = '';
      for (const w of words) {
        if (!w) continue;
        if (w.length > limit) {
          throw tgError(
            'TG_MSG_TOO_LONG_UNCHUNKABLE',
            `Message contains a single unbroken token of ${w.length} chars; Telegram's ${limit}-char limit cannot be satisfied`,
            { tokenLength: w.length, limit },
          );
        }
        if ((wordChunk + w).length > limit) {
          pieces.push(wordChunk.trimEnd());
          wordChunk = w.trimStart();
        } else {
          wordChunk += w;
        }
      }
      if (wordChunk.trim()) pieces.push(wordChunk.trim());
    }
    return pieces;
  };

  const paragraphs = text.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      for (const piece of splitParagraph(paragraph)) {
        appendPiece(piece, '\n');
      }
    } else {
      appendPiece(paragraph, '\n\n');
    }
  }
  pushCurrent();
  return chunks;
}

/**
 * Create a new Telegram outbound planner.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {Function} [deps.sender]
 * @param {(text: string, limit: number) => string[]} [deps.chunker]
 * @param {number} [deps.maxPerWindow]
 * @param {number} [deps.windowMs]
 */
export function createTelegramOutbound(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const chunker = deps.chunker ?? defaultChunker;
  const maxPerWindow = deps.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const sender =
    deps.sender ??
    (async () => ({ ok: true }));

  let idCounter = 0;
  const newId = deps.id ?? (() => `tg-${(idCounter += 1)}`);

  /** Internal message records, keyed by id. */
  const messages = new Map();

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

  /** Per-chat send timestamps (ms) for the rate budget; pruned on read. */
  const sendTimes = new Map(); // chatId -> number[]

  function record({ at, from, to, actor, detail }) {
    const entry = Object.freeze({
      at,
      from,
      to,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function getMessageOrThrow(id) {
    const msg = messages.get(id);
    if (!msg) {
      throw tgError('TG_NOT_FOUND', `Unknown message id: ${id}`, { messageId: id });
    }
    return msg;
  }

  function assertState(msg, allowed, op) {
    if (!allowed.includes(msg.state)) {
      throw tgError(
        'TG_INVALID_TRANSITION',
        `Cannot ${op} message ${msg.id} from state '${msg.state}'`,
        { messageId: msg.id, state: msg.state, op },
      );
    }
  }

  function snapshot(msg) {
    return Object.freeze({
      id: msg.id,
      state: msg.state,
      chatId: msg.chatId,
      parseMode: msg.parseMode,
      text: msg.text,
      chunks: Object.freeze([...msg.chunks]),
      sentChunks: msg.sentChunks,
      attempts: msg.attempts,
      lastError: msg.lastError ? Object.freeze({ ...msg.lastError }) : null,
      createdAt: msg.createdAt,
      validatedAt: msg.validatedAt,
      queuedAt: msg.queuedAt,
      sentAt: msg.sentAt,
      cancelledAt: msg.cancelledAt,
      failedAt: msg.failedAt,
    });
  }

  function transition(msg, to, actor, detail) {
    const from = msg.state;
    msg.state = to;
    record({
      at: clock(),
      from,
      to,
      actor,
      detail: { messageId: msg.id, ...(detail ?? {}) },
    });
    return snapshot(msg);
  }

  /** Validate compose input; throws coded errors on any problem. */
  function validateInput(input) {
    const chatId = input?.chatId;
    if (typeof chatId !== 'string' || chatId.trim() === '') {
      throw tgError('TG_INVALID_CHAT', 'chatId must be a non-empty string', { chatId });
    }
    const text = input?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw tgError('TG_EMPTY_TEXT', 'Message text must be a non-empty string');
    }
    const parseMode = input?.parseMode ?? 'none';
    if (!PARSE_MODES.includes(parseMode)) {
      throw tgError(
        'TG_INVALID_PARSE_MODE',
        `parseMode must be one of ${PARSE_MODES.join(', ')}; got '${parseMode}'`,
        { parseMode, allowed: [...PARSE_MODES] },
      );
    }
    return { chatId: chatId.trim(), text, parseMode };
  }

  /** Rate-budget bookkeeping: prune the window and count recent sends. */
  function pruneWindow(chatId) {
    const now = clock();
    const times = (sendTimes.get(chatId) ?? []).filter((t) => now - t < windowMs);
    sendTimes.set(chatId, times);
    return times;
  }

  function markSent(chatId) {
    const times = pruneWindow(chatId);
    times.push(clock());
    sendTimes.set(chatId, times);
  }

  const planner = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    get maxPerWindow() {
      return maxPerWindow;
    },

    get windowMs() {
      return windowMs;
    },

    /**
     * Compose a message: validates chat/text/parseMode eagerly and stores the
     * record in `compose` state. Chunk planning happens in validate().
     */
    compose(input, actor = 'agent') {
      const { chatId, text, parseMode } = validateInput(input);
      const id = newId();
      const msg = {
        id,
        state: 'compose',
        chatId,
        parseMode,
        text,
        chunks: [],
        sentChunks: 0,
        attempts: 0,
        lastError: null,
        createdAt: clock(),
        validatedAt: null,
        queuedAt: null,
        sentAt: null,
        cancelledAt: null,
        failedAt: null,
      };
      messages.set(id, msg);
      record({
        at: clock(),
        from: null,
        to: 'compose',
        actor,
        detail: { messageId: id, chatId, parseMode, textLength: text.length },
      });
      return snapshot(msg);
    },

    /**
     * Validate a composed message: runs the chunk planner (paragraph-aware,
     * each chunk ≤ 4096) and moves compose → validated.
     * Throws TG_MSG_TOO_LONG_UNCHUNKABLE when the text cannot be chunked.
     */
    validate(id, actor = 'agent') {
      const msg = getMessageOrThrow(id);
      assertState(msg, ['compose'], 'validate');
      const chunks = chunker(msg.text, TELEGRAM_MAX_MESSAGE_CHARS);
      if (!Array.isArray(chunks) || chunks.length === 0) {
        throw tgError('TG_MSG_TOO_LONG_UNCHUNKABLE', `Chunker produced no chunks for message ${id}`, {
          messageId: id,
        });
      }
      for (const chunk of chunks) {
        if (typeof chunk !== 'string' || chunk.length > TELEGRAM_MAX_MESSAGE_CHARS) {
          throw tgError(
            'TG_MSG_TOO_LONG_UNCHUNKABLE',
            `Chunker produced an over-limit chunk (${chunk?.length} chars) for message ${id}`,
            { messageId: id, limit: TELEGRAM_MAX_MESSAGE_CHARS },
          );
        }
      }
      msg.chunks = chunks;
      msg.validatedAt = clock();
      return transition(msg, 'validated', actor, {
        chunkCount: chunks.length,
        chunkLengths: chunks.map((c) => c.length),
      });
    },

    /** Move a validated message to `queued` (the send pool for flush()). */
    enqueue(id, actor = 'agent') {
      const msg = getMessageOrThrow(id);
      assertState(msg, ['validated'], 'enqueue');
      msg.queuedAt = clock();
      return transition(msg, 'queued', actor, { chunkCount: msg.chunks.length });
    },

    /**
     * Cancel a message that has not started sending. Allowed from
     * compose/validated/queued; sent/sending/failed/cancelled throw
     * TG_INVALID_TRANSITION.
     */
    cancel(id, actor = 'agent') {
      const msg = getMessageOrThrow(id);
      assertState(msg, ['compose', 'validated', 'queued'], 'cancel');
      msg.cancelledAt = clock();
      return transition(msg, 'cancelled', actor, {});
    },

    /** Current rate-budget usage for a chat: {used, maxPerWindow, windowMs}. */
    budgetStatus(chatId) {
      const used = pruneWindow(chatId).length;
      return { chatId, used, maxPerWindow, windowMs };
    },

    /**
     * Send one queued message through the injected sender, chunk by chunk, in
     * order. Applies the per-chat rate budget (a message over budget stays
     * queued and is reported as skipped) and the retry-once policy for
     * transient failures. Returns the final snapshot.
     */
    async sendOne(id, actor = 'agent') {
      const msg = getMessageOrThrow(id);
      assertState(msg, ['queued'], 'send');

      if (pruneWindow(msg.chatId).length >= maxPerWindow) {
        // Over budget: stay queued, loudly. The caller decides when to retry.
        record({
          at: clock(),
          from: 'queued',
          to: 'queued',
          actor,
          detail: {
            messageId: id,
            reason: 'rate budget exhausted',
            budget: { used: pruneWindow(msg.chatId).length, maxPerWindow, windowMs },
          },
        });
        return snapshot(msg);
      }

      transition(msg, 'sending', actor, { chunkCount: msg.chunks.length });

      for (let i = 0; i < msg.chunks.length; i += 1) {
        const payload = {
          chatId: msg.chatId,
          text: msg.chunks[i],
          parseMode: msg.parseMode,
          chunkIndex: i,
          chunkCount: msg.chunks.length,
        };

        let attempt = 0;
        let done = false;
        while (!done) {
          attempt += 1;
          msg.attempts += 1;
          try {
            const result = await sender(payload);
            if (result && result.ok) {
              done = true;
            } else {
              const transient = Boolean(result && result.transient);
              const code = transient ? 'TG_SEND_TRANSIENT' : 'TG_SEND_FAILED';
              const messageText = result?.error ?? `Sender returned ok:false for chunk ${i} of message ${id}`;
              if (transient && attempt < 2) {
                msg.lastError = { code, message: messageText, chunkIndex: i, attempts: attempt };
                record({
                  at: clock(),
                  from: 'sending',
                  to: 'sending',
                  actor,
                  detail: { messageId: id, chunkIndex: i, attempt, retried: true, code },
                });
                continue; // retry once
              }
              throw tgError(code, messageText, { messageId: id, chunkIndex: i, attempts: attempt });
            }
          } catch (err) {
            const code = err && typeof err.code === 'string' ? err.code : 'TG_SEND_FAILED';
            const transient = TRANSIENT_CODES.includes(code);
            if (transient && attempt < 2) {
              msg.lastError = { code, message: err?.message ?? String(err), chunkIndex: i, attempts: attempt };
              record({
                at: clock(),
                from: 'sending',
                to: 'sending',
                actor,
                detail: { messageId: id, chunkIndex: i, attempt, retried: true, code },
              });
              continue; // retry once
            }
            msg.failedAt = clock();
            msg.lastError = { code, message: err?.message ?? String(err), chunkIndex: i, attempts: attempt };
            return transition(msg, 'failed', actor, {
              code,
              chunkIndex: i,
              attempts: attempt,
              reason: msg.lastError.message,
            });
          }
        }
        msg.sentChunks = i + 1;
        markSent(msg.chatId);
      }

      msg.sentAt = clock();
      return transition(msg, 'sent', actor, {
        chunkCount: msg.chunks.length,
        attempts: msg.attempts,
      });
    },

    /**
     * Flush the send pool: FIFO over queued messages, skipping (not failing)
     * any message that is over its chat's rate budget. Returns
     * {sent: [ids], skipped: [ids]}.
     */
    async flush(actor = 'agent') {
      const queued = [...messages.values()]
        .filter((m) => m.state === 'queued')
        .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0) || (a.createdAt - b.createdAt));
      const sent = [];
      const skipped = [];
      for (const msg of queued) {
        if (pruneWindow(msg.chatId).length >= maxPerWindow) {
          skipped.push(msg.id);
          continue;
        }
        const after = await planner.sendOne(msg.id, actor);
        if (after.state === 'sent') sent.push(msg.id);
        else if (after.state === 'queued') skipped.push(msg.id);
      }
      return { sent, skipped };
    },

    /** Read-only snapshot of a message (null if unknown). */
    get(id) {
      const msg = messages.get(id);
      return msg ? snapshot(msg) : null;
    },

    /** Read-only snapshots of all messages, creation order. */
    list() {
      return [...messages.values()].map(snapshot);
    },

    /** True when the message is in a terminal state. */
    isTerminal(id) {
      return TERMINAL_STATES.has(getMessageOrThrow(id).state);
    },
  };

  return Object.freeze(planner);
}
