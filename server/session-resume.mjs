// server/session-resume.mjs — reattach + native resume for herdr-backed
// agent sessions (build lane B15).
//
// Design sources: REDESIGN.md §2.2 (spawnAgent/reportResume), phase1/seam-design.md
// (resume semantics: the agent CLI's own session store, never transcript replay),
// phase1/risk-review.md §1.3/§3 (report_agent_session resume-argv validation),
// phase2/design-docs/session-lifecycle.md (D2: reattach flow, 60s window,
// occupant re-verification, detached-means-fate-unknown, idempotency contract),
// phase2/design-docs/threat-model-terminal.md §2 (D1: adapter-constructed argv
// from kind→template, never caller-constructed argv).
//
// Layering: this module is bridge-side domain logic. It speaks to herdr only
// through the injected `adapter` object (getOccupant / spawnAgent, optional
// requestReportState) — the B14 SessionAdapter owns re-subscribe / re-snapshot /
// reconcile per the seam spec; this module owns the resume-layer decisions on
// top of it. Reattach tokens map to opaque adapter-level session ids; raw herdr
// pane ids never leave this module toward room code (risk-review §3.3).
//
// CONTINUITY GUARANTEES (the contract this module implements):
//  1. Native resume only. Conversation continuity is the agent CLI's OWN session
//     store via its native resume flag (e.g. `claude --resume <id>`). This module
//     contains no transcript capture, storage, or replay path — enforced by
//     tests/session-resume.test.js C1. Replay-the-transcript is explicitly
//     forbidden (D2 §3.2): it fabricates a past the agent never had.
//  2. Argv is never caller-constructed. The adapter builds resume argv from the
//     registered kind→template shapes (D1 §2.2); callers supply only `kind` +
//     a validated session ref. Stored resume refs are re-validated at
//     registration and the argv is RE-DERIVED from the shape at spawn time —
//     the stored bytes are never executed verbatim.
//  3. Reattach is explicit, never automatic (D2 §1.3 T3). An automatic re-pin
//     could attach a *different* occupant's pane; only an explicit reattach
//     call re-verifies the occupant.
//  4. Occupant re-verification after restart (D2 §3.2): a restored pane's
//     occupant must equal the pinned occupant id, else OccupantChangedError
//     unless the operator explicitly re-pins (forceRepin).
//  5. Detached means fate unknown (D2 §1.1 honesty rule). Silence is not death:
//     a detached session is never declared dead, its claim is untouched, and
//     this module has no claim-board access by construction.
//  6. herdr `done` ≠ claim `done`. Reattach/resume never settles claims.
//  7. Reattach tokens are single-use, expiring, opaque, and memory-resident.
//     A bridge restart invalidates every outstanding token (fail closed —
//     callers re-mint after rehydrate).
//  8. Idempotency (D2 §4): every mutating transition requires an idempotencyKey.
//     A duplicate key returns the stored response byte-for-byte with
//     `duplicate: true` and performs no herdr call. Keys are scoped per
//     transition and retained 24h.
//
// Worker-safe: pure ESM, no node: imports. Randomness via global
// crypto.getRandomValues, base64 via btoa, cloning via structuredClone.

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BARE_BINARY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ARGS = 64; // risk-review §1.3: ≤64 args on the resume-argv primitive
const MAX_ARGV_BYTES = 8192; // risk-review §1.3: 8 KiB cap
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, unpadded
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000; // D2 §4 rule 3: 24h dedupe retention

// D2 §1.3 T4: reattachTimeoutMs default. Exported so the bridge's room-side
// config can reference the design-doc value instead of inventing its own.
export const REATTACH_TIMEOUT_MS_DEFAULT = 60_000;

// ---------------------------------------------------------------------------
// Errors. Every error carries a stable string `code` (the append-only
// vocabulary D2 §2.9 maps to HTTP).
// ---------------------------------------------------------------------------

export class ResumeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ResumeError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export class ReattachTokenError extends ResumeError {
  constructor(code, message) {
    super(code, message);
    this.name = "ReattachTokenError";
  }
}

export class ResumeCommandError extends ResumeError {
  constructor(code, message) {
    super(code, message);
    this.name = "ResumeCommandError";
  }
}

export class OccupantChangedError extends ResumeError {
  constructor(message, detail) {
    super("session_occupant_changed", message, detail);
    this.name = "OccupantChangedError";
  }
}

export class ResumeTimeoutError extends ResumeError {
  constructor(message) {
    super("TIMEOUT", message);
    this.name = "ResumeTimeoutError";
  }
}

export class IdempotencyError extends ResumeError {
  constructor(code, message) {
    super(code, message);
    this.name = "IdempotencyError";
  }
}

// ---------------------------------------------------------------------------
// Reattach tokens: opaque, single-use, expiring.
//
// One store instance per tenant, owned by the bridge. Tokens map to opaque
// adapter-level session ids — never to raw herdr pane ids (risk-review §3.3).
// Memory-resident by design: a bridge restart drops every outstanding token
// (fail closed); supervisors re-mint after the bridge is back.
// ---------------------------------------------------------------------------

function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createReattachStore({ ttlMs = 600_000, now = Date.now, tokenBytes = TOKEN_BYTES } = {}) {
  const pending = new Map(); // token -> { sessionId, expiresAt }
  const used = new Map(); // token -> expiresAt (distinguishes reuse from unknown)

  function mint(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ReattachTokenError("TOKEN_MALFORMED", "sessionId must be a non-empty string");
    }
    const bytes = new Uint8Array(tokenBytes);
    crypto.getRandomValues(bytes);
    const token = base64url(bytes);
    const expiresAt = now() + ttlMs;
    pending.set(token, { sessionId, expiresAt });
    return { token, expiresAt };
  }

  function redeem(token) {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) {
      throw new ReattachTokenError("TOKEN_MALFORMED", "malformed reattach token");
    }
    const rec = pending.get(token);
    if (!rec) {
      if (used.has(token)) {
        throw new ReattachTokenError("TOKEN_REUSED", "reattach token already redeemed");
      }
      throw new ReattachTokenError("TOKEN_UNKNOWN", "unknown reattach token");
    }
    if (rec.expiresAt <= now()) {
      pending.delete(token);
      throw new ReattachTokenError("TOKEN_EXPIRED", "reattach token expired");
    }
    pending.delete(token); // single-use: redeem consumes the token
    used.set(token, rec.expiresAt);
    return { sessionId: rec.sessionId };
  }

  function revoke(sessionId) {
    for (const [token, rec] of pending) {
      if (rec.sessionId === sessionId) pending.delete(token);
    }
  }

  function sweep() {
    const t = now();
    let n = 0;
    for (const [token, rec] of pending) {
      if (rec.expiresAt <= t) { pending.delete(token); n++; }
    }
    for (const [token, expiresAt] of used) {
      if (expiresAt <= t) { used.delete(token); n++; }
    }
    return n;
  }

  return {
    mint, redeem, revoke, sweep,
    get size() { return pending.size; },
  };
}

// ---------------------------------------------------------------------------
// Resume-command validation: allowlisted SHAPES only (D1 §2.2).
//
// The adapter constructs argv; the caller never supplies argv. A kind maps to
// fixed argv templates ("the template is code, not config" — D1). Slots:
//   { lit: "string" }  — exact literal flag/binary
//   { slot: "sessionId" } — the agent CLI's opaque native session ref
//   { slot: "word" }   — a tight token (e.g. model name), no metacharacters
// The canonical (first) pattern must contain exactly one fillable slot — the
// session id — so the adapter can construct argv from kind + session ref alone.
// ---------------------------------------------------------------------------

const resumeKinds = new Map(); // kind -> { binary, patterns }

function compilePattern(kind, binary, pattern, index) {
  if (!Array.isArray(pattern) || pattern.length === 0 || pattern.length > MAX_ARGS) {
    throw new ResumeCommandError("BAD_PATTERNS", `kind "${kind}": pattern ${index} must be 1..${MAX_ARGS} slots`);
  }
  const compiled = pattern.map((s, i) => {
    if (s && typeof s.lit === "string" && s.lit.length > 0 && !s.lit.includes("\0")) {
      return { lit: s.lit };
    }
    if (s && s.slot === "sessionId") return { slot: "sessionId" };
    if (s && s.slot === "word") return { slot: "word" };
    throw new ResumeCommandError("BAD_PATTERNS", `kind "${kind}": pattern ${index} slot ${i} is not a valid slot`);
  });
  if (compiled[0].lit !== binary) {
    throw new ResumeCommandError("BAD_PATTERNS", `kind "${kind}": pattern ${index} must start with the registered binary`);
  }
  return compiled;
}

export function registerResumeKind(kind, { binary, patterns }) {
  if (typeof kind !== "string" || !/^[a-z0-9-]+$/.test(kind)) {
    throw new ResumeCommandError("BAD_KIND", `kind must be a lowercase slug, got ${JSON.stringify(kind)}`);
  }
  // Bare binary name only: no path separators, no parent traversal, no empty.
  // D1 §2.1: argv[0] is the sharpest primitive — it must name exactly the
  // allowlisted CLI, never a path the caller smuggled in.
  if (typeof binary !== "string" || !BARE_BINARY_RE.test(binary) || binary === "." || binary === "..") {
    throw new ResumeCommandError("BAD_BINARY", `resume binary must be a bare binary name, got ${JSON.stringify(binary)}`);
  }
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new ResumeCommandError("BAD_PATTERNS", `kind "${kind}": at least one pattern is required`);
  }
  const compiled = patterns.map((p, i) => compilePattern(kind, binary, p, i));
  const fillable = compiled[0].filter((s) => s.slot !== undefined);
  if (fillable.length !== 1 || fillable[0].slot !== "sessionId") {
    throw new ResumeCommandError(
      "BAD_PATTERNS",
      `kind "${kind}": the canonical (first) pattern must contain exactly one fillable slot: the session id`,
    );
  }
  resumeKinds.set(kind, { binary, patterns: compiled });
}

export function listResumeKinds() {
  return [...resumeKinds.keys()];
}

function matchPattern(pattern, argv) {
  if (pattern.length !== argv.length) return null;
  let sessionRef = null;
  for (let i = 0; i < pattern.length; i++) {
    const s = pattern[i];
    const a = argv[i];
    if (s.lit !== undefined) {
      if (a !== s.lit) return null;
    } else if (s.slot === "sessionId") {
      if (!SESSION_ID_RE.test(a)) return null;
      sessionRef = a;
    } else if (s.slot === "word") {
      if (!/^[A-Za-z0-9._-]+$/.test(a)) return null;
    }
  }
  return sessionRef;
}

// Validates a candidate resume argv against the kind's allowlisted shapes.
// This is the registration-time gate (D1 §2.2) for report_agent_session refs
// AND the spawn-time re-check: unmatched argv is rejected, never executed.
export function validateResumeCommand(kind, argv) {
  const reg = resumeKinds.get(kind);
  if (!reg) throw new ResumeCommandError("UNKNOWN_KIND", `unknown agent kind: ${String(kind)}`);
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ResumeCommandError("ARG_SHAPE", "resume argv must be a non-empty array");
  }
  if (argv.length > MAX_ARGS) {
    throw new ResumeCommandError("ARG_COUNT", `resume argv exceeds ${MAX_ARGS} args`);
  }
  let bytes = 0;
  for (const a of argv) {
    if (typeof a !== "string" || a.length === 0 || a.includes("\0")) {
      throw new ResumeCommandError("ARG_SHAPE", "resume argv elements must be non-empty strings without NUL bytes");
    }
    bytes += a.length;
  }
  if (bytes > MAX_ARGV_BYTES) {
    throw new ResumeCommandError("ARG_SIZE", `resume argv exceeds ${MAX_ARGV_BYTES} bytes`);
  }
  if (argv[0] !== reg.binary) {
    throw new ResumeCommandError("BINARY_MISMATCH", `argv[0] must be the registered binary "${reg.binary}"`);
  }
  for (const pattern of reg.patterns) {
    const sessionRef = matchPattern(pattern, argv);
    if (sessionRef !== null) return { binary: reg.binary, sessionRef };
  }
  throw new ResumeCommandError("ARG_SHAPE", "resume argv matches no allowlisted resume shape for this kind");
}

// The ONLY place resume argv is constructed. Builds from the registered shape
// and the validated session ref — caller input never flows into argv except
// through the sessionId slot, which rejects everything but opaque ids.
export function formatResumeCommand(kind, sessionRef) {
  const reg = resumeKinds.get(kind);
  if (!reg) throw new ResumeCommandError("UNKNOWN_KIND", `unknown agent kind: ${String(kind)}`);
  if (typeof sessionRef !== "string" || !SESSION_ID_RE.test(sessionRef)) {
    throw new ResumeCommandError("BAD_SESSION_REF", "session ref must be an opaque agent-CLI session id");
  }
  return reg.patterns[0].map((s) => (s.lit !== undefined ? s.lit : sessionRef));
}

// Built-in kind registry — the versioned kind→template mapping D1 §2.2 asks
// for. The template is code (this file), not config: not overridable via env,
// not loaded from a manifest. Shapes mirror each CLI's native resume surface;
// extend via registerResumeKind when a CLI's resume surface is confirmed
// (B10 fork-audit owns that confirmation for new kinds).
registerResumeKind("claude", {
  binary: "claude",
  patterns: [
    [{ lit: "claude" }, { lit: "--resume" }, { slot: "sessionId" }],
    [{ lit: "claude" }, { lit: "--resume" }, { slot: "sessionId" }, { lit: "--model" }, { slot: "word" }],
  ],
});
registerResumeKind("codex", {
  binary: "codex",
  patterns: [
    [{ lit: "codex" }, { lit: "resume" }, { slot: "sessionId" }],
  ],
});
registerResumeKind("gemini", {
  binary: "gemini",
  patterns: [
    [{ lit: "gemini" }, { lit: "--resume" }, { slot: "sessionId" }],
  ],
});
// Provisional: opencode's native resume surface is named in D1's kind enum;
// the exact flag shape is confirmed by B10 fork-audit before any lane uses it.
registerResumeKind("opencode", {
  binary: "opencode",
  patterns: [
    [{ lit: "opencode" }, { lit: "--resume" }, { slot: "sessionId" }],
  ],
});

// ---------------------------------------------------------------------------
// Idempotency store (D2 §4).
//
// Every mutating transition requires an idempotencyKey. A duplicate key
// returns the stored response byte-for-byte with `duplicate: true` and
// performs no herdr call. Keys are scoped per transition (rule 1: a spawn key
// is never valid for a destroy) and retained 24h (rule 3).
// ---------------------------------------------------------------------------

export function createIdempotencyStore({ now = Date.now, ttlMs = IDEMPOTENCY_TTL_MS } = {}) {
  const map = new Map(); // key -> { transition, response, recordedAt }

  function check(key, transition) {
    if (typeof key !== "string" || key.length === 0) {
      throw new IdempotencyError("IDKEY_REQUIRED", "idempotencyKey is required");
    }
    const e = map.get(key);
    if (!e) return { hit: false };
    if (e.recordedAt + ttlMs <= now()) {
      map.delete(key);
      return { hit: false };
    }
    if (e.transition !== transition) {
      throw new IdempotencyError(
        "IDKEY_SCOPE_MISMATCH",
        `idempotency key was recorded for "${e.transition}", not "${transition}"`,
      );
    }
    return { hit: true, response: structuredClone(e.response) };
  }

  function record(key, transition, response) {
    if (typeof key !== "string" || key.length === 0) {
      throw new IdempotencyError("IDKEY_REQUIRED", "idempotencyKey is required");
    }
    if (typeof transition !== "string" || transition.length === 0) {
      throw new IdempotencyError("IDKEY_REQUIRED", "transition scope is required");
    }
    map.set(key, { transition, response: structuredClone(response), recordedAt: now() });
  }

  function sweep() {
    const t = now();
    let n = 0;
    for (const [key, e] of map) {
      if (e.recordedAt + ttlMs <= t) { map.delete(key); n++; }
    }
    return n;
  }

  return { check, record, sweep, get size() { return map.size; } };
}

// ---------------------------------------------------------------------------
// Reattach manager (D2 §2.5 reattachSession, §3.2 restart path).
//
// Owns the room-session records for the reattach slice of the lifecycle:
// detached/suspended -> reattaching -> active (or back to detached). The
// durable record is B5's herdr_sessions table; this registry is the domain
// logic over it, injected stores keep it testable.
//
// Adapter surface (implemented by the B14 SessionAdapter / bridge):
//   getOccupant(paneId) -> Promise<{ occupantId, agentId } | null>
//       null = pane not in the snapshot (gone or never restored).
//   spawnAgent({ kind, command, args, resumeSessionRef, signal })
//       -> Promise<{ paneId, agentId, occupantId? }>
//       signal is the reattach window's AbortSignal: the adapter aborts
//       pane/process creation when it fires and never surfaces a half-spawn.
//   closePane(paneId) -> Promise<void> (idempotent; cleans up a raced spawn)
//   requestReportState?(paneId) -> Promise<void>  (best-effort handshake)
// ---------------------------------------------------------------------------

const VALID_REATTACH_FROM = new Set(["detached", "suspended"]);

function withTimeout(run, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ResumeTimeoutError(`reattach exceeded the ${ms}ms window`));
    }, ms);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

export function createReattachManager({
  adapter,
  tokenStore,
  idempotency,
  now = Date.now,
  journal,
} = {}) {
  if (!adapter || typeof adapter.getOccupant !== "function" || typeof adapter.spawnAgent !== "function") {
    throw new ResumeError("ADAPTER_REQUIRED", "adapter with getOccupant/spawnAgent is required");
  }
  const tokens = tokenStore ?? createReattachStore({ now });
  const idem = idempotency ?? createIdempotencyStore({ now });
  const log = journal ?? [];
  const sessions = new Map(); // sessionId -> record

  function note(sessionId, event, detail) {
    log.push({ t: now(), sessionId, event, ...(detail === undefined ? {} : { detail }) });
  }

  function get(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) throw new ResumeError("NO_SUCH_SESSION", `unknown session: ${String(sessionId)}`);
    return s;
  }

  function status(sessionId) {
    const s = get(sessionId);
    return {
      sessionId: s.sessionId, kind: s.kind, state: s.state,
      paneId: s.paneId, agentId: s.agentId, occupantId: s.occupantId,
    };
  }

  // Registers a room session the manager may later reattach. Fails closed:
  // unknown kinds and invalid stored resume commands are rejected here, at
  // registration time (D1 §2.2) — never discovered mid-restart.
  function registerSession({ sessionId, kind, paneId, agentId, occupantId, resumeRef }) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new ResumeError("BAD_SESSION", "sessionId must be a non-empty string");
    }
    if (!resumeKinds.get(kind)) {
      throw new ResumeCommandError("UNKNOWN_KIND", `unknown agent kind: ${String(kind)}`);
    }
    if (resumeRef !== undefined) {
      if (!resumeRef || typeof resumeRef.sessionRef !== "string" || !SESSION_ID_RE.test(resumeRef.sessionRef)) {
        throw new ResumeCommandError("BAD_SESSION_REF", "stored session ref must be an opaque agent-CLI session id");
      }
      validateResumeCommand(kind, resumeRef.resumeCommand);
    }
    sessions.set(sessionId, {
      sessionId, kind, paneId, agentId, occupantId,
      resumeRef: resumeRef === undefined ? null : { ...resumeRef },
      state: "active",
    });
    return status(sessionId);
  }

  // active -> detached. The honesty rule (D2 §1.1): detached means the pane's
  // fate is UNKNOWN — explicitly not dead. No adapter calls, no claim action;
  // the wake-queue fallback and the claim stay exactly as they were.
  function markDetached(sessionId, reason) {
    const s = get(sessionId);
    s.state = "detached";
    note(sessionId, "detached", { reason });
    return status(sessionId);
  }

  function mintReattachToken(sessionId) {
    get(sessionId); // fail closed before minting: no tokens for unknown sessions
    return tokens.mint(sessionId);
  }

  async function runReattach(s, { forceRepin, signal }) {
    const throwIfAborted = () => {
      if (signal.aborted) throw new ResumeTimeoutError("reattach window elapsed mid-flight");
    };
    const found = await adapter.getOccupant(s.paneId);
    throwIfAborted();

    if (!found) {
      // D2 §3.2 step 4: pane is gone but the agent CLI's native session ref was
      // stored — spawn a NEW pane via the CLI's own --resume flag and attach it
      // to the SAME room session. Continuity is the CLI's session store; the
      // transcript is never replayed into the fresh pane.
      if (!s.resumeRef) {
        note(s.sessionId, "reattach_failed", { code: "NO_RESUME_REF" });
        throw new ResumeError("NO_RESUME_REF", "pane is gone and no native resume ref was stored");
      }
      // Re-derived from the registered shape, never the stored bytes (defense
      // in depth on top of the registration-time validation).
      const argv = formatResumeCommand(s.kind, s.resumeRef.sessionRef);
      const spawned = await adapter.spawnAgent({
        kind: s.kind,
        command: argv[0],
        args: argv.slice(1),
        resumeSessionRef: s.resumeRef.sessionRef,
        signal, // the reattach window's controller: a raced timeout aborts the spawn at the adapter
      });
      // A raced timeout (or any mid-flight abort) must neither attach the new
      // pane to the session record nor leak it. An abort-aware adapter tears
      // its own spawn down; a backend that resolved anyway leaves an orphan —
      // close it here before surfacing the timeout.
      if (signal.aborted) {
        try {
          await adapter.closePane(spawned.paneId);
        } catch {
          // Best effort: the timeout is the outcome; cleanup must not mask it.
        }
      }
      throwIfAborted();
      const prevOccupant = s.occupantId;
      const prevPane = s.paneId;
      s.paneId = spawned.paneId;
      s.agentId = spawned.agentId;
      s.occupantId = spawned.occupantId ?? spawned.agentId;
      note(s.sessionId, "pane_replaced_after_restart", { oldPaneId: prevPane, newPaneId: s.paneId });
      return { occupantChanged: prevOccupant !== s.occupantId, resumed: true };
    }

    // D2 §3.2 step 3: the pane was restored — the occupant MUST be
    // re-verified. A restart may have re-run the agent CLI; the pre-restart
    // occupant is never assumed. Mismatch without an explicit operator re-pin
    // is OccupantChangedError and the session goes back to detached.
    if (found.occupantId !== s.occupantId && !forceRepin) {
      note(s.sessionId, "occupant_changed", {
        expected: s.occupantId, observed: found.occupantId, forceRepin: false,
      });
      throw new OccupantChangedError(
        "pane occupant changed since the pin; re-confirm intent or reattach with forceRepin",
        { expected: s.occupantId, observed: found.occupantId },
      );
    }
    const occupantChanged = found.occupantId !== s.occupantId;
    if (occupantChanged) {
      note(s.sessionId, "occupant_changed_forced", { from: s.occupantId, to: found.occupantId });
      s.occupantId = found.occupantId;
    } else {
      note(s.sessionId, "occupant_reverified", {});
    }
    s.agentId = found.agentId ?? s.agentId;

    // Resume handshake: ask the agent for a fresh state report — the room
    // cannot assume the pre-restart lane state still holds (D2 §3.2 step 5).
    // Best-effort: a busy agent must not fail the reattach.
    if (typeof adapter.requestReportState === "function") {
      try {
        await adapter.requestReportState(s.paneId);
        throwIfAborted();
        note(s.sessionId, "report_requested", {});
      } catch (err) {
        throwIfAborted();
        note(s.sessionId, "report_request_failed", { code: err && err.code ? String(err.code) : "unknown" });
      }
    }
    return { occupantChanged, resumed: false };
  }

  // detached/suspended -> reattaching -> active (D2 §2.5). Explicit only —
  // never automatic (D2 §1.3 T3). sendText/sendKeys stay blocked until the
  // occupant pin is re-verified by this transition completing.
  async function reattach({
    token,
    idempotencyKey,
    forceRepin = false,
    resumeTimeoutMs = REATTACH_TIMEOUT_MS_DEFAULT,
  } = {}) {
    // Idempotency first: a duplicate key returns the stored response with
    // duplicate:true and performs no token redeem and no herdr call (D2 §4).
    const seen = idem.check(idempotencyKey, "reattach");
    if (seen.hit) return { ...seen.response, duplicate: true };

    const { sessionId } = tokens.redeem(token); // single-use; throws TOKEN_*
    const s = get(sessionId);

    if (s.state === "active") {
      // Converge, don't duplicate: already attached is a successful no-op.
      const response = {
        sessionId: s.sessionId, paneId: s.paneId, agentId: s.agentId,
        occupantId: s.occupantId, occupantChanged: false,
        state: "active", resumed: false, duplicate: false,
      };
      idem.record(idempotencyKey, "reattach", response);
      return { ...response };
    }
    if (!VALID_REATTACH_FROM.has(s.state)) {
      throw new ResumeError("INVALID_STATE", `cannot reattach from state "${s.state}"`);
    }

    s.state = "reattaching";
    note(s.sessionId, "reattach_started", { forceRepin });
    try {
      const outcome = await withTimeout(
        (signal) => runReattach(s, { forceRepin, signal }),
        resumeTimeoutMs,
      );
      s.state = "active";
      const response = {
        sessionId: s.sessionId, paneId: s.paneId, agentId: s.agentId,
        occupantId: s.occupantId, occupantChanged: outcome.occupantChanged,
        state: "active", resumed: outcome.resumed, duplicate: false,
      };
      note(s.sessionId, "reattached", {
        occupantChanged: outcome.occupantChanged, resumed: outcome.resumed,
      });
      idem.record(idempotencyKey, "reattach", response);
      return { ...response };
    } catch (err) {
      // Back to fate-unknown on any failure — never to destroyed, never to a
      // speculative state. The pane may still be alive and working.
      if (s.state === "reattaching") s.state = "detached";
      if (err instanceof ResumeTimeoutError) {
        note(s.sessionId, "reattach_timeout", { resumeTimeoutMs });
      } else if (!(err instanceof OccupantChangedError) && err.code !== "NO_RESUME_REF") {
        note(s.sessionId, "reattach_failed", { code: err && err.code ? String(err.code) : "unknown" });
      }
      throw err;
    }
  }

  function sweep() {
    return { tokens: tokens.sweep(), idempotency: idem.sweep() };
  }

  return {
    registerSession,
    status,
    markDetached,
    mintReattachToken,
    reattach,
    sweep,
    get tokenStore() { return tokens; },
    get idempotencyStore() { return idem; },
    get journal() { return log; },
  };
}

// ---------------------------------------------------------------------------
// Domain error -> HTTP status (D2 §2.9, append-only vocabulary).
// Existing room codes keep their status and meaning; these additions never
// replace them. Used by B15's bridge HTTP translation.
// ---------------------------------------------------------------------------

const HTTP_MAP = {
  session_occupant_changed: [409, "session_occupant_changed"],
  TIMEOUT: [504, "herdr_timeout"],
  TOKEN_MALFORMED: [401, "reattach_token_invalid"],
  TOKEN_UNKNOWN: [401, "reattach_token_invalid"],
  TOKEN_EXPIRED: [401, "reattach_token_invalid"],
  TOKEN_REUSED: [401, "reattach_token_invalid"],
  UNKNOWN_KIND: [400, "resume_command_rejected"],
  BAD_KIND: [400, "resume_command_rejected"],
  BAD_BINARY: [400, "resume_command_rejected"],
  BAD_PATTERNS: [400, "resume_command_rejected"],
  BAD_SESSION_REF: [400, "resume_command_rejected"],
  ARG_SHAPE: [400, "resume_command_rejected"],
  ARG_COUNT: [400, "resume_command_rejected"],
  ARG_SIZE: [400, "resume_command_rejected"],
  BINARY_MISMATCH: [400, "resume_command_rejected"],
  IDKEY_REQUIRED: [400, "bad_idempotency_key"],
  IDKEY_SCOPE_MISMATCH: [400, "bad_idempotency_key"],
  NO_SUCH_SESSION: [404, "session_not_found"],
  NO_RESUME_REF: [409, "session_not_resumable"],
  INVALID_STATE: [409, "session_invalid_state"],
  ADAPTER_REQUIRED: [500, "herdr_server_error"],
  BAD_SESSION: [400, "bad_session"],
  // Adapter-originated codes (B14's taxonomy) mapped for the bridge:
  VERSION_MISMATCH: [503, "herdr_version_mismatch"],
  TRANSPORT: [502, "herdr_transport_error"],
  METHOD_UNSUPPORTED: [501, "herdr_method_unsupported"],
  SERVER: [500, "herdr_server_error"],
};

export function httpStatusForResumeError(err) {
  const code = err && typeof err.code === "string" ? err.code : null;
  const mapped = (code && HTTP_MAP[code]) || [500, "herdr_server_error"];
  return { status: mapped[0], code: mapped[1] };
}
