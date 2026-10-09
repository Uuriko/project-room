// worker-19 shard-19 hardening: fail-first regression tests for three bugs
// found by fuzzing the shard's exported functions.
//   1. scripts/herdr-migrate.mjs batchPlan: batchSize 0/negative/NaN hangs
//      forever (i += 0 never advances). Repro: batchPlan([{index:0}], 0)
//      had to be killed by timeout (exit 124).
//   2. scripts/herdr-migrate.mjs journal readers: a journal line that is valid
//      JSON but not an object (42, "str", null) crashes linkedClaimIds /
//      findTerminalEntry with TypeError, and would crash every command that
//      re-reads the journal (scan/plan/migrate/drain-status/reap-orphans/status).
//      Repro: linkedClaimIds([42, "str", null], "r") -> TypeError.
//   3. scripts/synthetic-mail-fixture.mjs outcome(): unknown operationId
//      throws TypeError (cannot read 'receipt' of undefined) instead of a
//      clear diagnostic. Repro: new SyntheticMailFixture(db).outcome("nope","accepted").
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  batchPlan, linkedClaimIds, findTerminalEntry, readJournal, appendJournalEntry,
} from "../scripts/herdr-migrate.mjs";
import { SyntheticMailFixture } from "../scripts/synthetic-mail-fixture.mjs";

// --- 1. batchPlan must reject non-positive batch sizes instead of hanging
for (const bad of [0, -1, NaN, 1.5, Infinity]) {
  test(`batchPlan rejects batchSize=${String(bad)}`, () => {
    assert.throws(() => batchPlan([{ index: 0 }], bad), /batch/i);
  });
}
test("batchPlan still batches normally", () => {
  const plan = [0, 1, 2, 3, 4].map((index) => ({ index }));
  assert.deepEqual(batchPlan(plan, 2).map((b) => b.length), [2, 2, 1]);
});

// --- 2. journal readers tolerate non-object lines
test("readJournal skips non-object lines, keeps objects", () => {
  const dir = mkdtempSync(join(tmpdir(), "w19-"));
  const p = join(dir, "j.jsonl");
  writeFileSync(p, '{"kind":"backfill_done","idempotency_key":"k"}\n42\n"str"\nnull\n[1]\n');
  const entries = readJournal(p);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "backfill_done");
});
test("linkedClaimIds ignores non-object entries", () => {
  const linked = linkedClaimIds(
    [null, 42, "str", { room_id: "r", kind: "session_attached", claim_id: "c", session_id: "s" }],
    "r",
  );
  assert.deepEqual([...linked], ["c"]);
});
test("findTerminalEntry ignores non-object entries", () => {
  const found = findTerminalEntry(
    [null, 42, { idempotency_key: "k", kind: "backfill_done" }],
    "k",
  );
  assert.equal(found.kind, "backfill_done");
  assert.equal(findTerminalEntry([null, 42], "k"), null);
});
test("journal roundtrip still assigns seq after junk lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "w19-"));
  const p = join(dir, "j.jsonl");
  writeFileSync(p, '42\n');
  const e = appendJournalEntry(p, { kind: "backfill_plan", room_id: "r" });
  assert.equal(e.seq, 1);
  assert.equal(readJournal(p).length, 1);
});

// --- 3. synthetic-mail-fixture outcome() diagnoses unknown ids
test("outcome() on unknown operationId throws a clear error", () => {
  const dir = mkdtempSync(join(tmpdir(), "w19-"));
  const f = new SyntheticMailFixture(join(dir, "mail.db"));
  assert.throws(() => f.outcome("nope", "accepted"), /unknown operationId.*nope/i);
  f.close();
});
test("outcome() still updates a known operation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w19-"));
  const f = new SyntheticMailFixture(join(dir, "mail.db"));
  await f.submit({ operationId: "op1", envelope: { previewVersion: 1 } });
  f.outcome("op1", "rejected");
  assert.equal((await f.lookup({ operationId: "op1" })).outcome, "rejected");
  f.close();
});
