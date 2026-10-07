// Merge-slot queue — phase 1 of the room-coordinated merge queue
// (docs/MERGE-QUEUE-DESIGN.md; research technique #1/#4 in
// ~/workspace/research_notes/multi-agent-orchestration-2026-10-05/report.md).
//
// Shape: lanes claim a merge-slot (enqueue); AUTOMATION — not each lane —
// does the serial work (scripts/merge-queue-worker.mjs: rebase the PR onto
// current main, run the checks, merge, release the slot). Lanes stop fighting
// HEAD themselves. Phase 2 wires this queue to GitHub's native merge queue
// after the repo-settings tap.
//
// Slot lock: leases with expiry, heartbeat renewal, and a sweep that releases
// stale slots. Expiry is evaluated on every operation (reads never show stale
// slots), mirroring the lease pattern in server/work-claims.mjs.
//
// This module is pure: the state machine never touches I/O. The per-room
// registry is in-process (no new infrastructure); a durable registry can
// replace it later without changing the state machine. All operations are
// synchronous, so check-and-set within one call is atomic on Node's single
// thread — two lanes racing enqueue() cannot both hold the slot.
//
// Error contract: the pure module throws MergeQueueError (code, no HTTP
// status); handleMergeQueue maps codes to statuses. Unknown errors are
// rethrown for the generic 500 path — never wrapped, so no internal detail
// leaks.

export const DEFAULT_SLOT_LEASE_MS = 15 * 60 * 1000; // 15 minutes

export class MergeQueueError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = "MergeQueueError";
    this.code = code;
    if (extra !== undefined) {
      this.extra = extra;
      // Machine-readable queue position is first-class: consumers checking a
      // "queue busy, position N" refusal should not dig through `extra`.
      if (extra.position !== undefined) this.position = extra.position;
    }
  }
}

const invalid = message => new MergeQueueError("merge_queue_invalid_input", message);
const busy = (message, position) => new MergeQueueError("merge_queue_busy", message, { position });
const forbidden = message => new MergeQueueError("merge_queue_forbidden", message);
const unknownEntry = claimId =>
  new MergeQueueError("merge_queue_unknown_entry", `no merge-slot for claim "${claimId}"`);

const CLAIM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function checkEntry({ pr, headSha, claimId, lane, mode }) {
  if (!Number.isSafeInteger(pr) || pr <= 0) throw invalid("pr must be a positive integer");
  if (typeof headSha !== "string" || !HEAD_SHA_PATTERN.test(headSha)) {
    throw invalid("headSha must be a 40-char hex commit SHA");
  }
  if (typeof claimId !== "string" || !CLAIM_ID_PATTERN.test(claimId)) {
    throw invalid("claimId must match [A-Za-z0-9_-]{1,128}");
  }
  if (typeof lane !== "string" || lane.length === 0 || lane.length > 128) {
    throw invalid("lane must be a non-empty member id (max 128 chars)");
  }
  if (mode !== undefined && mode !== "queue" && mode !== "try") {
    throw invalid('mode must be "queue" or "try"');
  }
}

function checkClaimId(claimId) {
  if (typeof claimId !== "string" || !CLAIM_ID_PATTERN.test(claimId)) throw invalid("claimId must match [A-Za-z0-9_-]{1,128}");
}

function checkCaller(caller) {
  if (typeof caller !== "string" || caller.length === 0 || caller.length > 128) {
    throw invalid("caller must be a non-empty member id (max 128 chars)");
  }
}

// Fresh-lease the given entry object in place.
const grant = (entry, nowMs, leaseMs) => {
  entry.leaseStartAt = nowMs;
  entry.leaseExpiresAt = nowMs + leaseMs;
  return entry;
};

const activeView = entry => entry ? {
  pr: entry.pr, headSha: entry.headSha, claimId: entry.claimId, lane: entry.lane,
  enqueuedAt: entry.enqueuedAt, leaseStartAt: entry.leaseStartAt,
  leaseExpiresAt: entry.leaseExpiresAt, adoptedBy: entry.adoptedBy, position: 0,
} : null;

const queuedView = (entry, index) => ({
  pr: entry.pr, headSha: entry.headSha, claimId: entry.claimId, lane: entry.lane,
  enqueuedAt: entry.enqueuedAt, adoptedBy: entry.adoptedBy, position: index + 1,
});

export function createMergeSlotQueue({ now = () => Date.now(), leaseMs = DEFAULT_SLOT_LEASE_MS } = {}) {
  const state = { active: null, queue: [] };

  // Release the holder when its lease lapsed and promote the queue head.
  // Runs at the top of every operation so stale slots never linger.
  function sweepExpired() {
    const swept = [];
    let promoted = null;
    if (state.active && state.active.leaseExpiresAt <= now()) {
      swept.push(state.active.claimId);
      state.active = null;
    }
    if (!state.active && state.queue.length > 0) {
      const next = state.queue.shift();
      state.active = grant(next, now(), leaseMs);
      promoted = next.claimId;
    }
    return { swept, promoted };
  }

  const findActive = claimId => (state.active && state.active.claimId === claimId ? state.active : null);
  const findQueued = claimId => state.queue.find(entry => entry.claimId === claimId) ?? null;

  // The lane, the adopted automation worker, or the room owner may operate a slot.
  const authorized = (entry, caller, asOwner) =>
    asOwner === true || caller === entry.lane || (entry.adoptedBy !== null && caller === entry.adoptedBy);

  return {
    enqueue(input) {
      checkEntry(input);
      const { pr, headSha, claimId, lane, mode = "queue" } = input;
      sweepExpired();
      const held = findActive(claimId);
      if (held) return { status: "holding", position: 0, claimId, leaseExpiresAt: held.leaseExpiresAt };
      const waiting = findQueued(claimId);
      if (waiting) return { status: "queued", position: state.queue.indexOf(waiting) + 1, claimId };
      const entry = { pr, headSha, claimId, lane, enqueuedAt: now(), adoptedBy: null };
      if (!state.active) {
        state.active = grant(entry, now(), leaseMs);
        return { status: "holding", position: 0, claimId, leaseExpiresAt: state.active.leaseExpiresAt };
      }
      if (mode === "try") throw busy("merge slot is held; queue position unavailable in try mode", state.queue.length + 1);
      state.queue.push(entry);
      return { status: "queued", position: state.queue.length, claimId };
    },

    heartbeat({ claimId, caller, asOwner = false }) {
      checkClaimId(claimId);
      checkCaller(caller);
      sweepExpired();
      const entry = findActive(claimId);
      if (!entry) throw unknownEntry(claimId);
      if (!authorized(entry, caller, asOwner)) throw forbidden("only the lane, the adopted worker, or the room owner may heartbeat this slot");
      grant(entry, now(), leaseMs);
      return { claimId, leaseExpiresAt: entry.leaseExpiresAt };
    },

    adopt({ claimId, caller }) {
      checkClaimId(claimId);
      checkCaller(caller);
      sweepExpired();
      const entry = findActive(claimId);
      if (!entry) throw unknownEntry(claimId);
      // Adoption is sticky: the first automation worker to adopt keeps it, so
      // two workers cannot fight over one slot. The lane (or owner) resets it
      // by releasing and re-enqueueing.
      if (entry.adoptedBy !== null && entry.adoptedBy !== caller) {
        throw forbidden("slot already adopted by another worker");
      }
      entry.adoptedBy = caller;
      return { claimId, adoptedBy: caller };
    },

    release({ claimId, caller, asOwner = false }) {
      checkClaimId(claimId);
      checkCaller(caller);
      sweepExpired();
      const held = findActive(claimId);
      if (held) {
        if (!authorized(held, caller, asOwner)) throw forbidden("only the lane, the adopted worker, or the room owner may release this slot");
        state.active = null;
        const { promoted } = sweepExpired();
        return { released: true, promoted };
      }
      const waiting = findQueued(claimId);
      if (waiting) {
        // Queued entries belong to their lane: the adopted worker operates
        // the active slot only, never someone else's queued entry.
        if (!(asOwner === true || caller === waiting.lane)) {
          throw forbidden("only the lane or the room owner may dequeue a queued entry");
        }
        state.queue.splice(state.queue.indexOf(waiting), 1);
        return { released: true, promoted: null };
      }
      throw unknownEntry(claimId);
    },

    sweep() {
      return sweepExpired();
    },

    status() {
      sweepExpired();
      return {
        active: activeView(state.active),
        queue: state.queue.map(queuedView),
        depth: state.queue.length,
      };
    },
  };
}

// Per-room registry: roomId -> merge-slot queue. In-process for phase 1;
// the state machine above is persistence-agnostic, so a durable registry
// can replace this without changing queue semantics.
export function createMergeQueueRegistry({ now, leaseMs } = {}) {
  const rooms = new Map();
  return {
    get(roomId) {
      if (typeof roomId !== "string" || roomId.length === 0) throw invalid("roomId is required");
      let queue = rooms.get(roomId);
      if (!queue) {
        queue = createMergeSlotQueue({ now, leaseMs });
        rooms.set(roomId, queue);
      }
      return queue;
    },
  };
}

// Shared in-process registry: the single source of truth both the REST
// handler and the MCP dispatch use (no store.mjs change for phase 1).
export const sharedMergeQueueRegistry = createMergeQueueRegistry();

const ROUTE_METHODS = {
  enqueue: "POST", heartbeat: "POST", adopt: "POST", release: "POST", sweep: "POST", status: "GET",
};

const ERROR_STATUS = {
  merge_queue_invalid_input: 422,
  merge_queue_busy: 409,
  merge_queue_forbidden: 403,
  merge_queue_unknown_entry: 404,
};

// HTTP handler mounted by server/http.mjs inside the authenticated room block
// (mount pending: server/http.mjs is file-leased to claude-code-drops until
// 2026-10-07T00:23Z; the mount is a 3-line add — see the ASK in the room).
// Routes: POST /api/rooms/{roomId}/merge-queue/{enqueue,heartbeat,adopt,release,sweep}
//         GET  /api/rooms/{roomId}/merge-queue/status
export async function handleMergeQueue({
  req, res, url, roomId, auth, mergeQueueRoute,
  registry = sharedMergeQueueRegistry, isOwner = false,
  helpers: { json, reject, body },
}) {
  const expected = ROUTE_METHODS[mergeQueueRoute];
  if (!expected) return reject(404, "unknown_merge_queue_route", `unknown merge-queue route "${mergeQueueRoute}"`);
  if (req.method !== expected) return reject(405, "method_not_allowed", `${mergeQueueRoute} requires ${expected}`);
  const queue = registry.get(roomId);
  const caller = auth?.member?.id;
  try {
    switch (mergeQueueRoute) {
      case "enqueue": {
        const input = await body();
        const out = queue.enqueue({
          pr: input.pr, headSha: input.headSha, claimId: input.claimId,
          lane: caller, mode: input.mode,
        });
        return json(200, out);
      }
      case "heartbeat": {
        const input = await body();
        return json(200, queue.heartbeat({ claimId: input.claimId, caller, asOwner: isOwner }));
      }
      case "adopt": {
        const input = await body();
        return json(200, queue.adopt({ claimId: input.claimId, caller }));
      }
      case "release": {
        const input = await body();
        return json(200, queue.release({ claimId: input.claimId, caller, asOwner: isOwner }));
      }
      case "sweep":
        return json(200, queue.sweep());
      case "status":
        return json(200, queue.status());
    }
  } catch (error) {
    if (error instanceof MergeQueueError) {
      const status = ERROR_STATUS[error.code] ?? 409;
      return reject(status, error.code, error.message, error.extra);
    }
    throw error;
  }
}

// Unattended queue requests retain the #1615 independent approval boundary:
// arbitrary room members must not authorize their own PRs through enqueue.
// John's 2026-10-07 release direction also permits operator authority bound
// to one full head SHA, supplied by the worker caller rather than the claim.
// Pure: the worker reads the claim and passes it in.
//   - latest review per reviewer counts (a later review supersedes an earlier one)
//   - any current changes_requested blocks
//   - an approve counts only from a member other than the claim owner, bound
//     to the head: basis.headSha matches, or the summary names the head (7+ hex)
const shortSha = sha => String(sha ?? "").slice(0, 7);
const ownerOf = claim => (typeof claim?.owner === "object" ? claim?.owner?.memberId ?? claim?.owner?.id : claim?.owner) ?? null;
const headsIn = text => (String(text ?? "").match(/\b[0-9a-f]{7,40}\b/gi) ?? []).map(sha => sha.toLowerCase());
const sameSha = (a, b) => !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

export function approvalGate({ claim, headSha, authorizedHeadSha }) {
  const head = String(headSha ?? "").toLowerCase();
  if (!claim || !Array.isArray(claim.reviews)) return { ok: false, reason: "no readable Board claim with reviews; release refused" };
  // Operator-supplied CLI authority, never a claim field or a lane self-report.
  // John permits authorized releases without formal independent approval;
  // unattended requests from arbitrary room members retain the default gate.
  if (authorizedHeadSha != null) {
    if (!/^[0-9a-f]{40}$/.test(head) || authorizedHeadSha !== head) {
      return { ok: false, reason: "operator authorization must match the full enqueued head SHA" };
    }
    if (claim.state === "blocked") return { ok: false, reason: "Board claim is blocked; resolve its explicit hold before landing" };
    return { ok: true, approvedBy: [], authorization: "operator_exact_head" };
  }
  if (head.length < 7) return { ok: false, reason: "no enqueued head to bind an approval to" };
  const latest = new Map();
  for (const review of [...claim.reviews].sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0))) {
    if (review?.memberId) latest.set(review.memberId, review);
  }
  const current = [...latest.values()];
  const blocking = current.find(review => review.verdict === "changes_requested");
  if (blocking) return { ok: false, reason: `changes requested on the claim by ${blocking.memberId}; merge waits for that reviewer's approve` };
  const owner = ownerOf(claim) ?? claim.reviews.find(review => review?.basis?.owner)?.basis?.owner ?? null;
  const approvals = current.filter(review => review.verdict === "approve" && review.memberId !== owner
    && (sameSha(String(review.basis?.headSha ?? "").toLowerCase(), head) || headsIn(review.summary).some(sha => sameSha(sha, head))));
  if (!approvals.length) return { ok: false, reason: `no independent approve bound to head ${shortSha(head)} on claim ${claim.id ?? "?"}: a reviewer other than the owner must approve this exact head (name it in the review)` };
  return { ok: true, approvedBy: approvals.map(review => review.memberId) };
}

// GitHub returns multiple attempts/checks; judge the latest per name and wait
// for nonterminal states. A pending check is not a failed check.
export function queueCheckVerdict({ runs = [], legacy = [], requiredChecks }) {
  const states = new Map();
  for (const run of [...runs].sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))) {
    if (requiredChecks.includes(run.name) && !states.has(run.name)) {
      states.set(run.name, run.status === "completed" ? (run.conclusion ?? "unknown") : run.status);
    }
  }
  for (const row of legacy) if (requiredChecks.includes(row.name) && !states.has(row.name)) states.set(row.name, row.state);
  const missing = requiredChecks.filter(name => !states.has(name));
  const nonterminal = new Set(["pending", "queued", "in_progress", "waiting", "requested"]);
  const failing = requiredChecks.filter(name => states.has(name) && states.get(name) !== "success" && !nonterminal.has(states.get(name)));
  if (failing.length) return { state: "failure", reason: `required checks failing: ${failing.map(name => `${name}=${states.get(name)}`).join(", ")}` };
  const pending = requiredChecks.filter(name => nonterminal.has(states.get(name)));
  return missing.length || pending.length
    ? { state: "pending", pending: [...pending, ...missing] }
    : { state: "success" };
}

// Second blocker from review 4404/4506: after its own rebase the worker must
// prove it is merging what was approved. The cumulative patch-id of the PR
// before the rebase (merge-base..enqueued head) must equal the one after it
// (main..rebased head); a rebase that drops or changes hunks refuses. Git is
// injected as runGit(args, stdin) so this stays testable without the worker.
export function patchUnchanged(runGit, { oldBase, oldHead, newBase, newHead }) {
  const id = (base, head) => {
    const diff = runGit(["diff", "--no-color", "--no-ext-diff", base, head]);
    return diff.trim() ? String(runGit(["patch-id", "--stable"], diff)).trim().split(/\s+/)[0] : "";
  };
  const before = id(oldBase, oldHead), after = id(newBase, newHead);
  return { ok: before !== "" && before === after, before, after };
}
