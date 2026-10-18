// Server-side room digest + since-wake delta (AUDIT-50X C-06 / register X-01).
//
// One bounded read replaces the whole-log catch-up: an agent that joins, wakes,
// or takes a handoff calls GET /api/rooms/:id/digest?since=<seq> and gets the
// room's current shape plus what changed in the window, composed from the
// projections that already exist — buildRoomContext (structure +
// context_version), the needs-me per-room attention slice (seq-carrying
// mentions/DMs/handoffs/asks), and the updates projection (actionable counts).
// The event journal contributes only window aggregates (per-type counts) and
// the latest rows of each kind; bodies are never reproduced — message text
// rides as the same 140-char clip needs-me already computes, and full bodies
// stay one targeted follow-up away (named in `followUps`).
//
// Honesty contract, pinned by tests/room-digest.test.js:
// - `coverage` is exact and never capped or trimmed: seq range covered,
//   per-type counts for the whole window, and section totals. The counts sum
//   to coverage.eventsInWindow, so a reader can prove there are no gaps or
//   double-counts against the projections it replaces.
// - `bodiesOmitted` is present exactly when message bodies in the window were
//   not reproduced (value = how many), and absent when none were.
// - Sections are capped by caps that already exist in-repo (140-char clip,
//   80-char board title, needs-me per-kind discipline) plus a total per-section
//   cap, and the whole document carries a hard byte budget: if the serialized
//   digest would exceed DIGEST_MAX_BYTES, lowest-priority sections shed rows
//   (messages, then decisions, then attention, then work) and the shed counts
//   are recorded in `truncated`. Coverage is never shed.
// Caps were sized by the C-06 prototype gate at 20,000 events (see
// audit-50x PROTOTYPE record): 3,734 B at the chosen caps vs 5,794 B at a
// naive 8-per-section composition.

export const DIGEST_MAX_BYTES = 4096;
export const DIGEST_CAPS = Object.freeze({
  messages: 3,      // latest message summaries in the window
  work: 4,          // latest changed work items in the window (deduped by claim)
  attention: 5,     // latest needs-me attention items for the caller in the window
  decisions: 2      // latest decision events in the window
});

const clip = (value, limit = 140) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
const title80 = value => String(value ?? "").slice(0, 80);
const byteSize = value => Buffer.byteLength(JSON.stringify(value), "utf8");

// Pure composition. Inputs are the gathered projection slices (the store
// method in store.mjs does auth, the history floor, and the SQL); every
// window input is already restricted to seq > since (and the viewer's floor).
// - byType: { type: count } for the whole window (uncapped, from the journal)
// - workChanged: latest row per changed claim, any order
// - attention: needs-me-shaped items { kind, seq, id, summary }, any order
// - messages: latest-first visible message rows { seq, id, actorId, summary }
// - decisions: decision-event rows { seq, type, actorId }, any order
// - actionable: { total, byKind } standing counts from the updates projection
// - context: the buildRoomContext result (carried as version + counts only;
//   its roster/decisions/fileRefs lists are uncapped and never embedded)
export function buildRoomDigest({
  roomId, viewerId, since, through, now,
  context, byType, workChanged, workChangedTotal,
  attention, messages, decisions, actionable
}) {
  if (typeof roomId !== "string" || typeof viewerId !== "string"
    || !Number.isSafeInteger(since) || since < 0
    || !Number.isSafeInteger(through) || through < since) {
    throw new RangeError("Room digest needs a room, viewer, and a valid seq window");
  }
  const counts = {};
  let eventsInWindow = 0;
  for (const [type, count] of Object.entries(byType ?? {})) {
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    counts[type] = count;
    eventsInWindow += count;
  }
  const messagesTotal = counts["message.posted"] ?? 0;
  const work = [...(workChanged ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .slice(-DIGEST_CAPS.work)
    .map(row => ({
      id: row.id, seq: row.seq,
      ...(row.title ? { title: title80(row.title) } : {}),
      ...(row.action ? { action: row.action } : {}),
      ...(row.state ? { state: row.state } : {})
    }));
  const attentionRows = [...(attention ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .slice(-DIGEST_CAPS.attention)
    .map(item => ({ kind: item.kind, seq: item.seq, id: item.id, summary: clip(item.summary) }));
  const decisionRows = [...(decisions ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .slice(-DIGEST_CAPS.decisions)
    .map(row => ({ seq: row.seq, type: row.type, actorId: row.actorId ?? null }));
  const messageRows = [...(messages ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .slice(-DIGEST_CAPS.messages)
    .map(row => ({ seq: row.seq, id: row.id, actorId: row.actorId ?? null, summary: clip(row.summary) }));
  const encodedRoom = encodeURIComponent(roomId);
  const digest = {
    contractVersion: 1,
    roomId,
    viewerId,
    since,
    through,
    next: through,
    evaluatedAt: new Date(now).toISOString(),
    coverage: {
      fromSeq: since + 1,
      toSeq: through,
      eventsInWindow,
      byType: counts,
      workChangedTotal: workChangedTotal ?? work.length,
      attentionTotal: (attention ?? []).length,
      messagesTotal
    },
    context: {
      context_version: context.context_version,
      rosterCount: context.roster?.length ?? 0,
      focusWorkTotal: context.focusWork?.length ?? 0,
      decisionsTotal: context.decisions?.length ?? 0,
      locksTotal: context.locks?.length ?? 0,
      omitted: [...(context.omitted ?? [])]
    },
    work,
    attention: attentionRows,
    decisions: decisionRows,
    messages: messageRows,
    actionableNow: actionable ?? { total: 0, byKind: {} },
    ...(messagesTotal > 0 ? { bodiesOmitted: messagesTotal } : {}),
    followUps: {
      events: `GET /api/rooms/${encodedRoom}/events?after=${since}&limit=100`,
      work: `GET /api/rooms/${encodedRoom}/work-claims/{id}`,
      context: `GET /api/rooms/${encodedRoom}/context`,
      updates: `GET /api/rooms/${encodedRoom}/updates`
    },
    untrusted: true
  };
  // Hard byte budget. Coverage, context_version, and the follow-up pointers
  // are the honesty core and are never shed; list sections shed latest-last
  // (oldest rows first) in reverse priority order and say how many went.
  const shedOrder = ["messages", "decisions", "attention", "work"];
  const truncated = {};
  for (const key of shedOrder) {
    while (byteSize(digest) > DIGEST_MAX_BYTES && digest[key].length) {
      digest[key].shift();
      truncated[key] = (truncated[key] ?? 0) + 1;
    }
    if (byteSize(digest) <= DIGEST_MAX_BYTES) break;
  }
  if (Object.keys(truncated).length) digest.truncated = truncated;
  return digest;
}
