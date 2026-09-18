// Shadow-period precision report (server/spam-shadow-report.mjs): the join of
// shadow would-be-hold records to quarantine review outcomes, the label
// contract, the precision/FPR/recall math, per-signal breakdowns, gate-block
// analysis, and the read-only CLI over a real store file. Fixture people,
// accounts, and messages are invented; nothing here is a real person.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shadowPrecisionReport, joinShadowOutcomes, shadowReviewWindowMs, ShadowReportError } from "../server/spam-shadow-report.mjs";

const DAY = 24 * 3600 * 1000;
const NOW = 1_750_000_000_000;

const feature = (key, weight = 25) => ({ key, weight, detail: `${key} detail` });
const decision = (overrides = {}) => ({
  messageId: "m-1", channel: "telegram", connectionId: "c-1",
  accountId: "acct-1", sourceId: "src-1", score: 80, threshold: 60,
  wouldHold: true, gateBlock: null, policyVersion: "v1",
  features: [feature("telegram_giveaway_lure")], at: NOW - 5 * DAY,
  ...overrides,
});
const review = (overrides = {}) => ({
  messageId: "m-1", channel: "telegram", connectionId: "c-1",
  accountId: "acct-1", sourceId: "src-1", score: 80,
  quarantinedAt: NOW - 5 * DAY, status: "held",
  reviewedAt: null, reviewedBy: null,
  ...overrides,
});

// --- label contract ----------------------------------------------------------

test("wouldHold + dismissed = true_positive (confirmed spam)", () => {
  const [row] = joinShadowOutcomes({ decisions: [decision()], reviews: [review({ status: "dismissed", reviewedAt: NOW - 4 * DAY, reviewedBy: "john" })], now: NOW });
  assert.equal(row.label, "true_positive");
  assert.equal(row.verdict, "confirmed_spam");
  assert.equal(row.review.status, "dismissed");
});

test("wouldHold + released = false_positive (ham wrongly held)", () => {
  const [row] = joinShadowOutcomes({ decisions: [decision()], reviews: [review({ status: "released", reviewedAt: NOW - 4 * DAY, reviewedBy: "john" })], now: NOW });
  assert.equal(row.label, "false_positive");
  assert.equal(row.verdict, "ham");
});

test("wouldHold + still held = pending inside the window, expired past it", () => {
  const fresh = decision({ messageId: "m-fresh" });
  const old = decision({ messageId: "m-old" });
  const rows = joinShadowOutcomes({
    decisions: [fresh, old],
    reviews: [review({ messageId: "m-fresh", quarantinedAt: NOW - 2 * DAY }), review({ messageId: "m-old", quarantinedAt: NOW - 20 * DAY })],
    now: NOW,
  });
  assert.equal(rows[0].label, "pending_review");
  assert.equal(rows[1].label, "expired_unreviewed");
  assert.equal(rows[0].verdict, null, "no verdict while awaiting review");
});

test("wouldHold with no journal row = unjournaled (data gap, not a verdict)", () => {
  const [row] = joinShadowOutcomes({ decisions: [decision({ messageId: "m-ghost" })], reviews: [], now: NOW });
  assert.equal(row.label, "unjournaled");
  assert.equal(row.review, null);
});

test("!wouldHold + dismissed = false_negative; + released/held = true_negative", () => {
  const pass = decision({ messageId: "m-pass", wouldHold: false, score: 40 });
  const rows = joinShadowOutcomes({
    decisions: [decision({ messageId: "m-fn", wouldHold: false, score: 95, gateBlock: "existingThread" }), pass,
      decision({ messageId: "m-tn", wouldHold: false, score: 30 })],
    reviews: [review({ messageId: "m-fn", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john" }),
      review({ messageId: "m-pass", status: "released", reviewedAt: NOW - DAY, reviewedBy: "john" }),
      review({ messageId: "m-tn", status: "held" })],
    now: NOW,
  });
  assert.equal(rows[0].label, "false_negative");
  assert.equal(rows[0].verdict, "confirmed_spam");
  assert.equal(rows[1].label, "true_negative");
  assert.equal(rows[2].label, "true_negative");
});

// --- metrics -----------------------------------------------------------------

test("precision, false-positive rate, and recall over reviewed would-be holds", () => {
  // 3 would-be holds: 2 dismissed (TP), 1 released (FP); 1 gate-blocked
  // high-scorer dismissed (FN); 1 pass released (TN); 1 hold still pending.
  const decisions = [
    decision({ messageId: "h1" }), decision({ messageId: "h2" }), decision({ messageId: "h3" }),
    decision({ messageId: "g1", wouldHold: false, gateBlock: "existingThread", score: 95, features: [feature("email_link_lure")] }),
    decision({ messageId: "p1", wouldHold: false, score: 30, features: [] }),
    decision({ messageId: "h4" }),
  ];
  const reviews = [
    review({ messageId: "h1", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "h2", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "h3", status: "released", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "g1", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "p1", status: "released", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "h4", status: "held" }),
  ];
  const report = shadowPrecisionReport({ decisions, reviews, now: NOW });
  assert.deepEqual(report.counts, { true_positive: 2, false_positive: 1, pending_review: 1,
    expired_unreviewed: 0, unjournaled: 0, false_negative: 1, true_negative: 1 });
  assert.equal(report.metrics.wouldBeHolds, 4);
  assert.equal(report.metrics.reviewedHolds, 3);
  assert.equal(report.metrics.precision, 2 / 3);
  assert.equal(report.metrics.falsePositiveRate, 1 / 3);
  assert.equal(report.metrics.recall, 2 / 3, "TP / (TP + FN)");
  assert.equal(report.metrics.reviewCoverage, 3 / 4, "pending holds never dilute precision");
  // policy §5 bar: false-positive rate <= ~5% before flipping the switch
  assert.ok(report.metrics.falsePositiveRate > 0.05, "fixture exceeds the bar on purpose");
});

test("zero reviewed holds yields null metrics, never 0", () => {
  const report = shadowPrecisionReport({ decisions: [decision()], reviews: [review()], now: NOW });
  assert.equal(report.metrics.precision, null);
  assert.equal(report.metrics.falsePositiveRate, null);
  assert.equal(report.metrics.recall, null);
  assert.deepEqual(report.counts.pending_review, 1);
});

test("empty inputs produce an empty but well-formed report", () => {
  const report = shadowPrecisionReport({ decisions: [], reviews: [], now: NOW });
  assert.deepEqual(report.counts, { true_positive: 0, false_positive: 0, pending_review: 0,
    expired_unreviewed: 0, unjournaled: 0, false_negative: 0, true_negative: 0 });
  assert.deepEqual(report.perSignal, []);
  assert.deepEqual(report.gateBlocks, {});
  assert.equal(report.metrics.precision, null);
});

// --- per-signal breakdown ----------------------------------------------------

test("per-signal precision and share of holds, sorted by volume", () => {
  const lure = feature("telegram_giveaway_lure");
  const imperson = feature("telegram_impersonation", 40);
  const hype = feature("bot_spam_pattern", 15);
  const decisions = [
    decision({ messageId: "s1", features: [lure, imperson] }),
    decision({ messageId: "s2", features: [lure, imperson] }),
    decision({ messageId: "s3", features: [lure, hype] }),
    decision({ messageId: "s4", features: [hype] }),          // pending: no verdict
  ];
  const reviews = [
    review({ messageId: "s1", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "s2", status: "released", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "s3", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "s4", status: "held" }),
  ];
  const report = shadowPrecisionReport({ decisions, reviews, now: NOW });
  const byKey = Object.fromEntries(report.perSignal.map(s => [s.key, s]));
  assert.equal(byKey.telegram_giveaway_lure.wouldBeHolds, 3);
  assert.equal(byKey.telegram_giveaway_lure.reviewed, 3);
  assert.equal(byKey.telegram_giveaway_lure.truePositives, 2);
  assert.equal(byKey.telegram_giveaway_lure.falsePositives, 1);
  assert.equal(byKey.telegram_giveaway_lure.precision, 2 / 3);
  assert.equal(byKey.telegram_giveaway_lure.shareOfHolds, 3 / 4);
  assert.equal(byKey.telegram_impersonation.precision, 1 / 2);
  assert.equal(byKey.bot_spam_pattern.reviewed, 1, "pending holds do not count as reviewed");
  assert.equal(byKey.bot_spam_pattern.precision, 1);
  assert.ok(report.perSignal[0].wouldBeHolds >= report.perSignal[1].wouldBeHolds, "sorted by volume");
});

// --- gate-block analysis -----------------------------------------------------

test("gate blocks are grouped with their review outcomes", () => {
  const decisions = [
    decision({ messageId: "t1", wouldHold: false, gateBlock: "existingThread", score: 95 }),
    decision({ messageId: "t2", wouldHold: false, gateBlock: "existingThread", score: 90 }),
    decision({ messageId: "v1", wouldHold: false, gateBlock: "verifiedConnector", score: 85 }),
    decision({ messageId: "p9", wouldHold: false, gateBlock: null, score: 20, features: [] }),
  ];
  const reviews = [
    review({ messageId: "t1", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "t2", status: "released", reviewedAt: NOW - DAY, reviewedBy: "john" }),
    review({ messageId: "v1", status: "held" }),
  ];
  const { gateBlocks } = shadowPrecisionReport({ decisions, reviews, now: NOW });
  assert.deepEqual(gateBlocks.existingThread, { count: 2, dismissed: 1, released: 1, held: 0, neverJournaled: 0 });
  assert.deepEqual(gateBlocks.verifiedConnector, { count: 1, dismissed: 0, released: 0, held: 1, neverJournaled: 0 });
  assert.deepEqual(gateBlocks.below_threshold, { count: 1, dismissed: 0, released: 0, held: 0, neverJournaled: 1 });
});

// --- join scoping (gap #2) ---------------------------------------------------

test("scoped decisions prefer the account+source triple; unscoped fall back to messageId", () => {
  const scopedA = decision({ messageId: "dup", accountId: "acct-A", sourceId: "src-A" });
  const scopedB = decision({ messageId: "dup", accountId: "acct-B", sourceId: "src-B" });
  const bare = decision({ messageId: "dup", accountId: null, sourceId: null });
  const rows = joinShadowOutcomes({
    decisions: [scopedA, scopedB, bare],
    reviews: [
      review({ messageId: "dup", accountId: "acct-A", sourceId: "src-A", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john", quarantinedAt: NOW - 2 * DAY }),
      review({ messageId: "dup", accountId: "acct-B", sourceId: "src-B", status: "released", reviewedAt: NOW - DAY, reviewedBy: "john", quarantinedAt: NOW - 2 * DAY }),
    ],
    now: NOW,
  });
  assert.equal(rows[0].label, "true_positive", "acct-A's dismissed row");
  assert.equal(rows[1].label, "false_positive", "acct-B's released row");
  assert.ok(rows[2].ambiguous, "bare join sees both rows with disagreeing verdicts");
  assert.equal(rows[2].review.accountId, "acct-A", "latest-updated tiebreak is deterministic");
});

test("identical verdicts are not flagged ambiguous", () => {
  const rows = joinShadowOutcomes({
    decisions: [decision({ messageId: "dup2", accountId: null, sourceId: null })],
    reviews: [review({ messageId: "dup2", accountId: "acct-A", sourceId: "src-A", status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john", quarantinedAt: NOW - 2 * DAY }),
      review({ messageId: "dup2", accountId: "acct-B", sourceId: "src-B", status: "dismissed", reviewedAt: NOW - 3 * DAY, reviewedBy: "john", quarantinedAt: NOW - 2 * DAY })],
    now: NOW,
  });
  assert.equal(rows[0].label, "true_positive");
  assert.equal(rows[0].ambiguous, false);
});

test("custom review window moves the pending/expired boundary", () => {
  const rows = joinShadowOutcomes({ decisions: [decision({ messageId: "w1" })],
    reviews: [review({ messageId: "w1", quarantinedAt: NOW - 3 * DAY })],
    now: NOW, reviewWindowMs: 7 * DAY });
  assert.equal(rows[0].label, "pending_review");
  assert.equal(joinShadowOutcomes({ decisions: [decision({ messageId: "w1" })],
    reviews: [review({ messageId: "w1", quarantinedAt: NOW - 3 * DAY })],
    now: NOW, reviewWindowMs: 2 * DAY })[0].label, "expired_unreviewed");
  assert.equal(shadowReviewWindowMs, 14 * DAY, "default matches the policy shadow period");
});

test("policy-version changes inside the window are surfaced, not blended", () => {
  const report = shadowPrecisionReport({
    decisions: [decision({ policyVersion: "v1" }), decision({ messageId: "m2", policyVersion: "v2" })],
    reviews: [], now: NOW });
  assert.deepEqual(report.policyVersions, ["v1", "v2"]);
});

test("outputs are frozen and the join is deterministic across runs", () => {
  const input = { decisions: [decision()], reviews: [review({ status: "dismissed", reviewedAt: NOW - DAY, reviewedBy: "john" })], now: NOW };
  const a = shadowPrecisionReport(input), b = shadowPrecisionReport(input);
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.rows) && Object.isFrozen(a.rows[0]));
});

test("malformed inputs fail with coded errors", () => {
  assert.throws(() => joinShadowOutcomes({ decisions: [{ messageId: "x" }], reviews: [], now: NOW }), e => e instanceof ShadowReportError);
  assert.throws(() => joinShadowOutcomes({ decisions: [], reviews: [{ messageId: "x", status: "maybe", quarantinedAt: 1 }], now: NOW }), e => e.code === "invalid_shadow_report_input");
  assert.throws(() => joinShadowOutcomes({ decisions: "nope", reviews: [], now: NOW }), ShadowReportError);
});

// --- CLI end to end over a real store file -----------------------------------

const buildStore = path => {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE private_inbox_commands (
    sequence INTEGER PRIMARY KEY, account_id TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), auth_epoch INTEGER NOT NULL, at INTEGER NOT NULL,
    UNIQUE(account_id,request_id)
  );`);
  db.exec(`CREATE TABLE spam_quarantine (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, channel TEXT NOT NULL, connection_id TEXT,
    account_id TEXT, source_id TEXT, reason TEXT NOT NULL CHECK(json_valid(reason)),
    score INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
    quarantined_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('held','released','dismissed')),
    reviewed_by TEXT, reviewed_at INTEGER, note TEXT, updated_at INTEGER NOT NULL
  );`);
  const addImport = (requestId, { accountId = "acct-1", messageId, shadow }) => {
    const receipt = { requestId, action: "source.import", sourceId: "src-1", shadowQuarantine: shadow ?? null };
    db.prepare("INSERT INTO private_inbox_commands(account_id,request_id,fingerprint,request_json,receipt_json,auth_epoch,at) VALUES(?,?,?,?,?,?,?)")
      .run(accountId, requestId, "fp", JSON.stringify({ requestId, action: "source.import", sourceId: "src-1" }), JSON.stringify(receipt), 1, NOW);
  };
  const shadow = (messageId, score, wouldHold) => ({
    policyVersion: "v1", threshold: 60, score, wouldHold, gateBlock: null,
    gates: {}, channel: "telegram", connectionId: "c-1", messageId,
    features: [{ key: "telegram_giveaway_lure", weight: 25, detail: "d" }], at: NOW - 5 * DAY });
  addImport("r1", { messageId: "m1", shadow: shadow("m1", 80, true) });
  addImport("r2", { messageId: "m2", shadow: shadow("m2", 75, true) });
  addImport("r3", { messageId: "m3", shadow: shadow("m3", 20, false) });
  addImport("r4", { messageId: "m4" }); // no shadow decision recorded
  const addRow = (id, messageId, status, reviewedBy = null, reviewedAt = null) =>
    db.prepare("INSERT INTO spam_quarantine(id,message_id,channel,connection_id,account_id,source_id,reason,score,quarantined_at,status,reviewed_by,reviewed_at,note,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, messageId, "telegram", "c-1", "acct-1", "src-1", JSON.stringify([{ key: "telegram_giveaway_lure", weight: 25, detail: "d" }]), 80, NOW - 5 * DAY, status, reviewedBy, reviewedAt, null, NOW - 5 * DAY);
  addRow("qz-1", "m1", "dismissed", "john", NOW - 4 * DAY);
  addRow("qz-2", "m2", "released", "john", NOW - 4 * DAY);
  addRow("qz-3", "m3", "dismissed", "john", NOW - 4 * DAY);
  db.close();
};

test("CLI: text and JSON reports over a read-only store", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-report-"));
  try {
    const storePath = join(dir, "room.db");
    buildStore(storePath);
    const script = new URL("../scripts/shadow-quarantine-report.mjs", import.meta.url);
    const json = JSON.parse(execFileSync(process.execPath, [script.pathname, "--store", storePath,
      "--now", String(NOW), "--format", "json"], { encoding: "utf8" }));
    assert.equal(json.metrics.wouldBeHolds, 2);
    assert.equal(json.metrics.precision, 1 / 2);
    assert.equal(json.metrics.falsePositiveRate, 1 / 2);
    assert.equal(json.metrics.recall, 1 / 2, "m1 TP, m3 FN");
    assert.equal(json.perSignal[0].key, "telegram_giveaway_lure");
    assert.equal(json.rows.length, 3, "r4 has no shadow decision and is skipped");
    const text = execFileSync(process.execPath, [script.pathname, "--store", storePath,
      "--now", String(NOW), "--since", new Date(NOW - 10 * DAY).toISOString()], { encoding: "utf8" });
    assert.match(text, /would-be holds:\s+2/);
    assert.match(text, /precision\s+50\.0%/);
    assert.match(text, /telegram_giveaway_lure/);
    // store left untouched by the read-only open
    const db = new DatabaseSync(storePath, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) n FROM private_inbox_commands").get().n, 4);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: clean errors for missing store and pre-instrumentation stores", { timeout: 30000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-report-err-"));
  try {
    const script = new URL("../scripts/shadow-quarantine-report.mjs", import.meta.url);
    assert.throws(() => execFileSync(process.execPath, [script.pathname, "--store", join(dir, "nope.db")], { encoding: "utf8", stdio: "pipe" }), /--store/);
    const bare = join(dir, "bare.db");
    new DatabaseSync(bare).close();
    assert.throws(() => execFileSync(process.execPath, [script.pathname, "--store", bare], { encoding: "utf8", stdio: "pipe" }), /private_inbox_commands/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
