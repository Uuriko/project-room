// tests/coord300-wave-accounting.test.js
// COORD-300 guild-02 — honest wave accounting: planned vs spawned vs runnable
// vs finished are separate numbers; costs are "unknown" unless receipts exist.
// Offline, fixture-backed (Dot constraint): no live reads in tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { accountWave, parseTs } from "../scripts/measure-wave-overhead.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/coord300");
const clean = readFileSync(join(FX, "ledger-clean.md"), "utf8");
const poisoned = readFileSync(join(FX, "ledger-poisoned.md"), "utf8");

test("parseTs handles ledger timestamp shapes", () => {
  assert.equal(parseTs("x 2026-10-09T08:35:00-07:00 y"), Date.parse("2026-10-09T08:35:00-07:00"));
  assert.equal(parseTs("x 2026-10-09T08:35-07:00 y"), Date.parse("2026-10-09T08:35:00-07:00"));
  assert.equal(parseTs("no timestamp here"), null);
});

test("clean ledger: the four counts stay separate and correct", () => {
  const r = accountWave({ ledgerText: clean });
  assert.equal(r.counts.planned, 2040);
  assert.equal(r.counts.spawnedCoordinators, 4);
  assert.equal(r.counts.spawnedWorkersUnique, 150); // G01 + G03 + G04, 50 each
  assert.deepEqual(r.counts.finishedGuilds, ["02"]);
  assert.equal(r.counts.finishedCount, 1);
  // prose-reported completions (05, 06) are weaker evidence: separate field
  assert.deepEqual(r.counts.finishedProseReported, ["05", "06"]);
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.anomalies.length, 0);
});

test("clean ledger: runnable comes from the latest heartbeat, marked approximate", () => {
  const r = accountWave({ ledgerText: clean });
  assert.equal(r.counts.runnable.agents, 153);
  assert.equal(r.counts.runnable.approximate, true);
});

test("clean ledger: queue wait measured per guild spawn phase", () => {
  const r = accountWave({ ledgerText: clean });
  const g01 = r.queue.find((q) => q.guild === "01");
  const g03 = r.queue.find((q) => q.guild === "03");
  const g04 = r.queue.find((q) => q.guild === "04");
  // G01: pilot 08:35 -> 50/50 @ 09:10 = 35 min (lower bound)
  assert.equal(g01.spawnPhaseMs, 35 * 60 * 1000);
  assert.equal(g01.lowerBound, true);
  // G03: first timestamped signal 09:35 heartbeat -> 50/50 @ 10:05 = 30 min
  assert.equal(g03.spawnPhaseMs, 30 * 60 * 1000);
  // G04: completion with no prior start signal -> unknown, never zero
  assert.equal(g04.spawnPhaseMs, "unknown");
  assert.equal(g04.lowerBound, false);
});

test("clean ledger: costs are unknown, never invented", () => {
  const r = accountWave({ ledgerText: clean });
  assert.equal(r.costs, "unknown");
  assert.match(JSON.stringify(r), /unknown/);
  // the JSON must not contain a numeric cost estimate field
  assert.ok(!("costUnits" in r) && !("costTokens" in r));
});

test("NEGATIVE CONTROL: poisoned ledger is flagged, never silently counted", () => {
  const r = accountWave({ ledgerText: poisoned });
  const kinds = r.duplicates.map((d) => d.kind).sort();
  assert.ok(kinds.includes("guild-spawned-twice"), "duplicate Guild 01 spawn flagged");
  assert.ok(kinds.includes("guild-done-twice"), "duplicate Guild 03 DONE flagged");
  const anomalyTypes = r.anomalies.map((a) => a.type);
  assert.ok(anomalyTypes.includes("done-before-wave-start"), "Guild 02 DONE-before-start flagged");
  // unique guilds counted once: 3 coordinators, not 4 spawn lines
  assert.equal(r.counts.spawnedCoordinators, 3);
});

test("NEGATIVE CONTROL: poisoned ledger still refuses cost estimates", () => {
  const r = accountWave({ ledgerText: poisoned });
  assert.equal(r.costs, "unknown");
});

test("branch census: ref list maps to branch guilds", () => {
  const refLines = [
    "aaa\trefs/heads/wave2000/guild-01",
    "bbb\trefs/heads/wave2000/guild-02",
    "ccc\trefs/heads/main",
  ];
  const r = accountWave({ ledgerText: clean, refLines });
  assert.equal(r.counts.branchesOnOrigin, 2);
  assert.deepEqual(r.counts.branchGuilds, ["01", "02"]);
});
