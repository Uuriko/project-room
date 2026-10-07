// Plug-in funnel metrics (lane 10): doc read -> identity mint -> room join ->
// first claim -> first receipt -> still active day 7.
//
// This is the measurement foundation for the plug-in deep-integration crew:
// every lane's improvement should move one of these stages. The design is
// deliberately boring and privacy-conscious:
//
// - One additive table, plugin_funnel_events(identity_key, stage, reached_at),
//   first-reach-wins per (key, stage). INSERT OR IGNORE; never updated.
// - Keys are domain-separated sha256 digests, not raw identity ids. The raw
//   id never lands in the funnel table, and the query endpoint only ever
//   returns aggregate counts — no per-agent rows leave the server.
// - Recording never throws: every record call is a no-op on bad input and the
//   HTTP hooks wrap it so a metrics failure can never break a hot path.
// - day-7 active is DERIVED at query time (mint >= 7d old + identity-attributed
//   room activity in the trailing 7d), not recorded, so there is no
//   per-agent surveillance stream — just the funnel events plus activity the
//   server already stores (messages, claim updates).

import { createHash } from "node:crypto";

export const PLUGIN_FUNNEL_STAGES = Object.freeze([
  "doc_read",
  "identity_mint",
  "room_join",
  "first_claim",
  "first_receipt",
  "active_day7", // derived at query time, never recorded
]);

export const DAY7_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const KEY_DOMAIN = "project-room-plugin-funnel-v1";

export const PLUGIN_FUNNEL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS plugin_funnel_events (
    identity_key TEXT NOT NULL,
    stage TEXT NOT NULL,
    reached_at INTEGER NOT NULL,
    PRIMARY KEY (identity_key, stage)
  );
  CREATE INDEX IF NOT EXISTS plugin_funnel_events_stage_at
    ON plugin_funnel_events(stage, reached_at);
`;

export function ensurePluginFunnelSchema(db) {
  db.exec(PLUGIN_FUNNEL_SCHEMA);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

// The funnel key for a minted identity. Domain-separated so the digest cannot
// be confused with any other hashed value in the system, and not reversible
// to the raw identity id.
export function funnelIdentityKey(identityId) {
  if (typeof identityId !== "string" || !identityId) return null;
  return digest(`${KEY_DOMAIN}:identity:${identityId}`);
}

// The funnel key for an anonymous doc reader (no identity yet). Built from the
// client address + browser session the same way growth-loop hashes parties.
// Caveat, documented in docs/PLUGIN-FUNNEL.md: a static-salt hash of an IPv4
// address is brute-forceable, so doc_read is a rough top-of-funnel counter,
// never a tracking vector.
export function funnelReaderKey({ address = "", session = null } = {}) {
  let ip = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  const sess = typeof session === "string" && session && session.length <= 512 ? session : "";
  if (!ip && !sess) return null;
  return digest(`${KEY_DOMAIN}:reader:${ip}\0${sess}`);
}

// Record that a funnel key reached a stage. First reach wins (INSERT OR
// IGNORE). Returns true when a write was attempted, false when skipped.
// Never throws: metrics must not break the mint/join/claim/receipt paths.
export function recordPluginFunnelStage(db, { identityId = null, readerKey = null, stage, atMs = Date.now() } = {}) {
  try {
    if (!db || typeof db.prepare !== "function") return false;
    if (!PLUGIN_FUNNEL_STAGES.includes(stage) || stage === "active_day7") return false;
    const key = typeof readerKey === "string" && readerKey
      ? readerKey
      : (typeof identityId === "string" && identityId ? funnelIdentityKey(identityId) : null);
    if (!key) return false;
    const at = Number.isFinite(atMs) ? Math.floor(atMs) : Date.now();
    ensurePluginFunnelSchema(db);
    db.prepare(
      "INSERT OR IGNORE INTO plugin_funnel_events(identity_key, stage, reached_at) VALUES(?,?,?)"
    ).run(key, stage, at);
    return true;
  } catch {
    return false;
  }
}

// Convenience for the doc-serving path: hash the reader, record doc_read.
export function recordPluginFunnelReader(db, { address = "", session = null, atMs = Date.now() } = {}) {
  const key = funnelReaderKey({ address, session });
  if (!key) return false;
  return recordPluginFunnelStage(db, { readerKey: key, stage: "doc_read", atMs });
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function isoWeek(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const year = thursday.getUTCFullYear();
  const week1 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thursday.getTime() - week1.getTime()) / (7 * 864e5));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const round4 = value => (value === null || value === undefined ? null : Math.round(value * 10000) / 10000);

export const PLUGIN_FUNNEL_DEFINITIONS = Object.freeze({
  doc_read: "Anonymous reader fetched an agent discovery doc (llms.txt, skill.md, agent.json, kits.txt). Counted per hashed reader key; cannot be linked to later mints.",
  identity_mint: "POST /api/agent-identities (or the MCP mint) returned 201 for an identity.",
  room_join: "The identity's first identity_links row: it joined (or created) a room.",
  first_claim: "The identity's member took its first work claim (claimed action on the work-claims board).",
  first_receipt: "The identity's first owned claim reached done — the in-room receipt card posted.",
  active_day7: "Derived: minted >= 7 days ago AND has identity-attributed room activity (message posted, claim touched, or funnel progress) in the trailing 7 days.",
});

// Pure aggregation over already-collected rows (same shape as the
// activation-funnel.mjs convention): unit-testable without a database.
//
// stageEvents:    [{ identityKey, stage, reachedAt }]
// links:          [{ roomId, identityId, memberId }]
// messageActivity:[{ roomId, memberId, atMs }]  (message.posted in the day-7 window)
// claimActivity:  [{ roomId, memberId, atMs }]  (work_claims.updated_at in the window)
export function pluginFunnelReport({ stageEvents = [], links = [], messageActivity = [], claimActivity = [], nowMs = Date.now() } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // First reach per (key, stage).
  const reached = new Map();
  for (const row of stageEvents ?? []) {
    const key = row?.identityKey;
    const stage = row?.stage;
    const at = row?.reachedAt;
    if (typeof key !== "string" || !PLUGIN_FUNNEL_STAGES.includes(stage) || !Number.isFinite(at)) continue;
    let stages = reached.get(key);
    if (!stages) { stages = new Map(); reached.set(key, stages); }
    const prior = stages.get(stage);
    if (prior === undefined || at < prior) stages.set(stage, at);
  }
  const keysFor = stage => {
    const out = new Set();
    for (const [key, stages] of reached) if (stages.has(stage)) out.add(key);
    return out;
  };
  const mintKeys = keysFor("identity_mint");
  const joinKeys = keysFor("room_join");
  const claimKeys = keysFor("first_claim");
  const receiptKeys = keysFor("first_receipt");
  const docReaders = keysFor("doc_read").size;

  const memberToIdentity = new Map();
  for (const row of links ?? []) {
    if (typeof row?.roomId === "string" && typeof row?.memberId === "string" && typeof row?.identityId === "string") {
      memberToIdentity.set(`${row.roomId}\0${row.memberId}`, row.identityId);
    }
  }

  // Identity-attributed activity in the trailing 7 days.
  const windowStart = now - DAY7_WINDOW_MS;
  const activeKeys = new Set();
  const markActivity = (roomId, memberId, at) => {
    if (typeof roomId !== "string" || typeof memberId !== "string" || !Number.isFinite(at)) return;
    if (at < windowStart || at > now) return;
    const identityId = memberToIdentity.get(`${roomId}\0${memberId}`);
    if (identityId) activeKeys.add(funnelIdentityKey(identityId));
  };
  for (const row of messageActivity ?? []) markActivity(row?.roomId, row?.memberId, row?.atMs);
  for (const row of claimActivity ?? []) markActivity(row?.roomId, row?.memberId, row?.atMs);
  // Funnel progress itself is activity (anonymous doc reads excluded).
  for (const [key, stages] of reached) {
    for (const [stage, at] of stages) {
      if (stage !== "doc_read" && at >= windowStart && at <= now) { activeKeys.add(key); break; }
    }
  }

  const mintAt = key => reached.get(key)?.get("identity_mint");
  const eligibleDay7 = [...mintKeys].filter(key => {
    const at = mintAt(key);
    return Number.isFinite(at) && at <= now - DAY7_WINDOW_MS;
  });
  const activeDay7 = eligibleDay7.filter(key => activeKeys.has(key));

  const inter = (a, b) => {
    let n = 0;
    for (const key of a) if (b.has(key)) n++;
    return n;
  };
  const conversion = (fromKeys, toKeys, from, to) => {
    const count = inter(toKeys, fromKeys);
    const of = fromKeys.size;
    const rate = of > 0 ? count / of : null;
    return { from, to, count, of, rate: round4(rate), dropoff: rate === null ? null : round4(1 - rate) };
  };

  const timeToStage = {};
  for (const stage of ["room_join", "first_claim", "first_receipt"]) {
    const diffs = [];
    for (const key of keysFor(stage)) {
      const start = mintAt(key);
      const end = reached.get(key)?.get(stage);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) diffs.push(end - start);
    }
    timeToStage[stage] = { n: diffs.length, medianMs: median(diffs) };
  }

  const cohorts = new Map();
  for (const key of mintKeys) {
    const at = mintAt(key);
    if (!Number.isFinite(at)) continue;
    const week = isoWeek(at);
    let cohort = cohorts.get(week);
    if (!cohort) {
      cohort = { week, minted: 0, joined: 0, claimed: 0, receipted: 0, day7Eligible: 0, day7Active: 0 };
      cohorts.set(week, cohort);
    }
    cohort.minted++;
    if (joinKeys.has(key)) cohort.joined++;
    if (claimKeys.has(key)) cohort.claimed++;
    if (receiptKeys.has(key)) cohort.receipted++;
    if (at <= now - DAY7_WINDOW_MS) {
      cohort.day7Eligible++;
      if (activeKeys.has(key)) cohort.day7Active++;
    }
  }
  const cohortList = [...cohorts.values()]
    .sort((a, b) => (a.week < b.week ? -1 : 1))
    .map(cohort => ({
      ...cohort,
      day7Rate: cohort.day7Eligible > 0 ? round4(cohort.day7Active / cohort.day7Eligible) : null,
    }));

  const eligible = eligibleDay7.length;
  const active = activeDay7.length;

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: 7,
    definitions: { ...PLUGIN_FUNNEL_DEFINITIONS },
    topOfFunnel: {
      docReaders,
      note: "Anonymous discovery-doc readers (hashed reader keys). Top-of-funnel awareness; cannot be linked to mints.",
    },
    stages: {
      identity_mint: { count: mintKeys.size },
      room_join: { count: joinKeys.size },
      first_claim: { count: claimKeys.size },
      first_receipt: { count: receiptKeys.size },
    },
    conversions: {
      mintToJoin: conversion(mintKeys, joinKeys, "identity_mint", "room_join"),
      joinToClaim: conversion(joinKeys, claimKeys, "room_join", "first_claim"),
      claimToReceipt: conversion(claimKeys, receiptKeys, "first_claim", "first_receipt"),
    },
    day7: {
      eligible,
      active,
      rate: eligible > 0 ? round4(active / eligible) : null,
      note: "Of identities minted >= 7 days ago, how many show identity-attributed room activity in the trailing 7 days.",
    },
    timeToStage,
    cohorts: cohortList,
  };
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch {
    return false;
  }
}

// Read-only collection of the rows the pure report needs. Tolerates stores
// that predate the funnel table (fresh installs, old backups): missing
// tables yield empty row sets, never a throw.
export function collectPluginFunnelInputs(store, { nowMs = Date.now() } = {}) {
  const db = store?.db;
  const inputs = { stageEvents: [], links: [], messageActivity: [], claimActivity: [] };
  if (!db || typeof db.prepare !== "function") return inputs;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  try {
    if (tableExists(db, "plugin_funnel_events")) {
      inputs.stageEvents = db.prepare(
        "SELECT identity_key AS identityKey, stage, reached_at AS reachedAt FROM plugin_funnel_events"
      ).all();
    }
    if (tableExists(db, "identity_links")) {
      inputs.links = db.prepare(
        "SELECT room_id AS roomId, identity_id AS identityId, member_id AS memberId FROM identity_links"
      ).all();
    }
    const windowStartMs = now - DAY7_WINDOW_MS;
    const windowStartIso = new Date(windowStartMs).toISOString();
    if (tableExists(db, "events")) {
      inputs.messageActivity = db.prepare(
        `SELECT room_id AS roomId,
                json_extract(body, '$.actorId') AS memberId,
                json_extract(body, '$.at') AS atIso
         FROM events
         WHERE body LIKE '%"type":"message.posted"%'
           AND json_extract(body, '$.at') >= ?`
      ).all(windowStartIso).map(row => ({
        roomId: row.roomId,
        memberId: row.memberId,
        atMs: Date.parse(row.atIso),
      }));
    }
    if (tableExists(db, "work_claims")) {
      inputs.claimActivity = db.prepare(
        `SELECT room_id AS roomId,
                json_extract(item_json, '$.owner') AS memberId,
                updated_at AS atMs
         FROM work_claims
         WHERE updated_at >= ?
           AND json_extract(item_json, '$.owner') IS NOT NULL`
      ).all(windowStartMs);
    }
  } catch {
    // Read-only surface: a failing query degrades to empty inputs, and the
    // HTTP layer turns a throwing handler into a 503, never a dropped conn.
  }
  return inputs;
}

// GET /api/plugin-funnel handler body. Read-only: non-GET is a 405.
export function handlePluginFunnelRequest(store, { method = "GET" } = {}) {
  if (method !== "GET") {
    return { status: 405, body: { error: { code: "method_not_allowed", message: "Use GET /api/plugin-funnel" } } };
  }
  const nowMs = typeof store?.now === "function" ? store.now() : Date.now();
  const report = pluginFunnelReport({ ...collectPluginFunnelInputs(store, { nowMs }), nowMs });
  return { status: 200, body: report };
}
