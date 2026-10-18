#!/usr/bin/env node
// Work-episode extract bench (data programme W2).
//
//   node scripts/extract-episodes-bench.mjs --settled 1000 --profile field
//   node scripts/extract-episodes-bench.mjs --settled 100000 --profile field
//   node scripts/extract-episodes-bench.mjs --settled 1000 --emit-snapshot > snap.ndjson
//
// Generates a synthetic production-shaped snapshot as a line stream
// (real journal hash chains, real trailer digests via the exporter's
// own helpers; generation never materialises the snapshot) and times
// the assembler over it: a full run, an incremental re-run over the
// identical stream (expect zero emitted), and an incremental run
// after a delta of new settled bounties is appended. The file-backed
// path the CLI uses is the same assembler over a readline stream.
// Profiles:
//   clean — every settled bounty fully recorded; measures the
//           assembler's ceiling (completeness must read 100%).
//   field — production-shaped defects at stated rates: 2% of settled
//           bounties carry no verdict record, 1% carry no criteria
//           pin, 0.5% are payout-to-funder rings (SD-2). Measures
//           detection, not luck.
// Composition of settled bounties: 70% keeper-release, 20% attested,
// 5% dispute-split-paid, 5% keeper-release with stamps at every
// placement; posters cycle over 50 refs, claimants over settled/3
// refs (repeat operators, like a real book). Refunded and proposed
// bounties ride along at 5% each for texture. Output is JSON: wall
// times, episodes/sec, peak RSS, completeness, trigger counters.

import { createHash } from "node:crypto";
import { createTableDigests } from "../server/room-export.mjs";
import { journalEntryHash } from "../server/bounty-escrow.mjs";
import { assembleWorkEpisodes } from "../server/work-episode-extract.mjs";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";
const MS1 = Date.parse(T1);
const json = value => JSON.stringify(value);
const stamp = principal => ({
  sessionInstanceId: `sess_${"b".repeat(24)}`, authorizingPrincipalId: principal,
  claimedModelVersion: "bench-model", claimedHarnessVersion: "bench-harness", claimedEnvironment: "bench",
});
const argOf = (name, fallback) => {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
};

async function* generateLines({ settled, profile, extraSettled = 0 }) {
  const total = settled + extraSettled;
  const field = profile === "field";
  const digests = createTableDigests();
  const eventHash = createHash("sha256");
  let journalSeq = 0, bountyEventSeq = 0, eventSeq = 0;
  const chainHeads = new Map();
  const row = (table, value) => { digests.add(table, value); return json({ table, row: value }); };
  const legLines = ({ kind, bountyId, accountId, amount, provenance = null }) => {
    const seq = ++journalSeq;
    const key = `room-bench\n${accountId}`;
    const entry = {
      seq, room_id: "room-bench", entry_id: `je_${seq}`, account_id: accountId, at: T1, kind,
      bounty_id: bountyId, lot_id: `lot_${bountyId}`, amount, lot_state: "locked",
      prev_hash: chainHeads.get(key) ?? "0".repeat(64), hash: null, memo: null,
      actor_kind: "member", actor_id: "op_actor", receipt_id: null, track: null,
      provenance_json: provenance ? json(provenance) : null,
    };
    entry.hash = journalEntryHash(entry);
    chainHeads.set(key, entry.hash);
    return row("bounty_journal", entry);
  };
  const moveLines = (kind, bountyId, from, to, amount, provenance = null) => [
    legLines({ kind, bountyId, accountId: from, amount: -amount }),
    legLines({ kind, bountyId, accountId: to, amount, provenance }),
  ];

  yield json({ kind: "watermark", version: 1, sanitizePolicy: 2, backedUpAt: T2, rooms: [{ id: "room-bench", sequence: 3 * total }], events: 3 * total });
  for (let i = 0; i < total; i++) {
    const bountyId = `bty_bench_${i}`;
    const poster = `op_poster_${i % 50}`;
    const claimant = `op_worker_${i % Math.max(1, Math.ceil(settled / 3))}`;
    const noVerdict = field && i % 50 === 0;
    const noPin = field && i % 100 === 0;
    const ring = field && i % 200 === 7;
    const mode = i % 20;
    const record = {
      bounty_id: bountyId, room_id: "room-bench", title: `Bench task ${i}`, criteria: "bench criteria",
      amount_millis: 4000, poster, verifier: "op_verifier", dispute_decider: "op_decider",
      approval_mode: "agent", claimant, state: "paid", state_changed_ms: MS1, deadline_ms: null,
      challenge_ends_ms: null, dispute_id: null, dispute_opened_ms: null,
      evidence_json: null, attestation_json: null, resolution_json: null, rubric_json: null,
      rubric_hash: noPin ? null : `rh_${i}`, rubric_version: noPin ? null : 1,
      submission_hash: `sh_${i}`, created_at: T0, updated_at: T1,
    };
    if (!noVerdict) {
      if (mode < 14) record.resolution_json = json({ kind: "release", outcome: "release", settledBy: { id: "escrow-keeper" }, settledAt: T2 });
      else if (mode < 18) record.attestation_json = json({ recordedBy: "op_verifier", recordedAt: T2, citations: [{ criterionId: "c1", verdict: "pass" }] });
      else if (mode === 18) {
        record.dispute_id = `dsp_bench_${i}`;
        record.dispute_opened_ms = MS1;
        record.resolution_json = json({ kind: "split", outcome: "split", decidedBy: "op_decider", decidedAt: T2, reasonCodes: ["partial"] });
        yield row("bounty_disputes", { dispute_id: record.dispute_id, room_id: "room-bench", body: json({ outcome: "split" }), updated_at: T2 });
      } else record.resolution_json = json({ kind: "release", outcome: "release", settledBy: { id: "escrow-keeper" }, settledAt: T2, provenance: stamp(poster) });
      if (mode >= 14) record.evidence_json = json({ provenance: stamp(poster) });
    }
    yield row("bounty_records", record);
    for (const afterState of ["claimed", "submitted"]) {
      yield row("bounty_events", {
        seq: ++bountyEventSeq, room_id: "room-bench", at: T1, type: "transition", bounty_id: bountyId,
        actor_kind: "member", actor_id: "op_actor", before_state: null, after_state: afterState, track: null, data: null,
      });
    }
    const lot = `acct_lot_${bountyId}`;
    yield* moveLines("escrow-lock", bountyId, poster, lot, 4000);
    yield* moveLines("attribute", bountyId, lot, lot, 4000, mode === 19 ? stamp(poster) : null);
    yield* moveLines("approve", bountyId, lot, lot, 4000);
    yield* moveLines("payout", bountyId, lot, ring ? poster : claimant, 4000);
    yield* moveLines("fee", bountyId, claimant, "acct_pool", 100);
    for (let k = 0; k < 3; k++) {
      const value = { room_id: "room-bench", sequence: ++eventSeq, id: `evt_bench_${eventSeq}`, kind: "note", at: T0 };
      eventHash.update(`room-bench\t${value.sequence}\t${value.id}\n`);
      yield row("events", value);
    }
  }
  for (let i = 0; i < Math.floor(total * 0.05); i++) {
    const base = {
      room_id: "room-bench", criteria: "x", amount_millis: 1000, poster: "op_poster_0",
      verifier: "op_verifier", dispute_decider: "op_decider", approval_mode: "agent",
      state_changed_ms: MS1, deadline_ms: null, challenge_ends_ms: null, dispute_id: null,
      dispute_opened_ms: null, evidence_json: null, attestation_json: null, resolution_json: null,
      rubric_json: null, rubric_hash: "rh_x", rubric_version: 1, submission_hash: null,
      created_at: T0, updated_at: T1,
    };
    yield row("bounty_records", { ...base, bounty_id: `bty_bench_ref_${i}`, title: "refunded", claimant: "op_worker_0", state: "refunded" });
    yield row("bounty_records", { ...base, bounty_id: `bty_bench_prop_${i}`, title: "proposed", claimant: null, state: "proposed" });
  }
  yield json({ kind: "trailer", version: 2, events: eventSeq, eventsHash: eventHash.digest("hex"), tables: digests.finish() });
}

async function timeRun(source, state = null) {
  const started = Date.now();
  const result = await assembleWorkEpisodes({ source, state });
  return { wallMs: Date.now() - started, result };
}

async function main() {
  const settled = Number(argOf("settled", "1000"));
  const profile = argOf("profile", "field");
  const delta = Number(argOf("delta", "100"));
  if (process.argv.includes("--emit-snapshot")) {
    for await (const line of generateLines({ settled, profile })) process.stdout.write(`${line}\n`);
    return;
  }
  const full = await timeRun(generateLines({ settled, profile }));
  const incremental = await timeRun(generateLines({ settled, profile }), full.result.nextState);
  const deltaRun = await timeRun(generateLines({ settled, profile, extraSettled: delta }), full.result.nextState);
  const bounty = full.result.report.surfaces.bounty;
  const counters = full.result.report.triggerCounters;
  process.stdout.write(`${JSON.stringify({
    settled, profile,
    fullRun: {
      wallMs: full.wallMs,
      episodes: full.result.episodes.length,
      episodesPerSecond: Math.round(full.result.episodes.length / (full.wallMs / 1000)),
      settledComplete: bounty.settledComplete,
      settledTotal: bounty.settled,
      completenessPct: bounty.settled ? Math.round((bounty.settledComplete / bounty.settled) * 1000) / 10 : null,
      missingReasons: bounty.missingReasons,
      journalChainOk: full.result.report.journalChain.ok,
      journalLegsChecked: full.result.report.journalChain.checked,
    },
    triggerCounters: {
      settledOutcomes: counters.settledOutcomes,
      verifiedSettledOutcomes: counters.verifiedSettledOutcomes,
      selfDealingFlaggedAmongVerified: counters.selfDealingFlaggedAmongVerified,
      verifiedExcludingSelfDealing: counters.verifiedExcludingSelfDealing,
      distinctOperators: counters.distinctOperators,
      triggerFires: counters.trigger.fires,
    },
    incrementalIdentical: { wallMs: incremental.wallMs, emitted: incremental.result.episodes.length, carried: incremental.result.report.totals.carried },
    incrementalDelta: { delta, wallMs: deltaRun.wallMs, emitted: deltaRun.result.episodes.length },
    peakRssMb: Math.round(((process.resourceUsage().maxRSS ?? process.resourceUsage().maxrss ?? 0) / 1024) * 10) / 10,
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`extract-episodes-bench: ${error.stack ?? error.message}\n`);
  process.exit(2);
});
