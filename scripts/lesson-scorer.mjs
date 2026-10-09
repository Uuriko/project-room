#!/usr/bin/env node
//
// scripts/lesson-scorer.mjs
//
// Lesson quality scorer (backlog W014): signal-vs-noise lint for the lessons
// corpus (room wiki, weekly learnings queue).
//
// This is a heuristic tool, not an LLM judge. It scores each lesson entry
// 0-100 on four signal dimensions and flags low-signal entries for human
// review. It REPORTS ONLY: it never edits, deletes, or reorders lessons.
//
// Dimensions (weights sum to 100, vagueness subtracts):
//   evidence      0-30  cited proof: file:line refs, PR/issue refs, commit
//                       SHAs, dates, room seqs, URLs, outcome markers (✓/✗),
//                       measured numbers.
//   actionability 0-30  the lesson tells the reader what to do: never/always,
//                       RULE:, don't, must, imperative verbs, numbered steps,
//                       prefer-X-over-Y phrasing.
//   concreteness  0-20  specific detail: code identifiers, paths, quoted
//                       strings, numbers — vs abstract generalities.
//   shape         0-20  length sweet spot (~80-600 chars). Essays and
//                       one-liners score low.
//   vagueness          penalty for hedge/generality phrases ("be careful",
//                       "make sure", "in general", "maybe", ...).
//
// Duplicate detection: token-overlap (Jaccard) near-dupes get a `dup-of:`
// flag on the later entry, so reviewers can consolidate.
//
// Usage:
//   node scripts/lesson-scorer.mjs [--format text|json] [--threshold N]
//       [--fail-under N] [--top N] [--files f1 f2 ...]
//   Default: score docs/ROOM-WIKI.md + docs/WEEKLY-LEARNINGS.md and print a
//   text report. Exit 0 on ok; 1 on error, or when --fail-under is set and
//   any entry scores below it.
//
// The pure helpers are exported for tests/lesson-scorer.test.js (repo
// convention: scripts export helpers, tests import them).

import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCorpus, preview, tokenize } from "./lesson-corpus.mjs";
// Back-compat re-exports: docs/lesson-scorer.md lists these as the script's
// API and lesson-contradictions.mjs used to import them from here.
export { parseWikiEntries, parseQueueEntries, tokenize, loadCorpus } from "./lesson-corpus.mjs";

export const REVIEW_THRESHOLD = 40; // below this: flagged for review
export const HIGH_SIGNAL_BAR = 60; // at/above this: solid signal
export const DUP_THRESHOLD = 0.55; // Jaccard at/above this: near-duplicate

// ---------------------------------------------------------------- scoring

const FILE_LINE_RE = /[\w\-./~]+\.(mjs|js|cjs|ts|tsx|jsx|md|markdown|yaml|yml|json|jsonl|sh|bash|css|html|py|go|rs)\s*:\s*\d+/g;
const PR_REF_RE = /(?:^|[\s(])#\d{2,}\b/g;
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const DATE_RE = /\b20\d{2}-\d{2}-\d{2}\b/g;
const SEQ_RE = /\bseq(?:uence)?\s+\d{3,}\b/gi;
const URL_RE = /https?:\/\/[^\s)]+/g;
const OUTCOME_RE = /(?:✓|✗|Outcome:|Verified|measured|confirmed)/g;
const NUMBER_RE = /\b\d{2,}\b/g;
const BACKTICK_RE = /`[^`\n]+`/g;
const QUOTED_RE = /"[^"\n]{2,}"/g;
const PATH_RE = /(?<![\w/])(?:[\w\-.~]+\/)+[\w\-.]+/g;
const IDENT_RE = /\b[a-z]+(?:[A-Z][a-z0-9]+){1,}|\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g;

const NEVER_RE = /\bnever\b/i;
const ALWAYS_RE = /\balways\b/i;
const RULE_RE = /\bRULE\s*:/;
const DONT_RE = /\bdon'?t\b/i;
const MUST_RE = /\bmust\b/i;
const STEPS_RE = /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+\S/m;
const INSTEAD_RE = /\binstead\b/i;

const IMPERATIVES = [
  "use", "run", "check", "verify", "prefer", "avoid", "keep", "delete",
  "remove", "add", "merge", "rebase", "commit", "test", "read", "fetch",
  "post", "skip", "treat", "repair", "restore", "inspect", "diff",
  "rebuild", "stand", "release", "record", "append", "quote", "pin",
  "gate", "freeze", "cap", "split", "move", "copy", "rename", "open",
  "close", "land", "ship", "deploy",
];
const IMPERATIVE_RE = new RegExp(
  `(?:^|[.!?;]\\s*|\\(\\s*|:\\s*|\\n\\s*-\\s*)(${IMPERATIVES.join("|")})\\b`,
  "gim"
);

const VAGUE_PHRASES = [
  "keep in mind", "be careful", "be aware", "be mindful", "make sure",
  "think about", "in general", "take care", "as appropriate", "do your best",
  "your best", "sort of", "kind of",
];
const VAGUE_WORDS = [
  "consider", "ensure", "leverage", "stuff", "things", "something",
  "everything", "anything", "somehow",
];
const HEDGE_WORDS = ["maybe", "possibly", "perhaps", "might", "could be"];

function countMatches(text, re) {
  const m = text.match(re instanceof RegExp && re.global ? re : new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  return m ? m.length : 0;
}

function scoreEvidence(text) {
  let s = 0;
  s += Math.min(20, countMatches(text, FILE_LINE_RE) * 10);
  s += Math.min(16, countMatches(text, PR_REF_RE) * 8);
  s += Math.min(16, countMatches(text, SHA_RE) * 8);
  s += Math.min(10, (countMatches(text, DATE_RE) + countMatches(text, SEQ_RE)) * 5);
  s += Math.min(10, countMatches(text, URL_RE) * 5);
  s += Math.min(8, countMatches(text, OUTCOME_RE) * 4);
  s += Math.min(8, countMatches(text, NUMBER_RE) * 2);
  return Math.min(30, s);
}

function scoreActionability(text) {
  let s = 0;
  if (NEVER_RE.test(text)) s += 10;
  if (ALWAYS_RE.test(text)) s += 8;
  if (RULE_RE.test(text)) s += 10;
  if (DONT_RE.test(text)) s += 8;
  if (MUST_RE.test(text)) s += 5;
  if (STEPS_RE.test(text)) s += 6;
  if (INSTEAD_RE.test(text)) s += 5;
  s += Math.min(12, countMatches(text, IMPERATIVE_RE) * 6);
  return Math.min(30, s);
}

function scoreConcreteness(text) {
  let s = 0;
  s += Math.min(12, countMatches(text, BACKTICK_RE) * 4);
  s += Math.min(6, countMatches(text, QUOTED_RE) * 3);
  s += Math.min(12, countMatches(text, PATH_RE) * 4);
  s += Math.min(5, countMatches(text, NUMBER_RE));
  s += Math.min(6, countMatches(text, IDENT_RE) * 2);
  return Math.min(20, s);
}

function scoreShape(text) {
  const len = text.trim().length;
  if (len < 40) return { score: 4, flag: "too-short" };
  if (len < 80) return { score: 12, flag: null };
  if (len <= 600) return { score: 20, flag: null };
  if (len <= 1200) return { score: 14, flag: "long" };
  if (len <= 2000) return { score: 8, flag: "long" };
  return { score: 3, flag: "essay" };
}

function scoreVagueness(text) {
  const lower = text.toLowerCase();
  let penalty = 0;
  for (const p of VAGUE_PHRASES) {
    let i = -1;
    while ((i = lower.indexOf(p, i + 1)) !== -1) penalty += 6;
  }
  for (const w of VAGUE_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, "gi");
    penalty += countMatches(text, re) * 3;
  }
  for (const w of HEDGE_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, "gi");
    penalty += countMatches(text, re) * 2;
  }
  return Math.min(24, penalty);
}

export function scoreLesson(text) {
  const t = String(text ?? "");
  const evidence = scoreEvidence(t);
  const actionability = scoreActionability(t);
  const concreteness = scoreConcreteness(t);
  const shape = scoreShape(t);
  const vagueness = scoreVagueness(t);

  const flags = [];
  if (shape.flag) flags.push(shape.flag);
  if (evidence === 0) flags.push("no-evidence");
  if (actionability === 0) flags.push("no-action");
  if (vagueness >= 6) flags.push("vague");

  const score = Math.max(
    0,
    Math.min(100, evidence + actionability + concreteness + shape.score - vagueness)
  );
  return {
    score,
    dims: { evidence, actionability, concreteness, shape: shape.score, vagueness },
    flags,
  };
}

export function scoreEntry(entry) {
  const r = scoreLesson(entry.text);
  return { ...entry, score: r.score, dims: r.dims, flags: [...r.flags] };
}

// ------------------------------------------------------- duplicate detection

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function findDuplicates(entries, { threshold = DUP_THRESHOLD } = {}) {
  const toks = entries.map((e) => tokenize(e.text));
  const pairs = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sim = jaccard(toks[i], toks[j]);
      if (sim >= threshold) {
        pairs.push({
          a: entries[i].id,
          b: entries[j].id,
          similarity: Math.round(sim * 1000) / 1000,
        });
      }
    }
  }
  return pairs;
}

export function scoreCorpus(entries) {
  const scored = entries.map(scoreEntry);
  const byId = new Map(scored.map((e) => [e.id, e]));
  for (const { a, b } of findDuplicates(entries)) {
    const later = byId.get(b);
    if (later && !later.flags.some((f) => f.startsWith("dup-of:"))) {
      later.flags.push(`dup-of:${a}`);
    }
  }
  // Stable: highest score first, ties keep corpus order.
  return scored
    .map((e, i) => ({ e, i }))
    .sort((x, y) => y.e.score - x.e.score || x.i - y.i)
    .map(({ e }) => e);
}

// Corpus loading/parsing now lives in scripts/lesson-corpus.mjs
// (parseWikiEntries, parseQueueEntries, loadCorpus, tokenize, preview);
// the re-exports above keep this script's documented API intact.

// ------------------------------------------------------------------- reporting

export function renderReport(scored, { threshold = REVIEW_THRESHOLD, top = Infinity } = {}) {
  const lines = [];
  const n = scored.length;
  const low = scored.filter((e) => e.score < threshold);
  const avg = n ? scored.reduce((a, e) => a + e.score, 0) / n : 0;
  lines.push(`Lesson quality report — ${n} entries scored (threshold ${threshold}, avg ${avg.toFixed(1)})`);
  lines.push("");
  lines.push("ranked:");
  scored.slice(0, top).forEach((e, i) => {
    const flag = e.flags.length ? ` [${e.flags.join(", ")}]` : "";
    const mark = e.score < threshold ? " REVIEW" : "";
    lines.push(
      `  ${String(i + 1).padStart(3)}  ${String(e.score).padStart(3)}  ${e.id}${flag}${mark}`
    );
    lines.push(`        ${preview(e.text)}`);
  });
  lines.push("");
  if (low.length) {
    lines.push(`REVIEW — ${low.length} low-signal entr${low.length === 1 ? "y" : "ies"} (score < ${threshold}):`);
    for (const e of low) {
      lines.push(`  - ${e.id} (score ${e.score}, flags: ${e.flags.join(", ") || "none"})`);
      lines.push(`    ${preview(e.text, 160)}`);
    }
  } else {
    lines.push("REVIEW — none. Every entry scored at or above the threshold.");
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------------ CLI

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = { format: "text", threshold: REVIEW_THRESHOLD, failUnder: null, top: Infinity, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.format = "json";
    else if (a === "--threshold") opts.threshold = Number(argv[++i]);
    else if (a === "--fail-under") opts.failUnder = Number(argv[++i]);
    else if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.files.push(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/lesson-scorer.mjs [--json] [--threshold N] [--fail-under N] [--top N] [--files f ...]"
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const entries = loadCorpus(root, opts.files);
  const scored = scoreCorpus(entries);
  if (opts.format === "json") {
    console.log(JSON.stringify({ threshold: opts.threshold, entries: scored }, null, 2));
  } else {
    console.log(renderReport(scored, { threshold: opts.threshold, top: opts.top }));
  }
  if (opts.failUnder != null && scored.some((e) => e.score < opts.failUnder)) {
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) main(process.argv.slice(2));
