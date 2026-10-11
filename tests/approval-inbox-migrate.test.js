// WAVE-500 guild 10/10 slice 23/50: one-time tap-list -> approval-inbox migration.
// Fail-first: the migration runner must be dry-run by default, idempotent
// (run twice, same result), journal its decisions, and degrade clearly when
// sibling slices (parser #2588, store #2579) are not merged yet.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseArgs,
  runMigration,
  fallbackParseTapList,
  scanRetiredTaps,
} from "../scripts/approval-inbox-migrate.mjs";

const FIXTURE = `# Fixture taps

## Money
1. Buy the widget — $50 budget; your call. Options: (a) buy now (b) wait a week.
2. **Retired spend — RETIRED 2026-10-01.** Old news, do not migrate.
6. ~~Struck tap — gone~~

## Decisions
3. Ship the widget — yes or no?
3. Duplicate number — second tap numbered 3, costs $10.

## Parked — not actionable unless you reopen
4. Parked item — never becomes a draft.
`;

function makeDir() {
  return mkdtempSync(join(tmpdir(), "inbox-migrate-test-"));
}

// Minimal store shim implementing the documented slice-1 seam
// (server/approval-inbox-store.mjs, PR #2579): createCard throws an error
// with code "duplicate_card" on id collision; getCard returns null unknown.
function makeTestStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS approval_inbox_cards (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
    what TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '{}',
    options_json TEXT NOT NULL DEFAULT '[]', requested_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'pending'
  )`);
  const insert = db.prepare(`INSERT INTO approval_inbox_cards
    (id, kind, title, what, context_json, options_json, requested_by, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
  return {
    createCard({ id, kind, title, what, context, options = [], requestedBy }) {
      try {
        insert.run(id, kind, title, what, JSON.stringify(context ?? {}),
          JSON.stringify(options), requestedBy, Date.now());
      } catch (error) {
        if (String(error?.message ?? "").includes("UNIQUE constraint failed")) {
          const dup = new Error(`card ${id} already exists`);
          dup.code = "duplicate_card";
          throw dup;
        }
        throw error;
      }
      return this.getCard(id);
    },
    getCard(id) {
      const row = db.prepare("SELECT * FROM approval_inbox_cards WHERE id=?").get(id);
      return row ? { id: row.id, kind: row.kind, title: row.title, status: row.status } : null;
    },
    close() { db.close(); },
  };
}

function fixtureOpts(dir, extra = {}) {
  const tapsPath = join(dir, "TAPS.md");
  writeFileSync(tapsPath, FIXTURE);
  return {
    tapsPath,
    journalPath: join(dir, "migration.json"),
    dbPath: join(dir, "inbox.db"),
    apply: true,
    createStore: dbPath => makeTestStore(dbPath),
    ...extra,
  };
}

test("parseArgs defaults to dry-run; --apply requires --db", () => {
  const dry = parseArgs([]);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.apply, false);
  const applied = parseArgs(["--apply", "--db", "/tmp/x.db"]);
  assert.equal(applied.apply, true);
  assert.equal(applied.dbPath, "/tmp/x.db");
  assert.throws(() => parseArgs(["--apply"]), /--db/);
});

test("fallback parser honors the slice-8 seam: skips retired, struck, parked", () => {
  const drafts = fallbackParseTapList(FIXTURE);
  const refs = drafts.map(d => d.sourceRef);
  // The parser reports raw refs (dedup to tap-3#2 happens in the runner's journal keys).
  assert.deepEqual(refs, ["tap-1", "tap-3", "tap-3"]);
  assert.ok(!refs.includes("tap-2"), "RETIRED tap skipped");
  assert.ok(!refs.includes("tap-6"), "struck tap skipped");
  assert.ok(!refs.includes("tap-4"), "parked-section tap skipped");
  assert.equal(drafts[0].kind, "permission"); // "your call" beats the $50 money keyword
  assert.equal(drafts[2].kind, "money"); // $10, no permission override
});

test("scanRetiredTaps records retired + skip-section items for the journal", () => {
  const skipped = scanRetiredTaps(FIXTURE);
  assert.equal(skipped["tap-2"], "retired");
  assert.equal(skipped["tap-6"], "retired");
  assert.equal(skipped["tap-4"], "skip-section");
  assert.ok(!("tap-1" in skipped));
});

test("apply run migrates drafts, journals decisions, skips retired", async () => {
  const dir = makeDir();
  const summary = await runMigration(fixtureOpts(dir));
  assert.equal(summary.draftsCreated, 3);
  assert.equal(summary.skippedRetired, 2);
  assert.equal(summary.alreadyPresent, 0);
  const journal = JSON.parse(readFileSync(join(dir, "migration.json"), "utf8"));
  assert.equal(journal.created["tap-1"], "tap-migrate-tap-1");
  assert.equal(journal.created["tap-3#2"], "tap-migrate-tap-3-2");
  assert.equal(journal.skipped["tap-2"], "retired");
  assert.equal(journal.skipped["tap-4"], "skip-section");
  summary.store.close();
});

test("idempotency: second run creates nothing, journal unchanged", async () => {
  const dir = makeDir();
  const first = await runMigration(fixtureOpts(dir));
  first.store.close();
  const before = readFileSync(join(dir, "migration.json"), "utf8");
  const second = await runMigration(fixtureOpts(dir));
  second.store.close();
  assert.equal(second.draftsCreated, 0);
  assert.equal(second.alreadyPresent, 3);
  assert.equal(second.skippedRetired, 2);
  const after = readFileSync(join(dir, "migration.json"), "utf8");
  assert.deepEqual(JSON.parse(after).created, JSON.parse(before).created);
  assert.deepEqual(JSON.parse(after).skipped, JSON.parse(before).skipped);
});

test("dry-run writes nothing: no journal, no cards", async () => {
  const dir = makeDir();
  const summary = await runMigration(fixtureOpts(dir, { apply: false, dryRun: true }));
  assert.equal(summary.draftsCreated, 0);
  assert.equal(summary.planned, 3);
  assert.ok(!existsSync(join(dir, "migration.json")), "dry-run must not write the journal");
  assert.ok(!existsSync(join(dir, "inbox.db")), "dry-run must not create a database");
});

test("--apply without a store seam degrades with a clear error", async () => {
  const dir = makeDir();
  const tapsPath = join(dir, "TAPS.md");
  writeFileSync(tapsPath, FIXTURE);
  const failure = await runMigration({
    tapsPath,
    journalPath: join(dir, "migration.json"),
    dbPath: join(dir, "inbox.db"),
    apply: true,
    storePath: join(dir, "does-not-exist-store.mjs"), // sibling slice not merged
  }).then(() => null, error => error);
  assert.ok(failure, "must reject");
  assert.match(failure.message, /store.*not .*merged|unavailable/i);
});
