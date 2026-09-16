/**
 * unsubscribe-execution.mjs — Pure per-message unsubscribe detection + execution planner.
 *
 * Complements A014-2's bulk executor (which fans out across many messages):
 * this module is the per-message detection side. It detects HOW a single
 * message can be unsubscribed from, then plans and records execution of that
 * unsubscribe. Nothing here touches the network, the DOM, localStorage, or any
 * secret — header parsing is pure, and execution runs through an injected
 * `executor` dependency so production wiring controls the actual HTTP/mailto
 * delivery (e.g. A014-2's bulk executor).
 *
 * Detection rules (RFC 8058 / List-Unsubscribe headers, case-insensitive):
 *   1. `List-Unsubscribe-Post: List-Unsubscribe=One-Click` + an <https://...>
 *      URL in `List-Unsubscribe` → method 'one-click', confidence 1.0
 *      (highest). One-click POST is only defined over https; without a usable
 *      https URL we fall through to rule 2.
 *   2. `List-Unsubscribe` header → parse <mailto:...> and <http(s):...> URLs
 *      from angle-bracketed entries (comma-separated). First https URL wins
 *      for method 'http' (confidence 0.9); if only plain http URLs exist the
 *      first one is used (confidence 0.85); if only mailto URLs exist the
 *      first one is used for method 'mailto' (confidence 0.8). When both
 *      https and mailto are present, https is preferred.
 *   3. No usable header → detect() returns null (and execute() on a null/no
 *      signal input throws UD_NO_SIGNAL).
 *
 * States:
 *   detected → executing → done
 *   Side states: failed, skipped
 *
 * Dependency injection (all via the `deps` parameter of
 * createUnsubscribeEngine):
 *   - clock:    () => number  (ms epoch; default: Date.now)
 *   - id:       () => string  (detection id generator; default: per-engine
 *                              counter 'ud-N')
 *   - executor: (detection) => result | Promise<result>  (REQUIRED for
 *               execute(); sync or async. A thrown error with `transient: true`
 *               — or code 'UD_EXEC_TRANSIENT' — triggers exactly one retry.)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   UD_NO_SIGNAL        — execute() called with null/no-signal input
 *   UD_NOT_FOUND        — unknown detection id
 *   UD_NOT_CONFIRMED    — execute() called without { confirmed: true }
 *   UD_NO_EXECUTOR      — execute() with no executor injected
 *   UD_INVALID_TRANSITION — operation not allowed from the current state
 *   UD_EXEC_FAILED      — executor failed (after the single transient retry)
 * Failures are never silent. Every execute() attempt (including retries) is
 * recorded on the append-only audit log.
 */

export const METHODS = Object.freeze(['one-click', 'http', 'mailto']);

export const STATES = Object.freeze([
  'detected',
  'executing',
  'done',
  'failed',
  'skipped',
]);

export const CONFIDENCE = Object.freeze({
  'one-click': 1.0,
  http: 0.9,
  'http-plain': 0.85,
  mailto: 0.8,
});

export const MAX_ATTEMPTS = 2; // initial attempt + exactly one transient retry

/** Throw a coded unsubscribe error (never silent failures). */
function udError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Case-insensitive header lookup. Values may be a string or array of strings. */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const raw = headers[key];
      if (Array.isArray(raw)) return raw.filter((v) => v != null).join(', ');
      return raw == null ? '' : String(raw);
    }
  }
  return null;
}

/** Parse angle-bracketed <mailto:...>/<http(s):...> URLs from a header value. */
function parseUnsubscribeTargets(listUnsub) {
  const mailtos = [];
  const httpsUrls = [];
  const httpUrls = [];
  if (!listUnsub) return { mailtos, httpsUrls, httpUrls };
  const re = /<\s*(mailto:[^<>\s]+|https?:\/\/[^<>\s]+)\s*>/gi;
  let m;
  while ((m = re.exec(listUnsub)) !== null) {
    const target = m[1];
    if (/^mailto:/i.test(target)) mailtos.push(target);
    else if (/^https:\/\//i.test(target)) httpsUrls.push(target);
    else httpUrls.push(target);
  }
  return { mailtos, httpsUrls, httpUrls };
}

/**
 * Detect how a message can be unsubscribed from.
 * @param {object} messageHeaders — header name → value (string or string[])
 * @returns detection record in `detected` state, or null when no usable signal.
 */
export function detectUnsubscribe(messageHeaders) {
  const post = headerValue(messageHeaders, 'List-Unsubscribe-Post');
  const listUnsub = headerValue(messageHeaders, 'List-Unsubscribe');

  const oneClickSignaled =
    post != null && /list-unsubscribe\s*=\s*one-click/i.test(post);

  const { mailtos, httpsUrls, httpUrls } = parseUnsubscribeTargets(listUnsub);

  let method = null;
  let target = null;
  let confidence = null;

  if (oneClickSignaled && httpsUrls.length > 0) {
    // RFC 8058 one-click: POST the https URL; highest confidence.
    method = 'one-click';
    target = httpsUrls[0];
    confidence = CONFIDENCE['one-click'];
  } else if (httpsUrls.length > 0) {
    method = 'http';
    target = httpsUrls[0];
    confidence = CONFIDENCE.http;
  } else if (httpUrls.length > 0) {
    method = 'http';
    target = httpUrls[0];
    confidence = CONFIDENCE['http-plain'];
  } else if (mailtos.length > 0) {
    method = 'mailto';
    target = mailtos[0];
    confidence = CONFIDENCE.mailto;
  } else {
    return null;
  }

  return {
    method,
    target,
    confidence,
    signals: {
      oneClickSignaled,
      mailtos: [...mailtos],
      httpsUrls: [...httpsUrls],
      httpUrls: [...httpUrls],
    },
  };
}

/**
 * Create an unsubscribe detection + execution engine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(detection) => (result | Promise<result>)} [deps.executor]
 */
export function createUnsubscribeEngine(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const executor = deps.executor ?? null;

  let idCounter = 0;
  const newId = deps.id ?? (() => `ud-${(idCounter += 1)}`);

  /** Internal detection records, keyed by id. */
  const detections = new Map();

  /** Append-only audit log: every attempt and transition lands here. */
  const audit = [];

  function record({ at, detectionId, from, to, attempt, actor, detail }) {
    const entry = Object.freeze({
      at,
      detectionId,
      from,
      to,
      attempt: attempt === undefined ? null : attempt,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function snapshot(rec) {
    return Object.freeze({
      id: rec.id,
      method: rec.method,
      target: rec.target,
      confidence: rec.confidence,
      signals: Object.freeze({
        oneClickSignaled: rec.signals.oneClickSignaled,
        mailtos: Object.freeze([...rec.signals.mailtos]),
        httpsUrls: Object.freeze([...rec.signals.httpsUrls]),
        httpUrls: Object.freeze([...rec.signals.httpUrls]),
      }),
      state: rec.state,
      attempts: Object.freeze(rec.attempts.map((a) => Object.freeze({ ...a }))),
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      error: rec.error,
    });
  }

  function transition(rec, to, actor, detail) {
    const from = rec.state;
    rec.state = to;
    rec.updatedAt = clock();
    record({
      at: rec.updatedAt,
      detectionId: rec.id,
      from,
      to,
      actor,
      detail: { method: rec.method, target: rec.target, ...(detail ?? {}) },
    });
    return snapshot(rec);
  }

  function getRecordOrThrow(id) {
    const rec = detections.get(id);
    if (!rec) {
      throw udError('UD_NOT_FOUND', `Unknown unsubscribe detection id: ${id}`, {
        detectionId: id,
      });
    }
    return rec;
  }

  function resolveId(input) {
    if (input == null) {
      throw udError(
        'UD_NO_SIGNAL',
        'Cannot execute: no unsubscribe signal (detect() returned null)',
      );
    }
    if (typeof input === 'string') return input;
    if (typeof input === 'object' && typeof input.id === 'string') return input.id;
    throw udError(
      'UD_NO_SIGNAL',
      'Cannot execute: expected a detection id or detection record',
    );
  }

  function isTransient(err) {
    return Boolean(err && (err.transient === true || err.code === 'UD_EXEC_TRANSIENT'));
  }

  const engine = {
    /** Append-only audit trail: {at, detectionId, from, to, attempt, actor, detail}. */
    get audit() {
      return [...audit];
    },

    /**
     * Pure detection. Registers the detection in `detected` state and returns
     * its snapshot — or null when no usable signal exists.
     */
    detect(messageHeaders, actor = 'agent') {
      const found = detectUnsubscribe(messageHeaders);
      if (!found) return null;
      const now = clock();
      const rec = {
        id: newId(),
        method: found.method,
        target: found.target,
        confidence: found.confidence,
        signals: found.signals,
        state: 'detected',
        attempts: [],
        createdAt: now,
        updatedAt: now,
        error: null,
      };
      detections.set(rec.id, rec);
      record({
        at: now,
        detectionId: rec.id,
        from: null,
        to: 'detected',
        actor,
        detail: {
          method: rec.method,
          target: rec.target,
          confidence: rec.confidence,
        },
      });
      return snapshot(rec);
    },

    /** detect() over many header sets, in order; null per no-signal entry. */
    detectBatch(headersList, actor = 'agent') {
      if (!Array.isArray(headersList)) {
        throw udError(
          'UD_NO_SIGNAL',
          'detectBatch() expects an array of header objects',
          { received: typeof headersList },
        );
      }
      return headersList.map((headers) => engine.detect(headers, actor));
    },

    /** Read-only snapshot of a detection (null if unknown). */
    get(id) {
      const rec = detections.get(id);
      return rec ? snapshot(rec) : null;
    },

    /**
     * Execute an unsubscribe. Requires { confirmed: true }. Runs the injected
     * executor with a retry-once policy: a transient failure (err.transient ===
     * true or err.code === 'UD_EXEC_TRANSIENT') is retried exactly once;
     * non-transient failures and a second transient failure move the record to
     * `failed` and throw UD_EXEC_FAILED. Successful execution → `done`.
     */
    async execute(input, options = {}, actor = 'agent') {
      const id = resolveId(input);
      const rec = getRecordOrThrow(id);

      if (!options || options.confirmed !== true) {
        throw udError(
          'UD_NOT_CONFIRMED',
          `Refusing to execute unsubscribe ${id}: confirmation required (pass { confirmed: true })`,
          { detectionId: id, state: rec.state },
        );
      }
      if (rec.state !== 'detected') {
        throw udError(
          'UD_INVALID_TRANSITION',
          `Cannot execute unsubscribe ${id} from state '${rec.state}' (must be 'detected')`,
          { detectionId: id, state: rec.state },
        );
      }
      if (!executor) {
        throw udError(
          'UD_NO_EXECUTOR',
          `Cannot execute unsubscribe ${id}: no executor injected`,
          { detectionId: id },
        );
      }

      transition(rec, 'executing', actor, { attempt: rec.attempts.length + 1 });

      const detectionForExecutor = Object.freeze({
        id: rec.id,
        method: rec.method,
        target: rec.target,
        confidence: rec.confidence,
      });

      let attempt = 0;
      while (attempt < MAX_ATTEMPTS) {
        attempt += 1;
        const at = clock();
        try {
          const result = await executor(detectionForExecutor);
          rec.attempts.push({ n: attempt, at, ok: true, result: result ?? null });
          record({
            at,
            detectionId: rec.id,
            from: 'executing',
            to: 'executing',
            attempt,
            actor,
            detail: { outcome: 'attempt-ok', transient: false },
          });
          rec.error = null;
          return transition(rec, 'done', actor, { attempts: rec.attempts.length });
        } catch (err) {
          const transient = isTransient(err);
          rec.attempts.push({
            n: attempt,
            at,
            ok: false,
            transient,
            error: err instanceof Error ? err.message : String(err),
            errorCode: err && err.code ? err.code : null,
          });
          record({
            at,
            detectionId: rec.id,
            from: 'executing',
            to: 'executing',
            attempt,
            actor,
            detail: {
              outcome: 'attempt-failed',
              transient,
              errorCode: err && err.code ? err.code : null,
            },
          });
          if (!transient || attempt >= MAX_ATTEMPTS) {
            rec.error = {
              code: 'UD_EXEC_FAILED',
              message: err instanceof Error ? err.message : String(err),
            };
            transition(rec, 'failed', actor, {
              attempts: rec.attempts.length,
              reason: transient ? 'transient failure persisted past retry' : 'non-transient failure',
            });
            throw udError(
              'UD_EXEC_FAILED',
              `Unsubscribe ${id} failed after ${attempt} attempt(s): ${rec.error.message}`,
              { detectionId: id, attempts: attempt, transient },
            );
          }
          // Transient failure with attempts remaining: retry once.
        }
      }
      // Unreachable: loop always returns or throws.
      throw udError('UD_EXEC_FAILED', `Unsubscribe ${id} exhausted attempts`, {
        detectionId: id,
      });
    },

    /**
     * Mark a detection as skipped (e.g. user opted out of unsubscribing).
     * Allowed only from `detected`.
     */
    skip(input, reason, actor = 'agent') {
      const id = resolveId(input);
      const rec = getRecordOrThrow(id);
      if (rec.state !== 'detected') {
        throw udError(
          'UD_INVALID_TRANSITION',
          `Cannot skip unsubscribe ${id} from state '${rec.state}' (must be 'detected')`,
          { detectionId: id, state: rec.state },
        );
      }
      return transition(rec, 'skipped', actor, { reason: reason ?? '' });
    },
  };

  return Object.freeze(engine);
}
