// Fail-first tests for FIX-56: the telemetry keeper's adoption board.
// scripts/telemetry-adoption.mjs scans the repo for telemetry emitters,
// validates each emitter's output against the schema registry
// (scripts/telemetry-schema.mjs `validateRecord`), and renders the
// GENERATED adoption report docs/telemetry/adoption.md.
//
// Written fail-first: before the keeper exists these tests fail on import.
// After the keeper lands, fixture emitters prove the three statuses work:
// CONFORMANT (output validates), DRIFTED (output fails, details attached),
// UNKNOWN (emitter can't be driven / module not in tree yet).
//
// Run: TMPDIR=$PWD/.tmp node --test tests/telemetry-adoption.test.js
import test from "node:test";
import assert from "node:assert/strict";

import {
  STATUSES,
  envelope,
  checkEmitter,
  renderAdoptionReport,
  collectAdoption,
  EMITTERS,
} from "../scripts/telemetry-adoption.mjs";

function goodEmitter() {
  return {
    id: "fx-conformant",
    name: "Fixture conformant emitter",
    kind: "sample",
    output: "fixture.jsonl",
    async obtain() {
      return {
        records: [
          envelope({ kind: "sample", window: { ticks: 2 }, self: { healthy: true } }),
          envelope({ kind: "sample", window: { ticks: 3 }, self: { healthy: true } }),
        ],
      };
    },
  };
}

function driftedEmitter() {
  return {
    id: "fx-drifted",
    name: "Fixture drifted emitter",
    kind: "sample",
    output: "fixture-drift.jsonl",
    async obtain() {
      // v/ts envelope dropped by a bad refactor: shape drifts from the registry.
      return {
        records: [
          { kind: "sample", window: { ticks: 2 }, self: { healthy: true } },
          { kind: "sample", window: { ticks: 3 } }, // also dropped `self`
        ],
      };
    },
  };
}

function unknownEmitter() {
  return {
    id: "fx-unknown",
    name: "Fixture unknown emitter",
    kind: "gauge",
    output: "fixture-missing.jsonl",
    async obtain() {
      return { unavailable: "emitter module not present in tree (branch unmerged)" };
    },
  };
}

function throwingEmitter() {
  return {
    id: "fx-throwing",
    name: "Fixture throwing emitter",
    kind: "probe",
    output: "fixture-throw.jsonl",
    async obtain() {
      throw new Error("offline sampler hit a live credential requirement");
    },
  };
}

test("CONFORMANT: a fixture emitter whose records validate gets CONFORMANT", async () => {
  const r = await checkEmitter(goodEmitter());
  assert.equal(r.id, "fx-conformant");
  assert.equal(r.status, "CONFORMANT");
  assert.equal(r.recordsChecked, 2);
  assert.deepEqual(r.drifts, []);
});

test("DRIFTED: a fixture emitter with a broken envelope gets DRIFTED with details", async () => {
  const r = await checkEmitter(driftedEmitter());
  assert.equal(r.status, "DRIFTED");
  assert.equal(r.recordsChecked, 2);
  assert.ok(r.drifts.length >= 1, "drift details must be attached");
  const detail = r.drifts.join("\n");
  assert.match(detail, /v must be 1/, "missing v is reported");
  assert.match(detail, /missing required field "self"/, "missing required payload field is reported");
});

test("UNKNOWN: an unavailable emitter gets UNKNOWN, never DRIFTED", async () => {
  const r = await checkEmitter(unknownEmitter());
  assert.equal(r.status, "UNKNOWN");
  assert.match(r.note, /not present in tree/, "reason is recorded");
  assert.deepEqual(r.drifts, []);
});

test("UNKNOWN: a sampler that throws gets UNKNOWN with the error as the reason", async () => {
  const r = await checkEmitter(throwingEmitter());
  assert.equal(r.status, "UNKNOWN");
  assert.match(r.note, /credential requirement/);
});

test("renderAdoptionReport documents the keeper and boards all three statuses", async () => {
  const results = [
    await checkEmitter(goodEmitter()),
    await checkEmitter(driftedEmitter()),
    await checkEmitter(unknownEmitter()),
  ];
  const md = renderAdoptionReport({ results, generatedAt: "2026-10-09T20:55:00.000Z" });
  assert.match(md, /Telemetry keeper/, "keeper role is documented at the top");
  assert.match(md, /scripts\/telemetry-adoption\.mjs/, "keeper file is named as owner");
  assert.match(md, /CONFORMANT/);
  assert.match(md, /DRIFTED/);
  assert.match(md, /UNKNOWN/);
  assert.match(md, /Fixture conformant emitter/);
  assert.match(md, /v must be 1/, "drift details land in the board");
  assert.match(md, /advisory/i, "board is advisory, not a CI gate");
  assert.match(md, /GENERATED/, "report is marked generated");
});

test("collectAdoption covers the four converged squads with a valid status each", { timeout: 120_000 }, async () => {
  const { results, discovered } = await collectAdoption({});
  assert.ok(Array.isArray(discovered), "discovery runs alongside the sweep");
  const ids = results.map((r) => r.id).sort();
  assert.deepEqual(ids, ["fix22c-ci-queue", "fix54-room-collector", "fix55-capacity-digest", "fix78-board-probe"]);
  for (const r of results) {
    assert.ok(STATUSES.includes(r.status), `${r.id} status must be one of ${STATUSES.join(", ")}`);
    if (r.status === "DRIFTED") assert.ok(r.drifts.length > 0, `${r.id} drifted without details`);
  }
  assert.equal(EMITTERS.length, 4, "registry owns exactly the four converged emitters");
});
