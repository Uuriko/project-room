// Summary-first boot contract (RR-D3), reconciled onto RR-D2's scoped
// projection grammar by GC7-C (RR-C2 section 2; PR #5187 is the grammar's
// implementation and this file now speaks it verbatim).
//
// THE GRAMMAR (canonical, #5187 as built): one route, the room
// projection path (/api/rooms/{roomId}/projection), whose fields query
// parameter is a comma-separated selector of class names from the
// closed set: summary, room, members, channels, messages, work, audit,
// pins, bonds. An unknown, duplicated, or missing selector refuses the
// whole read with 422 invalid_snapshot_view; a partial slice is never
// served. The response envelope is projectionVersion 1:
//   { projectionVersion, roomId, sequence, fields, returnedClasses,
//     omittedClasses, summary?, state, charter?, messagesWindow?,
//     messagesPage?, cursor, catchUpCursor, viewerId, viewerAccountId,
//     viewerAuthEpoch, viewerSessionBinding, viewerSessionRevision }
// state carries ONLY the requested classes' snapshot keys (room,
// members, channels, messages, work renamed workItems, audit renamed
// eventLog, pins, bonds); the charter rides with the room class, the
// message window and page ride with the messages class, and the
// summary pseudo-class rides as summary: { room, counts } — the room
// record plus per-class counts (members, channels, messages,
// workItems, pins, eventLog, bonds), no bodies anywhere.
//
// THE BOOT READ asks for the boot class set in the grammar's canonical
// order (BOOT_FIELDS): every class first paint renders from, and NOT
// work — the board's work items are the windowed snapshot's unbounded
// collection. What a boot summary still owes is read off the envelope
// itself: detailOwed is omittedClasses intersected with
// SUMMARY_DETAIL_VIEWS. The work detail loads per view through the
// existing scoped work view of the snapshot read, merged by
// mergeWorkDetail(); the full Record tail already loads per view
// through RoomClient.setAuditView("full").
//
// LANDING ORDER: this client lands BEFORE the projection endpoint
// (the landing queue runs this PR ahead of #5187), so the endpoint is
// probed, never depended on. A 404 or 422 answer is remembered for the
// session and deriveBootSummary() derives the identical grammar
// locally from the ordinary windowed read (marked summaryStaged:
// true) — same version field, same class names, same summary shape,
// same owed-set derivation. When the endpoint lands, the same probe
// succeeds and the switch is automatic: no client change, no grammar
// change. Nothing here changes refresh behaviour after boot: the
// first ordinary snapshot read supersedes the summary and clears the
// owed set.

export const BOOT_PROJECTION_VERSION = 1;

// The boot class set in the grammar's canonical order: the summary
// pseudo-class first, then the state classes in the endpoint's class
// order. "work" is deliberately absent — it is the owed detail, not
// first paint.
export const BOOT_FIELDS = Object.freeze(["summary", "room", "members", "channels", "messages", "audit", "pins", "bonds"]);

// The boot read's suffix on the room path: the projection route
// carrying the boot class set as its fields selector.
export const BOOT_PROJECTION_PATH = `/projection?fields=${BOOT_FIELDS.join(",")}`;

// Views whose detail a boot summary can owe, named by their grammar
// class name. "work" is the only one: the board's work items are the
// windowed snapshot's unbounded collection.
export const SUMMARY_DETAIL_VIEWS = Object.freeze(["work"]);

// Every class in canonical order, mapped to the snapshot.state key
// the class carries (the endpoint's class-key table, mirrored so the
// staged derivation speaks the same grammar as the endpoint).
const CLASS_KEYS = Object.freeze({
  summary: null,
  room: "room", members: "members", channels: "channels", messages: "messages",
  work: "workItems", audit: "eventLog", pins: "pins", bonds: "bonds"
});
const ALL_CLASSES = Object.freeze(Object.keys(CLASS_KEYS));

export function isBootSummary(read) {
  return Boolean(read) && read.projectionVersion === BOOT_PROJECTION_VERSION
    && Boolean(read.state) && typeof read.state === "object"
    && Array.isArray(read.detailOwed);
}

// A served projection envelope (the endpoint's response shape).
export function isProjectionRead(read) {
  return Boolean(read) && read.projectionVersion === BOOT_PROJECTION_VERSION
    && Array.isArray(read.fields) && Array.isArray(read.returnedClasses)
    && Array.isArray(read.omittedClasses)
    && Boolean(read.state) && typeof read.state === "object";
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

// The summary pseudo-class, derived exactly as the endpoint derives
// it: the room record plus per-class counts of the snapshot state.
// No message bodies, no member records, no event payloads.
export function projectionSummaryOf(state) {
  const source = state ?? {};
  return {
    room: source.room ?? null,
    counts: {
      members: countOf(source.members),
      channels: countOf(source.channels),
      messages: countOf(source.messages),
      workItems: countOf(source.workItems),
      pins: countOf(source.pins),
      eventLog: countOf(source.eventLog),
      bonds: countOf(source.bonds)
    }
  };
}

// Adapt a served projection envelope into the boot summary the client
// holds: the envelope verbatim (grammar fields and all), detailOwed
// read off omittedClasses, and the state completed with the one key
// the owed class owns — workItems as the empty map the owed marker
// already announces, until loadViewDetail merges the real detail.
export function bootSummaryFromProjection(read) {
  if (!isProjectionRead(read)) return null;
  return {
    ...read,
    summary: read.summary ?? projectionSummaryOf(read.state),
    detailOwed: (read.omittedClasses ?? []).filter(name => SUMMARY_DETAIL_VIEWS.includes(name)),
    state: { ...read.state, workItems: read.state.workItems ?? {} }
  };
}

// Staged derivation: slim a windowed snapshot (the shape the room
// read with the recent-messages window already serves) into the same
// grammar without another read. The summary counts are taken from the
// full windowed state before slimming (as the endpoint's summary
// class counts the snapshot it cuts); returnedClasses names the boot
// classes the slimmed state actually carries and omittedClasses the
// classes the source state held that were not carried — "work"
// whenever its detail was stripped — both in canonical order. Only
// state.workItems is replaced: it is the one unbounded collection in
// the windowed state; messages are already windowed and byte-capped
// by the server, and the event log is the capped audit tail. The
// input snapshot is not mutated.
export function deriveBootSummary(read) {
  if (!read || typeof read !== "object" || !read.state || typeof read.state !== "object") return read;
  if (isBootSummary(read)) return read;
  const returnedClasses = [], omittedClasses = [];
  for (const name of ALL_CLASSES) {
    const key = CLASS_KEYS[name];
    if (!key || !Object.hasOwn(read.state, key)) continue;
    if (name !== "work" && BOOT_FIELDS.includes(name)) returnedClasses.push(name);
    else omittedClasses.push(name);
  }
  return {
    ...read,
    projectionVersion: BOOT_PROJECTION_VERSION,
    fields: [...BOOT_FIELDS],
    returnedClasses,
    omittedClasses,
    summary: projectionSummaryOf(read.state),
    summaryStaged: true,
    detailOwed: omittedClasses.filter(name => SUMMARY_DETAIL_VIEWS.includes(name)),
    state: { ...read.state, workItems: {} }
  };
}

// Merge one view's scoped detail into a summary snapshot. The "work"
// detail is the scoped work-view payload ({ state: { room, members,
// workItems }, ...viewer fields }): its work items complete the board,
// and its members merge over the summary roster (same read model,
// fresher or equal). Returns a new snapshot; the owed set shrinks.
export function mergeWorkDetail(snapshot, detail) {
  if (!isBootSummary(snapshot) || !detail?.state?.workItems) return snapshot;
  const detailOwed = snapshot.detailOwed.filter(view => view !== "work");
  return {
    ...snapshot,
    detailOwed,
    state: {
      ...snapshot.state,
      members: { ...(snapshot.state.members ?? {}), ...(detail.state.members ?? {}) },
      workItems: detail.state.workItems
    }
  };
}
