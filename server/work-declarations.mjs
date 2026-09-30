// Step 2 of the matchmaking plan (docs/MATCHMAKING.md): the declarations that
// the filter in server/work-matchmaking.mjs reads.
//
// One side of the market is an agent saying what it can do, how long it will
// work, and why it is here. The other is a piece of work saying what it needs,
// how big it is, and who it will let near it. Everything here is NULLABLE on
// purpose: work that declares nothing keeps working exactly as it does today,
// claimable by id, and simply never appears in matchmaking.
//
// store.mjs imports this module, so this module imports nothing from store.mjs.
// Pure otherwise: injected clock, caller-owned rows, frozen outputs, domain
// errors with no HTTP status.

import { MOTIVES, MIN_TIER, MAX_TIER, declareSeeker, describeOpening } from "./work-matchmaking.mjs";

class DeclarationError extends Error {
  constructor(code, message) { super(message); this.name = "DeclarationError"; this.code = code; }
}
const fail = (code, message) => { throw new DeclarationError(code, message); };
const check = (condition, message, code = "invalid_input") => { if (!condition) fail(code, message); };

export const workDeclarationSchema = `
  CREATE TABLE IF NOT EXISTS seeker_declarations (
    identity_id TEXT PRIMARY KEY,
    motives TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    appetite_minutes INTEGER NOT NULL,
    trust_tier INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_offer_terms (
    work_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    reward_kind TEXT NOT NULL,
    reward_amount INTEGER NOT NULL DEFAULT 0,
    requires TEXT NOT NULL DEFAULT '[]',
    size_minutes INTEGER,
    trust_floor INTEGER,
    deadline TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS work_offer_terms_room ON work_offer_terms(room_id, reward_kind);
`;

const asList = value => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

// An identity's declaration, read back as the seeker the filter takes.
export function rowToSeeker(row) {
  if (!row) return null;
  return declareSeeker({
    seekerId: row.identity_id,
    motives: asList(row.motives),
    capabilities: asList(row.capabilities),
    appetiteMinutes: row.appetite_minutes,
    trustTier: row.trust_tier ?? MIN_TIER,
  });
}

export function seekerToRow(seeker, { now }) {
  check(typeof now === "function", "now must be a clock function");
  const at = now();
  check(Number.isFinite(at), "now() must return a finite epoch in milliseconds");
  return Object.freeze({
    identity_id: seeker.seekerId,
    motives: JSON.stringify(seeker.motives),
    capabilities: JSON.stringify(seeker.capabilities),
    appetite_minutes: seeker.appetiteMinutes,
    trust_tier: seeker.trustTier,
    created_at: at,
    updated_at: at,
  });
}

// Terms on a piece of work. A row missing size or trust floor has not declared
// itself, so it is deliberately NOT matchable: absent means claimable by id,
// never open to a stranger by default. That was the cautious call in the doc
// and it is enforced here rather than left to the caller.
export const isMatchable = row =>
  Boolean(row)
  && MOTIVES.includes(row.reward_kind)
  && Number.isInteger(row.size_minutes) && row.size_minutes > 0
  && Number.isInteger(row.trust_floor) && row.trust_floor >= MIN_TIER && row.trust_floor <= MAX_TIER;

export function rowToOpening(row, { title, open = true } = {}) {
  check(isMatchable(row), "this work has not declared terms, so it is not matchable", "not_matchable");
  return describeOpening({
    openingId: row.work_id,
    roomId: row.room_id,
    title: title ?? row.work_id,
    rewardKind: row.reward_kind,
    rewardAmount: row.reward_amount ?? 0,
    requires: asList(row.requires),
    sizeMinutes: row.size_minutes,
    trustFloor: row.trust_floor,
    open,
    deadline: row.deadline ?? null,
  });
}

// Whole-board conversion. Undeclared work is skipped silently rather than
// throwing, because one unlabelled row must never break matchmaking for
// everyone else on the board.
export function openingsFromRows(rows, { titles = {}, closed = [] } = {}) {
  check(Array.isArray(rows), "rows must be a list");
  const shut = new Set(closed);
  const openings = [];
  const skipped = [];
  for (const row of rows) {
    if (!isMatchable(row)) { skipped.push(row?.work_id ?? null); continue; }
    try {
      openings.push(rowToOpening(row, { title: titles[row.work_id], open: !shut.has(row.work_id) }));
    } catch { skipped.push(row.work_id); }
  }
  return Object.freeze({ openings: Object.freeze(openings), skipped: Object.freeze(skipped) });
}
