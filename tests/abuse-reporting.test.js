// F014 — tests for src/abuse-reporting.mjs.
//
// Covers: createReport validation and sanitization, the lifecycle
// (submitted -> triaged -> actioned | dismissed) with strict transitions,
// duplicate detection on (reporter, target, category) for open reports,
// reporter privacy (list views never carry PII), and listReports status /
// category / target filters plus pagination. Deterministic: the clock, the
// ids, and the salt are all pinned.

import test from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_FORMAT_VERSION,
  CATEGORIES,
  STATUSES,
  RESOLUTIONS,
  LIMITS,
  AbuseReportError,
  AbuseReporting,
  sanitizeText,
} from "../src/abuse-reporting.mjs";

const PINNED_NOW = 1_757_999_999_000; // 2026-09-16T04:33:19.000Z
const PINNED_ISO = new Date(PINNED_NOW).toISOString();
const PINNED_SALT = "pinned-test-salt";

const makeStore = (tick = 0) => {
  let t = PINNED_NOW;
  let tickCount = 0;
  let idCount = 0;
  return new AbuseReporting({
    now: () => t + (tick ? tick * (tickCount++) : 0),
    id: () => `rep-${String(++idCount).padStart(4, "0")}`,
    salt: PINNED_SALT,
  });
};

const baseInput = (overrides = {}) => ({
  reporter: "u-ada",
  target: "u-bob",
  category: "harassment",
  evidence: ["msg-1", "msg-2"],
  detail: "Bob kept @-mentioning me after I asked him to stop.",
  ...overrides,
});

const assertReportError = (fn, code) => {
  assert.throws(fn, err => {
    assert.ok(err instanceof AbuseReportError, `expected AbuseReportError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
};

// --- createReport: validation ---

test("createReport stores a validated, sanitized report in submitted status", () => {
  const store = makeStore();
  const { report, duplicate } = store.createReport(baseInput());
  assert.equal(duplicate, false);
  assert.equal(report.id, "rep-0001");
  assert.equal(report.category, "harassment");
  assert.equal(report.categoryLabel, CATEGORIES.harassment);
  assert.equal(report.target, "u-bob");
  assert.deepEqual(report.evidence, ["msg-1", "msg-2"]);
  assert.equal(report.status, STATUSES.submitted);
  assert.equal(report.resolution, null);
  assert.equal(report.createdAt, PINNED_ISO);
  assert.equal(report.triagedAt, null);
  assert.equal(report.resolvedAt, null);
});

test("createReport rejects bad reporters, targets, and self-reports", () => {
  const store = makeStore();
  assertReportError(() => store.createReport(baseInput({ reporter: "" })), "invalid_reporter");
  assertReportError(() => store.createReport(baseInput({ reporter: null })), "invalid_reporter");
  assertReportError(() => store.createReport(baseInput({ reporter: "has spaces" })), "invalid_reporter");
  assertReportError(() => store.createReport(baseInput({ target: "" })), "invalid_target");
  assertReportError(() => store.createReport(baseInput({ reporter: "u-ada", target: "u-ada" })), "self_report");
});

test("createReport rejects unknown categories and missing detail", () => {
  const store = makeStore();
  assertReportError(() => store.createReport(baseInput({ category: "murder" })), "invalid_category");
  assertReportError(() => store.createReport(baseInput({ category: undefined })), "invalid_category");
  assertReportError(() => store.createReport(baseInput({ detail: "   " })), "invalid_detail");
  assertReportError(() => store.createReport(baseInput({ detail: "x".repeat(LIMITS.detailLength + 1) })), "invalid_detail");
});

test("createReport validates evidence refs and dedupes them in order", () => {
  const store = makeStore();
  assertReportError(() => store.createReport(baseInput({ evidence: "msg-1" })), "invalid_evidence");
  assertReportError(() => store.createReport(baseInput({ evidence: [""] })), "invalid_evidence");
  assertReportError(() => store.createReport(baseInput({ evidence: ["has space"] })), "invalid_evidence");
  assertReportError(() => store.createReport(baseInput({ evidence: Array(LIMITS.evidenceMax + 1).fill("m") })), "invalid_evidence");

  const { report } = store.createReport(baseInput({
    reporter: "u-eve", evidence: ["msg-3", "msg-3", "msg-4"],
  }));
  assert.deepEqual(report.evidence, ["msg-3", "msg-4"]);
});

test("createReport strips control characters from detail but keeps newlines and tabs", () => {
  const store = makeStore();
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  const NUL = String.fromCharCode(0);
  const BEL = String.fromCharCode(7);
  const { report } = store.createReport(baseInput({
    reporter: "u-eve",
    detail: "line one" + NL + "line two" + NUL + "hidden" + BEL + TAB + "here",
  }));
  assert.equal(report.detail, "line one" + NL + "line twohidden" + TAB + "here");
});


// Sanity checks for the standalone plain-text sanitizer used on report
// details and moderator notes.
test("sanitizeText keeps plain text and newlines/tabs, strips other control chars", () => {
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  assert.equal(sanitizeText("  hello  "), "hello");
  assert.equal(sanitizeText("a" + String.fromCharCode(0) + "b" + String.fromCharCode(27) + "c"), "abc");
  assert.equal(sanitizeText("a" + NL + "b" + TAB + "c"), "a" + NL + "b" + TAB + "c");
  assert.equal(sanitizeText(42), "");
  assert.equal(sanitizeText(null), "");
});


// --- lifecycle ---

test("lifecycle: submitted -> triaged -> actioned records who and when", () => {
  const store = makeStore();
  const { report } = store.createReport(baseInput());
  const triaged = store.triageReport(report.id, "u-owner");
  assert.equal(triaged.status, STATUSES.triaged);
  assert.equal(triaged.triagedAt, PINNED_ISO);

  const actioned = store.actionReport(report.id, "u-owner", { action: "mute", note: "First offense; 24h mute." });
  assert.equal(actioned.status, STATUSES.actioned);
  assert.equal(actioned.resolution, RESOLUTIONS.mute);
  assert.equal(actioned.actionNote, "First offense; 24h mute.");
  assert.equal(actioned.resolvedAt, PINNED_ISO);

  const full = store.getReport(report.id);
  assert.equal(full.reporter, "u-ada");
  assert.equal(full.triagedBy, "u-owner");
  assert.equal(full.resolvedBy, "u-owner");
});

test("lifecycle: triaged -> dismissed records resolution none", () => {
  const store = makeStore();
  const { report } = store.createReport(baseInput());
  store.triageReport(report.id, "u-owner");
  const dismissed = store.dismissReport(report.id, "u-owner", { note: "Not abuse; heated thread." });
  assert.equal(dismissed.status, STATUSES.dismissed);
  assert.equal(dismissed.resolution, RESOLUTIONS.none);
  assert.equal(dismissed.actionNote, "Not abuse; heated thread.");
  assert.equal(dismissed.resolvedAt, PINNED_ISO);
});

test("transitions are strict: no skipping or revisiting states", () => {
  const store = makeStore();
  const { report } = store.createReport(baseInput());

  assertReportError(() => store.actionReport(report.id, "u-owner", { action: "warn" }), "invalid_transition");
  assertReportError(() => store.dismissReport(report.id, "u-owner"), "invalid_transition");

  store.triageReport(report.id, "u-owner");
  assertReportError(() => store.triageReport(report.id, "u-owner"), "invalid_transition");
  store.actionReport(report.id, "u-owner", { action: "warn" });
  assertReportError(() => store.triageReport(report.id, "u-owner"), "invalid_transition");
  assertReportError(() => store.dismissReport(report.id, "u-owner"), "invalid_transition");
  assertReportError(() => store.actionReport("rep-9999", "u-owner", { action: "warn" }), "report_not_found");
});

test("transitions validate the moderator, action, and note", () => {
  const store = makeStore();
  const { report } = store.createReport(baseInput());
  assertReportError(() => store.triageReport(report.id, ""), "invalid_moderator");
  store.triageReport(report.id, "u-owner");
  assertReportError(() => store.actionReport(report.id, "u-owner", { action: "none" }), "invalid_action");
  assertReportError(() => store.actionReport(report.id, "u-owner", { action: "exile" }), "invalid_action");
  assertReportError(() => store.actionReport(report.id, "u-owner", {}), "invalid_action");
  assertReportError(() => store.dismissReport(report.id, "u-owner", { note: "x".repeat(LIMITS.noteLength + 1) }), "invalid_note");
});

// --- duplicates ---

test("duplicate: same reporter+target+category on an open report returns the original", () => {
  const store = makeStore();
  const first = store.createReport(baseInput());
  const second = store.createReport(baseInput({ detail: "Reporting again with more words." }));
  assert.equal(second.duplicate, true);
  assert.equal(second.report.id, first.report.id);
  assert.equal(store.stats().total, 1, "duplicate does not create a second record");
});

test("duplicate only matches the exact triple, and only while open", () => {
  const store = makeStore();
  const { report } = store.createReport(baseInput());

  const otherTarget = store.createReport(baseInput({ reporter: "u-ada", target: "u-cara" }));
  assert.equal(otherTarget.duplicate, false);
  const otherCategory = store.createReport(baseInput({ reporter: "u-ada", category: "spam" }));
  assert.equal(otherCategory.duplicate, false);
  const otherReporter = store.createReport(baseInput({ reporter: "u-eve" }));
  assert.equal(otherReporter.duplicate, false);
  assert.equal(store.stats().total, 4);

  // Resolve the original triple: a fresh report about the same triple is now allowed.
  store.triageReport(report.id, "u-owner");
  store.actionReport(report.id, "u-owner", { action: "warn" });
  const fresh = store.createReport(baseInput({ detail: "It happened again after the warning." }));
  assert.equal(fresh.duplicate, false);
  assert.equal(store.stats().total, 5);
});

// --- privacy ---

test("list views never leak reporter identity, but carry a stable salted ref", () => {
  const store = makeStore();
  store.createReport(baseInput());
  store.createReport(baseInput({ reporter: "u-ada", target: "u-cara" }));
  store.createReport(baseInput({ reporter: "u-eve" }));

  const { reports } = store.listReports();
  assert.equal(reports.length, 3);
  for (const view of reports) {
    assert.ok(!("reporter" in view), "list view must not carry reporter id");
    assert.ok(!("triagedBy" in view) && !("resolvedBy" in view), "list view must not carry moderator ids");
    assert.ok(!("salt" in view), "list view must not carry the salt");
    assert.match(view.reporterRef, /^[0-9a-f]{16}$/);
  }
  // Same reporter => same ref (correlatable); different reporter => different ref.
  const adaViews = reports.filter(v => v.reporterRef === reports[0].reporterRef);
  assert.equal(adaViews.length, 2);
  const eveView = reports.find(v => v.target === "u-bob" && v.category === "harassment" && v.reporterRef !== reports[0].reporterRef);
  assert.ok(eveView, "eve's report has a different ref");
  // The ref is salted: a store with a different salt yields a different ref
  // for the same reporter, so refs cannot be joined across rooms.
  const otherSalted = new AbuseReporting({ salt: "different-test-salt", id: () => "rep-x" });
  otherSalted.createReport(baseInput());
  assert.notEqual(otherSalted.listReports().reports[0].reporterRef, reports[0].reporterRef);
});

// --- listReports filters ---

test("listReports filters by status, category, and target; newest first; paginates", () => {
  const store = makeStore(true); // tick the clock so ordering is deterministic
  const a = store.createReport(baseInput()).report; // harassment / u-bob / submitted
  const b = store.createReport(baseInput({ reporter: "u-eve", category: "spam", target: "u-cara" })).report;
  store.triageReport(a.id, "u-owner");
  store.triageReport(b.id, "u-owner");
  store.actionReport(b.id, "u-owner", { action: "remove" });
  store.createReport(baseInput({ reporter: "u-eve", target: "u-dan" })); // harassment / submitted
  const newest = store.listReports({ status: "submitted" }).reports[0];

  const triaged = store.listReports({ status: "triaged" });
  assert.equal(triaged.total, 1);
  assert.equal(triaged.reports[0].id, a.id);

  const multi = store.listReports({ status: ["submitted", "actioned"] });
  assert.equal(multi.total, 2);

  const byCategory = store.listReports({ category: "spam" });
  assert.equal(byCategory.total, 1);
  assert.equal(byCategory.reports[0].id, b.id);

  const byTarget = store.listReports({ target: "u-bob" });
  assert.equal(byTarget.total, 1);

  // Newest first by createdAt (not by resolvedAt: the resolved report b
  // sorts in the middle because it was created second).
  const all = store.listReports();
  assert.equal(all.total, 3);
  assert.deepEqual(all.reports.map(r => r.id), [newest.id, b.id, a.id]);
  assertReportError(() => store.listReports({ status: "nope" }), "invalid_filter");
  assertReportError(() => store.listReports({ category: "nope" }), "invalid_filter");
  assertReportError(() => store.listReports({ limit: 0 }), "invalid_filter");
  assertReportError(() => store.listReports({ limit: 201 }), "invalid_filter");
  assertReportError(() => store.listReports({ offset: -1 }), "invalid_filter");

  // Pagination.
  const page1 = store.listReports({ limit: 2, offset: 0 });
  const page2 = store.listReports({ limit: 2, offset: 2 });
  assert.equal(page1.reports.length, 2);
  assert.equal(page2.reports.length, 1);
  assert.equal(page2.total, 3);
  assert.ok(!page1.reports.some(r => page2.reports.some(s => s.id === r.id)), "pages do not overlap");
});

// --- stats ---

test("stats summarizes queue health without report content or PII", () => {
  const store = makeStore();
  store.createReport(baseInput());
  store.createReport(baseInput({ reporter: "u-eve", category: "spam", target: "u-cara" }));
  const { report } = store.createReport(baseInput({ reporter: "u-eve", target: "u-dan" }));
  store.triageReport(report.id, "u-owner");
  store.dismissReport(report.id, "u-owner");

  const stats = store.stats();
  assert.equal(stats.format_version, REPORT_FORMAT_VERSION);
  assert.equal(stats.total, 3);
  assert.equal(stats.open, 2);
  assert.equal(stats.byStatus.submitted, 2);
  assert.equal(stats.byStatus.triaged, 0);
  assert.equal(stats.byStatus.dismissed, 1);
  assert.equal(stats.byStatus.actioned, 0);
  assert.equal(stats.byCategory.harassment, 2);
  assert.equal(stats.byCategory.spam, 1);
  const statsJson = JSON.stringify(stats);
  assert.ok(!statsJson.includes("u-ada"), "stats carry no member ids");
});
