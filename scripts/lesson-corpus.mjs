// scripts/lesson-corpus.mjs
//
// Shared corpus loading/parsing for the lesson tools:
//   scripts/lesson-scorer.mjs (W014 quality scorer)
//   scripts/lesson-contradictions.mjs (W015 contradiction resolver)
// Sources: docs/ROOM-WIKI.md ("## YYYY-MM-DD · slice · agent" sections),
// docs/WEEKLY-LEARNINGS.md (bullets under "## <week>" headings), and any
// extra markdown (e.g. an AGENTS.md) parsed as "## Lessons" bullets.
// Pure module: no CLI, no writes.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ------------------------------------------------------------- tokenization

const STOPWORDS = new Set("a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,while,do,does,did,not,no,yes,so,such,than,too,very,can,will,just,into,over,under,after,before,when,where,which,who,whom,whose,my,our,your,his,her,their,per,via,vs".split(","));

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// ------------------------------------------------------------------ parsing

function stripFences(markdown) {
  return String(markdown).replace(/```[\s\S]*?```/g, "");
}

export function parseWikiEntries(markdown) {
  const text = stripFences(markdown);
  const headerRe = /^## (\d{4}-\d{2}-\d{2}) · (.+?) · (.+?)$/gm;
  const headers = [...text.matchAll(headerRe)];
  const entries = [];
  for (let k = 0; k < headers.length; k++) {
    const [full, date, slice, agent] = headers[k];
    const start = headers[k].index + full.length;
    const end = k + 1 < headers.length ? headers[k + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (!body) continue;
    const id = `wiki:${date}:${slice}`;
    entries.push({
      id,
      source: "wiki",
      date,
      slice,
      agent,
      text: `${date} · ${slice} · ${agent}\n${body}`,
    });
  }
  return entries;
}

export function parseQueueEntries(markdown) {
  const text = stripFences(markdown);
  const entries = [];
  let week = null;
  let n = 0;
  for (const line of text.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      week = h[1].trim();
      continue;
    }
    const b = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (b && week) {
      const body = b[1].trim();
      if (body.startsWith("<!--")) continue;
      entries.push({ id: `queue:${week}:${n++}`, source: "queue", week, text: body });
    }
  }
  return entries;
}

// Top-level "- " bullets under a "## Lessons" section (the operator's shared
// AGENTS.md has one; the repo's does not). Read-only; never writes back.
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

// ------------------------------------------------------------ corpus loading

const DEFAULT_FILES = ["docs/ROOM-WIKI.md", "docs/WEEKLY-LEARNINGS.md"];

// Scorer corpus: wiki + weekly learnings queue only.
export function loadCorpus(root, files) {
  const out = [];
  for (const rel of files && files.length ? files : DEFAULT_FILES) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    if (rel.includes("WIKI")) out.push(...parseWikiEntries(text));
    else out.push(...parseQueueEntries(text));
  }
  return out;
}

// Contradiction-resolver corpus: wiki + weekly learnings + any other file
// (e.g. an AGENTS.md) treated as lesson bullets.
export function loadAllCorpus(root, files) {
  const list = files && files.length ? files : DEFAULT_FILES;
  const out = [];
  for (const rel of list) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    if (rel.includes("WIKI")) out.push(...parseWikiEntries(text));
    else if (rel.includes("LEARNINGS")) out.push(...parseQueueEntries(text));
    else out.push(...parseLessonBullets(text));
  }
  return out;
}

// ------------------------------------------------------------------- preview

export function preview(text, max = 90) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
