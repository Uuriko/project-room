// Claim bonds P0 SHADOW mode.
//
// What this is: a pure observer that replays `work_claim.updated` room events
// and writes the bond journal entries that WOULD have existed under the
// slashable-claim-bonds spec
// (~/workspace/research_notes/claim-bonds-spec-2026-10-04.md, §2, §8 P0).
// Zero economic value is at stake: no balances change, no claim behavior
// changes, no new events enter the room stream. The point of P0 is
// measurement — the decision gate is "do flakes concentrate in repeat
// offenders?" and this module is the instrument that answers it.
//
// The concentration query (the P0 success signal):
//   SELECT owner_id, COUNT(*) AS flakes
//   FROM claim_bond_shadow
//   WHERE kind = 'flake-recorded'
//   GROUP BY owner_id
//   ORDER BY flakes DESC;
// If the top few owners account for most flakes -> flakes concentrate ->
// build P1 (reputation-cost bonds). If flakes are evenly spread, bonds
// solve the wrong problem -> stop here.
//
// Wiring: this module is NOT called from any request path. Run it on demand
// with `npm run analytics:bond-shadow -- --db <room.sqlite> --sync` (or read
// the report without --sync). Live wiring into the analytics tail is a
// documented follow-up for the analytics lane — deliberately not done here
// so this change stays additive and touches no lane-owned code.
//
// ADDITIVE ONLY: this module never imports or calls server/work-claims.mjs
// or server/work-claim-routes.mjs (owned by the #1303 author). It reads the
// durable `events` table and writes only its own `claim_bond_shadow` table,
// which lives outside the writer fence like the other analytics tables
// (see server/analytics/schema.mjs).

export const SHADOW_BOND_MILLIS = 1000; // nominal; mirrors the live anti-flake CLAIM_BOND_MILLIS. P0 moves nothing.

export const SHADOW_KINDS = Object.freeze([
  "bond-locked", // a shadow bond would have been posted at claim time
  "bond-released", // the posted bond would have been returned (done | clean release)
  "bond-forfeited", // the posted bond would have gone to the pool (lease expiry | judged bad)
  "bond-carried", // the open bond would have moved to the new owner on reassign
  "flake-recorded" // a flake strike would have been recorded (lease expiry | judged bad)
]);

export const SHADOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS claim_bond_shadow (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_id TEXT,
  amount_millis INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  bond_posted INTEGER NOT NULL DEFAULT 0,
  at INT NOT NULL,
  room_id TEXT,
  room_seq INT NOT NULL,
  shadow INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS claim_bond_shadow_claim ON claim_bond_shadow(claim_id);
CREATE INDEX IF NOT EXISTS claim_bond_shadow_kind ON claim_bond_shadow(kind);
CREATE INDEX IF NOT EXISTS claim_bond_shadow_owner ON claim_bond_shadow(owner_id);
`;

export function ensureShadowSchema(db) {
  db.exec(SHADOW_SCHEMA);
}

const entryId = (claimId, kind, roomSeq) => `shadow:${claimId}:${kind}:${roomSeq}`;

function draft(claimId, kind, row, { ownerId = null, reason = null, bondPosted = 0, amountMillis = 0 } = {}) {
  return {
    id: entryId(claimId, kind, row.seq),
    claimId,
    kind,
    ownerId,
    amountMillis,
    reason,
    bondPosted,
    at: row.atMs,
    roomId: row.roomId,
    roomSeq: row.seq
  };
}

// Pure derivation: ordered work_claim.updated rows -> shadow journal entries.
// A row is { roomId, seq, atMs, data } where data is the event's data object
// (workClaim, action, claimState, ownerId, previousOwnerId, verdict, ...).
// Entries are only ever emitted against a claim's observed lifecycle; a
// release/forfeit is never written without an open shadow bond, so the
// journal can never claim value moved that was never posted.
export function deriveShadowEntries(rows) {
  const entries = [];
  const open = new Map(); // claimId -> { ownerId, lockedAt, lockedSeq }

  for (const row of rows) {
    const data = row?.data;
    if (!data || typeof data !== "object") continue;
    const claimId = typeof data.workClaim === "string" ? data.workClaim : null;
    const action = typeof data.action === "string" ? data.action : null;
    if (!claimId || !action) continue;
    const bond = open.get(claimId) ?? null;

    switch (action) {
      case "claimed": {
        if (!bond && typeof data.ownerId === "string") {
          open.set(claimId, { ownerId: data.ownerId, lockedAt: row.atMs, lockedSeq: row.seq });
          entries.push(draft(claimId, "bond-locked", row, {
            ownerId: data.ownerId, amountMillis: SHADOW_BOND_MILLIS, reason: "claimed"
          }));
        }
        break;
      }
      case "state_changed": {
        const state = data.claimState;
        if (state === "done") {
          if (bond) {
            entries.push(draft(claimId, "bond-released", row, { ownerId: bond.ownerId, reason: "done" }));
            open.delete(claimId);
          }
        } else if ((state === "claimed" || state === "in_progress") && !bond && typeof data.ownerId === "string") {
          // The observer started mid-history (or the claimed action was
          // coalesced away): an owned, unfinished claim is treated as
          // bond-open from first sight, marked so the journal says so.
          open.set(claimId, { ownerId: data.ownerId, lockedAt: row.atMs, lockedSeq: row.seq });
          entries.push(draft(claimId, "bond-locked", row, {
            ownerId: data.ownerId, amountMillis: SHADOW_BOND_MILLIS, reason: "observed_open"
          }));
        }
        // blocked / unclaimed: the bond stays locked; nothing to write.
        break;
      }
      case "released": {
        if (bond) {
          entries.push(draft(claimId, "bond-released", row, { ownerId: bond.ownerId, reason: "owner_released" }));
          open.delete(claimId);
        }
        break;
      }
      case "reassigned": {
        const next = typeof data.ownerId === "string" ? data.ownerId : null;
        if (bond && next && next !== bond.ownerId) {
          entries.push(draft(claimId, "bond-carried", row, { ownerId: next, reason: "carried" }));
          open.set(claimId, { ...bond, ownerId: next });
        } else if (!bond && next) {
          open.set(claimId, { ownerId: next, lockedAt: row.atMs, lockedSeq: row.seq });
          entries.push(draft(claimId, "bond-locked", row, {
            ownerId: next, amountMillis: SHADOW_BOND_MILLIS, reason: "observed_open"
          }));
        }
        break;
      }
      case "lease_expired": {
        // ownerId is cleared to null on auto-release; previousOwnerId names
        // the lane that flaked (work-claim-routes.mjs passes before.owner).
        const flakeOwner = typeof data.previousOwnerId === "string"
          ? data.previousOwnerId
          : bond?.ownerId ?? (typeof data.ownerId === "string" ? data.ownerId : null);
        entries.push(draft(claimId, "flake-recorded", row, {
          ownerId: flakeOwner, reason: "lease_expired", bondPosted: bond ? 1 : 0
        }));
        if (bond) {
          entries.push(draft(claimId, "bond-forfeited", row, { ownerId: bond.ownerId, reason: "lease_expired" }));
          open.delete(claimId);
        }
        break;
      }
      case "reviewed": {
        if (data.verdict === "changes_requested") {
          const flakeOwner = typeof data.ownerId === "string" ? data.ownerId : bond?.ownerId ?? null;
          entries.push(draft(claimId, "flake-recorded", row, {
            ownerId: flakeOwner, reason: "judged_bad", bondPosted: bond ? 1 : 0
          }));
          if (bond) {
            entries.push(draft(claimId, "bond-forfeited", row, { ownerId: bond.ownerId, reason: "judged_bad" }));
            open.delete(claimId);
          }
        }
        // Any other verdict leaves the bond locked; a note is not a verdict.
        break;
      }
      // created, renewed, pr_merged, pr_closed, ci_changed: no bond movement.
      default:
        break;
    }
  }
  return entries;
}

const INSERT_ENTRY = `INSERT OR IGNORE INTO claim_bond_shadow
  (id, claim_id, kind, owner_id, amount_millis, reason, bond_posted, at, room_id, room_seq, shadow)
  VALUES (?,?,?,?,?,?,?,?,?,?,1)`;

function parseEventRow(row) {
  try {
    const body = JSON.parse(row.body);
    if (!body || typeof body !== "object" || !body.data || typeof body.data !== "object") return null;
    const atMs = Date.parse(body.at);
    if (!Number.isFinite(atMs)) return null;
    return { roomId: row.room_id, seq: row.sequence, atMs, data: body.data };
  } catch {
    return null;
  }
}

// Read work_claim.updated events from the durable events table and fold them
// into the shadow journal. Idempotent: re-running changes nothing.
export function syncShadowJournal(db, { roomId = null } = {}) {
  ensureShadowSchema(db);
  const rows = db.prepare(
    `SELECT room_id, sequence, body FROM events
     WHERE json_extract(body,'$.type')='work_claim.updated'
     ${roomId ? "AND room_id=?" : ""}
     ORDER BY sequence`
  ).all(...(roomId ? [roomId] : []));
  const parsed = [];
  for (const row of rows) {
    const event = parseEventRow(row);
    if (event) parsed.push(event);
  }
  const entries = deriveShadowEntries(parsed);
  const insert = db.prepare(INSERT_ENTRY);
  let written = 0;
  const write = db.transaction
    ? db.transaction(list => { for (const e of list) written += insert.run(e.id, e.claimId, e.kind, e.ownerId, e.amountMillis, e.reason, e.bondPosted, e.at, e.roomId, e.roomSeq).changes; })
    : (list => { for (const e of list) written += insert.run(e.id, e.claimId, e.kind, e.ownerId, e.amountMillis, e.reason, e.bondPosted, e.at, e.roomId, e.roomSeq).changes; });
  write(entries);
  return { eventsRead: parsed.length, entriesDerived: entries.length, entriesWritten: written };
}

const CONCENTRATION_MIN_FLAKES = 10;
const CONCENTRATION_SHARE = 0.5;

// Read-only baseline report. The verdict answers the P0 decision gate:
// "concentrated" -> flakes live with repeat offenders -> build P1;
// "dispersed" -> flakes are ambient -> bonds solve the wrong problem, stop;
// "insufficient_data" -> fewer than CONCENTRATION_MIN_FLAKES flakes observed.
export function shadowReport(db, { roomId = null } = {}) {
  const roomFilter = roomId ? "AND room_id=?" : "";
  const args = roomId ? [roomId] : [];
  const count = kind => db.prepare(
    `SELECT COUNT(*) AS c FROM claim_bond_shadow WHERE kind=? ${roomFilter}`
  ).get(kind, ...args).c;
  const locked = count("bond-locked");
  const released = count("bond-released");
  const forfeited = count("bond-forfeited");
  const flakes = db.prepare(
    `SELECT COUNT(*) AS c FROM claim_bond_shadow WHERE kind='flake-recorded' ${roomFilter}`
  ).get(...args).c;
  const topFlakers = db.prepare(
    `SELECT owner_id AS ownerId, COUNT(*) AS flakes
     FROM claim_bond_shadow
     WHERE kind='flake-recorded' ${roomFilter}
     GROUP BY owner_id
     ORDER BY flakes DESC
     LIMIT 10`
  ).all(...args);
  const top3 = topFlakers.slice(0, 3).reduce((sum, row) => sum + row.flakes, 0);
  const top3Share = flakes > 0 ? top3 / flakes : 0;
  const verdict = flakes < CONCENTRATION_MIN_FLAKES
    ? "insufficient_data"
    : top3Share >= CONCENTRATION_SHARE ? "concentrated" : "dispersed";
  const openBonds = db.prepare(
    `SELECT COUNT(*) AS c FROM (
       SELECT claim_id FROM claim_bond_shadow WHERE kind='bond-locked' ${roomFilter}
       EXCEPT
       SELECT claim_id FROM claim_bond_shadow
       WHERE kind IN ('bond-released','bond-forfeited') ${roomFilter}
     )`
  ).get(...args).c;
  return {
    locked,
    released,
    forfeited,
    flakes,
    openBonds,
    flakeRate: locked > 0 ? forfeited / locked : null,
    topFlakers,
    top3Share,
    verdict,
    verdictRule: `flakes>=${CONCENTRATION_MIN_FLAKES} and top-3 owner share>=${CONCENTRATION_SHARE} -> concentrated`
  };
}
