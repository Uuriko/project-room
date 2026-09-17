// F014 — abuse reporting flow for room members (pairs with F013
// moderation queue bulk actions).
//
// Pure, injectable module: no store, no network, no timers. The wiring slice
// keeps this instance server-side (or per-room) next to server/moderation.mjs,
// which covers message-level reports to the room owner. This module is the
// member-level abuse flow:
//
//   - createReport(reporter, target, category, { evidence, detail }) —
//     validated + sanitized; returns the stored report, or the existing open
//     report with `duplicate: true` for the same (reporter, target,
//     category) triple.
//   - lifecycle: submitted -> triaged -> actioned | dismissed. Transitions
//     are strict; anything else throws an AbuseReportError.
//   - reporter privacy: `listReports` (the queue / member-facing view)
//     never carries reporter identity. Each view exposes a salted,
//     non-reversible `reporterRef` so a queue operator can correlate repeat
//     reporters without seeing who they are. The full record (with the
//     reporter's member id) is available only through `getReport`, which the
//     wiring must keep owner-only, exactly like server/moderation.mjs keeps
//     message report identities owner-only.
//
// Suggested wiring (follow-up slice): POST /api/abuse-reports ->
// createReport(input) -> receipt; owner queue GET /api/abuse-reports ->
// listReports({ status }) -> triageReport / actionReport / dismissReport.
//
// Injectable seams: `now` (ms epoch, pinned in tests), `id` (report ids),
// `salt` (feeds reporterRef derivation). Reports live in an in-memory Map;
// persistence is the wiring slice's job.
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const REPORT_FORMAT_VERSION = "1.0.0";

// Abuse categories a room member can report another member for. Frozen; the
// wiring slice owns the UI copy for each.
export const CATEGORIES = Object.freeze({
  harassment: "Harassment or targeted abuse",
  spam: "Spam or unsolicited promotion",
  hate: "Hate speech or slurs",
  threats: "Threats or intimidation",
  impersonation: "Impersonating another member or agent",
  scam: "Scams, phishing, or fraud",
  nsfw: "Explicit or sexual content",
  other: "Something else",
});

// Lifecycle states. submitted -> triaged -> actioned | dismissed.
export const STATUSES = Object.freeze({
  submitted: "submitted",
  triaged: "triaged",
  actioned: "actioned",
  dismissed: "dismissed",
});

// Resolutions recorded when a report is actioned. "none" is only valid on
// dismiss; actioned requires a real outcome.
export const RESOLUTIONS = Object.freeze({
  warn: "warn",
  mute: "mute",
  remove: "remove",
  ban: "ban",
  none: "none",
});

export const OPEN_STATUSES = Object.freeze([STATUSES.submitted, STATUSES.triaged]);
export const TERMINAL_STATUSES = Object.freeze([STATUSES.actioned, STATUSES.dismissed]);

// Limits mirror server/moderation.mjs where the concepts overlap
// (reportLimits.reasonLength = 280).
export const LIMITS = Object.freeze({
  detailLength: 280,
  noteLength: 280,
  evidenceMax: 10,
  evidenceRefLength: 128,
  idLength: 128,
});

export class AbuseReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AbuseReportError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new AbuseReportError(code, message); };

const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Plain-text sanitizer (same rule as moderation.mjs): trim, keep newlines
// and tabs, strip every other control character. Returns "" for non-strings
// so callers can validate presence separately.
export function sanitizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\p{Cc}]/gu, match => (match === "\n" || match === "\t" ? match : ""));
}

const validMemberId = (value, code, label) => {
  if (!isNonEmptyString(value)) fail(code, `${label} must be a non-empty member id`);
  const id = value.trim();
  if (id.length > LIMITS.idLength || !idPattern.test(id)) fail(code, `${label} is not a valid member id`);
  return id;
};

const validDetail = (value, code, label, maxLength) => {
  const detail = sanitizeText(value);
  if (!detail) fail(code, `${label} must be non-empty plain text`);
  if (detail.length > maxLength) fail(code, `${label} must be ${maxLength} characters or fewer`);
  return detail;
};

const validEvidence = value => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("invalid_evidence", "Evidence must be a list of message or attachment ids");
  if (value.length > LIMITS.evidenceMax) fail("invalid_evidence", `Evidence holds at most ${LIMITS.evidenceMax} references`);
  const seen = new Set();
  const refs = [];
  for (const ref of value) {
    if (!isNonEmptyString(ref)) fail("invalid_evidence", "Each evidence reference must be a non-empty id");
    const clean = ref.trim();
    if (clean.length > LIMITS.evidenceRefLength || !idPattern.test(clean)) fail("invalid_evidence", "Each evidence reference must be a valid message or attachment id");
    if (!seen.has(clean)) { seen.add(clean); refs.push(clean); }
  }
  return refs;
};

// Salted, non-reversible reporter reference for list views. Correlates repeat
// reporters for the queue operator without carrying PII.
const reporterRef = (salt, reporterId) =>
  createHash("sha256").update(`${salt}\0${reporterId}`).digest("hex").slice(0, 16);

const isoOrNull = ms => (typeof ms === "number" ? new Date(ms).toISOString() : null);

export class AbuseReporting {
  constructor({ now = () => Date.now(), id = () => randomUUID(), salt = randomBytes(16).toString("hex") } = {}) {
    if (typeof now !== "function") fail("invalid_options", "now must be a function");
    if (typeof id !== "function") fail("invalid_options", "id must be a function");
    this.now = now;
    this.id = id;
    this.salt = salt;
    this.reports = new Map(); // report id -> internal record
  }

  // A report is "open" while it still needs moderation work; only open
  // reports participate in duplicate detection, so a resolved report never
  // blocks a fresh report about a repeat incident.
  #isOpen(report) {
    return report.status === STATUSES.submitted || report.status === STATUSES.triaged;
  }

  #findOpen(reporter, target, category) {
    for (const report of this.reports.values()) {
      if (report.reporter === reporter && report.target === target && report.category === category && this.#isOpen(report)) {
        return report;
      }
    }
    return null;
  }

  #getOrFail(reportId) {
    const report = this.reports.get(reportId);
    if (!report) fail("report_not_found", "No abuse report with that id");
    return report;
  }

  // Member-facing view: everything a queue list may carry, with reporter
  // identity replaced by the salted reporterRef. No PII leaves here.
  view(report) {
    return {
      id: report.id,
      category: report.category,
      categoryLabel: CATEGORIES[report.category],
      target: report.target,
      detail: report.detail,
      evidence: [...report.evidence],
      status: report.status,
      resolution: report.resolution,
      actionNote: report.actionNote,
      reporterRef: reporterRef(this.salt, report.reporter),
      createdAt: new Date(report.createdAt).toISOString(),
      triagedAt: isoOrNull(report.triagedAt),
      resolvedAt: isoOrNull(report.resolvedAt),
    };
  }

  // Owner-only full record: carries the reporter's member id plus which
  // moderator took each transition. The wiring slice must never serve this
  // to non-owners (same rule as server/moderation.mjs).
  getReport(reportId) {
    const report = this.#getOrFail(reportId);
    return {
      ...this.view(report),
      reporter: report.reporter,
      triagedBy: report.triagedBy,
      resolvedBy: report.resolvedBy,
    };
  }

  // Any member may report another member. Validates and sanitizes every
  // input; dedupes on (reporter, target, category) while a matching report
  // is still open.
  createReport({ reporter, target, category, evidence, detail } = {}) {
    const from = validMemberId(reporter, "invalid_reporter", "Reporter");
    const to = validMemberId(target, "invalid_target", "Target");
    if (from === to) fail("self_report", "You cannot file an abuse report against yourself");
    if (!Object.hasOwn(CATEGORIES, category)) fail("invalid_category", `Category must be one of: ${Object.keys(CATEGORIES).join(", ")}`);
    const refs = validEvidence(evidence);
    const text = validDetail(detail, "invalid_detail", "Detail", LIMITS.detailLength);

    const existing = this.#findOpen(from, to, category);
    if (existing) return { report: this.view(existing), duplicate: true };

    const now = this.now();
    const report = {
      id: this.id(),
      reporter: from,
      target: to,
      category,
      detail: text,
      evidence: refs,
      status: STATUSES.submitted,
      resolution: null,
      actionNote: null,
      triagedBy: null,
      resolvedBy: null,
      createdAt: now,
      triagedAt: null,
      resolvedAt: null,
    };
    this.reports.set(report.id, report);
    return { report: this.view(report), duplicate: false };
  }

  #transition(reportId, moderatorId, fromStatus, toStatus, mutate) {
    const moderator = validMemberId(moderatorId, "invalid_moderator", "Moderator");
    const report = this.#getOrFail(reportId);
    if (report.status !== fromStatus) {
      fail("invalid_transition", `Report ${report.id} is ${report.status}; it cannot move to ${toStatus}`);
    }
    mutate(report, moderator, this.now());
    return this.view(report);
  }

  // A moderator claims the report for review: submitted -> triaged.
  triageReport(reportId, moderatorId) {
    return this.#transition(reportId, moderatorId, STATUSES.submitted, STATUSES.triaged,
      (report, moderator, now) => {
        report.status = STATUSES.triaged;
        report.triagedBy = moderator;
        report.triagedAt = now;
      });
  }

  // A moderator closes the report with an outcome: triaged -> actioned.
  // `action` is one of warn | mute | remove | ban; `note` is an optional
  // plain-text justification recorded on the report.
  actionReport(reportId, moderatorId, { action, note } = {}) {
    if (!Object.hasOwn(RESOLUTIONS, action) || action === RESOLUTIONS.none) {
      fail("invalid_action", `Action must be one of: warn, mute, remove, ban`);
    }
    const cleanNote = note === undefined ? null : validDetail(note, "invalid_note", "Action note", LIMITS.noteLength);
    return this.#transition(reportId, moderatorId, STATUSES.triaged, STATUSES.actioned,
      (report, moderator, now) => {
        report.status = STATUSES.actioned;
        report.resolution = action;
        report.actionNote = cleanNote;
        report.resolvedBy = moderator;
        report.resolvedAt = now;
      });
  }

  // A moderator closes the report without action: triaged -> dismissed.
  dismissReport(reportId, moderatorId, { note } = {}) {
    const cleanNote = note === undefined ? null : validDetail(note, "invalid_note", "Dismiss note", LIMITS.noteLength);
    return this.#transition(reportId, moderatorId, STATUSES.triaged, STATUSES.dismissed,
      (report, moderator, now) => {
        report.status = STATUSES.dismissed;
        report.resolution = RESOLUTIONS.none;
        report.actionNote = cleanNote;
        report.resolvedBy = moderator;
        report.resolvedAt = now;
      });
  }

  // Queue / member-facing list. Privacy-safe views only — reporter identity
  // never appears, regardless of filters. Newest first; limit caps the page
  // (default 50, max 200) and offset pages through `total`.
  listReports({ status, category, target, limit = 50, offset = 0 } = {}) {
    const statuses = status === undefined ? Object.keys(STATUSES)
      : (Array.isArray(status) ? status : [status]);
    for (const s of statuses) {
      if (!Object.hasOwn(STATUSES, s)) fail("invalid_filter", `Unknown status filter: ${s}`);
    }
    if (category !== undefined && !Object.hasOwn(CATEGORIES, category)) fail("invalid_filter", `Unknown category filter: ${category}`);
    const targetId = target === undefined ? undefined : validMemberId(target, "invalid_filter", "Target filter");
    const page = Number(limit);
    const skip = Number(offset);
    if (!Number.isInteger(page) || page < 1 || page > 200) fail("invalid_filter", "limit must be an integer between 1 and 200");
    if (!Number.isInteger(skip) || skip < 0) fail("invalid_filter", "offset must be a non-negative integer");

    const matches = [...this.reports.values()]
      .filter(r => statuses.includes(r.status))
      .filter(r => category === undefined || r.category === category)
      .filter(r => targetId === undefined || r.target === targetId)
      .sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1));

    return {
      reports: matches.slice(skip, skip + page).map(r => this.view(r)),
      total: matches.length,
      limit: page,
      offset: skip,
    };
  }

  // Queue health summary for the F013 moderation queue sibling: counts by
  // status and by category. Carries no report content and no reporter PII.
  stats() {
    const byStatus = Object.fromEntries(Object.keys(STATUSES).map(s => [s, 0]));
    const byCategory = Object.fromEntries(Object.keys(CATEGORIES).map(c => [c, 0]));
    for (const report of this.reports.values()) {
      byStatus[report.status] += 1;
      byCategory[report.category] += 1;
    }
    return { format_version: REPORT_FORMAT_VERSION, total: this.reports.size, open: byStatus.submitted + byStatus.triaged, byStatus, byCategory };
  }
}
