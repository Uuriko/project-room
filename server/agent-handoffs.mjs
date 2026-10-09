// server/agent-handoffs.mjs — GUILD-04 messaging-failure repair prototype.
//
// *** NOT IMPORTED ANYWHERE. Do not import from server/http.mjs or any
//     route/module. This is a repair-layer prototype that sits ON TOP of the
//     existing Room messaging (board-comment [lane][kind] grammar + muse-room
//     event log); it introduces no new transport, queue, or protocol. ***
//
// What it repairs (all observed failures, with evidence pointers):
//   F1 double-answers from duplicate sweeps      — dedupeKey() + correlate()
//        dedupes RECEIPTs per (task_id, lane) and ownership checks use the
//        author USERNAME, never the JWT sub (2026-10-07 Colony author-id trap:
//        author.id ed2f5ebc-c06c-4bb5-973c-3035d144fe51 vs JWT sub
//        ed2f5ebc-c0c6-4bb5-973c-03d5d14fe51 — filtering on the sub matches
//        nothing and 30 inbounds got double-answered).
//   F2 parent-id threading mistakes             — checkThreadParent() requires
//        a reply's parent_id to be the INBOUND's id, never the grandparent's
//        (2026-10-05 Colony: 15 replies landed as siblings of the inbound,
//        10 duplicated sibling legs' answers).
//   F3 claim handoffs without acknowledgment    — correlate() enforces
//        ack-before-edit: no dependent action by the new owner may precede the
//        HANDOFF_ACK (2026-10-04 lane rule: "No acknowledgment, no edits").
//   F4 submission is not delivery               — a ROUTE (coordinator assigns
//        a task to a named owner) only counts as delivered when a READBACK
//        record shows the poster re-read the log and observed the route's own
//        message id (AGENTS.md: room-post read-back lesson — "Posted ok" is
//        submission, not delivery).
//
// Coordinator summaries are BOUNDED: summarize() caps output at maxLines so a
// rollup can never become a broadcast loop — one message, addressed, done.

const RECEIPT_KINDS = new Set(["receipt", "done", "status"]);
const ROUTE_KINDS = new Set(["route", "handoff-offer", "handoff"]);
const ACK_KINDS = new Set(["handoff-ack", "ack", "readback"]);

// [lane][kind] ...   e.g. "[instinct][handoff-offer] @jill - for RC-2026-09-27-2716"
const GRAMMAR = /^\s*\[([A-Za-z0-9_.-]+)\]\[([A-Za-z0-9_.-]+)\]/;
const TASK_ID = /\b(RC-\d{4}-\d{2}-\d{2}-\d+|[A-Z]{2,6}-\d{2,4}(?:-\d+)?)\b/;

/**
 * Normalize one board comment / room event into the repair-layer event shape.
 * Returns null when the comment carries no lane grammar (plain chatter is not
 * messaging work and is ignored — never classified as a handoff).
 */
export function normalizeEvent({ id, created_at, author_username, body, parent_id = null, jwt_sub = null, readback_of = null, thread_inbound_id = null, probe_owner = null, probe_sub = null }) {
  if (typeof body !== "string") return null;
  const m = body.match(GRAMMAR);
  if (!m) return null;
  const lane = m[1].toLowerCase();
  const kind = m[2].toLowerCase();
  const t = body.match(TASK_ID);
  return {
    id: String(id),
    seq: null,                 // filled by caller from log order when available
    created_at: created_at ?? null,
    lane,                      // parsed from the [lane] tag
    author_username: String(author_username ?? "").toLowerCase(),
    kind,
    task_id: t ? t[1] : null,
    parent_id: parent_id == null ? null : String(parent_id),
    // Deliberately NOT used for ownership matching (author-id trap). Carried so
    // tests can prove a jwt_sub lookup would mismatch while username matches.
    jwt_sub,
    // Passed through for the lint's cross-checks; never parsed from prose.
    readback_of: readback_of == null ? null : String(readback_of),
    thread_inbound_id: thread_inbound_id == null ? null : String(thread_inbound_id),
    probe_owner, probe_sub,
    body: body.slice(0, 2000),
  };
}

/** Dedupe key: one receipt per (task, lane, kind-family). Same task+lane+kind
 *  appearing twice is the duplicate-sweep / double-answer signature. */
export function dedupeKey(ev) {
  if (!ev || !ev.task_id) return null;
  const family = RECEIPT_KINDS.has(ev.kind) ? "receipt"
    : ROUTE_KINDS.has(ev.kind) ? "route"
    : ACK_KINDS.has(ev.kind) ? "ack" : ev.kind;
  return `${ev.task_id}|${ev.lane}|${family}`;
}

/**
 * Ownership test for "did lane X already touch task T?" — MUST be
 * username-based. A sub-lookup helper is exported so callers cannot
 * accidentally filter on jwt_sub.
 */
export function ownerMatches(ev, username) {
  return ev.author_username === String(username ?? "").toLowerCase();
}

/**
 * Thread-parent check. replyToId must equal the inbound's id. A grandparent
 * id (or any id that is not the inbound) is a threading violation.
 */
export function checkThreadParent(ev, inboundId) {
  const ok = ev.parent_id != null && String(ev.parent_id) === String(inboundId);
  return { ok, expected: String(inboundId), got: ev.parent_id };
}

/**
 * Correlate a sequence of normalized events (log order) into per-task
 * delivery/readback/ack records plus a violations list.
 *
 * Lifecycle per task, in the EXISTING vocabulary:
 *   ROUTE/HANDOFF (delivery candidate) -> READBACK (poster confirms its own
 *   message id visible in the log) -> HANDOFF_ACK (named owner accepts) ->
 *   RECEIPT/STATUS (owner's work) — owner actions before the ACK violate
 *   ack-before-edit; a second RECEIPT by the same lane duplicates a sweep.
 */
export function correlate(events) {
  const ordered = [...events].sort((a, b) =>
    (a.seq ?? 0) - (b.seq ?? 0) || String(a.id).localeCompare(String(b.id)));
  const records = new Map(); // task_id -> record
  const violations = [];

  const rec = (taskId) => {
    if (!records.has(taskId)) {
      records.set(taskId, {
        task_id: taskId,
        routes: [], readbacks: [], acks: [], receipts: [],
        delivered: false,   // route observed via read-back
        acked: false,       // owner acked
        receipted: false,   // owner posted a receipt
        duplicates: 0,
        violations: [],
      });
    }
    return records.get(taskId);
  };
  const flag = (r, code, detail) => {
    const v = { task_id: r.task_id, code, detail };
    r.violations.push(v); violations.push(v);
  };

  for (const ev of ordered) {
    if (!ev.task_id) continue;
    const r = rec(ev.task_id);

    if (ROUTE_KINDS.has(ev.kind)) {
      r.routes.push(ev.id);
      // F4: a route is only "delivered" when the poster proves read-back.
      const rb = r.readbacks.find((x) => x.routeId === ev.id);
      if (rb) r.delivered = true;
    } else if (ev.kind === "readback") {
      // READBACK body must name the route message id it confirms.
      const routeId = ev.readback_of || null;
      r.readbacks.push({ id: ev.id, routeId });
      if (routeId && r.routes.includes(routeId)) r.delivered = true;
    } else if (ev.kind === "handoff-ack" || ev.kind === "ack") {
      r.acks.push(ev.id); r.acked = true;
    } else if (RECEIPT_KINDS.has(ev.kind)) {
      r.receipts.push(ev.id); r.receipted = true;
      // F3: dependent action before ACK.
      if (r.routes.length > 0 && r.acks.length === 0) {
        flag(r, "EDIT_BEFORE_ACK",
          `event ${ev.id} by ${ev.author_username} on ${ev.task_id} precedes any HANDOFF_ACK`);
      }
      // F1: duplicate receipt by the same lane.
      const prior = r._receiptKeys || (r._receiptKeys = new Map());
      const k = dedupeKey(ev);
      if (k && prior.has(k)) {
        r.duplicates += 1;
        flag(r, "DUPLICATE_RECEIPT",
          `event ${ev.id} duplicates receipt ${prior.get(k)} for key ${k}`);
      } else if (k) prior.set(k, ev.id);
    }
  }

  // F4 follow-up: routes without any read-back are undelivered by definition.
  for (const r of records.values()) {
    for (const routeId of r.routes) {
      if (!r.readbacks.some((x) => x.routeId === routeId)) {
        flag(r, "ROUTE_WITHOUT_READBACK",
          `route ${routeId} has no READBACK confirming its message id in the log`);
      }
    }
    delete r._receiptKeys;
  }

  return { records, violations };
}

/**
 * Bounded coordinator summary. One rollup, hard line cap, counts only —
 * this is the anti-broadcast-loop rule: a coordinator reports, it does not
 * re-post the underlying events.
 */
export function summarize(correlated, { maxLines = 10 } = {}) {
  const { records, violations } = correlated;
  const lines = [];
  let delivered = 0, acked = 0, receipted = 0;
  for (const r of records.values()) {
    if (r.delivered) delivered++;
    if (r.acked) acked++;
    if (r.receipted) receipted++;
  }
  lines.push(`GUILD-04 messaging rollup: ${records.size} tasks tracked`);
  lines.push(`delivered(read-back confirmed): ${delivered} | acked: ${acked} | receipted: ${receipted}`);
  lines.push(`violations: ${violations.length}`);
  for (const v of violations.slice(0, Math.max(0, maxLines - 4))) {
    lines.push(`- [${v.code}] ${v.task_id}: ${v.detail}`.slice(0, 160));
  }
  if (violations.length > Math.max(0, maxLines - 4)) {
    lines.push(`… and ${violations.length - (maxLines - 4)} more (full list in artifact)`);
  }
  return lines.slice(0, maxLines).join("\n");
}
