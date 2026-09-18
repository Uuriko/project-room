// Review-coverage dashboard (server/quarantine-review-coverage.mjs): pure
// aggregation over quarantine journal rows plus the read-only CLI over a real
// store file. Fixture signals, accounts, and reviewers are invented.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reviewCoverageBySignal, ReviewCoverageError } from "../server/quarantine-review-coverage.mjs";

const NOW = 1_750_000_000_000;
const DAY = 24 * 3600 * 1000;

const signal = (key, weight = 25) => ({ key, weight, detail: `${key} detail` });
const row = (overrides = {}) => ({
  id: "qz-1", messageId: "m-1", status: "held",
  quarantinedAt: NOW - 2 * DAY, score: 80,
  reason: [signal("telegram_giveaway_lure")],
  ...overrides,
});
const signalOf = report => key => report.perSignal.find(s => s.key === key);

// --- aggregation ----------------------------------------------------------------

test("per-signal counts and the reviewCoverage ratio", () => {
  const report = reviewCoverageBySignal({ rows: [
    row({ id: "qz-1", status: "held" }),
    row({ id: "qz-2", status: "released" }),
    row({ id: "qz-3", status: "dismissed" }),
  ], now: NOW });
  assert.equal(report.generatedAt, NOW);
  const s = signalOf(report)("telegram_giveaway_lure");
  assert.equal(s.held, 1);
  assert.equal(s.confirmed, 1, "released = Confirm (verdict: not spam)");
  assert.equal(s.dismissed, 1, "dismissed = Dismiss (confirmed spam)");
  assert.equal(s.reviewed, 2);
  assert.equal(s.total, 3);
  assert.equal(s.reviewCoverage, 2 / 3);
  assert.equal(s.shareOfHolds, 1);
  assert.equal(s.split, 0);
  assert.equal(report.totals.reviewCoverage, 2 / 3);
  assert.equal(report.totals.reviewed, 2);
  assert.deepEqual(report.zeroCoverageSignals, []);
});

test("a row fires once per signal and shareOfHolds can sum past 1", () => {
  const report = reviewCoverageBySignal({ rows: [
    row({ id: "qz-1", reason: [signal("alpha"), signal("beta")] }),
  ], now: NOW });
  const byKey = signalOf(report);
  assert.equal(byKey("alpha").total, 1);
  assert.equal(byKey("beta").total, 1);
  assert.equal(byKey("alpha").shareOfHolds, 1);
  assert.equal(byKey("beta").shareOfHolds, 1);
});

test("least-covered signals lead; zero-coverage signals are listed as the gap", () => {
  const report = reviewCoverageBySignal({ rows: [
    row({ id: "qz-1", reason: [signal("fully")] }),
    row({ id: "qz-2", status: "released", reason: [signal("fully")] }),
    row({ id: "qz-3", reason: [signal("unseen")] }),
    row({ id: "qz-4", status: "dismissed", reason: [signal("half")] }),
    row({ id: "qz-5", reason: [signal("half")] }),
  ], now: NOW });
  const keys = report.perSignal.map(s => s.key);
  assert.deepEqual(keys, ["unseen", "fully", "half"], "0 first, then alphabetical on the tie");
  assert.equal(signalOf(report)("unseen").reviewCoverage, 0);
  assert.equal(signalOf(report)("half").reviewCoverage, 1 / 2);
  assert.equal(signalOf(report)("fully").reviewCoverage, 1 / 2, "released + held = half");
  assert.deepEqual(report.zeroCoverageSignals, ["unseen"]);
});

test("split is a thread action, not a verdict: it overlaps held/reviewed states", () => {
  const report = reviewCoverageBySignal({ rows: [
    row({ id: "qz-1", reason: [signal("alpha")] }),
    row({ id: "qz-2", status: "dismissed", reason: [signal("alpha")] }),
    row({ id: "qz-3", reason: [signal("beta")] }),
  ], splits: new Set(["qz-1", "qz-2", "qz-missing"]), now: NOW });
  assert.equal(signalOf(report)("alpha").split, 2, "split held + split dismissed both count");
  assert.equal(signalOf(report)("beta").split, 0);
  assert.equal(signalOf(report)("alpha").held, 1);
  assert.equal(signalOf(report)("alpha").dismissed, 1);
  assert.equal(report.totals.split, 2, "unknown split ids are ignored");
});

test("empty queue: coverage is honest absence, not perfection", () => {
  const report = reviewCoverageBySignal({ rows: [], now: NOW });
  assert.equal(report.totals.reviewCoverage, null);
  assert.deepEqual(report.perSignal, []);
  assert.deepEqual(report.zeroCoverageSignals, []);
});

test("avgScore/avgWeight give tuning context per signal", () => {
  const report = reviewCoverageBySignal({ rows: [
    row({ id: "qz-1", score: 90, reason: [signal("alpha", 30)] }),
    row({ id: "qz-2", score: 70, reason: [signal("alpha", 20)] }),
  ], now: NOW });
  const s = signalOf(report)("alpha");
  assert.equal(s.avgScore, 80);
  assert.equal(s.avgWeight, 25);
});

test("validation: malformed rows and splits throw coded errors", () => {
  assert.throws(() => reviewCoverageBySignal({ rows: [{ id: "qz-1" }] }),
    err => err instanceof ReviewCoverageError && err.code === "invalid_review_coverage_input");
  assert.throws(() => reviewCoverageBySignal({ rows: [row({ status: "archived" })] }), /held, released or dismissed/);
  assert.throws(() => reviewCoverageBySignal({ rows: [row({ reason: "nope" })] }), /reason/);
  assert.throws(() => reviewCoverageBySignal({ rows: [row()], splits: { not: "a set" } }), /splits/);
  assert.throws(() => reviewCoverageBySignal({ rows: "nope" }), /array/);
});

// --- read-only CLI --------------------------------------------------------------

const buildStore = (path, { withSplits = true } = {}) => {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE spam_quarantine (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, channel TEXT NOT NULL, connection_id TEXT,
    account_id TEXT, source_id TEXT, reason TEXT NOT NULL CHECK(json_valid(reason)),
    score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
    quarantined_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('held','released','dismissed')),
    reviewed_by TEXT, reviewed_at INTEGER, note TEXT, updated_at INTEGER NOT NULL
  );`);
  const addRow = (id, status, signals, { score = 80, splitBy = null } = {}) =>
    db.prepare("INSERT INTO spam_quarantine(id,message_id,channel,connection_id,account_id,source_id,reason,score,quarantined_at,status,reviewed_by,reviewed_at,note,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, `m-${id}`, "telegram", "c-1", "acct-1", "src-1", JSON.stringify(signals.map(k => signal(k))), score, NOW - 5 * DAY,
        status, status === "held" ? null : "john", status === "held" ? null : NOW - 4 * DAY, null, NOW - 5 * DAY);
  addRow("qz-1", "held", ["telegram_giveaway_lure", "unknown_sender"]);
  addRow("qz-2", "released", ["telegram_giveaway_lure"]);
  addRow("qz-3", "dismissed", ["telegram_giveaway_lure"]);
  addRow("qz-4", "dismissed", ["unknown_sender"], { splitBy: true });
  if (withSplits) {
    db.exec(`CREATE TABLE quarantine_thread_splits (
      quarantine_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_id TEXT NOT NULL,
      prior_thread TEXT NOT NULL, reviewer TEXT NOT NULL, reason TEXT, split_at INTEGER NOT NULL
    );`);
    db.prepare("INSERT INTO quarantine_thread_splits(quarantine_id,account_id,source_id,prior_thread,reviewer,reason,split_at) VALUES(?,?,?,?,?,?,?)")
      .run("qz-4", "acct-1", "src-1", "thread-9", "john", "kept the thread", NOW - 3 * DAY);
  }
  db.close();
};

const script = () => new URL("../scripts/quarantine-review-coverage.mjs", import.meta.url).pathname;

test("CLI: JSON and text dashboards over a read-only store", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "review-coverage-"));
  try {
    const storePath = join(dir, "room.db");
    buildStore(storePath);
    const json = JSON.parse(execFileSync(process.execPath, [script(), "--store", storePath,
      "--now", String(NOW), "--format", "json"], { encoding: "utf8" }));
    assert.equal(json.totals.total, 4);
    assert.equal(json.totals.held, 1);
    assert.equal(json.totals.reviewCoverage, 3 / 4);
    const lure = json.perSignal.find(s => s.key === "telegram_giveaway_lure");
    assert.equal(lure.held, 1);
    assert.equal(lure.confirmed, 1);
    assert.equal(lure.dismissed, 1);
    assert.equal(lure.reviewCoverage, 2 / 3);
    const unknown = json.perSignal.find(s => s.key === "unknown_sender");
    assert.equal(unknown.held, 1);
    assert.equal(unknown.dismissed, 1);
    assert.equal(unknown.split, 1);
    assert.deepEqual(json.zeroCoverageSignals, []);
    assert.equal(json.rows.length, 4);
    const text = execFileSync(process.execPath, [script(), "--store", storePath,
      "--now", String(NOW)], { encoding: "utf8" });
    assert.match(text, /review coverage:\s+75\.0%/);
    assert.match(text, /telegram_giveaway_lure/);
    assert.match(text, /conf = Confirmed/);
    assert.doesNotMatch(text, /COVERAGE GAP/);
    // store left untouched by the read-only open
    const db = new DatabaseSync(storePath, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) n FROM spam_quarantine").get().n, 4);
    assert.equal(db.prepare("SELECT count(*) n FROM quarantine_thread_splits").get().n, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: flags zero-coverage signals as the coverage gap", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "review-coverage-gap-"));
  try {
    const storePath = join(dir, "room.db");
    buildStore(storePath);
    const db = new DatabaseSync(storePath);
    db.prepare("UPDATE spam_quarantine SET status='held', reviewed_by=NULL, reviewed_at=NULL WHERE id IN ('qz-2','qz-3')").run();
    db.close();
    const text = execFileSync(process.execPath, [script(), "--store", storePath, "--now", String(NOW)], { encoding: "utf8" });
    assert.match(text, /COVERAGE GAP/);
    assert.match(text, /telegram_giveaway_lure/);
    assert.match(text, /review coverage:\s+25\.0%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: pre-#562 stores without the splits table report zero splits", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "review-coverage-nosplits-"));
  try {
    const storePath = join(dir, "room.db");
    buildStore(storePath, { withSplits: false });
    const json = JSON.parse(execFileSync(process.execPath, [script(), "--store", storePath,
      "--now", String(NOW), "--format", "json"], { encoding: "utf8" }));
    assert.equal(json.totals.split, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: clean errors for missing store and pre-journal stores", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "review-coverage-err-"));
  try {
    assert.throws(() => execFileSync(process.execPath, [script(), "--store", join(dir, "nope.db")], { encoding: "utf8", stdio: "pipe" }), /--store/);
    const bare = join(dir, "bare.db");
    new DatabaseSync(bare).close();
    assert.throws(() => execFileSync(process.execPath, [script(), "--store", bare], { encoding: "utf8", stdio: "pipe" }), /spam_quarantine/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
