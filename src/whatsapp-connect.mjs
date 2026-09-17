/**
 * whatsapp-connect.mjs — Pure WhatsApp connection state machine.
 *
 * Models the WhatsApp pairing/link flow as a pure state machine. Nothing here
 * touches the network, the DOM, localStorage, or any secret — it is pure
 * logic with dependency injection for everything external.
 *
 * States:
 *   disconnected → code-staged → linking → connected
 *   Side states: failed, expired
 *
 * A phone number enters at `disconnected`; `stageCode(phone)` validates it as
 * E.164, stages an 8-digit pairing code (format XXXX-XXXX) via the injected
 * `code` generator, and moves the connection to `code-staged`. `confirmCode`
 * checks the code (with a max-attempts limit, default 5, that invalidates the
 * code) and moves to `linking`; the injected `linker` performs the (mock) link
 * step on `link()` and moves to `connected` or `failed`. Codes expire after
 * `codeTtlMs` (default 10 minutes) via the injected `clock`.
 *
 * Secret hygiene: the full phone number is NEVER stored. Only the last-4-digit
 * fingerprint is kept for display/identification. The pairing code itself is
 * an ephemeral pairing artifact, not a long-lived secret, but it is kept out
 * of snapshots — it is only ever compared, never returned.
 *
 * Dependency injection (all via the `deps` parameter of createWhatsAppConnect):
 *   - clock:          () => number  (ms epoch; default: Date.now)
 *   - id:             () => string  (connection id generator; default: per-gate counter)
 *   - code:           () => string  (8-digit pairing code as XXXX-XXXX; default: random)
 *   - linker:         ({ connectionId, phoneFingerprint }) => result
 *                                     (mock link step; default: always succeeds)
 *   - codeTtlMs:      number        (pairing-code TTL; default: 10 minutes)
 *   - maxCodeAttempts: number       (wrong-code attempts before invalidation; default: 5)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   WA_PHONE_INVALID      — phone number is not valid E.164
 *   WA_INVALID_TRANSITION — operation not allowed from the current state
 *   WA_NOT_FOUND          — unknown connection id
 *   WA_CODE_MISMATCH      — presented code does not match the staged code
 *   WA_ATTEMPTS_EXCEEDED  — too many wrong attempts; code invalidated
 *   WA_CODE_EXPIRED       — pairing code lived longer than codeTtlMs
 *   WA_CODE_INVALIDATED   — code was invalidated by too many attempts
 *   WA_LINK_FAILED        — the injected linker step failed
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'disconnected',
  'code-staged',
  'linking',
  'connected',
  'failed',
  'expired',
]);

export const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_CODE_ATTEMPTS = 5;

/** E.164: leading +, country code 1-9, then 7–14 digits (8–15 total). */
export const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Pairing code shape: XXXX-XXXX, 8 digits. */
export const PAIRING_CODE_RE = /^\d{4}-\d{4}$/;

/** Throw a coded WhatsApp-connect error (never silent failures). */
function waError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Default pairing-code generator: random 8 digits as XXXX-XXXX. */
function randomCode() {
  const digits = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/** Keep only the last 4 digits — never store the raw phone number. */
function fingerprint(phone) {
  return phone.slice(-4);
}

/**
 * Create a new WhatsApp connection state machine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {() => string} [deps.code]
 * @param {(args: { connectionId: string, phoneFingerprint: string }) => any} [deps.linker]
 * @param {number} [deps.codeTtlMs]
 * @param {number} [deps.maxCodeAttempts]
 */
export function createWhatsAppConnect(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const codeTtlMs = deps.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
  const maxCodeAttempts = deps.maxCodeAttempts ?? DEFAULT_MAX_CODE_ATTEMPTS;
  const code = deps.code ?? randomCode;
  // Default linker: always succeeds. Production wiring injects the real (mock)
  // link step; tests inject a linker that throws to exercise the failure path.
  const linker = deps.linker ?? (() => ({ ok: true }));

  let idCounter = 0;
  const newId = deps.id ?? (() => `wa-${(idCounter += 1)}`);

  /** Internal connection records, keyed by id. */
  const connections = new Map();

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

  function getConnOrThrow(id) {
    const conn = connections.get(id);
    if (!conn) {
      throw waError('WA_NOT_FOUND', `Unknown WhatsApp connection id: ${id}`, {
        connectionId: id,
      });
    }
    return conn;
  }

  function snapshot(conn) {
    return Object.freeze({
      id: conn.id,
      state: conn.state,
      phoneFingerprint: conn.phoneFingerprint,
      codeStagedAt: conn.codeStagedAt,
      codeAttempts: conn.codeAttempts,
      linkedAt: conn.linkedAt,
      failReason: conn.failReason,
    });
  }

  function transition(conn, to, actor, detail) {
    const from = conn.state;
    conn.state = to;
    record({
      at: clock(),
      from,
      to,
      actor,
      detail: { connectionId: conn.id, ...(detail ?? {}) },
    });
    return snapshot(conn);
  }

  /** True when a staged code has lived past its TTL (uses injected clock). */
  function isCodeExpired(conn) {
    return (
      conn.state === 'code-staged' &&
      conn.codeStagedAt != null &&
      clock() - conn.codeStagedAt > codeTtlMs
    );
  }

  /**
   * If the staged code has expired, move the connection to `expired` and throw.
   * Called at the top of confirmCode() and by sweep() so expiry is never silent.
   */
  function expireIfStale(conn, actor) {
    if (isCodeExpired(conn)) {
      conn.code = null;
      transition(conn, 'expired', actor, {
        reason: 'pairing code TTL elapsed',
        codeTtlMs,
      });
      throw waError(
        'WA_CODE_EXPIRED',
        `Pairing code for connection ${conn.id} expired (TTL ${codeTtlMs}ms)`,
        { connectionId: conn.id, codeTtlMs },
      );
    }
  }

  function assertState(conn, allowed, op) {
    if (!allowed.includes(conn.state)) {
      throw waError(
        'WA_INVALID_TRANSITION',
        `Cannot ${op} connection ${conn.id} from state '${conn.state}'`,
        { connectionId: conn.id, state: conn.state, op },
      );
    }
  }

  const machine = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    get codeTtlMs() {
      return codeTtlMs;
    },

    get maxCodeAttempts() {
      return maxCodeAttempts;
    },

    /** Create a new connection in `disconnected` state. No phone stored yet. */
    createConnection(actor = 'agent') {
      const id = newId();
      const conn = {
        id,
        state: 'disconnected',
        phoneFingerprint: null,
        code: null,
        codeStagedAt: null,
        codeAttempts: 0,
        linkedAt: null,
        failReason: null,
      };
      connections.set(id, conn);
      record({ at: clock(), from: null, to: 'disconnected', actor, detail: { connectionId: id } });
      return snapshot(conn);
    },

    /**
     * Validate the phone number as E.164 and stage a pairing code.
     * Only the last-4-digit fingerprint is stored — never the raw number.
     */
    stageCode(id, phone, actor = 'agent') {
      const conn = getConnOrThrow(id);
      assertState(conn, ['disconnected', 'expired', 'failed'], 'stage a pairing code for');
      if (typeof phone !== 'string' || !E164_RE.test(phone)) {
        throw waError(
          'WA_PHONE_INVALID',
          `Phone number is not valid E.164: ${typeof phone === 'string' ? 'redacted' : typeof phone}`,
          { connectionId: id },
        );
      }
      const staged = code();
      if (typeof staged !== 'string' || !PAIRING_CODE_RE.test(staged)) {
        throw waError(
          'WA_INVALID_TRANSITION',
          `Injected code generator produced a malformed pairing code`,
          { connectionId: id },
        );
      }
      conn.phoneFingerprint = fingerprint(phone);
      conn.code = staged;
      conn.codeStagedAt = clock();
      conn.codeAttempts = 0;
      conn.failReason = null;
      conn.linkedAt = null;
      return transition(conn, 'code-staged', actor, {
        phoneFingerprint: conn.phoneFingerprint,
        codeTtlMs,
        maxCodeAttempts,
      });
    },

    /**
     * Confirm the staged pairing code. Wrong attempts are counted; reaching
     * `maxCodeAttempts` invalidates the code (→ `failed`, WA_ATTEMPTS_EXCEEDED).
     * Expired codes transition to `expired` and throw WA_CODE_EXPIRED.
     */
    confirmCode(id, presentedCode, actor = 'agent') {
      const conn = getConnOrThrow(id);
      assertState(conn, ['code-staged'], 'confirm a pairing code for');
      expireIfStale(conn, actor);
      if (conn.code === null) {
        // Code was invalidated by too many attempts.
        throw waError(
          'WA_CODE_INVALIDATED',
          `Pairing code for connection ${conn.id} was invalidated by too many attempts`,
          { connectionId: conn.id },
        );
      }
      if (presentedCode !== conn.code) {
        conn.codeAttempts += 1;
        if (conn.codeAttempts >= maxCodeAttempts) {
          conn.code = null;
          conn.failReason = 'too many wrong attempts';
          transition(conn, 'failed', actor, {
            reason: 'too many wrong pairing-code attempts',
            codeAttempts: conn.codeAttempts,
            maxCodeAttempts,
          });
          throw waError(
            'WA_ATTEMPTS_EXCEEDED',
            `Too many wrong pairing-code attempts for connection ${conn.id} (${conn.codeAttempts}/${maxCodeAttempts}); code invalidated`,
            { connectionId: conn.id, codeAttempts: conn.codeAttempts, maxCodeAttempts },
          );
        }
        throw waError(
          'WA_CODE_MISMATCH',
          `Wrong pairing code for connection ${conn.id} (attempt ${conn.codeAttempts + 1}/${maxCodeAttempts})`,
          { connectionId: conn.id, codeAttempts: conn.codeAttempts + 1, maxCodeAttempts },
        );
      }
      conn.code = null; // single-use
      return transition(conn, 'linking', actor, {
        phoneFingerprint: conn.phoneFingerprint,
      });
    },

    /**
     * Run the injected linker step. On success → `connected`; if the linker
     * throws, → `failed` with WA_LINK_FAILED wrapping the linker error.
     */
    link(id, actor = 'agent') {
      const conn = getConnOrThrow(id);
      assertState(conn, ['linking'], 'run the link step for');
      try {
        const result = linker({
          connectionId: conn.id,
          phoneFingerprint: conn.phoneFingerprint,
        });
        conn.linkedAt = clock();
        return transition(conn, 'connected', actor, {
          phoneFingerprint: conn.phoneFingerprint,
          linkResult: result === undefined ? null : result,
        });
      } catch (linkErr) {
        conn.failReason = linkErr instanceof Error ? linkErr.message : String(linkErr);
        transition(conn, 'failed', actor, {
          reason: 'link step failed',
          linkError: conn.failReason,
        });
        throw waError(
          'WA_LINK_FAILED',
          `Link step failed for connection ${conn.id}: ${conn.failReason}`,
          { connectionId: conn.id, linkError: conn.failReason },
        );
      }
    },

    /**
     * Transition every stale code-staged connection to `expired`. Returns the
     * ids that expired in this sweep.
     */
    sweep(actor = 'system') {
      const expired = [];
      for (const conn of connections.values()) {
        if (isCodeExpired(conn)) {
          conn.code = null;
          transition(conn, 'expired', actor, {
            reason: 'pairing code TTL elapsed',
            codeTtlMs,
          });
          expired.push(conn.id);
        }
      }
      return expired;
    },

    /** Read-only snapshot of a connection (null if unknown). Never leaks the code. */
    get(id) {
      const conn = connections.get(id);
      return conn ? snapshot(conn) : null;
    },
  };

  return Object.freeze(machine);
}
