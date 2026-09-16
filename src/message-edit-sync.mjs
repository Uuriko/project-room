/**
 * message-edit-sync.mjs — Pure planner + execution state machine for cross-channel
 * message edit/delete sync.
 *
 * Nothing here touches the network, the DOM, or any secret — it is a pure
 * planner. The actual channel-side edit/delete/retract is performed by an
 * injected `syncer` dependency, which production wiring implements per channel.
 *
 * Capability matrix (default; overridable via deps.matrix):
 *   email:    edit → unsupported (no true edit; a follow-up send is a new message)
 *             delete → retract-request only (no remote delete; best-effort recall)
 *   telegram: edit within 48h of send; delete anytime
 *   whatsapp: edit within 15min of send; delete-for-everyone within ~2 days
 *
 * Planning: `plan(intent)` is pure and total over valid intents — it takes
 *   {channel, messageId, sentAt, kind: 'edit'|'delete', newText?} and returns
 *   {action: 'edit'|'delete'|'retract-request'|'unsupported', reason,
 *    failureCode?}. Windows are evaluated against the injected clock, so tests
 *   can freeze time.
 *
 * Execution states:
 *   planned → syncing → synced
 *   Side states: failed, unsupported
 *
 * `submit(intent)` records an intent in `planned` state. `execute(id)` runs the
 * plan: unsupported plans fail fast (the syncer is never called) and move the
 * record to `unsupported`. Transient syncer failures are retried exactly once;
 * a permanent failure or an exhausted retry moves the record to `failed`.
 *
 * Dependency injection (all via the `deps` parameter of createMessageEditSync):
 *   - clock:      () => number  (ms epoch; default: Date.now)
 *   - id:         () => string  (plan id generator; default: per-gate counter)
 *   - syncer:     async (op) => any — performs the channel-side edit/delete/
 *                 retract-request. op = {planId, action, channel, messageId,
 *                 kind, newText?, sentAt, ageMs, actor}. Required for execute();
 *                 absent → MES_NO_SYNCER.
 *   - isTransient:(err) => bool (default: err?.transient === true) — decides
 *                 whether a syncer failure is worth one retry.
 *   - matrix:     override rows, e.g. {telegram: {edit: {supported: false}}}
 *                 — merged over DEFAULT_MATRIX.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   MES_INVALID_INTENT   — malformed intent (missing/unknown channel, messageId,
 *                          sentAt, kind; edit without newText)
 *   MES_UNSUPPORTED      — channel/kind combination has no supported action
 *                          (e.g. email edit, unknown channel)
 *   MES_WINDOW_EXPIRED   — a supported action whose time window already elapsed
 *   MES_NOT_FOUND        — unknown plan id
 *   MES_INVALID_TRANSITION — execute() on a record not in `planned` state
 *   MES_NO_SYNCER        — execute() without an injected syncer
 *   MES_SYNC_FAILED      — syncer failed (permanent failure, or transient
 *                          failure after the one retry)
 * Failures are never silent; every transition lands in the audit log.
 */

export const STATES = Object.freeze([
  'planned',
  'syncing',
  'synced',
  'failed',
  'unsupported',
]);

export const TELEGRAM_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const WHATSAPP_EDIT_WINDOW_MS = 15 * 60 * 1000;
export const WHATSAPP_DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;

export const ACTIONS = Object.freeze(['edit', 'delete', 'retract-request', 'unsupported']);

/**
 * Default capability matrix. A row is {supported: bool, windowMs: number|null,
 * as?: action-override}. windowMs: null means the action has no time window
 * (anytime). `as` remaps the action (email delete → 'retract-request').
 */
export const DEFAULT_MATRIX = Object.freeze({
  email: Object.freeze({
    edit: Object.freeze({ supported: false, windowMs: null }),
    delete: Object.freeze({ supported: true, windowMs: null, as: 'retract-request' }),
  }),
  telegram: Object.freeze({
    edit: Object.freeze({ supported: true, windowMs: TELEGRAM_EDIT_WINDOW_MS }),
    delete: Object.freeze({ supported: true, windowMs: null }),
  }),
  whatsapp: Object.freeze({
    edit: Object.freeze({ supported: true, windowMs: WHATSAPP_EDIT_WINDOW_MS }),
    delete: Object.freeze({ supported: true, windowMs: WHATSAPP_DELETE_WINDOW_MS }),
  }),
});

const MAX_SYNC_ATTEMPTS = 2; // first try + exactly one retry on transient failure

/** Throw a coded planner error (never silent failures). */
function mesError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Deep-merge a matrix override over the default, validating the shape. */
function resolveMatrix(override) {
  if (override == null) return DEFAULT_MATRIX;
  if (typeof override !== 'object') {
    throw mesError('MES_INVALID_INTENT', 'matrix override must be an object', {
      matrix: override,
    });
  }
  const merged = {};
  for (const [channel, row] of Object.entries(DEFAULT_MATRIX)) {
    const patch = override[channel] ?? {};
    merged[channel] = {
      edit: Object.freeze({ ...row.edit, ...(patch.edit ?? {}) }),
      delete: Object.freeze({ ...row.delete, ...(patch.delete ?? {}) }),
    };
    merged[channel] = Object.freeze(merged[channel]);
  }
  for (const channel of Object.keys(override)) {
    if (merged[channel] !== undefined) continue;
    const row = override[channel] ?? {};
    merged[channel] = Object.freeze({
      edit: Object.freeze({ supported: false, windowMs: null, ...(row.edit ?? {}) }),
      delete: Object.freeze({ supported: false, windowMs: null, ...(row.delete ?? {}) }),
    });
  }
  return Object.freeze(merged);
}

function formatAge(ageMs) {
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}min`;
  if (ageMs < 86_400_000) return `${(ageMs / 3_600_000).toFixed(1)}h`;
  return `${(ageMs / 86_400_000).toFixed(1)}d`;
}

/**
 * Pure planner. Returns {action, reason, failureCode?} — never throws for
 * unsupported or window-expired intents (those get action 'unsupported' with a
 * failureCode for execute() to fail fast with). Throws MES_INVALID_INTENT for
 * malformed intents.
 */
export function planIntent(intent, matrix = DEFAULT_MATRIX, nowMs = Date.now()) {
  if (intent == null || typeof intent !== 'object') {
    throw mesError('MES_INVALID_INTENT', 'intent must be an object', { intent });
  }
  const { channel, messageId, sentAt, kind, newText } = intent;
  if (typeof channel !== 'string' || channel.length === 0) {
    throw mesError('MES_INVALID_INTENT', 'intent.channel must be a non-empty string', {
      intent,
    });
  }
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw mesError('MES_INVALID_INTENT', 'intent.messageId must be a non-empty string', {
      intent,
    });
  }
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) {
    throw mesError('MES_INVALID_INTENT', 'intent.sentAt must be a finite ms epoch number', {
      intent,
    });
  }
  if (kind !== 'edit' && kind !== 'delete') {
    throw mesError('MES_INVALID_INTENT', `intent.kind must be 'edit' or 'delete', got ${String(kind)}`, {
      intent,
    });
  }
  if (kind === 'edit' && (typeof newText !== 'string' || newText.length === 0)) {
    throw mesError('MES_INVALID_INTENT', 'intent.newText must be a non-empty string for edit', {
      intent,
    });
  }

  const row = matrix[channel];
  if (!row) {
    return Object.freeze({
      action: 'unsupported',
      reason: `channel '${channel}' is not in the capability matrix`,
      failureCode: 'MES_UNSUPPORTED',
    });
  }
  const cell = row[kind];
  if (!cell || cell.supported !== true) {
    const noun = kind === 'edit' ? 'editing' : 'deleting';
    return Object.freeze({
      action: 'unsupported',
      reason: `${noun} messages is not supported on ${channel}${
        channel === 'email' && kind === 'edit'
          ? ' — an email cannot be edited after sending; send a follow-up instead'
          : ''
      }`,
      failureCode: 'MES_UNSUPPORTED',
    });
  }

  const action = cell.as ?? kind;
  const ageMs = Math.max(0, nowMs - sentAt);
  if (cell.windowMs != null && ageMs > cell.windowMs) {
    return Object.freeze({
      action: 'unsupported',
      reason: `${channel} ${kind} window expired: message is ${formatAge(ageMs)} old, limit is ${formatAge(cell.windowMs)}`,
      failureCode: 'MES_WINDOW_EXPIRED',
    });
  }

  const reasons = {
    'retract-request': `email has no remote delete — issuing a retract/recall request instead`,
    edit: `${channel} edit is within the ${formatAge(cell.windowMs ?? 0)} window (message age ${formatAge(ageMs)})`,
    delete: `${channel} delete is ${cell.windowMs == null ? 'not time-limited' : `within the ${formatAge(cell.windowMs)} window`} (message age ${formatAge(ageMs)})`,
  };
  return Object.freeze({
    action,
    reason: reasons[action] ?? `${action} on ${channel}`,
  });
}

/**
 * Create a message edit/delete sync planner + execution state machine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(op: object) => any} [deps.syncer]
 * @param {(err: unknown) => boolean} [deps.isTransient]
 * @param {object} [deps.matrix]
 */
export function createMessageEditSync(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const syncer = deps.syncer ?? null;
  const isTransient = deps.isTransient ?? ((err) => !!err && err.transient === true);
  const matrix = resolveMatrix(deps.matrix);

  let idCounter = 0;
  const newId = deps.id ?? (() => `mes-${(idCounter += 1)}`);

  /** Internal plan records, keyed by id. */
  const records = new Map();

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

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

  function getRecordOrThrow(id) {
    const rec = records.get(id);
    if (!rec) {
      throw mesError('MES_NOT_FOUND', `Unknown edit/delete plan id: ${id}`, { planId: id });
    }
    return rec;
  }

  function snapshot(rec) {
    return Object.freeze({
      id: rec.id,
      state: rec.state,
      intent: Object.freeze({ ...rec.intent }),
      plan: rec.plan,
      action: rec.plan.action,
      attempts: rec.attempts,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      lastError: rec.lastError === null ? null : Object.freeze({ ...rec.lastError }),
    });
  }

  function transition(rec, to, actor, detail) {
    const from = rec.state;
    rec.state = to;
    rec.updatedAt = clock();
    record({
      at: rec.updatedAt,
      from,
      to,
      actor,
      detail: { planId: rec.id, ...(detail ?? {}) },
    });
    return snapshot(rec);
  }

  function failFastUnsupported(rec, actor) {
    const plan = rec.plan;
    transition(rec, 'unsupported', actor, {
      action: plan.action,
      reason: plan.reason,
      failureCode: plan.failureCode,
    });
    throw mesError(
      plan.failureCode ?? 'MES_UNSUPPORTED',
      `Edit/delete ${rec.intent.kind} on ${rec.intent.channel} is not executable: ${plan.reason}`,
      {
        planId: rec.id,
        action: plan.action,
        reason: plan.reason,
      },
    );
  }

  const planner = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    /** Effective capability matrix (frozen). */
    get matrix() {
      return matrix;
    },

    /**
     * Pure planning: {action, reason, failureCode?} for an intent. Does not
     * create a record and never touches the syncer.
     */
    plan(intent) {
      return planIntent(intent, matrix, clock());
    },

    /**
     * Record an intent in `planned` state with its computed plan. Unsupported
     * intents are recorded too (so the failure is audited) and fail fast at
     * execute() — the syncer is never called for them.
     */
    submit(intent, actor = 'agent') {
      const plan = planIntent(intent, matrix, clock());
      const id = newId();
      const now = clock();
      const rec = {
        id,
        state: 'planned',
        intent: { ...intent },
        plan,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      records.set(id, rec);
      record({
        at: now,
        from: null,
        to: 'planned',
        actor,
        detail: { planId: id, action: plan.action, reason: plan.reason },
      });
      return snapshot(rec);
    },

    /**
     * Execute a planned intent through the injected syncer:
     * planned → syncing → synced; transient syncer failures get exactly one
     * retry; permanent or twice-failed attempts → failed. Unsupported plans
     * move to `unsupported` and throw without ever calling the syncer.
     */
    async execute(id, actor = 'agent') {
      const rec = getRecordOrThrow(id);
      if (rec.state !== 'planned') {
        throw mesError(
          'MES_INVALID_TRANSITION',
          `Cannot execute plan ${id} from state '${rec.state}' (must be 'planned')`,
          { planId: id, state: rec.state },
        );
      }
      if (rec.plan.action === 'unsupported') {
        failFastUnsupported(rec, actor);
      }
      if (!syncer) {
        transition(rec, 'failed', actor, { reason: 'no syncer injected' });
        throw mesError('MES_NO_SYNCER', 'No syncer injected — cannot perform channel sync', {
          planId: id,
        });
      }

      transition(rec, 'syncing', actor, { action: rec.plan.action });
      const intent = rec.intent;
      const ageMs = Math.max(0, clock() - intent.sentAt);
      const op = Object.freeze({
        planId: rec.id,
        action: rec.plan.action,
        channel: intent.channel,
        messageId: intent.messageId,
        kind: intent.kind,
        ...(intent.kind === 'edit' ? { newText: intent.newText } : {}),
        sentAt: intent.sentAt,
        ageMs,
        actor,
      });

      let result;
      for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
        rec.attempts = attempt;
        try {
          result = await syncer(op);
          break;
        } catch (err) {
          rec.lastError = { code: err?.code ?? null, message: err?.message ?? String(err) };
          const retriable = attempt < MAX_SYNC_ATTEMPTS && isTransient(err);
          record({
            at: clock(),
            from: 'syncing',
            to: 'syncing',
            actor,
            detail: {
              planId: rec.id,
              attempt,
              retriable,
              errorCode: err?.code ?? null,
              errorMessage: err?.message ?? String(err),
            },
          });
          if (!retriable) {
            transition(rec, 'failed', actor, {
              reason: 'syncer failure',
              attempts: rec.attempts,
              errorCode: err?.code ?? null,
              errorMessage: err?.message ?? String(err),
            });
            throw mesError(
              'MES_SYNC_FAILED',
              `Channel sync failed for ${intent.channel} ${intent.kind} (plan ${rec.id}): ${err?.message ?? String(err)}`,
              { planId: rec.id, attempts: rec.attempts, causeCode: err?.code ?? null },
            );
          }
        }
      }

      return transition(rec, 'synced', actor, {
        action: rec.plan.action,
        attempts: rec.attempts,
        syncResult: result === undefined ? null : result,
      });
    },

    /** Read-only snapshot of a plan record (null if unknown). */
    get(id) {
      const rec = records.get(id);
      return rec ? snapshot(rec) : null;
    },
  };

  return Object.freeze(planner);
}
