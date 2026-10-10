// fixwave C2 — fail-first tests for WAVE-500 B1/B2 (scripts/herdr-migrate.mjs).
//
// B1: one torn journal line must not brick the tool — readJournal skips
//     malformed lines with a warning and reports the count.
// B2: concurrent runs must not interleave seq assignment — appendJournalEntry
//     holds an exclusive sidecar lock for the read+append critical section.
//
// Pure core is imported from the script; TMPDIR-backed journal paths only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  appendJournalEntry,
  readJournal,
  readJournalReport,
  withJournalLock,
} from "../scripts/herdr-migrate.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "herdr-migrate-journal-test-"));
const scriptUrl = new URL("../scripts/herdr-migrate.mjs", import.meta.url).href;

test("B1: readJournal skips malformed lines, warns on stderr, and reports the count", () => {
  const dir = tmp();
  const journalPath = join(dir, "torn.journal.jsonl");
  const good1 = appendJournalEntry(journalPath, { kind: "backfill_start", room_id: "r", claim_id: "c1", idempotency_key: "k1" });
  appendFileSync(journalPath, "{torn json\n", "utf8");
  appendFileSync(journalPath, "definitely not json\n", "utf8");
  appendFileSync(journalPath, "\n", "utf8"); // blank lines stay ignorable, not "malformed"
  const good2 = appendJournalEntry(journalPath, { kind: "backfill_done", room_id: "r", claim_id: "c1", idempotency_key: "k1" });

  let warned = "";
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { warned += String(chunk); return origWrite(chunk, ...rest); };
  let report;
  try {
    report = readJournalReport(journalPath); // must not throw
  } finally {
    process.stderr.write = origWrite;
  }
  const entries = report.entries;
  assert.equal(entries.length, 2, "good entries survive the torn lines");
  assert.deepEqual(entries.map(e => e.seq), [good1.seq, good2.seq]);
  assert.equal(report.skippedMalformed, 2, "skipped count is reported");
  assert.deepEqual(readJournal(journalPath), entries, "readJournal keeps its plain-array contract");
  assert.match(warned, /skipped 2 malformed journal line/, "operator warning names the count");
  assert.match(warned, /torn\.journal\.jsonl/, "operator warning names the journal");
});

test("B1: a journal that is entirely torn still yields an empty readable journal", () => {
  const dir = tmp();
  const journalPath = join(dir, "all-torn.journal.jsonl");
  writeFileSync(journalPath, "{nope\n{{{{{\n", "utf8");
  const report = readJournalReport(journalPath);
  assert.deepEqual(report.entries, []);
  assert.equal(report.skippedMalformed, 2);
});

test("B1: a missing journal still reads as empty with a zero skip count", () => {
  const report = readJournalReport(join(tmp(), "does-not-exist.journal.jsonl"));
  assert.deepEqual(report.entries, []);
  assert.equal(report.skippedMalformed, 0);
});

test("B2: withJournalLock serializes across processes and reclaims a stale lock", async () => {
  const dir = tmp();
  const journalPath = join(dir, "locked.journal.jsonl");
  // A stale lockfile from a dead pid must not block the next run.
  writeFileSync(`${journalPath}.lock`, "2147483646\n", { mode: 0o600 });
  const ran = withJournalLock(journalPath, () => "ran-under-lock");
  assert.equal(ran, "ran-under-lock");
  assert.equal(existsSync(`${journalPath}.lock`), false, "stale lock reclaimed, lock released after fn");

  // A live holder blocks a contender until the timeout.
  const child = `
    const { withJournalLock } = await import(${JSON.stringify(scriptUrl)});
    const t0 = Date.now();
    try {
      withJournalLock(${JSON.stringify(journalPath)}, () => {}, { timeoutMs: 800 });
      console.log("ACQUIRED after " + (Date.now() - t0) + "ms");
    } catch (e) {
      console.log("BLOCKED: " + e.message);
      process.exit(3);
    }
  `;
  let childOut = "";
  withJournalLock(journalPath, () => {
    try {
      childOut = execFileSync(process.execPath, ["--input-type=module", "-e", child], { timeout: 10000 }).toString();
    } catch (e) {
      childOut = (e.stdout ?? "").toString();
      assert.equal(e.status, 3, "contender times out while the lock is held");
    }
  });
  assert.match(childOut, /BLOCKED: .*lock contention/, "contender reports contention, not silent success");

  // After release the contender acquires cleanly.
  const ok = execFileSync(process.execPath, ["--input-type=module", "-e", child], { timeout: 10000 }).toString();
  assert.match(ok, /ACQUIRED/, "lock is acquirable again after release");
});

test("B2: N concurrent processes appending to one journal get unique sequential seqs", { timeout: 60000 }, () => {
  const dir = tmp();
  const journalPath = join(dir, "race.journal.jsonl");
  const workers = 4;
  const perWorker = 5;
  const child = `
    const { appendJournalEntry } = await import(${JSON.stringify(scriptUrl)});
    for (let i = 0; i < ${perWorker}; i++) {
      appendJournalEntry(${JSON.stringify(journalPath)}, { kind: "race_probe", n: i });
    }
  `;
  const procs = [];
  for (let w = 0; w < workers; w++) {
    procs.push(execFileSync(process.execPath, ["--input-type=module", "-e", child], { timeout: 30000 }));
  }
  assert.equal(procs.length, workers, "every worker appended without lock contention errors");
  const entries = readJournal(journalPath);
  assert.equal(entries.length, workers * perWorker, "no entry lost");
  const seqs = entries.map(e => e.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: workers * perWorker }, (_, i) => i + 1),
    "seqs are unique and gap-free: no two runs computed the same seq");
});
