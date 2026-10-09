#!/usr/bin/env node
/**
 * normalize-report.mjs — REPORT NORMALIZER (WAVE-500 coord-cost, worker 11/17).
 *
 * Converts a verbose free-text worker completion report into a structured
 * v1 receipt (docs/RECEIPT-SCHEMA.md) via deterministic heuristics
 * (regex / keyword extraction, no model calls). Unconfident fields become
 * null and land in "needsHuman".
 *
 * Input:  free-text report — a file path argument, or stdin when no file.
 * Output: JSON { receipt, fieldConfidence, needsHuman, inputBytes,
 *         receiptBytes, outputBytes } on stdout.
 *         With --receipt-only: just the receipt JSON (pipe-friendly for
 *         scripts/validate-receipt.mjs).
 *
 * Receipt shape (v1, per docs/RECEIPT-SCHEMA.md):
 *   v, workerId, waveId, status, summary (<=280 chars), filesChanged[],
 *   tests {run,passed,failed}, claimsFiled[], branch, headSha,
 *   openQuestions[] (<=3), msElapsed, plus optional pr / ts when found.
 *
 * Status vocabulary is the v1 enum: completed | errored | blocked.
 * Report language maps onto it as follows:
 *   done/completed/finished/shipped/landed/delivered/succeeded/merged/
 *   closed/green          -> completed
 *   failed/failure/error/broke/broken/crash/timed-out/timeout
 *                           -> errored   (a timeout ends the attempt in failure)
 *   blocked/blocker/waiting-on/awaiting -> blocked
 *   in-progress / cancelled have NO v1 status: the field stays null and is
 *   listed in needsHuman (a receipt is a completion artifact; the human or
 *   runtime decides how to record a non-terminal report).
 *
 * Confidence: high = explicit labeled field (e.g. "status: done",
 *             "Merge SHA: …"); medium = strong pattern (first-line "— DONE"
 *             suffix, "N/M green", "[lane]" author tag); low = weak guess
 *             or nothing found -> value becomes null, field goes to
 *             needsHuman. Array fields with nothing found are [] with low
 *             confidence (also listed in needsHuman — absence may mean the
 *             report buried them in prose).
 *
 * Exit codes: 0 = report normalized (even with needsHuman entries);
 *             2 = usage / input error.
 */
import { readFileSync } from "node:fs";
import { stdin, stdout, exit } from "node:process";

// ------------------------------------------------------------------ config

const CORE_FIELDS = [
  "workerId",
  "waveId",
  "status",
  "summary",
  "filesChanged",
  "tests",
  "claimsFiled",
  "branch",
  "headSha",
  "openQuestions",
  "msElapsed",
];
const OPTIONAL_FIELDS = ["pr", "ts"];

const SUMMARY_MAX = 280;
const OPEN_QUESTIONS_MAX = 3;
const FILES_MAX = 50;

/** Report-language token -> v1 status. */
const STATUS_MAP = {
  // done-class -> completed
  done: "completed",
  completed: "completed",
  complete: "completed",
  finished: "completed",
  shipped: "completed",
  landed: "completed",
  delivered: "completed",
  succeeded: "completed",
  success: "completed",
  merged: "completed",
  closed: "completed",
  green: "completed",
  // error-class -> errored
  error: "errored",
  errored: "errored",
  failed: "errored",
  failure: "errored",
  broke: "errored",
  broken: "errored",
  crash: "errored",
  crashed: "errored",
  timeout: "errored",
  timed_out: "errored",
  // blocked-class -> blocked
  blocked: "blocked",
  blocker: "blocked",
  waiting: "blocked",
  awaiting: "blocked",
};

// ------------------------------------------------------------------ helpers

/** One extracted field: { value, confidence: high|medium|low, evidence }. */
const field = (value, confidence, evidence) => ({
  value,
  confidence,
  evidence: String(evidence ?? "").slice(0, 160).trim(),
});
const none = () => field(null, "low", "no match");

const uniq = (arr) => [...new Set(arr)];

const truncateWord = (s, max) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1).replace(/\s+\S*$/, "");
  return (cut || s.slice(0, max - 1)) + "…";
};

// ------------------------------------------------------------------ field extractors
// Each returns field(value, confidence, evidence).

function extractWorkerId(text) {
  let m = text.match(
    /\bworkerId\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._/-]{0,63})["']?/i
  );
  if (m) return field(m[1], "high", m[0]);
  m = text.match(
    /\bwave500[-/]coord[- ]cost[-/](?:worker[- ]?)?(\d+)(?:\s*\/\s*\d+)?/i
  );
  if (m) return field(`wave500-coord-cost-worker${m[1]}`, "medium", m[0]);
  // Leading [lane] author tag, e.g. "[quill-s2][receipt] …".
  m = text.match(/^\s*\[([A-Za-z0-9][A-Za-z0-9._-]{0,40})\]/);
  if (m && !/^(?:done|receipt|status|claim|blocked|error)$/i.test(m[1])) {
    return field(m[1], "medium", m[0]);
  }
  if (/wave-?500|coord[- ]cost/i.test(text)) {
    m = text.match(/\bworker\s*(\d+)\s*\/\s*17\b/i);
    if (m) return field(`wave500-coord-cost-worker${m[1]}`, "medium", m[0]);
    m = text.match(/\b(?:one-?shot\s+)?worker\s*(\d{1,2})\b/i);
    if (m) return field(`wave500-coord-cost-worker${m[1]}`, "low", m[0]);
  }
  return none();
}

function extractWaveId(text) {
  let m = text.match(/\bwave-?500\b/i);
  if (m) return field("wave-500", "high", m[0]);
  // "Wave 5 done" / "Wave 6 half done" as the report's subject wave.
  // (Deliberately NOT bare "wave-1" mid-sentence: that is usually a file
  // reference like "wave-1 src/foo.mjs", not the report's wave.)
  m = text.match(/\bWave\s+(\d{1,4})\s+(?:done|half\s+done|complete[sd]?|finished)\b/);
  if (m) return field(`wave${m[1]}`, "medium", m[0]);
  m = text.match(/\b(qa|product|help|demand)-?(\d{2,4})\b/i);
  if (m) return field(`${m[1].toLowerCase()}${m[2]}`, "medium", m[0]);
  return none();
}

/** Strip contexts where failure words are benign (error codes, "0 errors"). */
function sanitizeForStatus(text) {
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/g, " ")
    .replace(/\b0\s+errors?\b/gi, " ")
    .replace(/\bno\s+errors?\b/gi, " ")
    .replace(/\bcoded\s+errors?\b/gi, " ")
    .replace(/\berror\s+contracts?\b/gi, " ")
    .replace(/\berror\s+codes?\b/gi, " ")
    .replace(/\berror[-_\s]+budgets?\b/gi, " ") // "error budget policy", not a failure
    .replace(/\bfail-first\b/gi, " ")
    .replace(/\bfailed-before\b/gi, " ");
}

const normStatusToken = (tok) =>
  STATUS_MAP[
    tok
      .toLowerCase()
      .replace(/[\s—–-]+/g, "_")
  ];

function extractStatus(text) {
  // 1. Explicit labeled status / result (room-done blocks use "result:").
  let m = text.match(
    /\b(?:status|result)\s*[:=]\s*["']?([A-Za-z][A-Za-z _—–-]*)["']?/i
  );
  if (m) {
    const status = normStatusToken(m[1].trim());
    if (status) return field(status, "high", m[0].trim());
  }
  // 2. First-line terminal suffix, e.g. "… thread — DONE" / "… flow: DONE."
  const firstLine = (text.split("\n")[0] || "").trim();
  m = firstLine.match(
    /[—–\-:]\s*(DONE|COMPLETED|FINISHED|BLOCKED|FAILED|ERROR(?:ED)?)\s*[.!]?\s*$/i
  );
  if (m) {
    const status = normStatusToken(m[1]);
    if (status) return field(status, "high", m[0].trim());
  }
  // 2b. Leading DONE:/BLOCKED: prefix (older room convention).
  m = text.match(
    /^\s*(DONE|IN[- ]?PROGRESS|BLOCKED|FAILED|ERROR|TIMED[- ]?OUT|CANCEL+ED)\s*[:—–-]/im
  );
  if (m) {
    const status = normStatusToken(m[1]);
    if (status) return field(status, "high", m[0].trim());
  }
  // 3. Keyword classes on sanitized text — exactly one class may fire.
  const clean = sanitizeForStatus(text);
  const classes = {
    completed:
      /\b(done|completed|finished|shipped|landed|delivered|succeeded|success|merged|closed|green)\b/i,
    errored: /\b(failed|failure|error|broke|broken|crash(?:ed|es)?|timed?\s*out|timeout)\b/i,
    blocked: /\b(blocked|blocker|waiting\s+on|awaiting)\b/i,
  };
  const hits = Object.entries(classes)
    .filter(([, re]) => re.test(clean))
    .map(([k, re]) => ({ status: k, evidence: (clean.match(re) || [""])[0] }));
  const progOnly =
    /\b(in[- ]?progress|still working|remaining work|wip|cancel+ed|aborted)\b/i.test(
      clean
    );
  if (hits.length === 1) return field(hits[0].status, "medium", hits[0].evidence);
  if (hits.length === 0) {
    return field(
      null,
      "low",
      progOnly
        ? "report signals in-progress/cancelled; no v1 status exists"
        : "no status signal"
    );
  }
  return field(
    null,
    "low",
    `conflicting signals: ${hits.map((h) => h.status).join(", ")}`
  );
}

function extractSummary(text) {
  const noFences = text.replace(/```[\s\S]*?```/g, " ");
  const isJunk = (p, i) =>
    /^#{1,6}\s/.test(p) || // headings
    /^(?:workerId|status|result|files|branch|tests?|wave|claim)\s*[:=]/i.test(p) || // field lines
    (i > 0 && /^\[[^\]]+\]\[(?:claim|status)\]/i.test(p)); // claim/status re-posts (never the lead paragraph)
  const paragraphs = noFences
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((p, i) => !isJunk(p, i));
  const candidate =
    paragraphs.find((p) => p.length >= 40 && p.length < 900) || paragraphs[0];
  if (!candidate) return none();
  // Split into sentences, protecting dotted identifiers ("room.post",
  // "v1.0") from being treated as sentence boundaries, then re-merge any
  // short fragments that remain.
  const PROT = "\u0000";
  const guarded = candidate.replace(/(\w)\.(\w)/g, `$1${PROT}$2`);
  const raw = guarded.match(/[^.!?]+[.!?]+/g) || [];
  const consumed = raw.join("").length;
  const rest = guarded.slice(consumed).trim();
  if (rest) raw.push(rest);
  if (!raw.length) raw.push(guarded);
  const sentences = [];
  for (const s of raw) {
    const unprot = s.split(PROT).join(".").trim();
    const last = sentences[sentences.length - 1];
    if (last && last.length < 40)
      sentences[sentences.length - 1] = `${last} ${unprot}`.trim();
    else sentences.push(unprot);
  }
  const joined = sentences.slice(0, 3).join(" ").trim();
  return field(truncateWord(joined, SUMMARY_MAX), "medium", joined.slice(0, 160));
}

const FILE_ROOTS_SRC = "docs|scripts|tests|server|public|src|tools|\\.github";

// Static literals (FILE_ROOTS_SRC cannot be interpolated into /…/ literals).
const RE_BACKTICK_PATH = /`((?:docs|scripts|tests|server|public|src|tools|\.github)\/[^`\s]+)`/g;
const RE_BARE_PATH = /\b((?:docs|scripts|tests|server|public|src|tools|\.github)\/[A-Za-z0-9._/-]+\.[a-z]{1,5})\b/g;
const RE_WORKSPACE_PATH = /~\/workspace\/(?:pr-[\w-]+\/)?((?:docs|scripts|tests|server|public|src|tools|\.github)\/[^\s,;)"'`]+)/g;

function extractFilesChanged(text) {
  const found = [];
  const seen = new Set();
  const push = (p) => {
    p = p
      .replace(/^~\//, "")
      .replace(/^workspace\//, "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (!new RegExp(`^(?:${FILE_ROOTS_SRC})\\/`).test(p)) return;
    if (p.length > 200 || /\s/.test(p)) return;
    if (seen.has(p)) return;
    seen.add(p);
    found.push(p);
  };
  const negatedNear = (line, idx, len) => {
    // A path is excluded only when negation words sit in the same clause,
    // e.g. "existing `tests/rate-limit.test.js` untouched" — while NEW paths
    // later in the line ("Exact files: NEW src/a.mjs") are kept. Clause
    // boundaries are sentence-ish punctuation; "existing" alone is NOT a
    // negation ("extends existing work" must not nuke neighboring paths).
    const before = line.slice(0, idx).split(/[.;()—–-]/).pop();
    const after = line.slice(idx + len).split(/[.;()—–-]/)[0];
    return /\b(untouched|unchanged|not\s+(?:touched|changed|modified))\b/i.test(
      `${before} ${after}`
    );
  };
  // a. Labeled files: list.
  for (const m of text.matchAll(/^\s*files?\s*[:=]\s*(.+)$/gim)) {
    for (const part of m[1].split(/[,;|]/)) {
      part.trim().split(/\s+/).forEach(push);
    }
  }
  for (const line of text.split("\n")) {
    // b. Backtick-quoted paths.
    for (const m of line.matchAll(RE_BACKTICK_PATH)) {
      if (!negatedNear(line, m.index, m[0].length))
        push(m[1].replace(/[.,;:!?)]+$/, ""));
    }
    // c. Bare repo-relative paths (with or without intermediate dirs).
    for (const m of line.matchAll(RE_BARE_PATH)) {
      if (!negatedNear(line, m.index, m[0].length)) push(m[1]);
    }
    // d. ~/workspace/... paths.
    for (const m of line.matchAll(RE_WORKSPACE_PATH)) {
      if (!negatedNear(line, m.index, m[0].length))
        push(m[1].replace(/[.,;:!?)]+$/, ""));
    }
  }
  const files = found.slice(0, FILES_MAX);
  if (!files.length) return field([], "low", "no file paths found");
  const labeled = /^\s*files?\s*[:=]/im.test(text);
  return field(files, labeled ? "high" : "medium", files.slice(0, 5).join(", "));
}

function extractTests(text) {
  let m = text.match(
    /\btests?\s*[:=]?\s*run\s*[=:]\s*(\d+)\s*[,\s;]*pass(?:ed)?\s*[=:]\s*(\d+)\s*[,\s;]*fail(?:ed|ures)?\s*[=:]\s*(\d+)/i
  );
  if (m)
    return field({ run: +m[1], passed: +m[2], failed: +m[3] }, "high", m[0]);
  m = text.match(
    /\btests?\s*[:=]?\s*(\d+)\s*\/\s*(\d+)\s*(?:tests?|pass(?:ing|ed)?)\b/i
  );
  if (m) {
    const passed = +m[1];
    const run = +m[2];
    return field({ run, passed, failed: run - passed }, "medium", m[0]);
  }
  // "23/23 green", "3724/3724 across 797 test files".
  m = text.match(/\b(\d+)\s*\/\s*(\d+)\s+(?:green|across)\b/i);
  if (m) {
    const passed = +m[1];
    const run = +m[2];
    return field({ run, passed, failed: run - passed }, "medium", m[0]);
  }
  m = text.match(/\b(\d+)\s+tests?,?\s+all\s+green\b/i);
  if (m)
    return field({ run: +m[1], passed: +m[1], failed: 0 }, "medium", m[0]);
  m = text.match(/\b(\d+)\s*passed?,\s*(\d+)\s*failed?\b/i);
  if (m) {
    const passed = +m[1];
    const failed = +m[2];
    return field({ run: passed + failed, passed, failed }, "medium", m[0]);
  }
  m = text.match(/\ball\s+(\d+)\s+tests?\s+pass(?:ing|ed)?\b/i);
  if (m)
    return field({ run: +m[1], passed: +m[1], failed: 0 }, "medium", m[0]);
  // Suites reported green without counts: the schema's defined encoding for
  // "no counted tests" is {run:0,passed:0,failed:0}.
  if (/\b(all\s+)?tests?\s+(pass(?:ing|ed)?|green|ok)\b/i.test(text)) {
    return field(
      { run: 0, passed: 0, failed: 0 },
      "medium",
      (text.match(/\b(all\s+)?tests?\s+(pass(?:ing|ed)?|green|ok)\b/i) || [""])[0]
    );
  }
  return field({ run: 0, passed: 0, failed: 0 }, "low", "no test signal");
}

function extractClaimsFiled(text) {
  const ids = [];
  const push = (id, re) => {
    if (!id || ids.includes(id)) return;
    void re;
    ids.push(id);
  };
  for (const m of text.matchAll(/claim\.sh\s+claim\s+([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    push(m[1]);
  }
  // Room claim re-posts: "[quill-s2][claim] F023 …".
  for (const m of text.matchAll(
    /\[[^\]]*\]\[claim\]\s+([A-Za-z0-9][A-Za-z0-9._-]{0,40})/gi
  )) {
    push(m[1]);
  }
  // "Claim: #266 comment 5703142504" — the board claim's comment id.
  for (const m of text.matchAll(/#266\s+comment\s+(\d{5,})/gi)) {
    push(m[1]);
  }
  // Room task ids: RC-2026-09-16-007.
  for (const m of text.matchAll(/\b(RC-\d{4}-\d{2}-\d{2}-\d{3,6})\b/g)) {
    push(m[1]);
  }
  for (const m of text.matchAll(
    /\bclaim(?:[-_]id|\s+id)?\s*[:=]\s*["']?([a-z0-9][a-z0-9._-]*)/gi
  )) {
    if (/claim|wave500|w500|qa\d|product\d|help\d|demand\d/i.test(m[1]))
      push(m[1]);
  }
  for (const m of text.matchAll(
    /\b(?:claimed?|reclaim(?:ed)?)\s+([a-z0-9][a-z0-9._-]*)/gi
  )) {
    if (/claim|wave500|w500|qa\d|product\d|help\d|demand\d/i.test(m[1]))
      push(m[1]);
  }
  // Bare wave-style claim ids, excluding branch paths (slashes).
  for (const m of text.matchAll(
    /\b((?:wave500|w500|qa\d{2,4}|product\d{2,4}|help\d{2,4}|demand\d{2,4})-[a-z0-9-]+)\b/gi
  )) {
    const id = m[1].toLowerCase();
    if (/\/|\.\w{1,5}$/.test(id)) continue;
    push(id);
  }
  const claims = uniq(ids).slice(0, 32);
  if (!claims.length) return field([], "low", "no claim ids");
  const labeled =
    /claim\.sh\s+claim|\[[^\]]*\]\[claim\]|#266\s+comment/i.test(text);
  return field(claims, labeled ? "high" : "medium", claims.slice(0, 4).join(", "));
}

function extractBranch(text) {
  let m = text.match(
    /\bbranch\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._/-]{0,80})["']?/i
  );
  if (m) return field(m[1].replace(/[.,;:!?]+$/, ""), "high", m[0]);
  m = text.match(/\bon\s+branch\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,80})/i);
  if (m) return field(m[1].replace(/[.,;:!?]+$/, ""), "high", m[0]);
  m = text.match(/\b(wave500\/[a-z0-9][a-z0-9/_-]{1,60})\b/i);
  if (m && !/\.\w{1,5}$/.test(m[1])) {
    return field(m[1], "medium", m[0]);
  }
  return none();
}

function extractHeadSha(text) {
  let m = text.match(/\b(?:merge\s+)?sha\s*[:=]\s*([0-9a-f]{7,40})\b/i);
  if (m) return field(m[1].toLowerCase(), "high", m[0]);
  m = text.match(/\b[0-9a-f]{40}\b/);
  if (m) return field(m[0], "high", m[0]);
  m = text.match(
    /\b(?:commit(?:ted)?|pushed?|head|sha|merged?|at)\s*[:=]?\s+([0-9a-f]{7,40})\b/i
  );
  if (m) return field(m[1].toLowerCase(), "medium", m[0]);
  return none();
}

function extractOpenQuestions(text) {
  const qs = [];
  const seen = new Set();
  const push = (q, evidence) => {
    q = q.replace(/\s+/g, " ").trim().slice(0, 140);
    if (!q || seen.has(q)) return;
    seen.add(q);
    qs.push({ q, evidence });
  };
  for (const m of text.matchAll(
    /^\s*(?:[-*•>]|\d+[.)])?\s*(open\s+question|questions?|blockers?|needs?(?:\s+human)?|outstanding|unresolved|pending)\s*[:?-]\s*(.+)$/gim
  )) {
    if (/^(?:https?|#)/.test(m[2].trim())) continue;
    push(m[2], m[0].slice(0, 80));
  }
  // Lines ending in a question mark that read as asks.
  for (const m of text.matchAll(
    /^\s*(?:[-*•>]|\d+[.)])?\s*((?:should|can|could|will|would|is|are|does|do|what|how|when|who|which)\b[^?]{8,140})\?\s*$/gim
  )) {
    push(`${m[1].trim()}?`, m[0].slice(0, 80));
  }
  const questions = qs.slice(0, OPEN_QUESTIONS_MAX).map((e) => e.q);
  if (!questions.length) return field([], "low", "no open questions");
  return field(questions, "medium", questions[0].slice(0, 80));
}

const MS_PER_UNIT = [
  [/^ms|millis/i, 1],
  [/^s|sec/i, 1000],
  [/^m$|^min/i, 60000],
  [/^h|hr/i, 3600000],
];

function extractMsElapsed(text) {
  for (const line of text.split("\n")) {
    if (/\bage\s*=\s*/i.test(line)) continue; // claim ages, not report elapsed
    const m = line.match(
      /(?:elapsed|took|duration|runtime|spent|lasted)\s*:?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i
    );
    if (!m) continue;
    const unit = MS_PER_UNIT.find(([re]) => re.test(m[2]));
    if (!unit) continue;
    return field(Math.round(parseFloat(m[1]) * unit[1]), "medium", m[0].trim());
  }
  return none();
}

// Optional v1 fields: pr, ts.
function extractPr(text) {
  let m = text.match(/\bPR\s*[#:]\s*#?(\d{1,6})\b/i);
  if (m) return field(parseInt(m[1], 10), "high", m[0]);
  m = text.match(/\/pull\/(\d{1,6})\b/);
  if (m) return field(parseInt(m[1], 10), "medium", m[0]);
  return field(null, "low", "no PR number");
}

function extractTs(text) {
  const m = text.match(
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/
  );
  if (m && !Number.isNaN(Date.parse(m[1])))
    return field(m[1], "medium", m[0]);
  return field(null, "low", "no timestamp");
}

// ------------------------------------------------------------------ assembly

const EXTRACTORS = {
  workerId: extractWorkerId,
  waveId: extractWaveId,
  status: extractStatus,
  summary: extractSummary,
  filesChanged: extractFilesChanged,
  tests: extractTests,
  claimsFiled: extractClaimsFiled,
  branch: extractBranch,
  headSha: extractHeadSha,
  openQuestions: extractOpenQuestions,
  msElapsed: extractMsElapsed,
};

const OPTIONAL_EXTRACTORS = { pr: extractPr, ts: extractTs };

/** Normalize a free-text completion report into a v1 receipt. */
export function normalizeReport(text) {
  const inputBytes = Buffer.byteLength(text, "utf8");
  const extracted = {};
  for (const name of [...CORE_FIELDS, ...OPTIONAL_FIELDS]) {
    try {
      extracted[name] = (EXTRACTORS[name] || OPTIONAL_EXTRACTORS[name])(text);
    } catch {
      extracted[name] = none();
    }
  }
  const receipt = { v: 1 };
  const fieldConfidence = {};
  const needsHuman = [];
  for (const name of CORE_FIELDS) {
    const f = extracted[name];
    const confident = f.confidence === "high" || f.confidence === "medium";
    receipt[name] = confident ? f.value : null;
    fieldConfidence[name] = {
      value: f.value,
      confidence: f.confidence,
      evidence: f.evidence,
    };
    if (!confident) needsHuman.push(name);
  }
  // Optional v1 fields: include when confident, omit when not (never null).
  for (const name of OPTIONAL_FIELDS) {
    const f = extracted[name];
    fieldConfidence[name] = {
      value: f.value,
      confidence: f.confidence,
      evidence: f.evidence,
    };
    if (f.confidence === "high" || f.confidence === "medium") {
      receipt[name] = f.value;
    }
  }
  const receiptBytes = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  const output = {
    receipt,
    fieldConfidence,
    needsHuman,
    inputBytes,
    receiptBytes,
  };
  output.outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  return output;
}

// ------------------------------------------------------------------ CLI

function printHelp() {
  stdout.write(`normalize-report.mjs — free-text completion report -> v1 receipt

usage:
  node scripts/normalize-report.mjs [report.txt]      # file or stdin
  node scripts/normalize-report.mjs --receipt-only [report.txt]
  node scripts/normalize-report.mjs --help

output: JSON { receipt, fieldConfidence, needsHuman, inputBytes,
  receiptBytes, outputBytes } on stdout. With --receipt-only, only the
  receipt object is printed (pipe-friendly for validate-receipt.mjs):

  node scripts/normalize-report.mjs --receipt-only r.txt \\
    | node scripts/validate-receipt.mjs

receipt: v1 fields per docs/RECEIPT-SCHEMA.md — v, workerId, waveId,
  status (completed|errored|blocked), summary (<=280 chars),
  filesChanged[], tests {run,passed,failed}, claimsFiled[], branch,
  headSha, openQuestions[] (<=3), msElapsed, plus pr/ts when found.

Low-confidence fields are null in receipt and listed in needsHuman.
exit codes: 0 = normalized, 2 = usage/input error.
`);
}

export function main(argv) {
  const args = [];
  const flags = [];
  for (const a of argv) {
    if (a === "-") args.push(a);
    else if (a.startsWith("-")) flags.push(a);
    else args.push(a);
  }
  if (flags.includes("-h") || flags.includes("--help")) {
    printHelp();
    return 0;
  }
  const receiptOnly = flags.includes("--receipt-only");
  for (const f of flags) {
    if (f !== "--receipt-only") {
      process.stderr.write(`unknown flag ${f}\n`);
      return 2;
    }
  }
  let text = "";
  if (args.length > 1) {
    process.stderr.write(
      "usage: normalize-report.mjs [--receipt-only] [--help] [report-file]\n"
    );
    return 2;
  }
  if (args.length === 1) {
    try {
      text = readFileSync(args[0], "utf8");
    } catch (e) {
      process.stderr.write(`cannot read ${args[0]}: ${e.message}\n`);
      return 2;
    }
  } else {
    try {
      text = readFileSync(0, "utf8"); // stdin
    } catch (e) {
      process.stderr.write(`cannot read stdin: ${e.message}\n`);
      return 2;
    }
  }
  if (!text.trim()) {
    process.stderr.write("empty report: nothing to normalize\n");
    return 2;
  }
  const out = normalizeReport(text);
  stdout.write(
    receiptOnly
      ? JSON.stringify(out.receipt) + "\n"
      : JSON.stringify(out, null, 2) + "\n"
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  exit(main(process.argv.slice(2)));
}
