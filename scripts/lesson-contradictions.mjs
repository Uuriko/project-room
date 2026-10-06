#!/usr/bin/env node
//
// scripts/lesson-contradictions.mjs
//
// Contradiction resolver — input side only — for conflicting lesson entries
// (backlog W015). Builds on the lessons corpus (docs/ROOM-WIKI.md,
// docs/WEEKLY-LEARNINGS.md, and the "## Lessons" bullets of AGENTS.md).
//
// This is a heuristic detector (no LLM). It normalizes lesson entries and
// flags pairs that look contradictory:
//   opposing-directive     one entry says "never X", another says
//                          "always X" (or must/do X) on the same topic —
//                          same file path, shared identifier, or strong
//                          topic-token overlap plus overlapping directive
//                          targets.
//   preference-inversion     one entry prefers X over Y, another prefers
//                          Y over X.
//   unmarked-supersession    an entry claims to supersede/replace/correct a
//                          specific corpus entry without the correction
//                          entry referencing it back (the wiki is
//                          append-only, so the old entry can't mark itself
//                          — the pointer is one-way and needs review).
//
// It REPORTS ONLY. It never edits, deletes, resolves, or reorders lesson
// entries. Every hit is for human review; the report says so explicitly.
//
// Usage:
//   node scripts/lesson-contradictions.mjs [--json] [--files f1 f2 ...]
//   Default: scan docs/ROOM-WIKI.md + docs/WEEKLY-LEARNINGS.md.
//   Pass a repo AGENTS.md (or any markdown with a "## Lessons" section) via
//   --files to include its lesson bullets.
//   Exit 0 on ok; 1 on error or when --fail-on-hit is set and any hit exists.
//
// The pure helpers are exported for tests/lesson-contradictions.test.js
// (repo convention: scripts export helpers, tests import them).

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseWikiEntries,
  parseQueueEntries,
  tokenize,
} from "./lesson-scorer.mjs";

// ------------------------------------------------------- directive extraction

// Strong modals: directive force regardless of position within the clause
// lead (they are rarely descriptive). Plain verbs count only when they are
// the FIRST token of the clause — otherwise "full clones keep the history
// visible" (descriptive) would read as a directive.
const STRONG_NEG = [
  "never",
  "do not",
  "don't",
  "does not",
  "doesn't",
  "must not",
  "mustn't",
  "should not",
  "shouldn't",
  "avoid",
  "refuse to",
  "stop",
];
const STRONG_POS = ["always"];
const VERB_NEG = [];
const VERB_POS = [
  "commit to",
  "commit",
  "must",
  "should",
  "use",
  "prefer",
  "require",
  "run",
  "check",
  "verify",
  "post",
  "fetch",
  "refetch",
  "re-fetch",
  "treat",
  "read",
  "inspect",
  "keep",
  "merge",
  "rebase",
  "test",
  "repair",
  "ship",
  "stand",
  "release",
  "record",
  "append",
  "quote",
  "pin",
  "gate",
  "split",
  "move",
  "copy",
  "rename",
  "open",
  "close",
  "land",
  "deploy",
  "delete",
  "remove",
  "add",
];

function phraseRe(phrases, anchored = false) {
  const alt = phrases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
    .join("|");
  if (!alt) return null;
  return new RegExp(`${anchored ? "^" : ""}\\b(?:${alt})\\b`, "i");
}

const STRONG_NEG_LEAD_RE = phraseRe(STRONG_NEG);
const STRONG_POS_LEAD_RE = phraseRe(STRONG_POS);
const NEG_FIRST_RE = phraseRe([...STRONG_NEG, ...VERB_NEG], true);
const POS_FIRST_RE = phraseRe([...STRONG_POS, ...VERB_POS], true);

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?:;])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

// A directive = one clause whose leading words (first three tokens) carry a
// polarity-bearing word, plus the significant tokens that follow it (the
// "target" of the directive). Strong modals (never/always/do-not/…) qualify
// anywhere in the lead; plain verbs (keep/use/prefer/…) only as the first
// token — otherwise descriptive sentences like "full clones keep the real
// history visible" would count as directives while true rules
// ("never git stash…") still qualify.
export function extractDirectives(text) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    const lower = sentence.toLowerCase();
    const lead = lower.split(/\s+/).slice(0, 3).join(" ");
    let m = NEG_FIRST_RE?.exec(lower) ?? null;
    let polarity = m ? "neg" : null;
    if (!m) {
      m = POS_FIRST_RE?.exec(lower) ?? null;
      polarity = m ? "pos" : null;
    }
    if (!m) {
      // Non-first-token matches count only for strong modals — a leading
      // verb like "keep"/"use"/"prefer" is descriptive, not a directive.
      m = STRONG_NEG_LEAD_RE?.exec(lead) ?? null;
      polarity = m ? "neg" : null;
    }
    if (!m) {
      m = STRONG_POS_LEAD_RE?.exec(lead) ?? null;
      polarity = m ? "pos" : null;
    }
    if (!m) continue;
    const rest = lower.slice(m.index + m[0].length);
    const targets = new Set(tokenize(rest).slice(0, 10));
    out.push({
      polarity,
      phrase: m[0],
      targets,
      sentence: sentence.length > 220 ? sentence.slice(0, 219) + "…" : sentence,
    });
  }
  return out;
}

// ---------------------------------------------------------------- topic share

const PATH_RE = /(?<![\w/])(?:[\w\-.~]+\/)+[\w\-.]+/g;
const BACKTICK_RE = /`([^`\n]+)`/g;

// Tokens that carry no topic signal on their own.
const GENERIC = new Set([
  "never",
  "always",
  "must",
  "should",
  "use",
  "used",
  "using",
  "don",
  "doesn",
  "lesson",
  "rule",
  "review",
  "corpus",
]);

function pathAnchors(text) {
  const out = new Set();
  for (const m of String(text).matchAll(PATH_RE)) {
    const p = m[0].toLowerCase();
    if (p.includes(".") && !p.startsWith("http")) out.add(p);
  }
  for (const m of String(text).matchAll(BACKTICK_RE)) {
    const id = m[1].trim().toLowerCase();
    if (id.length >= 3 && !id.includes(" ")) out.add("`" + id + "`");
  }
  return out;
}

// What two entries talk about: shared file paths / backtick identifiers
// (hard anchors) and shared significant tokens (soft anchors).
export function sharedAnchors(a, b) {
  const pa = pathAnchors(a);
  const pb = pathAnchors(b);
  const paths = [...pa].filter((x) => pb.has(x));
  const ta = new Set(tokenize(a).filter((t) => !GENERIC.has(t)));
  const tb = new Set(tokenize(b).filter((t) => !GENERIC.has(t)));
  const tokens = [...ta].filter((t) => tb.has(t));
  return { paths, tokens };
}

const MIN_SHARED_TOKENS = 3;
const MIN_TARGET_OVERLAP = 2;

function topicShared(a, b) {
  const { paths, tokens } = sharedAnchors(a, b);
  return paths.length > 0 || tokens.length >= MIN_SHARED_TOKENS;
}

function intersectSets(a, b) {
  const out = [];
  for (const t of a) if (b.has(t) && !GENERIC.has(t)) out.push(t);
  return out;
}

// ------------------------------------------------------- contradiction types

const PREFER_RE = /\bprefer\s+(.+?)\s+over\s+(.+?)(?:[.;,]|$)/i;

function preferenceOf(text) {
  const m = PREFER_RE.exec(text);
  if (!m) return null;
  const side = (s) => new Set(tokenize(s).filter((t) => !GENERIC.has(t)));
  // Drop tokens present on both sides (sentence bleed); they carry no order signal.
  const x = side(m[1]);
  const y = side(m[2]);
  for (const t of [...x]) if (y.has(t)) { x.delete(t); y.delete(t); }
  if (x.size === 0 || y.size === 0) return null;
  return { x, y, raw: m[0].trim() };
}

function inversion(a, b) {
  if (!a || !b) return false;
  const xy = intersectSets(a.x, b.y);
  const yx = intersectSets(a.y, b.x);
  return xy.length >= 1 && yx.length >= 1;
}

// An entry claims to supersede another when it names the supersession AND
// points at a specific, identifiable corpus entry (a date, a PR/issue ref,
// or a wiki id/slice token). Vague "replaces our habits" lines are skipped.
const SUPER_RE =
  /\b(supersedes?|obsoletes?|replaces?|corrects?|correction (?:to|of)|takes? the place of|newer guidance|updated guidance|no longer (?:true|valid))\b/i;
const ENTRY_REF_RE = /\b20\d{2}-\d{2}-\d{2}\b|#\d{2,}\b|`[\w\-/.]+(?::\d+)?`/;

export function supersessionClaim(entry, corpus) {
  if (!SUPER_RE.test(entry.text)) return null;
  const refs = entry.text.match(ENTRY_REF_RE);
  if (!refs) return null;
  const ref = refs[0].toLowerCase().replace(/`/g, "");
  const target = corpus.find(
    (e) =>
      e.id !== entry.id &&
      (e.text.toLowerCase().includes(ref) || e.id.toLowerCase().includes(ref))
  );
  return target ? { ref: refs[0], target: target.id } : null;
}

export function findContradictions(entries) {
  const hits = [];
  const directives = new Map(entries.map((e) => [e.id, extractDirectives(e.text)]));
  const prefs = new Map(entries.map((e) => [e.id, preferenceOf(e.text)]));

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];

      // 3. Unmarked supersession — checked first: it is an explicit
      // reference to a named entry, not a topic-overlap judgment.
      for (const [src, dst] of [[a, b], [b, a]]) {
        const sup = supersessionClaim(src, entries);
        if (sup && sup.target === dst.id) {
          hits.push({
            type: "unmarked-supersession",
            a: src.id,
            b: dst.id,
            shared: [sup.ref],
            evidence: [
              src.text.length > 220 ? src.text.slice(0, 219) + "…" : src.text,
            ],
          });
        }
      }

      if (!topicShared(a.text, b.text)) continue;

      // 1. Opposing directives on the same topic.
      const da = directives.get(a.id);
      const db = directives.get(b.id);
      for (const x of da) {
        for (const y of db) {
          if (x.polarity === y.polarity) continue;
          const overlap = intersectSets(x.targets, y.targets);
          if (overlap.length >= MIN_TARGET_OVERLAP) {
            hits.push({
              type: "opposing-directive",
              a: a.id,
              b: b.id,
              shared: overlap.slice(0, 6),
              evidence: [x.sentence, y.sentence],
            });
          }
        }
      }

      // 2. Preference inversion (X>Y vs Y>X).
      if (inversion(prefs.get(a.id), prefs.get(b.id))) {
        hits.push({
          type: "preference-inversion",
          a: a.id,
          b: b.id,
          shared: [],
          evidence: [prefs.get(a.id).raw, prefs.get(b.id).raw],
        });
      }

    }
  }
  return hits;
}

// ---------------------------------------------------- agent-lessons parsing

// The repo AGENTS.md has no "## Lessons" section, but the operator's shared
// AGENTS.md does (top-level "- " bullets). Parse those when the file is
// passed via --files. Never writes back to the file.
export function parseLessonBullets(markdown) {
  const lines = String(markdown).split("\n");
  let inLessons = false;
  const entries = [];
  let cur = null;
  let n = 0;
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (cur) {
        entries.push({ id: `agent-lessons:${n++}`, source: "agent-lessons", text: cur.join("\n").trim() });
        cur = null;
      }
      inLessons = /^lessons$/i.test(h[1].trim());
      continue;
    }
    if (!inLessons) continue;
    const b = /^-\s+(.+?)\s*$/.exec(line);
    if (b) {
      if (cur) entries.push({ id: `agent-lessons:${n++}`, source: "agent-lessons", text: cur.join("\n").trim() });
      cur = [b[1]];
    } else if (cur && line.trim().length) {
      cur.push(line.trim());
    }
  }
  if (cur) entries.push({ id: `agent-lessons:${n++}`, source: "agent-lessons", text: cur.join("\n").trim() });
  return entries;
}

export function loadAllCorpus(root, files) {
  const defaults = ["docs/ROOM-WIKI.md", "docs/WEEKLY-LEARNINGS.md"];
  const list = files && files.length ? files : defaults;
  const out = [];
  for (const rel of list) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    if (rel.includes("WIKI")) out.push(...parseWikiEntries(text));
    else if (rel.includes("WEEKLY-LEARNINGS") || rel.includes("LEARNINGS"))
      out.push(...parseQueueEntries(text));
    else out.push(...parseLessonBullets(text));
  }
  return out;
}

// ------------------------------------------------------------------ reporting

function preview(text, max = 140) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

const TYPE_BLURB = {
  "opposing-directive":
    "one entry directs FOR and the other AGAINST the same topic — check which holds now",
  "preference-inversion":
    "entries rank two options in opposite order — one of the preferences is stale",
  "unmarked-supersession":
    "an entry claims to supersede a named entry; append-only wiki cannot mark the old one — verify a review pointer exists",
};

export function renderContradictionReport(hits, { format = "text" } = {}) {
  if (format === "json") return JSON.stringify({ hits }, null, 2);
  const lines = [];
  lines.push(`Contradiction scan — ${hits.length} candidate${hits.length === 1 ? "" : "s"} flagged for human review`);
  lines.push("report-only: this tool only reports; it never changes lesson entries in any way.");
  lines.push("");
  if (!hits.length) {
    lines.push("no contradictions found.");
    return lines.join("\n");
  }
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. [${h.type}] ${h.a}  <>  ${h.b}`);
    lines.push(`   ${TYPE_BLURB[h.type]}`);
    if (h.shared.length) lines.push(`   shared: ${h.shared.join(", ")}`);
    for (const ev of h.evidence) lines.push(`   > ${preview(ev)}`);
    lines.push("");
  });
  return lines.join("\n");
}

// ------------------------------------------------------------------------ CLI

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = { format: "text", failOnHit: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.format = "json";
    else if (a === "--fail-on-hit") opts.failOnHit = true;
    else if (a === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.files.push(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/lesson-contradictions.mjs [--json] [--fail-on-hit] [--files f ...]"
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
  const entries = loadAllCorpus(root, opts.files);
  const hits = findContradictions(entries);
  console.log(renderContradictionReport(hits, { format: opts.format }));
  if (opts.failOnHit && hits.length) process.exit(1);
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) main(process.argv.slice(2));
