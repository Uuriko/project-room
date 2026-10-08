// Replay-safe persisted-row envelope (UFO-steal slice 3, RC-2026-09-27-2730).
//
// Audit (2026-09-27): persisted rows across the room are written with bare
// JSON.stringify and read with bare JSON.parse — no version envelope, no
// writer identity, no defaults layer at the read site:
//   - server/work-claim-sqlite.mjs: work_claims.item_json stored whole; the
//     read site parsed and trusted; defaults live inside workOf() and only
//     run when callers remember to validate first.
//   - server/dispatch-journal.mjs: JSONL entries carry no schema version;
//     apply() throws on unknown states and requires key/state — every field
//     evolution has to be hand-rolled per module.
//   - server/bounty-escrow.mjs: bounty_disputes.body hydrated with a bare
//     JSON.parse at boot; the dispute machine reads fields directly.
// No class names are baked into stored JSON (plain-object culture), so the
// fragility is the inverse of UFO's: nothing identifies the writer's schema,
// and a module move or field evolution breaks readers ad hoc, per module.
//
// UFO analog: ufo-core core/src/ufo/harness/durability.py —
// ReplaySafeSerializer records (module path + field values) and rebuilds via
// model_validate on load (added fields take current defaults, dropped fields
// ignored); MOVED_MODULES maps old module paths to new ones across refactors.
//
// This module is the room's port: version-tagged envelopes (v), a
// move-tolerant kind codec (MOVED_KINDS), and a decode that never throws on
// old rows — unknown fields are dropped, missing fields take current
// defaults. It is a codec + envelope change, not a schema redesign: surfaces
// keep their tables and their state machines, and wrap at the single write
// path / unwrap at the single read path.

export const ROW_FORMAT_V = 1;

// MOVED_KINDS: old row-kind tag -> current kind tag. Append-only: an entry
// lives for as long as rows naming it replay. A module move lands with its
// entry here — the UFO MOVED_MODULES idea, adapted to kind tags, because the
// room persists plain objects rather than (module, class) paths.
export const MOVED_KINDS = Object.freeze({});

// Resolve a recorded kind through the move map. Unknown kinds pass through
// unchanged; callers decide whether an unresolved kind is an error.
export const resolveKind = (kind, moved = MOVED_KINDS) =>
  (kind != null && moved != null && Object.hasOwn(moved, kind)) ? moved[kind] : kind;

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Wrap a row for persistence: { v, kind, data }. The envelope is the only
// new thing on disk; data keeps whatever shape the surface wrote before.
export function encodeRow(kind, data) {
  if (typeof kind !== "string" || kind.length === 0) throw new TypeError("encodeRow: kind is required");
  if (!isPlainObject(data)) throw new TypeError("encodeRow: data must be an object");
  return { v: ROW_FORMAT_V, kind, data: { ...data } };
}

// Decode a persisted row. text may be the stored JSON string or an already
// parsed object (journal apply() paths).
//
// - kind: expected kind tag (after move-map resolution). A mismatch throws —
//   that is misrouted/corrupt data, not an old row.
// - fields + defaults: the surface's known fields and their current
//   defaults. Unknown fields are dropped; missing fields take defaults.
// - moved: override for the move map (tests prove resolution this way).
//
// Legacy rows (no `v` envelope) decode with the whole object as data.
// Corrupt JSON and non-object rows still throw — that is corruption, not
// schema evolution. Old rows never throw here.
export function decodeRow(text, { kind = null, fields = [], defaults = {}, moved = MOVED_KINDS, passthroughUnknown = false } = {}) {
  const raw = typeof text === "string" ? JSON.parse(text) : text;
  if (!isPlainObject(raw)) throw new Error("decodeRow: persisted row is not an object");
  const known = new Set([...fields, ...Object.keys(defaults)]);
  // Envelope detection is on `v` only: legacy dispute bodies carry a `kind`
  // field of their own ("economic"/"coordination"), so `kind` alone cannot
  // mark an envelope.
  const enveloped = typeof raw.v === "number";
  let data;
  if (enveloped) {
    const recorded = resolveKind(raw.kind ?? null, moved);
    if (kind !== null && recorded !== kind)
      throw new Error(`decodeRow: row kind mismatch (expected ${kind}, recorded ${JSON.stringify(raw.kind)})`);
    data = isPlainObject(raw.data) ? raw.data : {};
  } else {
    data = raw; // legacy row: the object itself is the data
  }
  const out = {};
  for (const field of known) out[field] = Object.hasOwn(data, field) ? data[field] : defaults[field];
  // Opt-in: schema drift (production rows carry fields the checkout doesn't
  // know). Unknown fields pass through verbatim instead of being dropped.
  if (passthroughUnknown) {
    for (const key of Object.keys(data)) {
      if (!known.has(key)) out[key] = data[key];
    }
  }
  return out;
}
