// Room-native claims board (board v2) — prototype.
//
// BOARD-1 (RC-2026-09-26-1114). Design: docs/BOARD-V2-DESIGN.md.
//
// The board of record the room owns: claims, heartbeats, releases and
// receipts as typed JSON writes validated at the write boundary — never
// parsed out of prose. Every mutation appends one event with a monotonic
// `seq`; the seq is the consumer watermark (room-watch cursors migrate from
// GitHub comment ids to seq via the mirror map, so mirror-issue rotation
// can never orphan a cursor).
//
// This prototype is in-memory with an injectable clock. `handleBoardV2Request`
// implements the exact route contract from the design doc so the prototype's
// contract IS the production contract; the deployment wiring (RC-2026-09-27-2720)
// mounts it in server/http.mjs over the durable state machine in
// server/board-v2-durable.mjs (SQLite, see design §3).

export const TASK_ID_RE = /^RC-\d{4}-\d{2}-\d{2}-\d+$/;
export const LANE_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const LEASE_RE = /^lease=(\d+)h$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/i;

const LIVE_STATES = new Set(["submitted", "working", "suspended"]);
const TERMINAL_STATES = new Set(["cancelled", "completed", "released"]);

const MAX_REASON_CHARS = 2000;
const MAX_NOTE_CHARS = 500;
const MAX_FILES = 100;
const MAX_PATH_CHARS = 512;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export class BoardV2Error extends Error {
  constructor(status, code, message, fields = null) {
    super(message);
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }
}

const fail = (status, code, message, fields) => {
  throw new BoardV2Error(status, code, message, fields);
};

// ---------------------------------------------------------------------------
// Validation: the grammars the old board *recovered* from prose are enforced
// here, at write time. Malformed input is rejected; it can never enter the
// board, so there is nothing to mis-parse later.
// ---------------------------------------------------------------------------

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

function cleanTaskId(value) {
  if (typeof value !== "string" || !TASK_ID_RE.test(value)) {
    fail(422, "invalid_task_id", "task_id must match RC-YYYY-MM-DD-NNN");
  }
  return value;
}

function cleanLane(value) {
  if (typeof value !== "string" || !LANE_RE.test(value)) {
    fail(422, "invalid_lane", "lane must match [A-Za-z0-9_-]{1,64}");
  }
  return value;
}

function cleanPath(value) {
  if (typeof value !== "string") fail(422, "invalid_files", "files must be an array of path strings");
  const p = value.trim().replace(/\/+/g, "/").replace(/^\.\//, "");
  if (!p || p.length > MAX_PATH_CHARS) fail(422, "invalid_files", `bad path: ${value.slice(0, 80)}`);
  if (p.startsWith("/") || p.includes("..") || p.includes("*") || /[\x00-\x1f\x7f]/.test(p)) {
    fail(422, "invalid_files", `bad path: ${value.slice(0, 80)}`);
  }
  return p;
}

function cleanFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) {
    fail(422, "invalid_files", "files must be a non-empty array (max 100)");
  }
  const out = [];
  for (const f of value) {
    const p = cleanPath(f);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

function cleanLease(value) {
  const m = typeof value === "string" ? LEASE_RE.exec(value) : null;
  const n = m ? Number(m[1]) : NaN;
  // NOTE: bare "6h" is rejected — the old board's standing misfire. The
  // grammar is lease=<N>h, nothing else.
  if (!m || !(n >= 1 && n <= 72)) {
    fail(422, "invalid_lease", "lease must be lease=<N>h with 1<=N<=72");
  }
  return n;
}

function cleanText(value, max, code, name) {
  if (typeof value !== "string" || !value.trim()) fail(422, code, `${name} must be a non-empty string`);
  if (value.length > max) fail(422, code, `${name} exceeds ${max} chars`);
  return value.trim();
}

function rejectUnknown(body, allowed, what) {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) fail(422, "unknown_field", `${what}: unknown field ${JSON.stringify(k)}`);
  }
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

const iso = ms => new Date(ms).toISOString();

// Exported for server/board-v2-durable.mjs: the durable state machine reuses
// the prototype's validation grammar verbatim, so both surfaces reject
// identical input with identical codes. Additive export; no behavior change.
export {
  cleanTaskId, cleanLane, cleanPath, cleanFiles, cleanLease, cleanText,
  rejectUnknown,
  LIVE_STATES, TERMINAL_STATES, MAX_REASON_CHARS, MAX_NOTE_CHARS, MAX_FILES,
  MAX_PATH_CHARS, MAX_LIMIT, DEFAULT_LIMIT, iso,
};

export class BoardV2 {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._seq = 0;
    this._events = []; // unified append-only event log (Phase 3.1)
    this._claims = new Map(); // task_id -> claim record
    this._mirror = new Map(); // seq -> { issue, comment_id }
    this._notes = []; // append-only note events (legacy, see _events)
    this._findings = []; // append-only finding events (legacy, see _events)
    this._decisions = []; // append-only decision events (legacy, see _events)
    this._idempotency = new Map(); // idempotency-key -> { status, body }
  }

  get seq() { return this._seq; }

  _emit(kind, taskId, lane, payload, opts = {}) {
    this._seq += 1;
    const event = { seq: this._seq, at: iso(this._now()), kind, task_id: taskId, lane, payload };
    if (opts.supersedes != null) event.supersedes = opts.supersedes;
    if (opts.idempotencyKey != null) event.idempotency_key = opts.idempotencyKey;
    // Phase 3.1: append to unified event log
    this._events.push(event);
    return event;
  }

  // Idempotency: store the response for a key, or return the cached response.
  // Returns { cached: true, response } if the key was seen, else { cached: false }.
  // Idempotency: 24h TTL (Stripe's window), per-lane scoping, payload fingerprinting.
  // Same key + different payload => 422 (IETF Idempotency-Key draft), not cached response.
  _checkIdempotency(lane, key, fingerprint) {
    if (key == null) return { cached: false };
    const scopedKey = `${lane}:${key}`;
    const hit = this._idempotency.get(scopedKey);
    if (!hit) return { cached: false };
    // TTL: expire after 24h.
    const ageMs = this._now() - hit.created_at;
    if (ageMs > 24 * 60 * 60 * 1000) {
      this._idempotency.delete(scopedKey);
      return { cached: false };
    }
    // Payload mismatch: same key with different payload is a 422, not a cache hit.
    if (hit.fingerprint !== fingerprint) {
      return { cached: false, mismatch: true };
    }
    return { cached: true, response: { status: hit.status, body: hit.body } };
  }

  _storeIdempotency(lane, key, fingerprint, status, body) {
    if (key == null) return;
    const scopedKey = `${lane}:${key}`;
    // Bound the cache: keep only the most recent 1000 keys (secondary to TTL).
    if (this._idempotency.size >= 1000) {
      const oldest = this._idempotency.keys().next().value;
      this._idempotency.delete(oldest);
    }
    this._idempotency.set(scopedKey, {
      status, body, fingerprint,
      created_at: this._now(),
    });
  }

  _getLive(taskId) {
    const claim = this._claims.get(taskId);
    if (!claim || !LIVE_STATES.has(claim.state)) {
      fail(404, "unknown_task", `no live claim ${taskId}`);
    }
    return claim;
  }

  _checkLane(claim, lane) {
    if (claim.lane !== lane) fail(403, "lane_mismatch", `claim ${claim.task_id} is held by lane ${claim.lane}`);
  }

  _expiresAt(claim) {
    const base = claim.heartbeat_at_ms ?? claim.claim_at_ms;
    return base + claim.lease_h * 3600_000;
  }

  _public(claim) {
    const expiresAtMs = this._expiresAt(claim);
    return {
      task_id: claim.task_id,
      lane: claim.lane,
      files: [...claim.files],
      lease: claim.lease,
      lease_h: claim.lease_h,
      reason: claim.reason,
      state: claim.state,
      claim_at: iso(claim.claim_at_ms),
      heartbeat_at: claim.heartbeat_at_ms == null ? null : iso(claim.heartbeat_at_ms),
      expires_at: iso(expiresAtMs),
      expired: this._now() > expiresAtMs,
      last_seq: claim.last_seq,
      receipts: claim.receipts.map(r => ({ ...r })),
    };
  }

  /** Live claims (any lane) holding any of `files`, excluding `exceptLane`. */
  _holders(files, exceptLane) {
    const holders = [];
    const nowMs = this._now();
    for (const claim of this._claims.values()) {
      if (!LIVE_STATES.has(claim.state) || claim.lane === exceptLane) continue;
      // A lapsed lease does not hold a file. The lease is the whole point of
      // the lease: an agent that stopped working still has state "working",
      // and without this check its files stay blocked for every other lane
      // until a human calls the sweep. Nothing sweeps automatically, so that
      // wait was unbounded. The claim record is left untouched so the history
      // still shows who held it and when the lease ran out.
      if (nowMs > this._expiresAt(claim)) continue;
      const overlap = claim.files.filter(f => files.includes(f));
      if (overlap.length) holders.push({ task_id: claim.task_id, lane: claim.lane, files: overlap });
    }
    return holders;
  }

  postClaim({ task_id, lane, files, lease, reason }) {
    const tid = cleanTaskId(task_id);
    const ln = cleanLane(lane);
    if (this._claims.has(tid)) fail(409, "duplicate_task", `task-id ${tid} is already used: a task-id never gets a second claimant`);
    const fs = cleanFiles(files);
    const leaseH = cleanLease(lease);
    const rs = cleanText(reason, MAX_REASON_CHARS, "invalid_reason", "reason");
    const holders = this._holders(fs, ln);
    if (holders.length) {
      fail(409, "claim_conflict", "files held live by another lane", { holders });
    }
    const nowMs = this._now();
    const event = this._emit("claim", tid, ln, { files: fs, lease: `lease=${leaseH}h`, reason: rs });
    const claim = {
      task_id: tid, lane: ln, files: fs, lease: `lease=${leaseH}h`, lease_h: leaseH,
      reason: rs, state: "submitted",
      claim_at_ms: nowMs, heartbeat_at_ms: null, last_seq: event.seq, receipts: [],
    };
    this._claims.set(tid, claim);
    return { seq: event.seq, claim: this._public(claim) };
  }

  heartbeat({ task_id, lane, note = null }) {
    const tid = cleanTaskId(task_id);
    const ln = cleanLane(lane);
    if (note !== null && note !== undefined) cleanText(note, MAX_NOTE_CHARS, "invalid_note", "note");
    const claim = this._getLive(tid);
    this._checkLane(claim, ln);
    const nowMs = this._now();
    const event = this._emit("heartbeat", tid, ln, note == null ? {} : { note: note.trim() });
    claim.heartbeat_at_ms = nowMs;
    if (claim.state === "submitted") claim.state = "working";
    claim.last_seq = event.seq;
    return { seq: event.seq, claim: this._public(claim) };
  }

  release({ task_id, lane, reason }) {
    const tid = cleanTaskId(task_id);
    const ln = cleanLane(lane);
    const rs = cleanText(reason, MAX_REASON_CHARS, "invalid_reason", "reason");
    const claim = this._getLive(tid);
    this._checkLane(claim, ln);
    const event = this._emit("release", tid, ln, { reason: rs });
    claim.state = "released";
    claim.last_seq = event.seq;
    return { seq: event.seq, claim: this._public(claim) };
  }

  postReceipt({ task_id, lane, sha, pr = null }) {
    const tid = cleanTaskId(task_id);
    const ln = cleanLane(lane);
    if (typeof sha !== "string" || !SHA_RE.test(sha)) fail(422, "invalid_sha", "sha must be 7-40 hex chars");
    if (pr !== null && pr !== undefined && !(typeof pr === "number" && Number.isInteger(pr) && pr > 0)) {
      fail(422, "invalid_pr", "pr must be a positive integer");
    }
    const claim = this._claims.get(tid);
    if (!claim) fail(404, "unknown_task", `no claim ${tid}`);
    this._checkLane(claim, ln);
    const event = this._emit("receipt", tid, ln, { sha, pr: pr ?? null });
    const receipt = { seq: event.seq, at: event.at, sha, pr: pr ?? null };
    claim.receipts.push(receipt);
    claim.last_seq = event.seq;
    return { seq: event.seq, receipt };
  }

  postNote({ lane, thread = null, body, severity = null }) {
    const ln = cleanLane(lane);
    const bd = cleanText(body, MAX_NOTE_CHARS, "invalid_body", "body");
    let th = null;
    if (thread !== null && thread !== undefined) {
      th = cleanText(thread, 128, "invalid_thread", "thread");
    }
    let sev = null;
    if (severity !== null && severity !== undefined) {
      if (!["info", "milestone", "warning"].includes(severity)) {
        fail(422, "invalid_severity", "severity must be info, milestone, or warning");
      }
      sev = severity;
    }
    const event = this._emit("note", null, ln, { thread: th, body: bd, severity: sev });
    const note = { seq: event.seq, at: event.at, lane: ln, thread: th, body: bd, severity: sev };
    this._notes.push(note);
    return { seq: event.seq, note };
  }

  postFinding({ lane, claim_ref = null, pr_ref = null, severity, title, evidence = [], recommendation }) {
    const ln = cleanLane(lane);
    if (!["low", "medium", "high", "critical"].includes(severity)) {
      fail(422, "invalid_severity", "severity must be low, medium, high, or critical");
    }
    const ti = cleanText(title, 200, "invalid_title", "title");
    const rec = cleanText(recommendation, MAX_REASON_CHARS, "invalid_recommendation", "recommendation");
    let cr = null;
    if (claim_ref !== null && claim_ref !== undefined) cr = cleanTaskId(claim_ref);
    let pr = null;
    if (pr_ref !== null && pr_ref !== undefined) {
      if (!(typeof pr_ref === "number" && Number.isInteger(pr_ref) && pr_ref > 0)) {
        fail(422, "invalid_pr_ref", "pr_ref must be a positive integer");
      }
      pr = pr_ref;
    }
    if (!Array.isArray(evidence)) fail(422, "invalid_evidence", "evidence must be an array");
    const ev = evidence.slice(0, 20).map(e => cleanText(e, 500, "invalid_evidence", "evidence item"));
    const event = this._emit("finding", cr, ln, {
      pr_ref: pr, severity, title: ti, evidence: ev, recommendation: rec,
    });
    const finding = {
      seq: event.seq, at: event.at, lane: ln, claim_ref: cr, pr_ref: pr,
      severity, title: ti, evidence: ev, recommendation: rec,
    };
    this._findings.push(finding);
    return { seq: event.seq, finding };
  }

  postDecision({ decider, scope, statement, reversible = null, supersedes = null }) {
    const dc = cleanLane(decider);
    const sc = cleanText(scope, 128, "invalid_scope", "scope");
    const st = cleanText(statement, MAX_REASON_CHARS, "invalid_statement", "statement");
    let rev = null;
    if (reversible !== null && reversible !== undefined) {
      if (typeof reversible !== "boolean") fail(422, "invalid_reversible", "reversible must be a boolean");
      rev = reversible;
    }
    let sup = null;
    if (supersedes !== null && supersedes !== undefined) {
      // Phase 3.2: supersedes must be a seq number referencing an existing decision
      const seq = Number(supersedes);
      if (!Number.isInteger(seq) || seq < 1 || seq > this._seq) {
        fail(422, "invalid_supersedes", "supersedes must be a valid decision seq");
      }
      // Verify the target is actually a decision
      const target = this._decisions.find(d => d.seq === seq);
      if (!target) {
        fail(422, "invalid_supersedes", `no decision with seq ${seq}`);
      }
      sup = seq;
    }
    const event = this._emit("decision", null, dc, {
      scope: sc, statement: st, reversible: rev, supersedes: sup,
    });
    const decision = {
      seq: event.seq, at: event.at, decider: dc, scope: sc,
      statement: st, reversible: rev, supersedes: sup,
    };
    this._decisions.push(decision);
    return { seq: event.seq, decision };
  }

  readBoard({ lane = null, state = null, file = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    let claims = [...this._claims.values()];
    if (lane !== null && lane !== undefined) claims = claims.filter(c => c.lane === cleanLane(lane));
    if (state !== null && state !== undefined) {
      if (!LIVE_STATES.has(state) && !TERMINAL_STATES.has(state)) fail(422, "invalid_state", `unknown state ${state}`);
      claims = claims.filter(c => c.state === state);
    }
    if (file !== null && file !== undefined) {
      const p = cleanPath(file);
      claims = claims.filter(c => c.files.includes(p));
    }
    if (since > 0) claims = claims.filter(c => c.last_seq > since);
    claims.sort((a, b) => a.last_seq - b.last_seq);
    const live = claims.filter(c => LIVE_STATES.has(c.state));
    // file-claims: inverted index over live claims (S1 registry, machine form)
    const fileClaims = [];
    const byFile = new Map();
    for (const c of live) {
      for (const f of c.files) {
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push(c);
      }
    }
    for (const [f, cs] of [...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      fileClaims.push({ file: f, claims: cs.map(c => ({ task_id: c.task_id, lane: c.lane, state: c.state })) });
    }
    const overlaps = fileClaims
      .filter(fc => new Set(fc.claims.map(c => c.lane)).size > 1)
      .map(fc => ({ file: fc.file, claims: fc.claims }));
    // Phase 3.2: Include live decisions (supersede-chain resolved)
    const liveDecisions = [...this._resolveDecisionChains().values()]
      .sort((a, b) => a.seq - b.seq)
      .slice(0, lim);
    return {
      watermark: this._seq,
      claims: claims.slice(0, lim).map(c => this._public(c)),
      file_claims: fileClaims,
      overlaps,
      decisions: liveDecisions,
    };
  }

  readNotes({ lane = null, thread = null, severity = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    let notes = [...this._notes];
    if (lane !== null && lane !== undefined) notes = notes.filter(n => n.lane === cleanLane(lane));
    if (thread !== null && thread !== undefined) notes = notes.filter(n => n.thread === thread);
    if (severity !== null && severity !== undefined) notes = notes.filter(n => n.severity === severity);
    if (since > 0) notes = notes.filter(n => n.seq > since);
    notes.sort((a, b) => a.seq - b.seq);
    return { watermark: this._seq, notes: notes.slice(0, lim) };
  }

  readFindings({ lane = null, severity = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    let findings = [...this._findings];
    if (lane !== null && lane !== undefined) findings = findings.filter(f => f.lane === cleanLane(lane));
    if (severity !== null && severity !== undefined) findings = findings.filter(f => f.severity === severity);
    if (since > 0) findings = findings.filter(f => f.seq > since);
    findings.sort((a, b) => a.seq - b.seq);
    return { watermark: this._seq, findings: findings.slice(0, lim) };
  }

  readDecisions({ decider = null, scope = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    let decisions = [...this._decisions];
    if (decider !== null && decider !== undefined) decisions = decisions.filter(d => d.decider === cleanLane(decider));
    if (scope !== null && scope !== undefined) decisions = decisions.filter(d => d.scope === scope);
    if (since > 0) decisions = decisions.filter(d => d.seq > since);
    decisions.sort((a, b) => a.seq - b.seq);
    return { watermark: this._seq, decisions: decisions.slice(0, lim) };
  }

  // Phase 3.2: Resolve supersede chains to find live decisions.
  // Returns a Map of seq -> decision for decisions that are not superseded.
  // Cycle guard: max 100 hops, then break and mark as error.
  _resolveDecisionChains() {
    const bySeq = new Map(this._decisions.map(d => [d.seq, d]));
    const superseded = new Set(); // seqs that are superseded by another decision
    
    // Build the superseded set
    for (const d of this._decisions) {
      if (d.supersedes != null) {
        superseded.add(d.supersedes);
      }
    }
    
    // Find live decisions (not in superseded set)
    // But also need to handle chains: if A->B->C, only C is live
    const live = new Map();
    for (const d of this._decisions) {
      if (!superseded.has(d.seq)) {
        // This decision is not directly superseded, but check if it's part of a cycle
        // Follow the chain forward to see if we loop back
        let current = d;
        const visited = new Set([current.seq]);
        let hops = 0;
        let isCycle = false;
        
        while (current.supersedes != null && hops < 100) {
          const nextSeq = current.supersedes;
          if (visited.has(nextSeq)) {
            isCycle = true;
            break;
          }
          visited.add(nextSeq);
          const next = bySeq.get(nextSeq);
          if (!next) break; // Broken reference, treat as terminal
          current = next;
          hops++;
        }
        
        if (!isCycle && hops < 100) {
          live.set(d.seq, d);
        }
        // If cycle or too many hops, don't include (defensive)
      }
    }
    
    return live;
  }

  // Phase 3.1: Unified event log with cursor pagination.
  // Returns events in seq order, with has_more indicating if more exist beyond limit.
  readEvents({ kind = null, lane = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    let events = [...this._events];
    if (kind !== null && kind !== undefined) events = events.filter(e => e.kind === kind);
    if (lane !== null && lane !== undefined) events = events.filter(e => e.lane === cleanLane(lane));
    if (since > 0) events = events.filter(e => e.seq > since);
    events.sort((a, b) => a.seq - b.seq);
    // Fetch one extra to determine has_more
    const slice = events.slice(0, lim + 1);
    const has_more = slice.length > lim;
    return { watermark: this._seq, events: slice.slice(0, lim), has_more };
  }

  // --- mirror map: (issue, comment_id) <-> seq translation for migration ---
  recordMirror({ seq, issue, comment_id }) {
    const s = Number(seq);
    if (!(Number.isInteger(s) && s >= 1 && s <= this._seq)) fail(422, "invalid_seq", "seq must be a known board event seq");
    if (!(Number.isInteger(issue) && issue > 0)) fail(422, "invalid_issue", "issue must be a positive integer");
    if (!(Number.isInteger(comment_id) && comment_id > 0)) fail(422, "invalid_comment", "comment_id must be a positive integer");
    this._mirror.set(s, { issue, comment_id });
    return { seq: s, issue, comment_id };
  }

  resolveMirror({ issue, comment_id }) {
    for (const [seq, m] of this._mirror) {
      if (m.issue === issue && m.comment_id === comment_id) return { seq, issue, comment_id };
    }
    fail(404, "mirror_unknown", `no board seq for issue #${issue} comment ${comment_id}`);
  }

  mirrorSince(sinceSeq) {
    const since = Number(sinceSeq) || 0;
    return [...this._mirror.entries()]
      .filter(([seq]) => seq > since)
      .sort(([a], [b]) => a - b)
      .map(([seq, m]) => ({ seq, issue: m.issue, comment_id: m.comment_id }));
  }

  health() {
    const live = [...this._claims.values()].filter(c => LIVE_STATES.has(c.state)).length;
    return {
      seq: this._seq, live_claims: live, mirror_entries: this._mirror.size,
      notes: this._notes.length, findings: this._findings.length, decisions: this._decisions.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Route contract (§4 of the design doc), as a callable handler.
// `lane` is the authenticated lane (http.mjs binds the credential when this
// is mounted for real). Returns { status, body } — never throws for
// BoardV2Error; unexpected errors propagate.
// ---------------------------------------------------------------------------

const CLAIM_BODY_FIELDS = ["task_id", "lane", "files", "lease", "reason"];

function parseTaskPath(path) {
  const m = /^\/claims\/([^/]+)(?:\/(heartbeat|release|receipts))?$/.exec(path);
  return m ? { taskId: decodeURIComponent(m[1]), action: m[2] ?? null } : null;
}

export function handleBoardV2Request(board, { method, path, query = {}, body = null, lane = null, headers = {} }) {
  const needLane = () => {
    if (typeof lane !== "string" || !LANE_RE.test(lane)) fail(401, "unauthenticated", "lane credential required");
    return lane;
  };
  const needBody = () => {
    if (!isObj(body)) fail(422, "invalid_body", "JSON object body required");
    return body;
  };
  // Idempotency: POSTs MAY carry Idempotency-Key (optional, not mandatory).
  // If the key was seen, return the cached response without re-executing.
  // Fingerprint = method + path + body (stable JSON). Mismatch => 422.
  //
  // Design decision (2026-09-27 audit F1): Idempotency is optional, not required.
  // Rationale: task_id uniqueness (409 on duplicate) provides idempotency for
  // claims; heartbeats/releases/receipts are naturally idempotent through
  // state-machine validation. Mandatory keys would add client complexity
  // without proportional benefit for the prototype phase. Revisit if
  // duplicate-mutation incidents occur in production.
  const idempotencyKey = headers["idempotency-key"] || headers["Idempotency-Key"] || null;
  const fingerprint = idempotencyKey
    ? `${method}:${path}:${JSON.stringify(body ?? null)}`
    : null;
  const checkIdempotent = (authedLane) => {
    if (method !== "POST" || !idempotencyKey) return null;
    const hit = board._checkIdempotency(authedLane, idempotencyKey, fingerprint);
    if (hit.mismatch) {
      fail(422, "idempotency_key_mismatch", "Idempotency-Key already used with a different payload");
    }
    if (hit.cached) return hit.response;
    return null;
  };
  const storeIdempotent = (authedLane, status, responseBody) => {
    if (method === "POST" && idempotencyKey) {
      board._storeIdempotency(authedLane, idempotencyKey, fingerprint, status, responseBody);
    }
  };
  try {
    if (path === "/claims" && method === "POST") {
      const b = needBody();
      rejectUnknown(b, CLAIM_BODY_FIELDS, "claim");
      const authed = needLane();
      const cached = checkIdempotent(authed);
      if (cached) return cached;
      if (b.lane !== undefined && b.lane !== authed) fail(403, "lane_mismatch", "body lane must equal the authenticated lane");
      const out = board.postClaim({ ...b, lane: authed });
      const resp = { status: 201, body: { watermark: board.seq, ...out } };
      storeIdempotent(authed, resp.status, resp.body);
      return resp;
    }
    if (path === "/claims" && method === "GET") {
      rejectUnknown(query, ["lane", "state", "file", "since_seq", "limit"], "query");
      return { status: 200, body: board.readBoard(query) };
    }
    if (path === "/claims") return { status: 405, body: { error: { code: "method_not_allowed", message: "Method not allowed" } } };

    // Phase 3.2: GET /board — materialized board view with supersede-chain resolution
    if (path === "/board" && method === "GET") {
      rejectUnknown(query, ["lane", "state", "file", "since_seq", "limit"], "query");
      return { status: 200, body: board.readBoard(query) };
    }
    if (path === "/board") return { status: 405, body: { error: { code: "method_not_allowed", message: "Method not allowed" } } };

    const tp = parseTaskPath(path);
    if (tp && method === "POST" && tp.action) {
      const b = needBody();
      const authed = needLane();
      const cached = checkIdempotent(authed);
      if (cached) return cached;
      let resp;
      if (tp.action === "heartbeat") {
        rejectUnknown(b, ["note"], "heartbeat");
        const out = board.heartbeat({ task_id: tp.taskId, lane: authed, note: b.note ?? null });
        resp = { status: 200, body: { watermark: board.seq, ...out } };
      } else if (tp.action === "release") {
        rejectUnknown(b, ["reason"], "release");
        if (b.reason === undefined) fail(422, "invalid_reason", "reason must be a non-empty string");
        const out = board.release({ task_id: tp.taskId, lane: authed, reason: b.reason });
        resp = { status: 200, body: { watermark: board.seq, ...out } };
      } else if (tp.action === "receipts") {
        rejectUnknown(b, ["sha", "pr"], "receipt");
        const out = board.postReceipt({ task_id: tp.taskId, lane: authed, sha: b.sha, pr: b.pr ?? null });
        resp = { status: 201, body: { watermark: board.seq, ...out } };
      }
      if (resp) {
        storeIdempotent(authed, resp.status, resp.body);
        return resp;
      }
    }
    if (tp && !tp.action) return { status: 405, body: { error: { code: "method_not_allowed", message: "Method not allowed" } } };

    if (path === "/mirror-map" && method === "GET") {
      rejectUnknown(query, ["issue", "comment_id", "since_seq"], "query");
      if (query.issue !== undefined || query.comment_id !== undefined) {
        const issue = Number(query.issue), comment_id = Number(query.comment_id);
        if (!(Number.isInteger(issue) && issue > 0) || !(Number.isInteger(comment_id) && comment_id > 0)) {
          fail(422, "invalid_mirror_ref", "issue and comment_id must be positive integers");
        }
        return { status: 200, body: { watermark: board.seq, ...board.resolveMirror({ issue, comment_id }) } };
      }
      return { status: 200, body: { watermark: board.seq, entries: board.mirrorSince(query.since_seq ?? 0) } };
    }
    if (path === "/mirror-map" && method === "POST") {
      const b = needBody();
      rejectUnknown(b, ["seq", "issue", "comment_id"], "mirror-map");
      const authed = needLane();
      const cached = checkIdempotent(authed);
      if (cached) return cached;
      const out = board.recordMirror(b);
      const resp = { status: 201, body: { watermark: board.seq, ...out } };
      storeIdempotent(authed, resp.status, resp.body);
      return resp;
    }
    if (path === "/notes" && method === "POST") {
      const b = needBody();
      rejectUnknown(b, ["thread", "body", "severity"], "note");
      const authed = needLane();
      const cached = checkIdempotent(authed);
      if (cached) return cached;
      if (b.body === undefined) fail(422, "invalid_body", "body must be a non-empty string");
      const out = board.postNote({ lane: authed, thread: b.thread ?? null, body: b.body, severity: b.severity ?? null });
      const resp = { status: 201, body: { watermark: board.seq, ...out } };
      storeIdempotent(authed, resp.status, resp.body);
      return resp;
    }
    // Phase 3.1: Unified event log with cursor pagination
    if (path === "/events" && method === "GET") {
      rejectUnknown(query, ["kind", "lane", "since_seq", "limit"], "query");
      return { status: 200, body: board.readEvents(query) };
    }
    if (path === "/events") return { status: 405, body: { error: { code: "method_not_allowed", message: "Method not allowed" } } };

    if (path === "/notes" && method === "GET") {
      rejectUnknown(query, ["lane", "thread", "severity", "since_seq", "limit"], "query");
      return { status: 200, body: board.readNotes(query) };
    }
    if (path === "/notes") return { status: 405, body: { error: { code: "method_not_allowed", message: "Method not allowed" } } };

    if (path === "/findings" && method === "POST") {
      const b = needBody();
      rejectUnknown(b, ["claim_ref", "pr_ref", "severity", "title", "evidence", "recommendation"], "finding");
      const authed = needLane();
      const cached = checkIdempotent(authed);
      if (cached) return cached;
      if (b.severity === undefined) fail(422, "invalid_severity", "severity is required");
      if (b.title === undefined) fail(422, "invalid_title", "title must be a non-empty string");
      if (b.recommendation === undefined) fail(422, "invalid_recommendation", "recommendation must be a non-empty string");
      const out = board.postFinding({
        lane: authed, claim_ref: b.claim_ref ?? null, pr_ref: b.pr_ref ?? null,
        severity: b.severity, title: b.title, evidence: b.evidence ?? [], recommendation: b.recommendation,
      });
      const resp = { status: 201, body: { watermark: board.seq, ...out } };
      storeIdempotent(authed, resp.status, resp.body);
      return resp;
    }
    if (path === "/findings" && method === "GET") {
      rejectUnknown(query, ["lane", "severity", "since_seq", "limit"], "query");
      return { status: 200, body: board.readFindings(query) };
    }
    if (path === "/findings") return { status: 405, body: { error: { code: "method_not_allowed", message: "Method not allowed" } } };

    if (path === "/decisions" && method === "POST") {
      const b = needBody();
      rejectUnknown(b, ["scope", "statement", "reversible", "supersedes"], "decision");
      const authed = needLane();
      const cached = checkIdempotent(authed);
      if (cached) return cached;
      if (b.scope === undefined) fail(422, "invalid_scope", "scope must be a non-empty string");
      if (b.statement === undefined) fail(422, "invalid_statement", "statement must be a non-empty string");
      const out = board.postDecision({
        decider: authed, scope: b.scope, statement: b.statement,
        reversible: b.reversible ?? null, supersedes: b.supersedes ?? null,
      });
      const resp = { status: 201, body: { watermark: board.seq, ...out } };
      storeIdempotent(authed, resp.status, resp.body);
      return resp;
    }
    if (path === "/decisions" && method === "GET") {
      rejectUnknown(query, ["decider", "scope", "since_seq", "limit"], "query");
      return { status: 200, body: board.readDecisions(query) };
    }
    if (path === "/decisions") return { status: 405, body: { error: { code: "method_not_allowed", message: "Method not allowed" } } };

    if (path === "/health" && method === "GET") {
      return { status: 200, body: board.health() };
    }
    return { status: 404, body: { error: { code: "not_found", message: "Unknown board v2 route" } } };
  } catch (err) {
    if (err instanceof BoardV2Error) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.fields) body.error.fields = err.fields;
      return { status: err.status, body };
    }
    throw err;
  }
}
