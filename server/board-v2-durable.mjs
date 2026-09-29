// Board-v2 durable state machine (RC-2026-09-27-2720).
//
// A faithful port of BoardV2 (server/board-v2.mjs) over the board_vtwo_*
// tables (server/board-v2-sqlite.mjs): same method names, same validation
// order, same error codes, same response shapes. The only difference is that
// state lives in SQLite instead of process memory, so handleBoardV2Request
// (server/board-v2.mjs) mounts this unchanged.
//
// Notes on the port:
// - Events are the source of truth for notes/findings/decisions/mirror,
//   exactly as in the prototype (one unified append-only log). The registry
//   has no separate note tables; note views are projected from note-kind
//   events.
// - The prototype never sweeps expired leases; neither does this port.
//   `expired` is a computed flag on the public claim view.
// - Multi-step mutations are NOT wrapped here; the HTTP layer runs the whole
//   handleBoardV2Request call inside store.transaction (BEGIN IMMEDIATE), so
//   check-then-write sequences (duplicate task-id, claim_conflict,
//   idempotency replay) are atomic.
// - Scoping: the tables carry no room_id (PR #1144). The board is the
//   deployment's coordination board; the :roomId in
//   /api/rooms/:roomId/board/v2/* selects the auth context, not a data
//   partition.

import { createDurableBoardV2 } from "./board-v2-sqlite.mjs";
import {
  BoardV2Error,
  cleanTaskId, cleanLane, cleanPath, cleanFiles, cleanLease, cleanText,
  LIVE_STATES, TERMINAL_STATES, MAX_REASON_CHARS, MAX_NOTE_CHARS,
  MAX_LIMIT, DEFAULT_LIMIT, iso,
} from "./board-v2.mjs";

const fail = (status, code, message, fields) => {
  throw new BoardV2Error(status, code, message, fields);
};

export const SHA_RE = /^[0-9a-f]{7,40}$/i;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export function createDurableBoardV2Machine(db, { now = () => Date.now() } = {}) {
  const reg = createDurableBoardV2(db, { now });

  const getSeq = () => reg.seq();

  // --- events ------------------------------------------------------------
  const emit = (kind, taskId, lane, payload, opts = {}) => reg.appendEvent({
    kind,
    task_id: taskId ?? null,
    lane,
    payload,
    supersedes: opts.supersedes ?? null,
    idempotencyKey: opts.idempotencyKey ?? null,
  });

  const eventView = e => {
    const view = { seq: e.seq, at: e.at, kind: e.kind, task_id: e.task_id, lane: e.lane, payload: e.payload };
    if (e.supersedes != null) view.supersedes = e.supersedes;
    if (e.idempotency_key != null) view.idempotency_key = e.idempotency_key;
    return view;
  };

  // Full ordered scan for a (kind, lane, since) slice. The prototype filters
  // its in-memory arrays the same way; the board's event volume makes one
  // scan per read the faithful equivalent.
  const collectEvents = ({ kind = null, lane = null, since_seq = 0 } = {}) => {
    const since = Number(since_seq) || 0;
    const ln = lane !== null && lane !== undefined ? cleanLane(lane) : null;
    const out = [];
    let cursor = since, exhausted = false;
    while (!exhausted) {
      const page = reg.listEvents({ kind, since_seq: cursor, limit: 200 });
      for (const e of page.events) {
        if (ln === null || e.lane === ln) out.push(e);
      }
      exhausted = !page.has_more;
      if (page.events.length) cursor = page.events[page.events.length - 1].seq;
      else exhausted = true;
    }
    return out;
  };

  // --- idempotency (24h TTL, per-lane scope, payload fingerprint) ---------
  const checkIdempotency = (lane, key, fingerprint) => {
    if (key == null) return { cached: false };
    const hit = reg.getIdempotency(lane, key);
    if (!hit) return { cached: false };
    if (now() - hit.created_at > IDEMPOTENCY_TTL_MS) {
      reg.deleteIdempotency(lane, key);
      return { cached: false };
    }
    if (hit.fingerprint !== fingerprint) return { cached: false, mismatch: true };
    return { cached: true, response: { status: hit.status, body: hit.body } };
  };

  const storeIdempotency = (lane, key, fingerprint, status, body) => {
    if (key == null) return;
    reg.putIdempotency(lane, key, { status, body, fingerprint });
  };

  // --- claims ------------------------------------------------------------
  const publicClaim = claim => {
    const base = claim.heartbeat_at_ms ?? claim.claim_at_ms;
    const expiresAtMs = base + claim.lease_h * 3600_000;
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
      expired: now() > expiresAtMs,
      last_seq: claim.last_seq,
      receipts: claim.receipts.map(r => ({ ...r })),
    };
  };

  const getLive = taskId => {
    const claim = reg.getClaim(taskId);
    if (!claim || !LIVE_STATES.has(claim.state)) {
      fail(404, "unknown_task", `no live claim ${taskId}`);
    }
    return claim;
  };

  const checkLane = (claim, lane) => {
    if (claim.lane !== lane) {
      fail(403, "lane_mismatch", `claim ${claim.task_id} is held by lane ${claim.lane}`);
    }
  };

  /** Live claims (any lane) holding any of `files`, excluding `exceptLane`. */
  const holders = (files, exceptLane) => {
    const out = [];
    for (const claim of reg.listClaims({})) {
      if (!LIVE_STATES.has(claim.state) || claim.lane === exceptLane) continue;
      const overlap = claim.files.filter(f => files.includes(f));
      if (overlap.length) out.push({ task_id: claim.task_id, lane: claim.lane, files: overlap });
    }
    return out;
  };

  const postClaim = ({ task_id, lane, files, lease, reason }) => {
    const tid = cleanTaskId(task_id);
    const ln = cleanLane(lane);
    if (reg.getClaim(tid)) {
      fail(409, "duplicate_task", `task-id ${tid} is already used: a task-id never gets a second claimant`);
    }
    const fs = cleanFiles(files);
    const leaseH = cleanLease(lease);
    const rs = cleanText(reason, MAX_REASON_CHARS, "invalid_reason", "reason");
    const hs = holders(fs, ln);
    if (hs.length) {
      fail(409, "claim_conflict", "files held live by another lane", { holders: hs });
    }
    const nowMs = now();
    const event = emit("claim", tid, ln, { files: fs, lease: `lease=${leaseH}h`, reason: rs });
    const claim = {
      task_id: tid, lane: ln, files: fs, lease: `lease=${leaseH}h`, lease_h: leaseH,
      reason: rs, state: "submitted",
      claim_seq: event.seq, claim_at_ms: nowMs, heartbeat_at_ms: null,
      last_seq: event.seq, receipts: [],
    };
    reg.putClaim(claim);
    return { seq: event.seq, claim: publicClaim(claim) };
  };

  const heartbeat = ({ task_id, lane, note = null }) => {
    const tid = cleanTaskId(task_id);
    const ln = cleanLane(lane);
    if (note !== null && note !== undefined) cleanText(note, MAX_NOTE_CHARS, "invalid_note", "note");
    const claim = getLive(tid);
    checkLane(claim, ln);
    const nowMs = now();
    const event = emit("heartbeat", tid, ln, note == null ? {} : { note: note.trim() });
    claim.heartbeat_at_ms = nowMs;
    if (claim.state === "submitted") claim.state = "working";
    claim.last_seq = event.seq;
    reg.putClaim(claim);
    return { seq: event.seq, claim: publicClaim(claim) };
  };

  const release = ({ task_id, lane, reason }) => {
    const tid = cleanTaskId(task_id);
    const ln = cleanLane(lane);
    const rs = cleanText(reason, MAX_REASON_CHARS, "invalid_reason", "reason");
    const claim = getLive(tid);
    checkLane(claim, ln);
    const event = emit("release", tid, ln, { reason: rs });
    claim.state = "released";
    claim.last_seq = event.seq;
    reg.putClaim(claim);
    return { seq: event.seq, claim: publicClaim(claim) };
  };

  const postReceipt = ({ task_id, lane, sha, pr = null }) => {
    const tid = cleanTaskId(task_id);
    const ln = cleanLane(lane);
    if (typeof sha !== "string" || !SHA_RE.test(sha)) fail(422, "invalid_sha", "sha must be 7-40 hex chars");
    if (pr !== null && pr !== undefined && !(typeof pr === "number" && Number.isInteger(pr) && pr > 0)) {
      fail(422, "invalid_pr", "pr must be a positive integer");
    }
    const claim = reg.getClaim(tid);
    if (!claim) fail(404, "unknown_task", `no claim ${tid}`);
    checkLane(claim, ln);
    const event = emit("receipt", tid, ln, { sha, pr: pr ?? null });
    const receipt = { seq: event.seq, at: event.at, sha, pr: pr ?? null };
    claim.receipts.push(receipt);
    claim.last_seq = event.seq;
    reg.putClaim(claim);
    return { seq: event.seq, receipt };
  };

  // --- notes / findings / decisions --------------------------------------
  const postNote = ({ lane, thread = null, body, severity = null }) => {
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
    const event = emit("note", null, ln, { thread: th, body: bd, severity: sev });
    const note = { seq: event.seq, at: event.at, lane: ln, thread: th, body: bd, severity: sev };
    return { seq: event.seq, note };
  };

  const postFinding = ({ lane, claim_ref = null, pr_ref = null, severity, title, evidence = [], recommendation }) => {
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
    const event = emit("finding", cr, ln, {
      pr_ref: pr, severity, title: ti, evidence: ev, recommendation: rec,
    });
    const finding = {
      seq: event.seq, at: event.at, lane: ln, claim_ref: cr, pr_ref: pr,
      severity, title: ti, evidence: ev, recommendation: rec,
    };
    return { seq: event.seq, finding };
  };

  const postDecision = ({ decider, scope, statement, reversible = null, supersedes = null }) => {
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
      const seqNum = Number(supersedes);
      if (!Number.isInteger(seqNum) || seqNum < 1 || seqNum > getSeq()) {
        fail(422, "invalid_supersedes", "supersedes must be a valid decision seq");
      }
      const target = reg.getEvent(seqNum);
      if (!target || target.kind !== "decision") {
        fail(422, "invalid_supersedes", `no decision with seq ${seqNum}`);
      }
      sup = seqNum;
    }
    const event = emit("decision", null, dc, {
      scope: sc, statement: st, reversible: rev, supersedes: sup,
    });
    const decision = {
      seq: event.seq, at: event.at, decider: dc, scope: sc,
      statement: st, reversible: rev, supersedes: sup,
    };
    return { seq: event.seq, decision };
  };

  // --- reads ---------------------------------------------------------------
  const readBoard = ({ lane = null, state = null, file = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) => {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    let claims = reg.listClaims(lane !== null && lane !== undefined ? { lane: cleanLane(lane) } : {});
    if (state !== null && state !== undefined) {
      if (!LIVE_STATES.has(state) && !TERMINAL_STATES.has(state)) {
        fail(422, "invalid_state", `unknown state ${state}`);
      }
      claims = claims.filter(c => c.state === state);
    }
    if (file !== null && file !== undefined) {
      const p = cleanPath(file);
      claims = claims.filter(c => c.files.includes(p));
    }
    if (since > 0) claims = claims.filter(c => c.last_seq > since);
    claims.sort((a, b) => a.last_seq - b.last_seq);
    const live = claims.filter(c => LIVE_STATES.has(c.state));
    // file-claims: inverted index over live claims (machine form)
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
    const liveDecisions = [...resolveDecisionChains().values()]
      .sort((a, b) => a.seq - b.seq)
      .slice(0, lim);
    return {
      watermark: getSeq(),
      claims: claims.slice(0, lim).map(publicClaim),
      file_claims: fileClaims,
      overlaps,
      decisions: liveDecisions,
    };
  };

  const readNotes = ({ lane = null, thread = null, severity = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) => {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const notes = [];
    for (const e of collectEvents({ kind: "note", lane, since_seq: since })) {
      const p = e.payload ?? {};
      const note = {
        seq: e.seq, at: e.at, lane: e.lane,
        thread: p.thread ?? null, body: p.body, severity: p.severity ?? null,
      };
      if (thread !== null && thread !== undefined && note.thread !== thread) continue;
      if (severity !== null && severity !== undefined && note.severity !== severity) continue;
      notes.push(note);
      if (notes.length >= lim) break;
    }
    return { watermark: getSeq(), notes };
  };

  const readFindings = ({ lane = null, severity = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) => {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const findings = [];
    for (const e of collectEvents({ kind: "finding", lane, since_seq: since })) {
      const p = e.payload ?? {};
      const finding = {
        seq: e.seq, at: e.at, lane: e.lane, claim_ref: e.task_id,
        pr_ref: p.pr_ref ?? null, severity: p.severity, title: p.title,
        evidence: p.evidence ?? [], recommendation: p.recommendation,
      };
      if (severity !== null && severity !== undefined && finding.severity !== severity) continue;
      findings.push(finding);
      if (findings.length >= lim) break;
    }
    return { watermark: getSeq(), findings };
  };

  const readDecisions = ({ decider = null, scope = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) => {
    const since = Number(since_seq) || 0;
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const dc = decider !== null && decider !== undefined ? cleanLane(decider) : null;
    const decisions = [];
    for (const e of collectEvents({ kind: "decision", since_seq: since })) {
      const p = e.payload ?? {};
      const decision = {
        seq: e.seq, at: e.at, decider: e.lane, scope: p.scope, statement: p.statement,
        reversible: p.reversible ?? null, supersedes: p.supersedes ?? null,
      };
      if (dc !== null && decision.decider !== dc) continue;
      if (scope !== null && scope !== undefined && decision.scope !== scope) continue;
      decisions.push(decision);
      if (decisions.length >= lim) break;
    }
    return { watermark: getSeq(), decisions };
  };

  // Resolve supersede chains to the live decisions (cycle-guarded, max 100 hops).
  const resolveDecisionChains = () => {
    const decisions = [];
    for (const e of collectEvents({ kind: "decision" })) {
      const p = e.payload ?? {};
      decisions.push({
        seq: e.seq, at: e.at, decider: e.lane, scope: p.scope, statement: p.statement,
        reversible: p.reversible ?? null, supersedes: p.supersedes ?? null,
      });
    }
    const bySeq = new Map(decisions.map(d => [d.seq, d]));
    const superseded = new Set();
    for (const d of decisions) {
      if (d.supersedes != null) superseded.add(d.supersedes);
    }
    const live = new Map();
    for (const d of decisions) {
      if (superseded.has(d.seq)) continue;
      let current = d;
      const visited = new Set([current.seq]);
      let hops = 0, isCycle = false;
      while (current.supersedes != null && hops < 100) {
        const nextSeq = current.supersedes;
        if (visited.has(nextSeq)) { isCycle = true; break; }
        visited.add(nextSeq);
        const next = bySeq.get(nextSeq);
        if (!next) break;
        current = next;
        hops++;
      }
      if (!isCycle && hops < 100) live.set(d.seq, d);
    }
    return live;
  };

  // Unified event log with cursor pagination (one extra to detect has_more).
  const readEvents = ({ kind = null, lane = null, since_seq = 0, limit = DEFAULT_LIMIT } = {}) => {
    const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const events = collectEvents({ kind, lane, since_seq });
    const slice = events.slice(0, lim + 1);
    return {
      watermark: getSeq(),
      events: slice.slice(0, lim).map(eventView),
      has_more: slice.length > lim,
    };
  };

  // --- mirror map: (issue, comment_id) <-> seq translation for migration ---
  const recordMirror = ({ seq, issue, comment_id }) => {
    const s = Number(seq);
    if (!(Number.isInteger(s) && s >= 1 && s <= getSeq()) || !reg.getEvent(s)) {
      fail(422, "invalid_seq", "seq must be a known board event seq");
    }
    if (!(Number.isInteger(issue) && issue > 0)) fail(422, "invalid_issue", "issue must be a positive integer");
    if (!(Number.isInteger(comment_id) && comment_id > 0)) fail(422, "invalid_comment", "comment_id must be a positive integer");
    reg.recordMirror({ seq: s, issue, comment_id });
    return { seq: s, issue, comment_id };
  };

  const resolveMirror = ({ issue, comment_id }) => {
    const hit = reg.resolveMirror({ issue, comment_id });
    if (!hit) fail(404, "mirror_unknown", `no board seq for issue #${issue} comment ${comment_id}`);
    return hit;
  };

  const mirrorSince = sinceSeq => {
    const since = Number(sinceSeq) || 0;
    const out = [];
    for (const e of collectEvents({ since_seq: since })) {
      if (e.mirror_issue != null) {
        out.push({ seq: e.seq, issue: e.mirror_issue, comment_id: e.mirror_comment });
      }
    }
    return out;
  };

  const health = () => {
    const live = reg.listClaims({}).filter(c => LIVE_STATES.has(c.state)).length;
    let notes = 0, findings = 0, decisions = 0, mirrorEntries = 0;
    for (const e of collectEvents({})) {
      if (e.kind === "note") notes++;
      else if (e.kind === "finding") findings++;
      else if (e.kind === "decision") decisions++;
      if (e.mirror_issue != null) mirrorEntries++;
    }
    return {
      seq: getSeq(), live_claims: live, mirror_entries: mirrorEntries,
      notes, findings, decisions,
    };
  };

  return {
    get seq() { return getSeq(); },
    _checkIdempotency: checkIdempotency,
    _storeIdempotency: storeIdempotency,
    postClaim, heartbeat, release, postReceipt,
    postNote, postFinding, postDecision,
    readBoard, readNotes, readFindings, readDecisions, readEvents,
    recordMirror, resolveMirror, mirrorSince, health,
  };
}
