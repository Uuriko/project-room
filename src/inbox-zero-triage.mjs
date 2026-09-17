/**
 * inbox-zero-triage.mjs — Pure inbox-zero triage session state machine.
 *
 * Runs a triage session over an inbox snapshot: every item is scored at session
 * start and placed in a suggested bucket, then a human/agent works the queue by
 * marking items decided. Nothing here touches the network, the DOM, storage,
 * or any secret — it is a pure state machine.
 *
 * Session states:
 *   idle → triaging → done
 *   Side states: paused, abandoned
 *   (triaging ⇄ paused; triaging/paused → abandoned; triaging → done)
 *
 * Item states: pending → decided (with decision + decidedAt).
 * Decisions are reversible while the session is open (triaging); closing a
 * session is only allowed when zero items remain pending (inbox-zero invariant).
 * Abandon keeps every recorded decision but marks the session abandoned.
 *
 * Buckets (suggested by scoring; the actual decision is validated against them):
 *   act-now, schedule, delegate, archive, spam-candidate
 *
 * Scoring (all weights sum to 1 by default):
 *   score = w.recency * recencyScore + w.sender * senderScore(sender)
 *         + w.attachment * (hasAttachment ? 1 : 0)
 *         + w.thread * min(1, threadDepth / 10)
 *   recencyScore = 1 - min(1, ageMs / RECENCY_WINDOW_MS), clamped at 0.
 *   Bucket thresholds on score: >= 0.75 act-now, >= 0.5 schedule,
 *   >= 0.3 delegate, >= 0.15 archive, below that spam-candidate.
 *   An item whose injected senderScore is <= SPAM_SENDER_SCORE_MAX lands in
 *   spam-candidate regardless of the other signals.
 *
 * Dependency injection (all via the `deps` parameter of createInboxZeroTriage):
 *   - clock:               () => number  (ms epoch; default: Date.now)
 *   - id:                  () => string  (session/item id generator; default: per-gate counter)
 *   - senderScore:         (sender: string) => number  (0..1 sender importance; default: () => 0.5)
 *   - weights:             { recency, sender, attachment, thread }  (score weights; default 0.4/0.3/0.15/0.15)
 *   - decisionTimeSavedMs: number  (estimated triage time saved per decided item; default 2 minutes)
 *
 * Estimated time saved = decidedCount * decisionTimeSavedMs. It is an estimate
 * (the value of structured triage vs ad-hoc inbox spelunking), not a measured
 * quantity — callers that want measured values should inject their own constant.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   IZ_NO_ACTIVE_SESSION — operation needs a started session (state is idle)
 *   IZ_SESSION_ACTIVE    — startSession while a session is triaging/paused
 *   IZ_EMPTY_SNAPSHOT    — startSession with an empty inbox snapshot
 *   IZ_UNKNOWN_ITEM      — unknown item id in the current session
 *   IZ_ALREADY_TRIAGED   — decide() on an item that is already decided
 *   IZ_INVALID_DECISION  — decision is not one of the known buckets
 *   IZ_INVALID_TRANSITION — operation not allowed from the current session/item state
 *   IZ_PENDING_ITEMS     — close() attempted while pending items remain
 * Failures are never silent.
 */

export const SESSION_STATES = Object.freeze([
  'idle',
  'triaging',
  'paused',
  'done',
  'abandoned',
]);

export const ITEM_STATES = Object.freeze(['pending', 'decided']);

/** Suggested-bucket vocabulary; decisions are validated against this list. */
export const BUCKETS = Object.freeze([
  'act-now',
  'schedule',
  'delegate',
  'archive',
  'spam-candidate',
]);

export const RECENCY_WINDOW_MS = 72 * 60 * 60 * 1000;
export const SPAM_SENDER_SCORE_MAX = 0.1;
export const DEFAULT_DECISION_TIME_SAVED_MS = 2 * 60 * 1000;

const DEFAULT_WEIGHTS = Object.freeze({
  recency: 0.4,
  sender: 0.3,
  attachment: 0.15,
  thread: 0.15,
});

const ACTIVE_STATES = new Set(['triaging', 'paused']);

/** Throw a coded triage error (never silent failures). */
function triageError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function bucketForScore(score) {
  if (score >= 0.75) return 'act-now';
  if (score >= 0.5) return 'schedule';
  if (score >= 0.3) return 'delegate';
  if (score >= 0.15) return 'archive';
  return 'spam-candidate';
}

/**
 * Create a new inbox-zero triage session manager.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(sender: string) => number} [deps.senderScore]
 * @param {{recency:number,sender:number,attachment:number,thread:number}} [deps.weights]
 * @param {number} [deps.decisionTimeSavedMs]
 */
export function createInboxZeroTriage(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const senderScore = deps.senderScore ?? (() => 0.5);
  const weights = { ...DEFAULT_WEIGHTS, ...(deps.weights ?? {}) };
  const decisionTimeSavedMs =
    deps.decisionTimeSavedMs ?? DEFAULT_DECISION_TIME_SAVED_MS;

  let idCounter = 0;
  const newId = deps.id ?? (() => `iz-${(idCounter += 1)}`);

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

  /** Current session (null until the first startSession). */
  let session = null;

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

  function scoreItem(item, now) {
    const ageMs = Math.max(0, now - item.receivedAt);
    const recency = 1 - Math.min(1, ageMs / RECENCY_WINDOW_MS);
    const sender = clamp01(senderScore(item.sender ?? ''));
    const attachment = item.hasAttachment ? 1 : 0;
    const thread = Math.min(1, (item.threadDepth ?? 0) / 10);
    const score =
      weights.recency * recency +
      weights.sender * sender +
      weights.attachment * attachment +
      weights.thread * thread;
    const bucket =
      sender <= SPAM_SENDER_SCORE_MAX ? 'spam-candidate' : bucketForScore(score);
    return Object.freeze({
      score,
      bucket,
      components: Object.freeze({ recency, sender, attachment, thread }),
    });
  }

  function itemSnapshot(item) {
    return Object.freeze({
      id: item.id,
      state: item.state,
      sender: item.sender,
      subject: item.subject,
      receivedAt: item.receivedAt,
      hasAttachment: item.hasAttachment,
      threadDepth: item.threadDepth,
      score: item.score,
      bucket: item.bucket,
      decision: item.decision,
      decidedAt: item.decidedAt,
    });
  }

  function requireSession() {
    if (!session) {
      throw triageError(
        'IZ_NO_ACTIVE_SESSION',
        'No triage session has been started yet',
        {},
      );
    }
    return session;
  }

  function assertSessionState(allowed, op) {
    const s = requireSession();
    if (!allowed.includes(s.state)) {
      throw triageError(
        'IZ_INVALID_TRANSITION',
        `Cannot ${op} while session ${s.id} is in state '${s.state}'`,
        { sessionId: s.id, state: s.state, op },
      );
    }
    return s;
  }

  function getItemOrThrow(s, itemId) {
    const item = s.items.get(itemId);
    if (!item) {
      throw triageError(
        'IZ_UNKNOWN_ITEM',
        `Unknown item id ${itemId} in session ${s.id}`,
        { sessionId: s.id, itemId },
      );
    }
    return item;
  }

  function assertValidDecision(decision, s) {
    if (!BUCKETS.includes(decision)) {
      throw triageError(
        'IZ_INVALID_DECISION',
        `Invalid decision '${decision}': must be one of ${BUCKETS.join(', ')}`,
        { sessionId: s.id, decision },
      );
    }
  }

  function setSessionState(s, to, actor, detail) {
    const from = s.state;
    s.state = to;
    record({
      at: clock(),
      from,
      to,
      actor,
      detail: { sessionId: s.id, ...(detail ?? {}) },
    });
  }

  function transitionItem(s, item, to, actor, detail) {
    const from = item.state;
    item.state = to;
    record({
      at: clock(),
      from: `item:${from}`,
      to: `item:${to}`,
      actor,
      detail: { sessionId: s.id, itemId: item.id, ...(detail ?? {}) },
    });
  }

  function statsOf(s) {
    const breakdown = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    let decided = 0;
    for (const item of s.items.values()) {
      if (item.state === 'decided') {
        decided += 1;
        breakdown[item.decision] += 1;
      }
    }
    const total = s.items.size;
    return Object.freeze({
      total,
      decided,
      pending: total - decided,
      decisions: Object.freeze(breakdown),
      estimatedTimeSavedMs: decided * decisionTimeSavedMs,
    });
  }

  function sessionSnapshot(s) {
    return Object.freeze({
      id: s.id,
      state: s.state,
      startedAt: s.startedAt,
      closedAt: s.closedAt,
      stats: statsOf(s),
    });
  }

  const triage = {
    /** Append-only audit trail of every session and item transition. */
    get audit() {
      return [...audit];
    },

    get decisionTimeSavedMs() {
      return decisionTimeSavedMs;
    },

    /**
     * Start a triage session over an inbox snapshot. Scores and buckets every
     * item. Allowed from idle, done, or abandoned (a new session resets).
     */
    startSession(snapshot, actor = 'agent') {
      if (session && ACTIVE_STATES.has(session.state)) {
        throw triageError(
          'IZ_SESSION_ACTIVE',
          `Cannot start a session while session ${session.id} is '${session.state}'`,
          { sessionId: session.id, state: session.state },
        );
      }
      if (!Array.isArray(snapshot) || snapshot.length === 0) {
        throw triageError(
          'IZ_EMPTY_SNAPSHOT',
          'Cannot start a triage session over an empty inbox snapshot',
          {},
        );
      }
      const now = clock();
      const s = {
        id: newId(),
        state: 'idle',
        startedAt: now,
        closedAt: null,
        items: new Map(),
      };
      for (const raw of snapshot) {
        const scored = scoreItem(raw ?? {}, now);
        const item = {
          id: raw?.id ?? newId(),
          state: 'pending',
          sender: raw?.sender ?? '',
          subject: raw?.subject ?? '',
          receivedAt: typeof raw?.receivedAt === 'number' ? raw.receivedAt : now,
          hasAttachment: Boolean(raw?.hasAttachment),
          threadDepth: typeof raw?.threadDepth === 'number' ? raw.threadDepth : 0,
          score: scored.score,
          bucket: scored.bucket,
          scoreComponents: scored.components,
          decision: null,
          decidedAt: null,
        };
        s.items.set(item.id, item);
      }
      session = s;
      record({
        at: now,
        from: 'idle',
        to: 'triaging',
        actor,
        detail: { sessionId: s.id, itemCount: s.items.size },
      });
      session.state = 'triaging';
      return sessionSnapshot(session);
    },

    /**
     * Mark a pending item decided. Decisions are validated against BUCKETS and
     * are reversible via reverseDecision() until the session closes.
     */
    decide(itemId, decision, actor = 'agent') {
      const s = assertSessionState(['triaging'], 'decide');
      assertValidDecision(decision, s);
      const item = getItemOrThrow(s, itemId);
      if (item.state === 'decided') {
        throw triageError(
          'IZ_ALREADY_TRIAGED',
          `Item ${itemId} is already decided (${item.decision}); reverse the decision first`,
          { sessionId: s.id, itemId, decision: item.decision },
        );
      }
      item.decision = decision;
      item.decidedAt = clock();
      transitionItem(s, item, 'decided', actor, { decision });
      return itemSnapshot(item);
    },

    /** Reverse a decision, returning the item to pending (triaging only). */
    reverseDecision(itemId, actor = 'agent') {
      const s = assertSessionState(['triaging'], 'reverse decision');
      const item = getItemOrThrow(s, itemId);
      if (item.state !== 'decided') {
        throw triageError(
          'IZ_INVALID_TRANSITION',
          `Cannot reverse decision for item ${itemId}: it is '${item.state}', not 'decided'`,
          { sessionId: s.id, itemId, state: item.state },
        );
      }
      item.decision = null;
      item.decidedAt = null;
      transitionItem(s, item, 'pending', actor, { reversed: true });
      return itemSnapshot(item);
    },

    /** Pause triage; decisions and reversals are blocked until resume(). */
    pause(actor = 'agent') {
      const s = assertSessionState(['triaging'], 'pause');
      setSessionState(s, 'paused', actor, {});
      return sessionSnapshot(s);
    },

    /** Resume a paused session back to triaging. */
    resume(actor = 'agent') {
      const s = assertSessionState(['paused'], 'resume');
      setSessionState(s, 'triaging', actor, {});
      return sessionSnapshot(s);
    },

    /**
     * Abandon the session. Recorded decisions are kept (items stay decided),
     * but the session is terminal and can never reach done.
     */
    abandon(actor = 'agent') {
      const s = assertSessionState(['triaging', 'paused'], 'abandon');
      setSessionState(s, 'abandoned', actor, statsOf(s));
      return sessionSnapshot(s);
    },

    /**
     * Close the session. Allowed only from triaging and only when zero items
     * are pending (the inbox-zero invariant); otherwise throws IZ_PENDING_ITEMS.
     */
    close(actor = 'agent') {
      const s = assertSessionState(['triaging'], 'close');
      const stats = statsOf(s);
      if (stats.pending > 0) {
        throw triageError(
          'IZ_PENDING_ITEMS',
          `Cannot close session ${s.id}: ${stats.pending} item(s) still pending (inbox-zero invariant)`,
          { sessionId: s.id, pending: stats.pending },
        );
      }
      s.closedAt = clock();
      setSessionState(s, 'done', actor, statsOf(s));
      return sessionSnapshot(s);
    },

    /** Highest-scoring pending item (the next thing to triage), or null. */
    peekNext() {
      const s = requireSession();
      let best = null;
      for (const item of s.items.values()) {
        if (item.state !== 'pending') continue;
        if (!best || item.score > best.score) best = item;
      }
      return best ? itemSnapshot(best) : null;
    },

    /** Current session snapshot with live stats (null before first session). */
    session() {
      return session ? sessionSnapshot(session) : null;
    },

    /** Live stats for the current session (null before first session). */
    stats() {
      return session ? statsOf(session) : null;
    },

    /** Read-only snapshot of one item (null if unknown). */
    get(itemId) {
      if (!session) return null;
      const item = session.items.get(itemId);
      return item ? itemSnapshot(item) : null;
    },

    /** Read-only snapshots of every item in the current session. */
    items() {
      if (!session) return [];
      return [...session.items.values()].map(itemSnapshot);
    },
  };

  return Object.freeze(triage);
}
