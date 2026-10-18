// Dataset packaging — Lane 1 §5.1 stages 2–6 over work-episodes assembled
// from a frozen snapshot (W2's assembler is stage 1; dataset-anonymise.mjs
// is stage 3). Pure and offline: inputs are plain data, outputs are file
// contents in memory. The CLI (scripts/dataset-package.mjs) writes them.
//
// U5 (ruled bright line) is applied here, before anonymisation: dataset
// extracts pass the SAME opt-out/unpublish filters as the public read model.
// An episode is dropped when its room is operator-unpublished, when the
// record itself is operator-unpublished, or when any room it belongs to has
// receipts recorded OFF (room_public_receipts_setting mirror /
// room_directory_settings.public_receipts = 0 — the read model's two owner
// predicates, fail-closed like legal-store.isUnpublished: unreadable
// visibility state drops the episode, it never keeps it).
//
// Quality gates GQ-1..GQ-6 (Lane 1 §5.3) run from the produced package
// alone wherever the design requires it; a blocking failure marks the
// package FAILED in its manifest — the files are still returned so the
// failure can be inspected, but the manifest says do-not-ship and the CLI
// exits non-zero. Nothing here ships anything externally; release is a
// separate licensing decision (programme §0).

import { createHash } from "node:crypto";
import { canonicalJson } from "../src/audit-receipts.mjs";
import { journalEntryHash } from "./bounty-escrow.mjs";
import {
  DATASET_TRANSFORM_VERSION,
  amountBand,
  anonymiseEpisodeForRows,
  anonymiseEpisodeForText,
  classifyEpisode,
  createPseudonymiser,
  createTextScrubber,
  episodeActorIds,
  scanForLeaks,
  shingleOverlapSets,
  wordShingles,
} from "./dataset-anonymise.mjs";

export const DATASET_PACKAGE_SCHEMA = "dataset-package/1";
export const DATASET_MANIFEST_SCHEMA = "dataset-manifest/1";
export const DATASET_EXTRACT_LOG_SCHEMA = "dataset-extract-log/1";

export const MIN_COHORT_ACTORS = 5; // Lane 1 §3.4.3
export const UNIQUENESS_DEMOTE_THRESHOLD = 0.5; // §3.4.1 shingle overlap
export const DEFAULT_ORPHAN_BOUND_PCT = 5;
export const MANUAL_SAMPLE_SIZE = 50; // GQ-3 floor for the text review sample

// ---------------------------------------------------------------------------
// Risk-tiered audit sampling — SCOPE ADDITION (SCALE-READINESS R9, adopted
// 2026-10-18). A flat-% corpus audit models at ~13 FTE at the 10,000-room
// tier; risk-tiered sampling models at ~4, because audit cost then scales
// with the RISK population, not with volume. The packager therefore carries
// the sampling hooks: every kept episode is assigned a risk stratum from
// signals already in the record, each stratum has an inclusion rate, and
// selection is deterministic (rank = sha256 of packageId + pseudonym), so
// the sample is reproducible under GQ-6 and re-derivable by an auditor.
// GQ-3's human gate consumes this sample: for external Tier T, the manual
// review must cover the sampled text records (plus the flat floor below) —
// high-risk text is reviewed at 100%, routine text at the floor.
// ---------------------------------------------------------------------------
export const AUDIT_SAMPLE_VERSION = "audit-sample/1";
export const DEFAULT_AUDIT_RATES = Object.freeze({ high: 1, medium: 0.25, standard: 0.02 });

function actorRiskStats(episodes) {
  const stats = new Map();
  const bump = (id, field) => {
    if (id === null || id === undefined || id === "") return;
    const key = String(id);
    if (!stats.has(key)) stats.set(key, { episodes: 0, disputes: 0 });
    stats.get(key)[field] += 1;
  };
  for (const ep of episodes) {
    const actors = episodeActorIds(ep);
    for (const id of actors) bump(id, "episodes");
    if (ep.dispute) for (const id of actors) bump(id, "disputes");
  }
  return stats;
}

// Strata from structural risk signals (Lane-1 records carry no outcome-code
// enum for disputes yet, so dispute HISTORY weighs in at medium; when W5's
// outcome labels pin the codes, upheld-against-claimant disputes promote to
// high — named seam).
//   high:     self-review (verdict subject == verifier), self-adjudication
//             (dispute decider is the claimant or the delivery's subject),
//             accepted verdict with no settlement (money-shape anomaly)
//   medium:   any dispute on the episode, claimant == authorising principal
//             (operator grading own room's work), new operator (claimant or
//             principal touches <=2 kept episodes — package-local proxy
//             until operator tenure exists upstream)
//   standard: everything else
export function classifyRiskStratum(episode, stats) {
  const claimant = episode.claim?.claimantRef;
  const principal = episode.provenance?.authorizingPrincipalId;
  for (const v of episode.verdicts ?? []) {
    if (v.subjectId && v.subjectId === v.verifierId) return "high";
    if ((v.outcome === "accepted" || v.accepted === true) && !episode.settlement) return "high";
  }
  if (episode.dispute) {
    const decider = episode.dispute.deciderRef;
    if (decider && (decider === claimant || (episode.verdicts ?? []).some(v => decider === v.subjectId))) {
      return "high";
    }
    return "medium";
  }
  if (claimant && principal && String(claimant) === String(principal)) return "medium";
  const touches = id => (id ? stats.get(String(id))?.episodes ?? 0 : 0);
  if ((claimant && touches(claimant) <= 2) || (principal && touches(principal) <= 2)) return "medium";
  return "standard";
}

const sampleRank = (packageId, pseudo) => sha256Hex(`${AUDIT_SAMPLE_VERSION}|${packageId}|${pseudo}`);

// keptOrdered: [{ episode, licence }] in build order. Returns strata counts,
// the sampled pseudonyms, and the per-episode stratum map (keyed by raw
// recordId for the caller's joins; only pseudonyms leave this function in
// sampledRefs).
export function buildAuditSample(keptOrdered, pseudonymiser, { rates = DEFAULT_AUDIT_RATES, floor = MANUAL_SAMPLE_SIZE } = {}) {
  for (const [k, v] of Object.entries(rates)) {
    if (!(v >= 0 && v <= 1)) throw new Error(`buildAuditSample: rate ${k}=${v} outside [0,1]`);
  }
  const stats = actorRiskStats(keptOrdered.map(k => k.episode));
  const byStratum = { high: [], medium: [], standard: [] };
  const stratumByRecord = new Map();
  for (const { episode } of keptOrdered) {
    const stratum = classifyRiskStratum(episode, stats);
    const pseudo = pseudonymiser.episode(episode.recordId ?? episode.episodeId);
    byStratum[stratum].push({ pseudo, rank: sampleRank(pseudonymiser.packageId, pseudo) });
    stratumByRecord.set(String(episode.recordId ?? episode.episodeId), stratum);
  }
  const sampled = new Set();
  const strataSummary = {};
  for (const [stratum, entries] of Object.entries(byStratum)) {
    const rate = rates[stratum] ?? 0;
    const ranked = [...entries].sort((a, b) => a.rank.localeCompare(b.rank));
    const take = rate >= 1 ? ranked.length : Math.ceil(rate * ranked.length);
    for (const e of ranked.slice(0, take)) sampled.add(e.pseudo);
    strataSummary[stratum] = { episodes: entries.length, sampled: Math.min(take, entries.length), rate };
  }
  // Flat floor on the whole-package sample (the audit never goes blind on a
  // small package): top up in global rank order.
  const target = Math.min(floor, keptOrdered.length);
  if (sampled.size < target) {
    const all = Object.values(byStratum).flat()
      .sort((a, b) => a.rank.localeCompare(b.rank));
    for (const e of all) {
      if (sampled.size >= target) break;
      sampled.add(e.pseudo);
    }
  }
  return {
    version: AUDIT_SAMPLE_VERSION,
    rates,
    floor,
    strata: strataSummary,
    sampledRefs: [...sampled].sort(),
    stratumByRecord,
    rankOf: pseudo => sampleRank(pseudonymiser.packageId, pseudo),
  };
}

const sha256Hex = s => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// U5 visibility — built from the same tables the read model reads
// ---------------------------------------------------------------------------

// tables: raw snapshot rows — public_unpublish [{kind,target}],
// room_directory_settings [{room_id, public_receipts}],
// room_public_receipts_setting [{room_id, enabled}].
// Returns { unpublishedRooms:Set, unpublishedRecords:Set, receiptsOffRooms:Set }.
export function visibilityFromSnapshotTables(tables = {}) {
  const unpublishedRooms = new Set();
  const unpublishedRecords = new Set();
  for (const row of tables.public_unpublish ?? []) {
    if (row?.kind === "room") unpublishedRooms.add(String(row.target));
    else if (row?.kind === "receipt") unpublishedRecords.add(String(row.target));
  }
  const receiptsOffRooms = new Set();
  for (const row of tables.room_directory_settings ?? []) {
    if (Number(row?.public_receipts) === 0 && row?.room_id) receiptsOffRooms.add(String(row.room_id));
  }
  for (const row of tables.room_public_receipts_setting ?? []) {
    // The mirror records the owner's setting: only a recorded OFF hides;
    // "never recorded" stays distinguishable (read-model comment, #3594-era).
    if (Number(row?.enabled) === 0 && row?.room_id) receiptsOffRooms.add(String(row.room_id));
  }
  return { unpublishedRooms, unpublishedRecords, receiptsOffRooms };
}

// Person dictionary for the Tier T scrubber and the GQ-3 scan, from the
// identity tables: accounts + agent_identities give display names;
// identity_links join them to rooms (not needed for the dictionary itself).
// handles: operator-supplied GitHub handles per identity id (the product
// keeps handles in the repo/PR corpus, not in one table).
export function peopleFromSnapshotTables(tables = {}, handlesByIdentity = {}) {
  const people = [];
  const byId = new Map();
  const add = (id, name) => {
    if (!id) return;
    if (!byId.has(String(id))) byId.set(String(id), { names: [], handles: [] });
    const entry = byId.get(String(id));
    if (name && !entry.names.includes(name)) entry.names.push(name);
  };
  for (const row of tables.accounts ?? []) add(row?.id, row?.display_name ?? row?.displayName);
  for (const row of tables.agent_identities ?? []) {
    add(row?.identity_id ?? row?.identityId, row?.display_name ?? row?.displayName);
  }
  for (const [id, handles] of Object.entries(handlesByIdentity)) {
    if (!byId.has(String(id))) byId.set(String(id), { names: [], handles: [] });
    byId.get(String(id)).handles.push(...handles);
  }
  for (const entry of byId.values()) people.push(entry);
  return people;
}

// Every raw id in the inputs — the GQ-3 scan's strongest check is that none
// of these strings survives anywhere in the serialized output.
export function collectRawIds({ episodes = [], rooms = {}, people = [] } = {}) {
  const ids = new Set();
  const add = v => { if (typeof v === "string" && v.length >= 4) ids.add(v); };
  for (const ep of episodes) {
    add(ep.recordId); add(ep.episodeId); add(ep.roomId);
    add(ep.claim?.claimantRef); add(ep.dispute?.deciderRef);
    add(ep.provenance?.sessionInstanceId); add(ep.provenance?.authorizingPrincipalId);
    add(ep.delivery?.prUrl);
    for (const id of ep.settlement?.journalEntryIds ?? []) add(id);
    for (const v of ep.verdicts ?? []) {
      add(v.rowId); add(v.subjectId); add(v.verifierId);
      add(v.sessionInstanceId); add(v.authorizingPrincipalId); add(v.supersedesRowId);
    }
  }
  for (const roomId of Object.keys(rooms)) add(roomId);
  return [...ids];
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

// GQ-1: recompute every journal hash (the repo's own audit check) and, when
// both digests are supplied, the snapshot trailer match. Chain linkage: per
// account, every entry but one must have its prev_hash equal to a sibling
// entry's hash.
export function gateJournalIntegrity(journalEntries, { trailerDigest, computedTrailerDigest } = {}) {
  if (!Array.isArray(journalEntries) || journalEntries.length === 0) {
    return { id: "GQ-1", name: "integrity", status: "skipped", blocking: true, detail: "no journal rows in extract scope" };
  }
  const failures = [];
  const byAccount = new Map();
  for (const e of journalEntries) {
    if (journalEntryHash(e) !== e.hash) failures.push(`hash mismatch at ${e.entry_id}`);
    const list = byAccount.get(e.account_id) ?? [];
    list.push(e);
    byAccount.set(e.account_id, list);
  }
  for (const [account, entries] of byAccount) {
    const hashes = new Set(entries.map(e => e.hash));
    const heads = entries.filter(e => !hashes.has(e.prev_hash));
    if (heads.length !== 1) failures.push(`account ${account}: ${heads.length} chain heads (expected 1)`);
  }
  if (trailerDigest && computedTrailerDigest && trailerDigest !== computedTrailerDigest) {
    failures.push("snapshot trailer digest mismatch");
  }
  return {
    id: "GQ-1", name: "integrity", blocking: true,
    status: failures.length ? "fail" : "pass",
    detail: failures.length ? failures.slice(0, 5).join("; ") : `${journalEntries.length} entries re-verified`,
  };
}

// GQ-2: orphan verdicts (a verdict whose episode lacks a task or a delivery
// join) within the declared bound; criteria-pin coverage reported.
export function gateCompleteness(episodes, { orphanBoundPct = DEFAULT_ORPHAN_BOUND_PCT } = {}) {
  let verdicts = 0;
  let orphans = 0;
  let pinned = 0;
  for (const ep of episodes) {
    for (const v of ep.verdicts ?? []) {
      verdicts += 1;
      if (!ep.task || !ep.delivery) orphans += 1;
      if (ep.task?.criteriaHash || v.criteriaHash) pinned += 1;
    }
  }
  const orphanPct = verdicts ? (orphans / verdicts) * 100 : 0;
  const coveragePct = verdicts ? (pinned / verdicts) * 100 : 0;
  return {
    id: "GQ-2", name: "completeness", blocking: true,
    status: orphanPct > orphanBoundPct ? "fail" : "pass",
    detail: `orphans ${orphans}/${verdicts} (${orphanPct.toFixed(1)}% vs bound ${orphanBoundPct}%); criteria-pin coverage ${coveragePct.toFixed(1)}%`,
    orphanPct, coveragePct,
  };
}

// GQ-5: honesty — verification tiers and outcomes carried verbatim, cohort
// labels intact, outcome labels copied (never upgraded/asserted).
export function gateHonesty(inputEpisodes, outputRows) {
  const failures = [];
  // Output episodes are pseudonyms, so this gate compares the outcome
  // multiset (outcome|accepted|tier per verdict) rather than matching rows.
  const tally = rows => {
    const m = new Map();
    for (const r of rows) {
      for (const v of r.verdicts ?? []) {
        const k = `${v.outcome ?? ""}|${v.accepted ?? ""}|${v.tier ?? ""}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
    return m;
  };
  const inTally = tally(inputEpisodes.map(ep => ({ verdicts: ep.verdicts ?? [] })));
  const outTally = tally(outputRows);
  for (const [k, n] of inTally) {
    if ((outTally.get(k) ?? 0) < n) failures.push(`verdict tally shrank for ${k}`);
  }
  const inCohorts = new Map();
  for (const ep of inputEpisodes) inCohorts.set(ep.cohort ?? null, (inCohorts.get(ep.cohort ?? null) ?? 0) + 1);
  const outCohorts = new Map();
  for (const r of outputRows) outCohorts.set(r.cohort ?? null, (outCohorts.get(r.cohort ?? null) ?? 0) + 1);
  for (const [cohort, n] of inCohorts) {
    if ((outCohorts.get(cohort) ?? 0) !== n) failures.push(`cohort ${cohort} count changed ${n} -> ${outCohorts.get(cohort) ?? 0}`);
  }
  return {
    id: "GQ-5", name: "honesty", blocking: true,
    status: failures.length ? "fail" : "pass",
    detail: failures.length ? failures.slice(0, 5).join("; ") : "tiers, outcomes and cohort labels verbatim",
  };
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

function bandUniqueAmounts(rows, field, bandField) {
  const counts = new Map();
  for (const row of rows) {
    const v = row[field === "netMillis" ? "settlement" : "task"]?.[field];
    if (Number.isFinite(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let banded = 0;
  for (const row of rows) {
    const holder = row[field === "netMillis" ? "settlement" : "task"];
    if (!holder) continue;
    const v = holder[field];
    if (Number.isFinite(v) && counts.get(v) === 1) {
      holder[bandField] = amountBand(v);
      holder[field] = null;
      banded += 1;
    }
  }
  return banded;
}

export function buildDatasetPackage(input) {
  const {
    episodes = [],
    rooms = {},
    people = [],
    visibility = null,
    journalEntries = null,
    trailerDigest = null,
    computedTrailerDigest = null,
    publicCorpusTexts = [],
    key,
    packageId,
    packageClass = "external",
    tiers = ["R"],
    manualReview = null,
    auditRates = null, // R9: per-stratum inclusion rates (defaults above)
    orphanBoundPct = DEFAULT_ORPHAN_BOUND_PCT,
    builtAt = null, // injected for reproducibility; CLI passes wall clock
    actor = null,
    snapshotHash = null,
    prodRevision = null,
  } = input;
  if (packageClass !== "external" && packageClass !== "internal") {
    throw new Error(`buildDatasetPackage: unknown packageClass ${packageClass}`);
  }
  const external = packageClass === "external";
  const precision = external ? "day" : "hour";
  const pseudonymiser = createPseudonymiser({ key, packageId });

  const counts = {
    episodesIn: episodes.length,
    droppedU5: 0,
    droppedBrightLine: {},
    pooledEpisodes: 0,
    demotedRowsOnly: 0,
    bandedAmounts: 0,
    rowsOut: 0,
    textOut: 0,
  };

  // Stage 2a — U5 visibility filter (all packages; fail-closed when a
  // visibility object was promised but its sets are missing).
  const vis = visibility ?? { unpublishedRooms: new Set(), unpublishedRecords: new Set(), receiptsOffRooms: new Set() };
  const afterU5 = [];
  for (const ep of episodes) {
    const roomHidden = vis.unpublishedRooms.has(String(ep.roomId)) || vis.receiptsOffRooms.has(String(ep.roomId));
    const recordHidden = vis.unpublishedRecords.has(String(ep.recordId));
    if (roomHidden || recordHidden) counts.droppedU5 += 1;
    else afterU5.push(ep);
  }

  // Stage 2b — bright-line classification.
  const kept = [];
  for (const ep of afterU5) {
    const verdict = classifyEpisode(ep, rooms[ep.roomId] ?? {}, { packageClass });
    if (!verdict.include) {
      for (const r of verdict.reasons) counts.droppedBrightLine[r] = (counts.droppedBrightLine[r] ?? 0) + 1;
      continue;
    }
    kept.push({ episode: ep, licence: verdict.licence });
  }

  // Stage 3a prep — cohort pooling (external only): rooms under the minimum
  // distinct-actor count ship pooled with room attributes stripped.
  const actorsByRoom = new Map();
  for (const { episode } of kept) {
    const set = actorsByRoom.get(episode.roomId) ?? new Set();
    for (const id of episodeActorIds(episode)) set.add(id);
    actorsByRoom.set(episode.roomId, set);
  }
  const isPooled = roomId => external && (actorsByRoom.get(roomId)?.size ?? 0) < MIN_COHORT_ACTORS;

  // Deterministic processing order: raw recordId sort, so pseudonym
  // placeholder assignment and file bytes are reproducible (GQ-6).
  const ordered = [...kept].sort((a, b) =>
    String(a.episode.recordId ?? a.episode.episodeId).localeCompare(String(b.episode.recordId ?? b.episode.episodeId)));

  // Stage 3 — Tier R rows.
  const rows = ordered.map(({ episode, licence }) =>
    anonymiseEpisodeForRows(episode, {
      pseudonymiser, precision, licence,
      pooled: isPooled(episode.roomId),
      room: rooms[episode.roomId] ?? {},
    }));
  counts.pooledEpisodes = ordered.filter(({ episode }) => isPooled(episode.roomId)).length;
  if (external) {
    counts.bandedAmounts += bandUniqueAmounts(rows, "netMillis", "netBand");
    counts.bandedAmounts += bandUniqueAmounts(rows, "rewardMillis", "rewardBand");
  }
  counts.rowsOut = rows.length;

  // Stage 3 — Tier T text (separate file, heavier pass, uniqueness demotion).
  const wantText = tiers.includes("T");
  let textRecords = [];
  const corpusShingleSets = publicCorpusTexts.map(t => wordShingles(t));
  if (wantText) {
    const roomTerms = [
      ...Object.keys(rooms),
      ...Object.values(rooms).flatMap(r => [r?.name, r?.title]).filter(Boolean),
    ];
    const scrubber = createTextScrubber({ people, roomTerms });
    for (const { episode, licence } of ordered) {
      const rec = anonymiseEpisodeForText(episode, { pseudonymiser, scrubber, licence });
      if (!rec) continue;
      // Uniqueness: a text that substantially overlaps one public document
      // is a fingerprint — the episode ships rows-only (§3.4.1). Corpus
      // shingle sets are built once per build (see corpusShingleSets).
      const joined = [rec.spec, rec.criteria, rec.artefact,
        ...Object.values(rec.criteriaSummaries ?? {}), ...Object.values(rec.verdictReasons ?? {})]
        .filter(Boolean).join("\n");
      const candidateShingles = wordShingles(joined);
      const worst = corpusShingleSets.reduce(
        (max, docSet) => Math.max(max, shingleOverlapSets(candidateShingles, docSet)), 0);
      if (external && worst >= UNIQUENESS_DEMOTE_THRESHOLD) {
        counts.demotedRowsOnly += 1;
        continue;
      }
      textRecords.push(rec);
    }
    counts.textOut = textRecords.length;
  }

  // R9 audit sample over the kept episodes (all tiers — rows are audited
  // too), plus the text-review requirement GQ-3 enforces: every sampled
  // text record, topped up by rank to the flat floor.
  const auditSample = buildAuditSample(ordered, pseudonymiser, {
    rates: auditRates ?? DEFAULT_AUDIT_RATES,
  });
  const textRefs = textRecords.map(r => r.episode);
  const textReviewRequired = (() => {
    const sampledSet = new Set(auditSample.sampledRefs);
    const required = new Set(textRefs.filter(ref => sampledSet.has(ref)));
    const target = Math.min(MANUAL_SAMPLE_SIZE, textRefs.length);
    if (required.size < target) {
      const ranked = [...textRefs].sort((a, b) => auditSample.rankOf(a).localeCompare(auditSample.rankOf(b)));
      for (const ref of ranked) {
        if (required.size >= target) break;
        required.add(ref);
      }
    }
    return [...required].sort();
  })();

  // Stage 4/5 — normalize + serialize.
  const serialize = records => (records.length ? `${records.map(r => canonicalJson(r)).join("\n")}\n` : "");
  const files = new Map();
  files.set("rows.ndjson", serialize(rows));
  if (wantText) files.set("text.ndjson", serialize(textRecords));

  // Stage 6 — gates, run from the serialized output + inputs.
  const gates = [];
  gates.push(gateJournalIntegrity(journalEntries, { trailerDigest, computedTrailerDigest }));
  gates.push(gateCompleteness(kept.map(k => k.episode), { orphanBoundPct }));
  {
    const outputText = [...files.values()].join("");
    const hits = scanForLeaks(outputText, { people, rawIds: collectRawIds({ episodes, rooms }) });
    let status = hits.length ? "fail" : "pass";
    let detail = hits.length
      ? `${hits.length} leak hit(s): ${hits.slice(0, 5).map(h => h.kind).join(", ")}`
      : "zero-hit on output scan";
    if (wantText && external) {
      // The human gate reviews the R9 risk-tiered sample, not a flat draw:
      // every required ref (100% of sampled high-risk text + floor) must be
      // in the reviewer's attested list.
      const covered = new Set(manualReview?.sampledRecordIds ?? []);
      const missing = textReviewRequired.filter(ref => !covered.has(ref));
      if (!manualReview || manualReview.verdict !== "pass" || missing.length) {
        status = "fail";
        detail += `; manual review missing/incomplete (${textReviewRequired.length - missing.length}/${textReviewRequired.length} required records covered)`;
      } else {
        detail += `; manual review by ${manualReview.reviewer} covered all ${textReviewRequired.length} required records (risk-tiered sample + floor)`;
      }
    }
    gates.push({ id: "GQ-3", name: "anonymisation", blocking: true, status, detail, hits });
  }
  {
    // GQ-4: zip the kept inputs (same order the rows were built in) against
    // the output rows — a row is pooled iff its episode's room is under the
    // minimum cohort. Any mismatch means the pooling pass and the gate
    // disagree, which is exactly the failure this gate exists to catch.
    let mismatches = 0;
    if (external) {
      for (let i = 0; i < ordered.length; i += 1) {
        const shouldPool = isPooled(ordered[i].episode.roomId);
        const isRowPooled = rows[i]?.room?.ref === "room_pooled";
        if (shouldPool !== isRowPooled) mismatches += 1;
      }
    }
    const smallRooms = [...actorsByRoom.values()].filter(s => s.size < MIN_COHORT_ACTORS).length;
    gates.push({
      id: "GQ-4", name: "cohort", blocking: true,
      status: mismatches ? "fail" : "pass",
      detail: external
        ? `${smallRooms} room(s) under ${MIN_COHORT_ACTORS} actors; ${counts.pooledEpisodes} episode(s) pooled; ${mismatches} pooling mismatch(es)`
        : "internal package — pooling not applied",
    });
  }
  gates.push(gateHonesty(kept.map(k => k.episode), rows));

  const manifest = {
    schema: DATASET_MANIFEST_SCHEMA,
    packageId,
    packageClass,
    tiers,
    status: "built", // set to FAILED below if a blocking gate fails
    transformVersion: DATASET_TRANSFORM_VERSION,
    packageSchema: DATASET_PACKAGE_SCHEMA,
    builtAt: builtAt ?? null,
    snapshot: { hash: snapshotHash ?? null, prodRevision: prodRevision ?? null },
    pseudonym: {
      algorithm: "HMAC-SHA256",
      truncationBits: 128,
      domain: "w4/1",
      keyCustody: external ? "destroyed-after-packaging" : "sealed-mapping-operator-held",
    },
    counts,
    auditSample: {
      version: auditSample.version,
      rates: auditSample.rates,
      floor: auditSample.floor,
      strata: auditSample.strata,
      sampledRefs: auditSample.sampledRefs,
      textReviewRequired,
    },
    manualReview: manualReview
      ? { reviewer: manualReview.reviewer, sampled: manualReview.sampledRecordIds?.length ?? 0, verdict: manualReview.verdict }
      : null,
    gates: gates.map(g => ({ id: g.id, name: g.name, status: g.status, blocking: g.blocking, detail: g.detail })),
    files: {},
  };
  for (const [name, content] of files) {
    manifest.files[name] = {
      sha256: sha256Hex(content),
      bytes: Buffer.byteLength(content),
      records: content ? content.trimEnd().split("\n").length : 0,
    };
  }
  const blockingFailure = gates.some(g => g.blocking && g.status === "fail");
  if (blockingFailure) manifest.status = "FAILED";

  // GQ-6 (advisory in v1): rebuild from the same inputs and byte-compare
  // everything except the manifest's builtAt.
  let reproDetail = "not run";
  let reproStatus = "skipped";
  if (!buildDatasetPackage._reproRunning) {
    buildDatasetPackage._reproRunning = true;
    try {
      const again = buildDatasetPackage({ ...input, builtAt });
      const sameFiles = [...files.keys()].every(name => again.files.get(name) === files.get(name));
      // Compare counts + per-file digests (the gate lists themselves embed
      // this very check's status, so they are excluded by construction).
      const sameManifest = canonicalJson(again.manifest.counts) === canonicalJson(manifest.counts) &&
        canonicalJson(again.manifest.files) === canonicalJson(manifest.files);
      reproStatus = sameFiles && sameManifest ? "pass" : "fail";
      reproDetail = sameFiles && sameManifest
        ? "second build byte-identical (manifest modulo builtAt)"
        : "second build differs";
    } finally {
      buildDatasetPackage._reproRunning = false;
    }
  }
  gates.push({ id: "GQ-6", name: "reproducibility", blocking: false, status: reproStatus, detail: reproDetail });
  manifest.gates = gates.map(g => ({ id: g.id, name: g.name, status: g.status, blocking: g.blocking, detail: g.detail }));
  manifest.status = gates.some(g => g.blocking && g.status === "fail") ? "FAILED" : "built";

  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  files.set("DATASHEET.md", renderDatasheet({ manifest, counts, gates, input, auditSample, textReviewRequired }));
  const extractLog = {
    schema: DATASET_EXTRACT_LOG_SCHEMA,
    packageId,
    at: builtAt ?? null,
    actor: actor ?? null,
    snapshotHash: snapshotHash ?? null,
    transformVersion: DATASET_TRANSFORM_VERSION,
    packageHash: sha256Hex(canonicalJson(manifest.gates) + canonicalJson(manifest.counts)),
    status: manifest.status,
    counts,
  };
  files.set("extract-log.json", `${JSON.stringify(extractLog, null, 2)}\n`);

  return { files, manifest, gates, extractLog, rows, textRecords, auditSample: { ...auditSample, textReviewRequired } };
}

function renderDatasheet({ manifest, counts, gates, input, auditSample, textReviewRequired }) {
  const cohorts = new Set((input.episodes ?? []).map(e => e.cohort ?? "unspecified"));
  const lines = [
    `# Datasheet — ${manifest.packageId}`,
    "",
    `- Package class: ${manifest.packageClass} (tiers: ${manifest.tiers.join(", ")})`,
    `- Transform: ${manifest.transformVersion}; pseudonyms HMAC-SHA256, 128-bit, per-package key (${manifest.pseudonym.keyCustody}).`,
    `- Snapshot: hash ${manifest.snapshot.hash ?? "unspecified"}, prod revision ${manifest.snapshot.prodRevision ?? "unspecified"}.`,
    `- Cohorts present: ${[...cohorts].join(", ")}. Drill and fleet episodes are labelled as such in every record (GQ-5); nothing in this package upgrades a verification tier.`,
    "",
    "## Counts",
    "",
    `- Episodes in: ${counts.episodesIn}; dropped by U5 visibility filters: ${counts.droppedU5}; dropped by bright lines: ${JSON.stringify(counts.droppedBrightLine)}`,
    `- Rows out: ${counts.rowsOut}; text records out: ${counts.textOut}; pooled (small-cohort) episodes: ${counts.pooledEpisodes}; rows-only demotions for public-text uniqueness: ${counts.demotedRowsOnly}; unique amounts banded: ${counts.bandedAmounts}`,
    "",
    "## Anonymisation method",
    "",
    "Extract-time only; capture remains verbatim. Tier R: ids replaced by keyed pseudonyms (linkage within this package only), names dropped, role labels kept, timestamps coarsened (hour internal / day external), amounts kept unless unique-in-package (then banded). Tier T: secret scrub + email/phone/URL pattern pass + person-dictionary placeholders, consistent within the package. Journal memos, claim-history notes, and dispute narratives are never emitted (B6 / Lane 1 §3.3). Private (B1), NDA/enterprise (B8), and sensitive (B7) material is excluded from external packages; DM (B4) and inbox (B9) material is excluded from all packages; pre-acceptance draft text never ships (B5). Extracts passed the public read model's opt-out/unpublish filters (U5) before anonymisation.",
    "",
    "## Quality gates",
    "",
    ...gates.map(g => `- ${g.id} ${g.name}: **${g.status}**${g.blocking ? "" : " (advisory)"} — ${g.detail}`),
    "",
    "## Audit sampling (risk-tiered — SCALE-READINESS R9)",
    "",
    "Scope addition from the scale plan (2026-10-18): audit effort must scale with risk, not volume — a flat-% corpus audit models at ~13 FTE at the 10,000-room tier vs ~4 risk-tiered. Every kept episode is stratified by structural risk signals (self-review / self-adjudication / accepted-without-settlement = high; disputes, operator-self-claims, new operators = medium; the rest standard) and sampled at per-stratum rates, deterministically (sha256 rank over packageId + pseudonym), so any auditor can re-derive the sample. GQ-3's manual review covers the sampled text records plus a flat floor.",
    "",
    ...(auditSample
      ? Object.entries(auditSample.strata).map(([s, v]) => `- ${s}: ${v.episodes} episode(s), rate ${v.rate}, sampled ${v.sampled}`)
      : []),
    `- Text records requiring manual review this package: ${textReviewRequired?.length ?? 0}.`,
    "",
    "## Known residuals (Lane 1 §3.4)",
    "",
    "- Rare-task fingerprinting: mitigated by the uniqueness demotion (rows-only) for texts overlapping public corpora; short texts under the shingle window cannot be demoted by that check and rely on scrubbing + the manual sample (external Tier T).",
    "- Pseudonym reversal via public receipts: pseudonyms are keyed HMACs, never derivable from public ids; the key for external packages is destroyed at packaging, so the mapping is unrecoverable by construction.",
    "- Small-room singling-out: rooms under the minimum cohort are pooled with attributes stripped.",
    "- Redaction resurrection: message-derived text must enter through the redaction view upstream (assembler contract); this packager never reads the raw event log.",
    "- Decider/verifier stylometry in free-text reasons: accepted residual for internal packages; external Tier T carries the manual sample gate.",
    manifest.status === "FAILED" ? "\n**THIS PACKAGE FAILED A BLOCKING GATE AND MUST NOT SHIP.**" : "",
  ];
  return `${lines.join("\n")}\n`;
}
