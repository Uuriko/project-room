// Stage 0 public offload (per-room architecture design, 2026-10-18):
// the public read model (server/public-read-model.mjs) and the cross-room
// directory move to D1, fed by outbox + alarm, with sequential consistency
// accepted (PERF-10X CALL 3). D1 does not exist yet — its creation is an
// operator act gated on a wrangler-authenticated session — so this module
// builds everything that is provable before wiring day:
//
//   1. A projection publisher that consumes outbox-shaped entries (the
//      design's §3.7 contract: appended in the writer's transaction,
//      delivered at-least-once, consumers idempotent and keyed by the
//      mutation's sequence) and applies them to a target adapter.
//   2. An in-memory target adapter implementing the same row shapes and
//      the same served answers as the in-DO public read model, used by
//      the read-equivalence harness (tests/public-offload.test.js).
//   3. A production target adapter that is a clearly-marked not-yet-wired
//      stub: no D1 binding exists, and every operation fails safe with a
//      named error instead of silently dropping a projection.
//   4. A dual-read compare shape for wiring day: a testable comparator
//      plus a per-surface flip configuration whose default is everything
//      off (the in-DO model stays authoritative).
//
// No production read path changes behaviour here: nothing in the served
// routes calls this module's reads. receipts-live.mjs re-exports the
// compare/flip shape so it sits on the public-read surface it will
// eventually gate.
//
// Sequence discipline: entries carry one comparable sequence (the source
// outbox's monotonic id). The publisher applies last-writer-wins PER
// TARGET ROW (tombstones included), so a replayed entry is a no-op and a
// reordered entry converges to the newest state of each row. Entries for
// disjoint rows commute; two entries for the same row resolve to the
// higher sequence regardless of arrival order. A same-sequence entry
// whose payload differs from what is stored is a conflict: the first
// writer wins and the conflict is counted, never silently merged.

import { DIRECTORY_PAGE_SIZE, PUBLIC_RECEIPT_ID, LOT_RECEIPT_ID } from "./public-read-model.mjs";

export class PublicOffloadNotWiredError extends Error {
  constructor() {
    super("public offload target is not wired: no D1 binding exists yet (Stage 0 wiring day creates the database, binds it, and swaps this stub for the D1 adapter)");
    this.name = "PublicOffloadNotWiredError";
    this.code = "public_offload_not_wired";
  }
}

export class PublicOffloadEntryError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublicOffloadEntryError";
    this.code = "invalid_outbox_entry";
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The public surfaces the design names for offload to the directory
// (design §3.2 "Moves as-is", §3.5 class 2). `lot-receipt-detail` is
// listed so the flip configuration must name it — and refuse it: lot
// receipts have no stored public row to offload (see NAMED_DIVERGENCES).
export const PUBLIC_OFFLOAD_SURFACES = Object.freeze([
  Object.freeze({ id: "receipts-list", offloadable: true }),
  Object.freeze({ id: "receipt-detail", offloadable: true }),
  Object.freeze({ id: "receipts-collect", offloadable: true }),
  Object.freeze({ id: "receipts-sitemap", offloadable: true }),
  Object.freeze({ id: "room-page", offloadable: true }),
  Object.freeze({ id: "rooms-sitemap", offloadable: true }),
  Object.freeze({ id: "room-proof", offloadable: true }),
  Object.freeze({ id: "room-page-receipts", offloadable: true }),
  Object.freeze({ id: "directory-list", offloadable: true }),
  Object.freeze({ id: "lot-receipt-detail", offloadable: false }),
]);

// Surfaces where served-answer equality with the in-DO model cannot be
// held from the offloaded rows alone under sequential consistency. These
// are named, with the divergence, instead of being dropped from the
// equivalence harness: the harness asserts every other field is equal
// and asserts the divergent fields are exactly the ones named here.
export const PUBLIC_OFFLOAD_NAMED_DIVERGENCES = Object.freeze([
  Object.freeze({
    surface: "lot-receipt-detail",
    fields: Object.freeze(["*"]),
    divergence: "Lot receipts are composed at read time from the room-side escrow journal (bounty_journal + bounty_records, publicLotReceiptById in server/public-read-model.mjs); no row exists in public_receipts to publish. Equality requires the stored lot row the design (§3.2) writes at settlement time, which is not part of this slice. The flip configuration refuses to enable this surface.",
  }),
  Object.freeze({
    surface: "public-work-receipt-outcome",
    fields: Object.freeze(["state", "verification", "checksReported", "executedChecks", "review"]),
    divergence: "For source='public-work' receipts, queryPublicReceipts / publicReceiptById / collectPublicReceipts / roomProofRows compose outcome fields at read time from public_work_receipts + public_work_reviews, which are not public-model rows. The offloaded row carries only the stored public_receipts columns, so a candidate answer lacks exactly these composed fields until the outbox entry shape also carries an outcome snapshot. The equivalence harness compares all other fields for equality and asserts the missing fields are exactly this set.",
  }),
]);

// ---------------------------------------------------------------------
// Outbox entry kinds -> target table + row key.
// Rows travel in the stored (database) shape, exactly as the in-DO
// public read model stores them, so a D1 adapter needs no translation.
// ---------------------------------------------------------------------
const ENTRY_KINDS = Object.freeze({
  "public_room.upsert": { table: "public_rooms", key: row => row?.slug },
  "public_room.delete": { table: "public_rooms" },
  "public_receipt.upsert": { table: "public_receipts", key: row => row?.id },
  "public_receipt.delete": { table: "public_receipts" },
  "public_directory_entry.upsert": { table: "public_directory_entries", key: row => row?.agent_id },
  "public_directory_entry.delete": { table: "public_directory_entries" },
  "room_public_receipts_setting.upsert": { table: "room_public_receipts_setting", key: row => row?.room_id },
  "room_public_receipts_setting.delete": { table: "room_public_receipts_setting" },
  "room_directory_receipts_setting.upsert": { table: "room_directory_settings", key: row => row?.room_id },
  "room_directory_receipts_setting.delete": { table: "room_directory_settings" },
  "public_unpublish.upsert": { table: "public_unpublish", key: row => (row ? `${row.kind}\0${row.target}` : null) },
  "public_unpublish.delete": { table: "public_unpublish" },
});

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") throw new PublicOffloadEntryError("outbox entry must be an object");
  if (typeof entry.scope !== "string" || !entry.scope) throw new PublicOffloadEntryError("outbox entry scope must be a non-empty string");
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0) {
    throw new PublicOffloadEntryError("outbox entry sequence must be a non-negative safe integer (the source outbox's monotonic id)");
  }
  const spec = ENTRY_KINDS[entry.kind];
  if (!spec) throw new PublicOffloadEntryError(`unknown outbox entry kind: ${String(entry.kind)}`);
  if (entry.kind.endsWith(".upsert")) {
    const key = spec.key(entry.row);
    if (typeof key !== "string" || !key) throw new PublicOffloadEntryError(`outbox entry ${entry.kind} row is missing its key`);
    return { spec, key };
  }
  if (typeof entry.key !== "string" || !entry.key) throw new PublicOffloadEntryError(`outbox entry ${entry.kind} key must be a non-empty string`);
  return { spec, key: entry.key };
}

const stable = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${stable(value[name])}`).join(",")}}`;
};

// The publisher. `target` is any adapter implementing:
//   rowSeq(table, key) -> number (-1 when the key was never written)
//   putRow(table, key, row, sequence)
//   removeRow(table, key, sequence)   (retains the tombstone sequence)
export function createPublicProjectionPublisher({ target } = {}) {
  if (!target || typeof target.rowSeq !== "function" || typeof target.putRow !== "function" || typeof target.removeRow !== "function") {
    throw new PublicOffloadEntryError("publisher target must implement rowSeq/putRow/removeRow");
  }
  const stats = { applied: 0, replayed: 0, stale: 0, conflicts: 0 };
  function publish(entry) {
    const { spec, key } = validateEntry(entry);
    const current = target.rowSeq(spec.table, key);
    if (entry.sequence < current) { stats.stale += 1; return { applied: false, reason: "stale" }; }
    if (entry.sequence === current) {
      const existing = typeof target.getRow === "function" ? target.getRow(spec.table, key) : undefined;
      if (entry.kind.endsWith(".delete")) { stats.replayed += 1; return { applied: false, reason: "replay" }; }
      if (existing !== undefined && stable(existing) === stable(entry.row)) { stats.replayed += 1; return { applied: false, reason: "replay" }; }
      if (existing !== undefined) { stats.conflicts += 1; return { applied: false, reason: "conflict" }; }
      stats.replayed += 1; return { applied: false, reason: "replay" };
    }
    if (entry.kind.endsWith(".upsert")) target.putRow(spec.table, key, entry.row, entry.sequence);
    else target.removeRow(spec.table, key, entry.sequence);
    stats.applied += 1;
    return { applied: true, reason: "applied" };
  }
  return {
    publish,
    publishAll(entries) {
      const results = [];
      for (const entry of entries) results.push(publish(entry));
      return results;
    },
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------
// Production target: not yet wired. There is no D1 binding to write to;
// failing loud and safe beats a silent no-op that would let public
// surfaces go stale invisibly on wiring day.
// ---------------------------------------------------------------------
export function createD1PublicModelTargetStub() {
  const fail = () => { throw new PublicOffloadNotWiredError(); };
  return { rowSeq: fail, getRow: fail, putRow: fail, removeRow: fail };
}

// ---------------------------------------------------------------------
// In-memory target adapter (tests + Node self-host shape proof, design
// §3.8: the directory is an interface with two implementations). Served
// reads below replicate server/public-read-model.mjs semantics over the
// stored rows — same order, same keyset pagination, same visibility
// predicates (operator unpublish; the owner public-receipts toggle via
// the receipt's room / origin room) — except the two named divergences.
// ---------------------------------------------------------------------
const parseJson = (text, fallback) => {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch { return fallback; }
};

export function createInMemoryPublicModelTarget() {
  const tables = new Map(); // table -> Map(key -> { row, sequence })
  const table = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const liveRows = name => [...table(name).values()].map(entry => entry.row).filter(row => row !== null);

  const target = {
    rowSeq(name, key) {
      return table(name).get(key)?.sequence ?? -1;
    },
    getRow(name, key) {
      const entry = table(name).get(key);
      return entry && entry.row !== null ? entry.row : undefined;
    },
    putRow(name, key, row, sequence) {
      table(name).set(key, { row: { ...row }, sequence });
    },
    removeRow(name, key, sequence) {
      table(name).set(key, { row: null, sequence });
    },

    // --- served reads (candidate answers for the dual-read compare) ---
    _isUnpublished(kind, targetId) {
      return liveRows("public_unpublish").some(row => row.kind === kind && row.target === targetId);
    },
    _hiddenReceipt(row) {
      return target._isUnpublished("receipt", row.id)
        || (row.room_id && target._isUnpublished("room", row.room_id))
        || (row.origin_room_id && target._isUnpublished("room", row.origin_room_id));
    },
    _ownerHiddenReceipt(row) {
      return liveRows("room_directory_settings").some(setting => setting.public_receipts === 0
        && (setting.room_id === row.origin_room_id || setting.room_id === row.room_id));
    },
    _rowToPublic(row) {
      return {
        schema: "project-room-public-receipt/1",
        id: row.id,
        title: row.title,
        source: row.source,
        room: row.room_id ? { id: row.room_id, title: row.room_title ?? null } : null,
        agents: parseJson(row.agents_json, []),
        humans: parseJson(row.humans_json, []),
        pullRequest: row.pull_request,
        mergedAt: row.merged_at,
        ...(row.verification_state ? { verification: { state: row.verification_state } } : {}),
        hashes: parseJson(row.hashes_json, []),
        at: row.at,
        startHref: row.start_href,
      };
    },
    _sortedReceipts(rows) {
      return [...rows].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : (a.at > b.at ? -1 : 1)));
    },

    queryPublicReceipts({ room = null, agent = null, cursor = null, limit = 20 } = {}) {
      if (room != null && (typeof room !== "string" || !room || room.length > 128)) {
        return { error: { status: 422, code: "invalid_receipt_query", message: "room filter must be a room id" } };
      }
      if (agent != null && (typeof agent !== "string" || !agent.trim() || agent.length > 80)) {
        return { error: { status: 422, code: "invalid_receipt_query", message: "agent filter must be a name" } };
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        return { error: { status: 422, code: "invalid_receipt_query", message: "limit must be an integer from 1 to 50" } };
      }
      const needle = agent ? agent.trim().toLowerCase() : null;
      const visible = row => !target._hiddenReceipt(row) && !target._ownerHiddenReceipt(row);
      const matches = row => visible(row)
        && (room == null || row.room_id === room)
        && (needle == null || String(row.agents_json).toLowerCase().includes(needle));
      let rows = target._sortedReceipts(liveRows("public_receipts").filter(matches));
      if (cursor != null) {
        if (typeof cursor !== "string" || !cursor) {
          return { error: { status: 422, code: "invalid_receipt_query", message: "cursor is not a receipt from this list" } };
        }
        const current = liveRows("public_receipts").find(row => row.id === cursor && matches(row));
        if (!current) return { error: { status: 422, code: "invalid_receipt_query", message: "cursor is not a receipt from this list" } };
        rows = rows.filter(row => row.at < current.at || (row.at === current.at && row.id > current.id));
      }
      const page = rows.slice(0, limit).map(row => target._rowToPublic(row));
      return { receipts: page, nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null };
    },

    publicReceiptById(id) {
      if (typeof id !== "string" || !PUBLIC_RECEIPT_ID.test(id)) return null;
      // Named divergence: lot receipts are composed at read from the
      // escrow journal in the in-DO model; there is no stored row here.
      if (LOT_RECEIPT_ID.test(id)) return null;
      const row = liveRows("public_receipts").find(candidate => candidate.id === id);
      if (!row || target._hiddenReceipt(row)) return null;
      return target._rowToPublic(row);
    },

    collectPublicReceipts() {
      return target._sortedReceipts(liveRows("public_receipts").filter(row => !target._hiddenReceipt(row)))
        .map(row => target._rowToPublic(row));
    },

    listPublicReceiptSitemap(limit = 1000) {
      const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 1000;
      return target._sortedReceipts(liveRows("public_receipts").filter(row => !target._hiddenReceipt(row)))
        .slice(0, cap)
        .map(row => ({ path: `/receipts/${row.id}`, lastmod: typeof row.at === "string" ? row.at.slice(0, 10) : null }));
    },

    loadPublicRoom(slug) {
      if (!SLUG.test(slug ?? "") || target._isUnpublished("room", slug)) return null;
      const row = liveRows("public_rooms").find(candidate => candidate.slug === slug);
      if (!row) return null;
      return {
        slug: row.slug,
        title: row.title,
        purpose: row.purpose,
        counts: { humans: row.humans, agents: row.agents },
        names: parseJson(row.names_json, []),
        tasks: parseJson(row.tasks_json, []),
        receiptsEnabled: row.receipts_enabled === 1,
        joinMode: row.join_mode === "link" && row.join_token ? "link" : "request",
        joinToken: row.join_mode === "link" ? row.join_token : null,
        setAt: row.set_at,
      };
    },

    listPublicRoomSitemap() {
      return liveRows("public_rooms")
        .filter(row => !target._isUnpublished("room", row.slug))
        .sort((a, b) => (a.slug < b.slug ? -1 : 1))
        .map(row => ({ slug: row.slug, setAt: row.set_at, receiptsEnabled: row.receipts_enabled === 1 }));
    },

    roomProofRows(slug) {
      return target._sortedReceipts(liveRows("public_receipts").filter(row => !target._hiddenReceipt(row)
        && (row.room_id === slug || (row.origin_room_id === slug && (row.source === "work-claim" || row.source === "work-item")))))
        .map(row => target._rowToPublic(row));
    },

    roomPageReceipts(slug, receiptsEnabled, { limit = 5, after = null } = {}) {
      const cap = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 5;
      let rows = target._sortedReceipts(liveRows("public_receipts").filter(row => !target._hiddenReceipt(row)
        && (row.room_id === slug || (receiptsEnabled && row.origin_room_id === slug && (row.source === "work-claim" || row.source === "work-item")))));
      if (after && typeof after.at === "string" && typeof after.id === "string") {
        rows = rows.filter(row => row.at < after.at || (row.at === after.at && row.id > after.id));
      }
      return rows.slice(0, cap).map(row => ({ id: row.id, title: row.title, at: row.at }));
    },

    queryDirectoryEntries({ cursor = null, limit = DIRECTORY_PAGE_SIZE } = {}) {
      const cap = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : DIRECTORY_PAGE_SIZE;
      const sorted = liveRows("public_directory_entries")
        .sort((a, b) => (a.name === b.name ? (a.agent_id < b.agent_id ? -1 : 1) : (a.name < b.name ? -1 : 1)));
      let rows = sorted;
      if (cursor != null) {
        if (typeof cursor !== "string" || !cursor) {
          return { error: { status: 422, code: "invalid_cursor", message: "cursor is not an agent on this list" } };
        }
        const current = sorted.find(row => row.agent_id === cursor);
        if (!current) return { error: { status: 422, code: "invalid_cursor", message: "cursor is not an agent on this list" } };
        rows = sorted.filter(row => row.name > current.name || (row.name === current.name && row.agent_id > current.agent_id));
      }
      const page = rows.slice(0, cap).map(row => ({
        agentId: row.agent_id,
        name: row.name,
        description: row.description,
        skills: parseJson(row.skills_json, []),
        receiptCount: row.receipt_count,
        roomCount: row.room_count,
      }));
      return { agents: page, nextCursor: rows.length > cap ? page.at(-1)?.agentId ?? null : null };
    },
  };
  return target;
}

// ---------------------------------------------------------------------
// Dual-read compare shape for wiring day. Default: every surface off,
// the in-DO model authoritative. A flipped surface serves the candidate
// only when the compare is equal; any divergence serves the in-DO
// answer and reports the divergence — the flip can never serve a
// candidate answer that was just shown to differ.
// ---------------------------------------------------------------------
export const PUBLIC_OFFLOAD_FLIP_DEFAULTS = Object.freeze(Object.fromEntries(
  PUBLIC_OFFLOAD_SURFACES.map(surface => [surface.id, false]),
));

export function resolvePublicOffloadConfig(overrides = {}) {
  const config = { ...PUBLIC_OFFLOAD_FLIP_DEFAULTS };
  for (const [surface, enabled] of Object.entries(overrides ?? {})) {
    const known = PUBLIC_OFFLOAD_SURFACES.find(candidate => candidate.id === surface);
    if (!known) throw new PublicOffloadEntryError(`unknown public offload surface: ${surface}`);
    if (enabled && !known.offloadable) {
      throw new PublicOffloadEntryError(`public offload surface ${surface} is not offloadable (see PUBLIC_OFFLOAD_NAMED_DIVERGENCES)`);
    }
    config[surface] = enabled === true;
  }
  return Object.freeze(config);
}

export function readSourceFor(surface, config = PUBLIC_OFFLOAD_FLIP_DEFAULTS) {
  return config?.[surface] === true ? "directory" : "in-do";
}

function diffPaths(a, b, path = "", out = []) {
  if (out.length >= 10) return out;
  if (Object.is(a, b)) return out;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) { out.push(path || "$"); return out; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(path || "$"); return out; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    diffPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
    if (out.length >= 10) return out;
  }
  return out;
}

export function comparePublicAnswers(surface, authoritative, candidate) {
  const differences = diffPaths(authoritative, candidate);
  return { surface, equal: differences.length === 0, differences };
}

export function createDualReadComparator({ config = PUBLIC_OFFLOAD_FLIP_DEFAULTS, onDivergence = null } = {}) {
  return {
    // Both readers are thunks so the candidate is only consulted when a
    // caller actually performs a dual read. Returns the answer to serve:
    // the candidate only when this surface is flipped AND the compare
    // is equal; otherwise the authoritative (in-DO) answer.
    read(surface, authoritative, candidate) {
      if (!PUBLIC_OFFLOAD_SURFACES.some(entry => entry.id === surface)) {
        throw new PublicOffloadEntryError(`unknown public offload surface: ${surface}`);
      }
      const authoritativeAnswer = authoritative();
      const candidateAnswer = candidate();
      const comparison = comparePublicAnswers(surface, authoritativeAnswer, candidateAnswer);
      if (!comparison.equal && typeof onDivergence === "function") onDivergence(comparison);
      const serveCandidate = readSourceFor(surface, config) === "directory" && comparison.equal;
      return {
        value: serveCandidate ? candidateAnswer : authoritativeAnswer,
        servedFrom: serveCandidate ? "directory" : "in-do",
        comparison,
      };
    },
  };
}
