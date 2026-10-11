// WAVE-500 guild 10/10 slice 21/50: approval-inbox seed CLI.
//
// Guards the seed CLI contract, not the sibling slices:
// - dry-run (default) prints kind/title/sourceRef per draft and creates nothing
// - retired / struck / parked entries never become drafts
// - --confirm requires --db; writes go through the store module contract
// - card ids are deterministic (seed-<sourceRef>) so re-runs skip present cards
// - a missing store module fails loudly instead of silently skipping writes
//
// Test-audit gate answers: the CLI is new, so no existing coverage protects
// it; the regression it guards is a seed that double-files cards, silently
// drops taps, or writes live cards during a dry run. The env overrides
// (APPROVAL_INBOX_IMPORT_PATH / APPROVAL_INBOX_STORE_PATH) are the only
// production seams, and they exist so tests stay deterministic whether or
// not the sibling slice modules have landed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "scripts", "approval-inbox-seed.mjs");
// Force the vendored parser so results are deterministic regardless of
// whether slice 8's server/approval-inbox-import.mjs has landed.
const FORCE_VENDORED_PARSER = {
  APPROVAL_INBOX_IMPORT_PATH: "/nonexistent-seed-test-dir/approval-inbox-import.mjs",
};

// Fixture: a small tap list exercising every skip rule plus classification.
const FIXTURE = [
  "## Security - do these first",
  "1. Revoke Clerk OAuth grant - github.com/settings/applications -> Clerk (one click).",
  "0. **Restore signing-key custody (tap #59) - RETIRED 2026-10-04: superseded.** gone.",
  "",
  "## Money - exact terms prepared, nothing moves without your word",
  "6. Receipt Challenge prizes - $1,500 pool or $750 lean.",
  "44. ~~**RSVP: \"MQ-X\" Zoom - Friday Oct 9.**~~ **RETIRED 2026-10-09** - window passed.",
  "",
  "## Parked - not actionable unless you reopen",
  "7. Some parked item - never a draft.",
  "",
  "## Decisions only you can make",
  "22. Launch-kit thesis - yes or no on the whole direction.",
  "",
  "## Added 2026-10-10 (credits-402 kill switch)",
  "- **Credits-402 owner kill switch - your call.** A 402 is firing. Options: (a) flip the owner kill switch to silence the 402, (b) leave the 402 live.",
].join("\n");

// Minimal fixture of the slice-1 store contract: ApprovalInboxStore with
// createCard/getCard and duplicate_card semantics, persisted in the sqlite
// db the CLI hands it (like the real server/approval-inbox-store.mjs, which
// owns the full contract and its own tests). This fixture only exercises the
// seed CLI's write path, including cross-process idempotency.
const FIXTURE_STORE = `
import { DatabaseSync } from "node:sqlite";
export class ApprovalInboxStore {
  constructor({ db } = {}) {
    this.db = db ?? new DatabaseSync(":memory:");
    this.db.exec("CREATE TABLE IF NOT EXISTS seed_cards (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  }
  getCard(id) {
    const row = this.db.prepare("SELECT payload FROM seed_cards WHERE id=?").get(id);
    return row ? JSON.parse(row.payload) : null;
  }
  createCard(card) {
    if (typeof card.id !== "string" || !card.id) throw new Error("id required");
    if (this.db.prepare("SELECT 1 FROM seed_cards WHERE id=?").get(card.id)) {
      const err = new Error("card " + card.id + " already exists");
      err.code = "duplicate_card";
      throw err;
    }
    const stored = { ...card, status: "pending" };
    this.db.prepare("INSERT INTO seed_cards (id, payload) VALUES (?, ?)").run(card.id, JSON.stringify(stored));
    return stored;
  }
}
`;

let scratch;
let tapFile;
let fixtureStorePath;

test.before(() => {
  scratch = mkdtempSync(join(tmpdir(), "inbox-seed-test-"));
  tapFile = join(scratch, "taps.md");
  writeFileSync(tapFile, FIXTURE);
  fixtureStorePath = join(scratch, "fixture-store.mjs");
  writeFileSync(fixtureStorePath, FIXTURE_STORE);
});

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...FORCE_VENDORED_PARSER, ...extraEnv },
  });
}

function stdoutLines(result) {
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

test("help exits 0 and prints usage", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--tap-file/);
});

test("missing --tap-file is a usage error", () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--tap-file/);
});

test("--confirm without --db is a usage error", () => {
  const r = runCli(["--tap-file", tapFile, "--confirm"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--confirm requires --db/);
});

test("--dry-run combined with --confirm is a usage error", () => {
  const r = runCli(["--tap-file", tapFile, "--db", join(scratch, "x.db"), "--dry-run", "--confirm"]);
  assert.equal(r.status, 2);
});

test("dry-run prints kind/title/sourceRef per draft and creates nothing", () => {
  const r = runCli(["--tap-file", tapFile]);
  assert.equal(r.status, 0);
  const lines = stdoutLines(r);
  const drafts = lines.filter((l) => l.startsWith("[would-create]"));
  assert.equal(drafts.length, 4);
  assert.ok(drafts.some((l) => /kind=identity sourceRef=tap-1 title=Revoke Clerk OAuth grant/.test(l)));
  assert.ok(drafts.some((l) => /kind=money sourceRef=tap-6 title=Receipt Challenge prizes/.test(l)));
  assert.ok(drafts.some((l) => /kind=permission sourceRef=tap-22 title=Launch-kit thesis/.test(l)));
  assert.ok(drafts.some((l) => /kind=permission sourceRef=added-2026-10-10-1 title=Credits-402 owner kill switch/.test(l)));
  assert.ok(lines.some((l) => /seed summary: drafts=4 skipped=0 would-create=4/.test(l)));
  assert.ok(!existsSync(join(scratch, "dry.db")), "dry-run must not create a db file");
});

test("retired, struck and parked entries never become drafts", () => {
  const r = runCli(["--tap-file", tapFile]);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes("sourceRef=tap-0"), "tap-0 is RETIRED");
  assert.ok(!r.stdout.includes("sourceRef=tap-44"), "tap-44 is struck + RETIRED");
  assert.ok(!r.stdout.includes("sourceRef=tap-7"), "tap-7 is parked");
});

test("dry-run with --db but no --confirm creates nothing", () => {
  const dbPath = join(scratch, "norun.db");
  const r = runCli(["--tap-file", tapFile, "--db", dbPath]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("[would-create]"));
  assert.ok(!existsSync(dbPath), "dry-run must not create the db file");
});

test("missing tap file fails cleanly", () => {
  const r = runCli(["--tap-file", join(scratch, "nope.md")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read tap file/);
});

test("missing store module fails loudly instead of silently skipping writes", () => {
  const r = runCli(
    ["--tap-file", tapFile, "--db", join(scratch, "writes.db"), "--confirm"],
    { APPROVAL_INBOX_STORE_PATH: "/nonexistent-seed-test-dir/approval-inbox-store.mjs" },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /approval-inbox store module not available/);
});

test("--confirm writes cards and re-running skips them (idempotent)", () => {
  const dbPath = join(scratch, "writes.db");
  const env = { APPROVAL_INBOX_STORE_PATH: fixtureStorePath };
  const first = runCli(["--tap-file", tapFile, "--db", dbPath, "--confirm"], env);
  assert.equal(first.status, 0);
  assert.ok(first.stdout.split("\n").some((l) => /seed summary: drafts=4 skipped=0 created=4 failed=0/.test(l)),
    "first run creates all drafts:\n" + first.stdout + first.stderr);
  const second = runCli(["--tap-file", tapFile, "--db", dbPath, "--confirm"], env);
  assert.equal(second.status, 0);
  assert.ok(second.stdout.split("\n").some((l) => /seed summary: drafts=4 skipped=4 created=0 failed=0/.test(l)),
    "second run skips every already-present card:\n" + second.stdout + second.stderr);
  assert.ok(!second.stdout.includes("[created]"), "no card is created twice");
});
