// Computed `next:` line + needs-you custody rule (organism Step 5 /
// vibestack APPLICATION §2, concept (e) ADOPT narrowed).
//
// A `next:` line is COMPUTED from structured rows only, never hand-written.
// Every machine-generated needs-you surface carries exactly one such line:
// a JSON twin, and the human line rendered from that twin. The line always
// carries a denominator (`1 of N` blocking items) and a named owner drawn
// from the closed verb vocabulary below.
//
// Custody rule: a needs-you item clears the queue ONLY on
//   (a) work restarting,
//   (b) the item reaching a terminal state, or
//   (c) a valid computed `next:` that transfers custody to a named actor
//       (with a deadline where the verb is `wait`/`escalate`).
// A comment does not clear the queue. A terminal line over blocking rows
// and a self-loop `wait` are invalid — they are the dropped-work signature.
// This module is pure: no store, no I/O. Callers supply structured rows.

// Closed verb vocabulary (APPLICATION §2). Anything outside it is invalid.
export const NEXT_LINE_VERBS = Object.freeze([
  "fix", "prove", "submit", "resubmit", "verify", "review", "decide",
  "escalate", "wait", "amend-spec", "unblock",
]);
const VERB_SET = new Set(NEXT_LINE_VERBS);
// Verbs that hold custody in place over time: they must carry a deadline,
// otherwise the item can sit forever behind a plausible-looking line.
const DEADLINE_VERBS = new Set(["wait", "escalate"]);

// A row is blocking when its check/state has not passed: FAILED and NOT-RUN
// rows block exactly like an open work state; PASSED/done rows do not.
export function isBlockingRow(row) {
  if (!row || row.terminal === true) return false;
  const status = String(row.status ?? "open").toUpperCase();
  return status !== "PASSED" && status !== "DONE" && status !== "GREEN";
}

function blockingRowsOf(rows) {
  return (rows ?? []).filter(isBlockingRow);
}

function renderLine(json) {
  if (json.terminal) return `next: none — 0 of ${json.totalCount} blocking items`;
  const due = json.dueAt ? ` by ${json.dueAt}` : "";
  return `next: ${json.verb} — owner ${json.owner} — ${json.position} blocking items${due} [${json.itemId}]`;
}

// computeNextLine(rows, {holderId}) -> { json, line }
// rows: [{ id, status, verb, owner, dueAt?, terminal? }] in stage order.
// The first blocking row (in the caller's order) is the computed next step.
// With no blocking rows the terminal form is returned; it is valid only
// because the rows support it (validateNextLine enforces that on input).
export function computeNextLine(rows, { holderId = null } = {}) {
  const all = rows ?? [];
  const blocking = blockingRowsOf(all);
  if (blocking.length === 0) {
    const json = Object.freeze({
      verb: null, terminal: true, owner: null, itemId: null,
      position: `0 of ${all.length}`, blockingCount: 0, totalCount: all.length,
      dueAt: null, holder: holderId,
    });
    return Object.freeze({ json, line: renderLine(json) });
  }
  const first = blocking[0];
  const verb = VERB_SET.has(first.verb) ? first.verb : "unblock";
  const json = Object.freeze({
    verb, terminal: false,
    owner: typeof first.owner === "string" && first.owner ? first.owner : holderId,
    itemId: first.id ?? null,
    position: `1 of ${blocking.length}`, blockingCount: blocking.length,
    totalCount: all.length,
    dueAt: typeof first.dueAt === "string" && first.dueAt ? first.dueAt : null,
    holder: holderId,
  });
  return Object.freeze({ json, line: renderLine(json) });
}

// validateNextLine(json, { rows, currentHolderId }) -> { valid, rule }
// `rule` names the failing rule when invalid; null when valid.
export function validateNextLine(json, { rows = [], currentHolderId = null } = {}) {
  if (!json || typeof json !== "object") return { valid: false, rule: "missing-next-line" };
  const blocking = blockingRowsOf(rows);
  const terminal = json.terminal === true || json.verb === null || json.verb === "none";
  if (terminal) {
    // `next: none` over failing/open rows is the dropped-work signature.
    if (blocking.length > 0) return { valid: false, rule: "terminal-over-blocking-rows" };
    return { valid: true, rule: null };
  }
  if (!VERB_SET.has(json.verb)) return { valid: false, rule: "verb-outside-vocabulary" };
  if (typeof json.owner !== "string" || !json.owner) return { valid: false, rule: "missing-owner" };
  // A wait/escalate that hands custody back to the current holder transfers
  // nothing: the item would leave the queue while nobody new owns it.
  if (DEADLINE_VERBS.has(json.verb) && currentHolderId && json.owner === currentHolderId) {
    return { valid: false, rule: "self-loop-wait" };
  }
  if (DEADLINE_VERBS.has(json.verb) && !(typeof json.dueAt === "string" && json.dueAt)) {
    return { valid: false, rule: "missing-deadline" };
  }
  const expected = `1 of ${blocking.length}`;
  if (json.position !== expected || json.blockingCount !== blocking.length) {
    return { valid: false, rule: "denominator-mismatch" };
  }
  return { valid: true, rule: null };
}

// evaluateClearance(item, attempt) -> { clears, rule }
// item: { id, terminal?, rows? } — the queued item and its supporting rows.
// attempt: { kind, next?, actorId? } with kind one of
//   "comment" | "answer" | "work-restarted" | "terminal-state" | "next-line".
// "answer" is an attempt that carries (or fails to carry) a `next:` twin.
export function evaluateClearance(item, attempt) {
  if (!attempt || typeof attempt !== "object") return { clears: false, rule: "no-clearance-attempt" };
  // A terminal item is out of the queue by its own state, whatever the
  // attempt was; merely claiming terminality in an attempt does not clear
  // a live item.
  if (item?.terminal === true) return { clears: true, rule: "terminal-state" };
  if (attempt.kind === "terminal-state") return { clears: false, rule: "not-terminal" };
  if (attempt.kind === "comment") return { clears: false, rule: "comment-does-not-clear" };
  if (attempt.kind === "work-restarted") return { clears: true, rule: "work-restarted" };
  if (attempt.kind === "answer" || attempt.kind === "next-line") {
    if (!attempt.next) return { clears: false, rule: "missing-next-line" };
    const verdict = validateNextLine(attempt.next, {
      rows: item?.rows ?? [], currentHolderId: item?.holderId ?? null,
    });
    return verdict.valid
      ? { clears: true, rule: "custody-transferred" }
      : { clears: false, rule: verdict.rule };
  }
  return { clears: false, rule: "unknown-clearance-attempt" };
}

// applyClearanceAttempts(items, attemptsById) -> { remaining, cleared }
// Pure queue filter implementing the custody rule: an item leaves only when
// its recorded attempt clears it. Items whose attempt failed stay queued and
// carry the failing rule name on `clearanceRule`, so the drop attempt is
// visible on the queue instead of silently succeeding.
export function applyClearanceAttempts(items, attemptsById = {}) {
  const remaining = [], cleared = [];
  for (const item of items ?? []) {
    const attempt = attemptsById?.[item.id];
    if (!attempt) { remaining.push(item); continue; }
    const verdict = evaluateClearance(item, attempt);
    if (verdict.clears) cleared.push(Object.freeze({ ...item, clearanceRule: verdict.rule }));
    else remaining.push(Object.freeze({ ...item, clearanceRule: verdict.rule }));
  }
  return { remaining, cleared };
}

// enrichNeedsYouQueue(items, { holderId, verbFor, dueAtFor })
// Rendering half of the mechanism for a live queue read: every item gains
// its holding actor, its due date (when the underlying state carries one)
// and its `1 of N` queue position; the queue gains the one computed
// `next:` line (JSON twin + human line rendered from it). Items are the
// blocking rows: a queued item is by definition work nobody has cleared.
export function enrichNeedsYouQueue(items, { holderId = null, verbFor = () => "review", dueAtFor = () => null } = {}) {
  const list = items ?? [];
  const total = list.length;
  const enriched = list.map((item, index) => Object.freeze({
    ...item,
    holder: holderId,
    dueAt: dueAtFor(item),
    queuePosition: `${index + 1} of ${total}`,
  }));
  const rows = enriched.map(item => ({
    id: item.id, status: "open", verb: verbFor(item), owner: holderId, dueAt: item.dueAt,
  }));
  const { json, line } = computeNextLine(rows, { holderId });
  return Object.freeze({ items: Object.freeze(enriched), nextLineJson: json, nextLine: line });
}
