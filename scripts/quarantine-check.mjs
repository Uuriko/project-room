#!/usr/bin/env node
/**
 * scripts/quarantine-check.mjs
 *
 * Zero-Bug System: flaky-test quarantine gate.
 *
 * Reads tests/quarantine.json and fails (exit 1) when any entry violates
 * the quarantine contract:
 *   1. repair_by is in the past (overdue) — CI fails until the entry is
 *      repaired (test fixed and re-admitted) or the repair-by date is moved
 *      with justification in the reason field.
 *   2. quarantined_at is older than 14 days AND the entry has no owner —
 *      an ownerless flake that lingers forever defeats the quarantine.
 *   3. the entry's test file does not exist (F-28, under #3673) — a
 *      renamed-away test otherwise leaves a dead entry that passes every
 *      other check while running nothing.
 *
 * Additional sanity checks: malformed entries, unparseable dates,
 * quarantined_at in the future, repair_by beyond the 14-day cap.
 *
 * Zero-count canary (F-28): an empty list must not pass vacuously. On
 * every run the existence predicate is exercised against a synthetic
 * dead entry (must be rejected) and against this run's own quarantine
 * file (must be accepted); if the predicate cannot fail, the gate fails
 * itself and says so.
 *
 * Dependency-free: uses only node builtins.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MAX_QUARANTINE_DAYS = 14;

function usageError(msg) {
  console.error(`quarantine-check: ${msg}`);
  process.exit(2);
}

function dayDiffISO(fromISO, toDate) {
  // Whole-calendar-day difference between an ISO date string and a Date.
  const from = new Date(fromISO + "T00:00:00Z");
  if (Number.isNaN(from.getTime())) return null;
  const to = new Date(
    Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate()),
  );
  return Math.round((to - from) / 86_400_000);
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(new Date(s + "T00:00:00Z").getTime());
}

const here = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = process.argv[2] ?? path.join(here, "..", "tests", "quarantine.json");

let data;
try {
  data = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (err) {
  usageError(`cannot read/parse ${jsonPath}: ${err.message}`);
}

if (!data || !Array.isArray(data.quarantined)) {
  usageError(`${jsonPath} must contain {"quarantined": [...]}`);
}

// F-28 existence check: entry.test is "file" or "file > test name"; the
// file part must exist relative to the repo root (the parent of the
// directory holding the quarantine file).
const repoRoot = path.dirname(path.dirname(path.resolve(jsonPath)));

function entryTestFile(entry) {
  if (typeof entry?.test !== "string") return null;
  const file = entry.test.split(" > ")[0].trim();
  return file.length > 0 ? file : null;
}

function testFileExists(entry) {
  const file = entryTestFile(entry);
  return file !== null && existsSync(path.join(repoRoot, file));
}

// Zero-count canary: prove the existence predicate can fail (dead entry
// rejected) and can pass (this run's own quarantine file, named as a
// pseudo-entry, is accepted). Runs on every invocation, empty list or
// not, so the gate never passes vacuously (F-28 / battery-gamma C-L8).
{
  const deadEntry = { test: "tests/__quarantine_canary_missing__.test.js" };
  const liveEntry = { test: path.relative(repoRoot, path.resolve(jsonPath)) };
  if (testFileExists(deadEntry) || !testFileExists(liveEntry)) {
    console.error(
      "quarantine-check: CANARY FAILURE — the existence predicate did not behave " +
      "(dead entry must be rejected, the quarantine file itself must be accepted). " +
      "The gate would pass vacuously; failing itself instead.",
    );
    process.exit(1);
  }
}

const now = new Date();
const violations = [];

data.quarantined.forEach((entry, idx) => {
  const label = entry?.test ? `"${entry.test}"` : `entry #${idx}`;
  const problems = [];

  if (!entry || typeof entry !== "object") {
    problems.push("entry is not an object");
    violations.push({ label, problems });
    return;
  }
  if (typeof entry.test !== "string" || !entry.test.trim()) {
    problems.push('missing/empty "test" (file or "file > test name")');
  } else if (!testFileExists(entry)) {
    problems.push(
      `test file "${entryTestFile(entry)}" does not exist — dead entry (test renamed or removed?)`,
    );
  }
  if (typeof entry.reason !== "string" || !entry.reason.trim()) {
    problems.push('missing/empty "reason" (failure signature)');
  }
  const hasOwner = typeof entry.owner === "string" && entry.owner.trim().length > 0;
  if (!isISODate(entry.quarantined_at)) {
    problems.push('"quarantined_at" must be an ISO date (YYYY-MM-DD)');
  }
  if (!isISODate(entry.repair_by)) {
    problems.push('"repair_by" must be an ISO date (YYYY-MM-DD)');
  }
  if (isISODate(entry.quarantined_at) && isISODate(entry.repair_by)) {
    const ageDays = dayDiffISO(entry.quarantined_at, now);
    const untilRepairDays = dayDiffISO(
      now.toISOString().slice(0, 10),
      new Date(entry.repair_by + "T00:00:00Z"),
    );
    if (ageDays !== null && ageDays < 0) {
      problems.push(`"quarantined_at" (${entry.quarantined_at}) is in the future`);
    }
    const span = dayDiffISO(entry.quarantined_at, new Date(entry.repair_by + "T00:00:00Z"));
    if (span !== null && span > MAX_QUARANTINE_DAYS) {
      problems.push(
        `"repair_by" (${entry.repair_by}) is ${span} days after "quarantined_at" — cap is ${MAX_QUARANTINE_DAYS} days`,
      );
    }
    if (untilRepairDays !== null && untilRepairDays < 0) {
      problems.push(
        `OVERDUE: repair_by (${entry.repair_by}) passed ${-untilRepairDays} day(s) ago — repair the test or re-admit it`,
      );
    }
    if (!hasOwner && ageDays !== null && ageDays > MAX_QUARANTINE_DAYS) {
      problems.push(
        `OWNERLESS: quarantined ${ageDays} days ago with no owner — stale flakes need an owner`,
      );
    }
  }

  if (problems.length > 0) violations.push({ label, problems });
});

if (violations.length === 0) {
  console.log(
    `quarantine-check: OK — ${data.quarantined.length} quarantined test(s), all within contract`,
  );
  console.log(
    "quarantine-check: canary OK — existence predicate rejected a synthetic dead entry and accepted a live file (zero-count canary, F-28)",
  );
  process.exit(0);
}

console.error(
  `quarantine-check: FAIL — ${violations.length} quarantined test(s) violate the contract:`,
);
for (const { label, problems } of violations) {
  console.error(`\n  ${label}`);
  for (const p of problems) console.error(`    - ${p}`);
}
process.exit(1);
