# Guild-09 BUG CONFIRMED log

The BUG CONFIRMED muse-room post ceremony was retired 2026-10-07; findings are
recorded here and surfaced in the DONE-ROLLUP. No third room post is made.

## BUG-1 (2026-10-09): columnExists() in server/analytics/schema.mjs:90-91 — two survived mutants

**Repro (both verified):**
1. L90: `if (!tableExists(db, table)) return false;` → `return true;`
2. L91: `.some(row => row.name === column)` → `.some(row => row.name !== column)`

**Method:** mutation unit m10 ran 5 analytics suites importing the module
(analytics-catalog, analytics-derive, analytics-export, analytics-sampling,
analytics-tail) — all green under both mutants. Baseline green.

**Why it's a real bug:** `columnExists` guards real derivation logic —
server/analytics/derive-tables.mjs:297 skips the referrals derivation when the
column is absent. Mutant 1 (missing table reports column present) or mutant 2
(any differing column name reports present) would let derivation query a
nonexistent column → SQL failure / wrong analytics output. No suite asserted
`columnExists` negative cases.

**Fix:** fail-first regression added to tests/analytics-derive.test.js
("columnExists is true only for the exact column on an existing table
(guild-09 fail-first)"). Verified red under both mutants, green on clean code.
Committed as 2f3f890b8 on wave1000/guild-09.
