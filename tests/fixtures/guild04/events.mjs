// Fixtures for tests/guild04-messaging-repairs.test.mjs
// Shape mirrors GitHub issue-comment rows (id, created_at, author login, body)
// plus optional parent_id / thread_inbound_id / jwt_sub / probe_* fields.
// `seq` is assigned from array order by scripts/handoff-lint.mjs.

export const GOOD_ROUTE = [
  {
    id: "c1", created_at: "2026-10-09T12:00:00Z", author_username: "Uuriko",
    body: "[jill][route] ROUTE TASK-100 to @instinct — verify the D4 board pin. Claim it before starting.",
  },
  {
    id: "c2", created_at: "2026-10-09T12:01:00Z", author_username: "Uuriko",
    body: "[jill][readback] TASK-100 READBACK: route c1 observed in the event log (message id c1).",
    readback_of: "c1",
  },
  {
    id: "c3", created_at: "2026-10-09T12:02:00Z", author_username: "Uuriko",
    body: "[instinct][handoff-ack] ACK TASK-100 — claim filed, starting work. Ack before any edit.",
  },
  {
    id: "c4", created_at: "2026-10-09T12:30:00Z", author_username: "Uuriko",
    body: "[instinct][receipt] TASK-100 D4 board pin verified, PR #2299 merged green at a1b2c3d.",
  },
];

// New owner acts BEFORE acking — the ack-before-edit violation.
export const BAD_EDIT_BEFORE_ACK = [
  {
    id: "e1", created_at: "2026-10-09T12:00:00Z", author_username: "Uuriko",
    body: "[jill][handoff-offer] HANDOFF TASK-200 to @fo — RC-004 patch is yours if you want it.",
  },
  {
    id: "e2", created_at: "2026-10-09T12:05:00Z", author_username: "Uuriko",
    body: "[fo][status] TASK-200 STATUS: pushed the RC-004 fix branch.",
  },
];

// Two receipts, same task + lane — the 2026-09-16 Q001 double-receipt shape.
export const BAD_DUPLICATE_RECEIPT = [
  {
    id: "d1", created_at: "2026-09-16T15:43:00Z", author_username: "Uuriko",
    body: "[quill-s2][receipt] TASK-300 flaky-test quarantine — done. PR #317 merged at 4477ab5.",
  },
  {
    id: "d2", created_at: "2026-09-16T15:50:00Z", author_username: "Uuriko",
    body: "[quill-s2][receipt] TASK-300 flaky-test quarantine merged green: PR #317 -> 4477ab5 (all checks pass).",
  },
];

// Route with no READBACK — submission treated as delivery (F4).
export const BAD_ROUTE_NO_READBACK = [
  {
    id: "r1", created_at: "2026-10-09T12:00:00Z", author_username: "Uuriko",
    body: "[jill][route] ROUTE TASK-400 to @codex — drain the PR queue. Assume it landed.",
  },
  {
    id: "r2", created_at: "2026-10-09T12:30:00Z", author_username: "Uuriko",
    body: "[codex][receipt] TASK-400 queue drained.",
  },
];

// Thread parent points at the grandparent, not the inbound being answered
// (2026-10-05 Colony: replies landed as siblings of the inbound).
// thread_inbound_id is the inbound's real id; parent_id is the wrong one.
export const BAD_THREAD_PARENT = [
  {
    id: "t1", created_at: "2026-10-09T12:00:00Z", author_username: "Uuriko",
    body: "[jill][route] ROUTE TASK-500 to @tab — check the REL-25 regression.",
  },
  {
    id: "t2", created_at: "2026-10-09T12:01:00Z", author_username: "Uuriko",
    body: "[tab][receipt] TASK-500 REL-25 regression green (23/23).",
    parent_id: "t0-grandparent",
    thread_inbound_id: "t1",
  },
];

// Author-id trap (2026-10-07 Colony): venue comment author.id is
// ed2f5ebc-c06c-4bb5-973c-3035d144fe51 while the JWT sub is
// ed2f5ebc-c0c6-4bb5-973c-03d5d14fe51 (transposed). Only username matching is
// reliable. probe_sub carries the venue author.id form — the naive filter.
export const OWNER_PROBE = [
  {
    id: "p1", created_at: "2026-10-09T12:00:00Z", author_username: "jill",
    body: "[jill][receipt] TASK-600 sweep handled — 6 inbounds answered.",
    jwt_sub: "ed2f5ebc-c0c6-4bb5-973c-03d5d14fe51",
    probe_owner: "jill",
    probe_sub: "ed2f5ebc-c06c-4bb5-973c-3035d144fe51",
  },
];

// Plain chatter: no lane grammar — must parse to null, never a handoff.
export const PLAIN_CHATTER = [
  {
    id: "g1", created_at: "2026-10-09T12:00:00Z", author_username: "Uuriko",
    body: "[instinct] @jill - ack, and no fault taken on the claim overlap.",
  },
  {
    id: "g2", created_at: "2026-10-09T12:00:00Z", author_username: "Uuriko",
    body: "GM GM — the room is looking good today :)",
  },
];
