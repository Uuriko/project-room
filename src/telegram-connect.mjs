/**
 * telegram-connect.mjs — Pure Telegram bot token connection state machine.
 *
 * Models connecting a Telegram bot token without ever touching the network,
 * the DOM, localStorage, or persisting a secret anywhere. The raw token is
 * held ONLY transiently in memory between stageToken() and verify() (or
 * expiry/disconnect), then wiped. Everything durable — snapshots, audit
 * entries — carries only the token fingerprint (hash prefix + last 4 chars),
 * never the raw token.
 *
 * States:
 *   disconnected → token-staged → verifying → connected
 *   Side states: failed, expired
 *
 * Flow: createConnection() starts `disconnected`. stageToken() validates the
 * token format, fingerprints it, and moves to `token-staged`. verify() moves
 * through `verifying` while the injected verifier checks the token, then
 * lands in `connected` (bot profile recorded) or `failed`. disconnect() returns
 * to `disconnected` from any non-disconnected state. Staged tokens older than
 * stageTtlMs are dead: verify() transitions them to `expired` and throws, and
 * sweep() expires them in bulk.
 *
 * Dependency injection (all via the `deps` parameter of createTelegramConnect):
 *   - clock:       () => number  (ms epoch; default: Date.now)
 *   - id:          () => string  (connection id generator; default: per-gate counter)
 *   - hash:        (input: string) => string  (fingerprint hash; default: FNV-1a hex)
 *   - verifier:    (botId: string, token: string) => object  (sync token check;
 *                  must return a truthy bot profile or throw; default: accepts any
 *                  well-formed token and returns { botId })
 *   - stageTtlMs:  number        (token-staged TTL; default: 10 minutes)
 *
 * The verifier runs synchronously: production wiring performs its network call
 * OUTSIDE this machine and injects the result via a verifier that returns the
 * profile or throws — this module never does I/O itself.
 *
 * The injected `hash` feeds the token fingerprint, so production wiring MUST
 * inject a cryptographic hash (e.g. sha256 hex). The default FNV-1a is
 * deterministic but NOT collision-resistant; it exists only so the machine is
 * usable/testable without any dependency.
 *
 * Token format: /^\d+:[A-Za-z0-9_-]+$/ (Telegram bot tokens are botId:secret).
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   TG_NOT_FOUND          — unknown connection id
 *   TG_TOKEN_MALFORMED    — token fails the format check
 *   TG_INVALID_TRANSITION — operation not allowed from the current state
 *   TG_VERIFY_FAILED      — the injected verifier rejected the token
 *   TG_VERIFY_EXPIRED     — staged token lived longer than stageTtlMs
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'disconnected',
  'token-staged',
  'verifying',
  'connected',
  'failed',
  'expired',
]);

export const DEFAULT_STAGE_TTL_MS = 10 * 60 * 1000;

export const TOKEN_FORMAT = /^\d+:[A-Za-z0-9_-]+$/;

/** Throw a coded telegram-connect error (never silent failures). */
function tgError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Default fingerprint hash: FNV-1a (32-bit), hex. Deterministic, non-crypto. */
function fnv1aHex(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Create a new Telegram bot token connection machine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(input: string) => string} [deps.hash]
 * @param {(botId: string, token: string) => object} [deps.verifier]
 * @param {number} [deps.stageTtlMs]
 */
export function createTelegramConnect(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const hash = deps.hash ?? fnv1aHex;
  const verifier = deps.verifier ?? ((botId) => ({ botId }));
  const stageTtlMs = deps.stageTtlMs ?? DEFAULT_STAGE_TTL_MS;

  let idCounter = 0;
  const newId = deps.id ?? (() => `tg-conn-${(idCounter += 1)}`);

  /** Internal connection records, keyed by id. */
  const connections = new Map();

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

  /** Fingerprint for a token: hash prefix + last 4 chars. Never the raw token. */
  function fingerprint(token) {
    return `${hash(token).slice(0, 8)}…${token.slice(-4)}`;
  }

  /** Split a well-formed token into its bot id (digits before the colon). */
  function botIdOf(token) {
    return token.slice(0, token.indexOf(':'));
  }

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
      throw tgError('TG_NOT_FOUND', `Unknown telegram connection id: ${id}`, {
        connectionId: id,
      });
    }
    return conn;
  }

  /** Public snapshot: exposes the fingerprint, never the raw token. */
  function snapshot(conn) {
    return Object.freeze({
      id: conn.id,
      label: conn.label,
      state: conn.state,
      botId: conn.botId,
      tokenFingerprint: conn.tokenFingerprint,
      botProfile: conn.botProfile ? Object.freeze({ ...conn.botProfile }) : null,
      stagedAt: conn.stagedAt,
      verifiedAt: conn.verifiedAt,
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
      detail: {
        connectionId: conn.id,
        ...(conn.tokenFingerprint ? { tokenFingerprint: conn.tokenFingerprint } : {}),
        ...(detail ?? {}),
      },
    });
    return snapshot(conn);
  }

  /** Wipe the transient raw token from a record. Called after every use. */
  function wipeToken(conn) {
    conn.rawToken = null;
  }

  function assertState(conn, allowed, op) {
    if (!allowed.includes(conn.state)) {
      throw tgError(
        'TG_INVALID_TRANSITION',
        `Cannot ${op} connection ${conn.id} from state '${conn.state}'`,
        { connectionId: conn.id, state: conn.state, op },
      );
    }
  }

  /** True when a staged token has lived past its TTL (uses injected clock). */
  function isStageExpired(conn) {
    return (
      conn.state === 'token-staged' &&
      conn.stagedAt != null &&
      clock() - conn.stagedAt > stageTtlMs
    );
  }

  /**
   * If a staged token has expired, wipe it, move the connection to `expired`,
   * and throw TG_VERIFY_EXPIRED.
   */
  function expireIfStale(conn, actor, op) {
    if (isStageExpired(conn)) {
      wipeToken(conn);
      transition(conn, 'expired', actor, {
        reason: 'stage TTL elapsed',
        stageTtlMs,
      });
      throw tgError(
        'TG_VERIFY_EXPIRED',
        `Staged token for connection ${conn.id} expired (TTL ${stageTtlMs}ms) before ${op}`,
        { connectionId: conn.id, stageTtlMs },
      );
    }
  }

  const machine = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    get stageTtlMs() {
      return stageTtlMs;
    },

    /** Create a new connection in `disconnected` state. */
    createConnection(label = '', actor = 'agent') {
      const id = newId();
      const conn = {
        id,
        label,
        state: 'disconnected',
        botId: null,
        tokenFingerprint: null,
        rawToken: null,
        botProfile: null,
        stagedAt: null,
        verifiedAt: null,
        failReason: null,
      };
      connections.set(id, conn);
      record({
        at: clock(),
        from: null,
        to: 'disconnected',
        actor,
        detail: { connectionId: id, label },
      });
      return snapshot(conn);
    },

    /**
     * Validate and stage a token. The raw token is held ONLY transiently in
     * memory until verify()/sweep()/disconnect() consumes or wipes it; the
     * record keeps just the fingerprint. Allowed from disconnected,
     * token-staged (re-stage replaces the previous token), failed, expired.
     */
    stageToken(id, token, actor = 'agent') {
      const conn = getConnOrThrow(id);
      assertState(conn, ['disconnected', 'token-staged', 'failed', 'expired'], 'stage token for');
      if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) {
        throw tgError(
          'TG_TOKEN_MALFORMED',
          `Malformed telegram bot token for connection ${id}: expected digits:alphanumeric`,
          { connectionId: id },
        );
      }
      wipeToken(conn);
      conn.botId = botIdOf(token);
      conn.tokenFingerprint = fingerprint(token);
      conn.rawToken = token;
      conn.botProfile = null;
      conn.stagedAt = clock();
      conn.verifiedAt = null;
      conn.failReason = null;
      return transition(conn, 'token-staged', actor, {
        botId: conn.botId,
      });
    },

    /**
     * Run the injected verifier against the staged token. Moves
     * token-staged → verifying, then to `connected` on success (raw token
     * wiped, bot profile recorded) or `failed` on verifier rejection.
     * Expired staged tokens move to `expired` and throw TG_VERIFY_EXPIRED.
     */
    verify(id, actor = 'agent') {
      const conn = getConnOrThrow(id);
      assertState(conn, ['token-staged'], 'verify');
      expireIfStale(conn, actor, 'verify');
      const token = conn.rawToken;
      transition(conn, 'verifying', actor, { botId: conn.botId });
      let profile;
      try {
        profile = verifier(conn.botId, token);
      } catch (verifierErr) {
        wipeToken(conn);
        conn.failReason = verifierErr instanceof Error ? verifierErr.message : String(verifierErr);
        transition(conn, 'failed', actor, { reason: conn.failReason });
        throw tgError(
          'TG_VERIFY_FAILED',
          `Token verification failed for connection ${id}: ${conn.failReason}`,
          { connectionId: id, reason: conn.failReason },
        );
      }
      wipeToken(conn);
      if (!profile || typeof profile !== 'object') {
        conn.failReason = 'verifier returned no bot profile';
        transition(conn, 'failed', actor, { reason: conn.failReason });
        throw tgError(
          'TG_VERIFY_FAILED',
          `Token verification failed for connection ${id}: ${conn.failReason}`,
          { connectionId: id, reason: conn.failReason },
        );
      }
      conn.botProfile = { ...profile };
      conn.verifiedAt = clock();
      conn.failReason = null;
      return transition(conn, 'connected', actor, {
        botId: conn.botId,
        verifiedAt: conn.verifiedAt,
      });
    },

    /**
     * Disconnect: wipe any staged token and profile, return to
     * `disconnected`. Not allowed when already disconnected.
     */
    disconnect(id, actor = 'agent') {
      const conn = getConnOrThrow(id);
      assertState(conn, ['token-staged', 'verifying', 'connected', 'failed', 'expired'], 'disconnect');
      wipeToken(conn);
      conn.botProfile = null;
      conn.failReason = null;
      return transition(conn, 'disconnected', actor, {});
    },

    /**
     * Transition every stale staged token to `expired` (wiping the raw
     * token). Returns the ids that expired in this sweep.
     */
    sweep(actor = 'system') {
      const expired = [];
      for (const conn of connections.values()) {
        if (isStageExpired(conn)) {
          wipeToken(conn);
          transition(conn, 'expired', actor, {
            reason: 'stage TTL elapsed',
            stageTtlMs,
          });
          expired.push(conn.id);
        }
      }
      return expired;
    },

    /** Read-only snapshot of a connection (null if unknown). */
    get(id) {
      const conn = connections.get(id);
      return conn ? snapshot(conn) : null;
    },
  };

  return Object.freeze(machine);
}
