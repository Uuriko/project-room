import {readCurrentNeedsMePage} from './current-needs-me.mjs';
import {readCurrentHead,withCurrentReadContext} from './current-room-repository.mjs';
import {ServiceError} from './service-error.mjs';
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
// - `coverage.attentionIncomplete` is present exactly when the attention
//   section does not list every attention item the window holds for the
//   viewer — a bounded scan stopped at its budget, a per-kind overflow
//   clamp capped the slice, or the section cap left rows unlisted —
//   with `coverage.attentionThrough` naming the sequence the listing
//   is complete through and `followUps.attention` carrying the
//   continuation read that pages the listing forward from there.
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
  attention: 5,     // earliest needs-me attention items for the caller in the window (the section pages forward via coverage.attentionThrough; it never silently takes the latest)
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
// - attentionCoverage: { through, complete } from the attention slice —
//   the bounded needs-me scans may stop at their budgets before the
//   window's end and the slice's per-kind overflow clamps may cap the
//   listing; the section cap below may leave rows unlisted too. When
//   the composed section is not the whole listing, coverage names the
//   sequence the listing is complete through (attentionThrough) and
//   marks attentionIncomplete, so an attention total of 0 over a
//   partially scanned window never reads as "nothing needs you" and
//   the reader can continue the attention listing with the
//   followUps.attention read instead of advancing past unlisted
//   items. Absent when complete: a fully listed window keeps the
//   exact pre-marker shape.
// - messages: latest-first visible message rows { seq, id, actorId, summary }
// - decisions: decision-event rows { seq, type, actorId }, any order
// - actionable: { total, byKind } standing counts from the updates projection
// - context: the buildRoomContext result (carried as version + counts only;
//   its roster/decisions/fileRefs lists are uncapped and never embedded)
export function buildRoomDigest({
  roomId, viewerId, since, through, now, requestedSince = since,
  context, byType, workChanged, workChangedTotal,
  attention, attentionCoverage, messages, decisions, actionable
}) {
  if (typeof roomId !== "string" || typeof viewerId !== "string"
    || !Number.isSafeInteger(since) || since < 0
    || !Number.isSafeInteger(requestedSince) || requestedSince < 0 || requestedSince > since
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
  // Attention pages chronologically — earliest first, unlike the
  // latest-first state sections — because the listing is cursor
  // machinery: rows past the section cap are reached by continuing
  // from coverage.attentionThrough, never skipped by taking the
  // latest rows and advancing the window cursor past the rest.
  const sortedAttention = [...(attention ?? [])].sort((a, b) => a.seq - b.seq);
  const attentionRows = sortedAttention
    .slice(0, DIGEST_CAPS.attention)
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
  // The attention listing is partial when the slice stopped short
  // (scan budget or per-kind overflow clamp) or when the section cap
  // left rows unlisted; it is complete through the tighter of the
  // slice's evaluated ground and the ground the cap leaves fully
  // listed (the sequence just before the first unlisted row).
  const attentionTotal = sortedAttention.length;
  const sliceIncomplete = Boolean(attentionCoverage && attentionCoverage.complete === false);
  const capDropped = attentionTotal - attentionRows.length;
  const attentionIncomplete = sliceIncomplete || capDropped > 0;
  let attentionThrough;
  if (attentionIncomplete) {
    attentionThrough = sliceIncomplete ? attentionCoverage.through : undefined;
    if (capDropped > 0) {
      // Complete through the sequence just before the first unlisted
      // row: a sequence group is advanced past only when returned in
      // full, so a row sharing the last listed row's sequence is
      // re-listed by the continuation rather than skipped.
      const listedThrough = sortedAttention[attentionRows.length].seq - 1;
      attentionThrough = attentionThrough === undefined ? listedThrough : Math.min(attentionThrough, listedThrough);
    }
    if (!Number.isSafeInteger(attentionThrough) || attentionThrough < since) attentionThrough = since;
  }
  const digest = {
    contractVersion: 1,
    roomId,
    viewerId,
    since,
    requestedSince,
    ...(requestedSince !== since ? { floorApplied: true } : {}),
    through,
    next: through,
    evaluatedAt: new Date(now).toISOString(),
    coverage: {
      fromSeq: since + 1,
      toSeq: through,
      eventsInWindow,
      byType: counts,
      workChangedTotal: workChangedTotal ?? work.length,
      attentionTotal,
      ...(attentionIncomplete
        ? { attentionThrough, attentionIncomplete: true }
        : {}),
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
      updates: `GET /api/rooms/${encodedRoom}/updates`,
      ...(attentionIncomplete
        ? { attention: `GET /api/rooms/${encodedRoom}/digest?since=${attentionThrough}` }
        : {})
    },
    untrusted: true
  };
  // Hard byte budget. Coverage, context_version, and the follow-up pointers
  // are the honesty core and are never shed; list sections shed latest-last
  // (oldest rows first) in reverse priority order and say how many went.
  const shedOrder = ["messages", "decisions", "attention", "work"];
  for (const key of shedOrder) {
    while (byteSize(digest) > DIGEST_MAX_BYTES && digest[key].length) {
      digest[key].shift();
      digest.truncated ??= {};
      digest.truncated[key] = (digest.truncated[key] ?? 0) + 1;
    }
    if (byteSize(digest) <= DIGEST_MAX_BYTES) break;
  }
  if (byteSize(digest) > DIGEST_MAX_BYTES) throw new RangeError("Room digest coverage exceeds the byte budget");
  return digest;
}

// Native v2 covers the existing bounded attention sources, not exact global
// journal aggregates. Opaque continuation is mandatory until this scope is
// complete; ordinary callers cannot confuse an empty filtered page with done.
export function readCurrentRoomDigest(store,token,roomId,viewerId,{since,cursor}) {
 const page=readCurrentNeedsMePage(store,token,roomId,{after:since,expectedMode:'catch_up',...(cursor!==undefined?{cursor}:{})});
 const head=withCurrentReadContext(store.db,roomId,()=>readCurrentHead(store.db,roomId));
 const through=Math.max(since,page.visibleThrough),value={contractVersion:2,roomId,viewerId,since,requestedSince:since,through,next:page.complete?through:since,evaluatedAt:new Date(store.now()).toISOString(),untrusted:true,
  sourceWindow:{complete:page.complete,nextRead:page.cursor?{since,cursor:page.cursor}:null,coverage:page.coverage},
  coverage:{eventsInWindow:null,byType:null,workChangedTotal:null,attentionTotal:null,messagesTotal:null,attentionReturned:page.items.filter(i=>i.kind!=='work').length},
  context:{context_version:head.head_sha256},actionableNow:{total:null,complete:false},
  attention:page.items.filter(i=>i.kind!=='work'),work:page.items.filter(i=>i.kind==='work'),
  followUps:{context:`GET /api/rooms/${encodeURIComponent(roomId)}/context`,events:`GET /api/rooms/${encodeURIComponent(roomId)}/events?after=${since}&limit=4`}};
 if(byteSize(value)>16384)throw new ServiceError(409,'current_room_context_unavailable','Bounded digest and its continuation exceed the v2 response budget; use inbox and selected work reads');
 return value;
}
