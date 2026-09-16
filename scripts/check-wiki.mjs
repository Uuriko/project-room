// Wiki schema check: docs/ROOM-WIKI.md must be a well-formed append-only log.
// Standalone: `node scripts/check-wiki.mjs`. Exit 0 on success, 1 on failure.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "docs", "ROOM-WIKI.md");
const text = readFileSync(path, "utf8");

const failures = [];
const fail = (msg) => failures.push(msg);

const headerRe = /^## (\d{4}-\d{2}-\d{2}) · (.+?) · (.+?)$/;
const lines = text.split("\n");
const entries = [];
let current = null;
let inFence = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.trimStart().startsWith("```")) { inFence = !inFence; continue; }
  if (inFence) continue;
  if (line.startsWith("## ")) {
    if (current) entries.push(current);
    const m = headerRe.exec(line);
    if (!m) {
      fail(`line ${i + 1}: entry header does not match schema: ${line}`);
      current = null;
    } else {
      const [, date, id, agent] = m;
      if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) {
        fail(`line ${i + 1}: invalid date: ${date}`);
      }
      if (!id.trim() || !agent.trim()) fail(`line ${i + 1}: empty slice/id or agent`);
      current = { line: i + 1, date, bullets: new Set() };
    }
  } else if (current) {
    const b = /^-\s*(Tried|Outcome|Lesson|Rejected):/.exec(line);
    if (b) current.bullets.add(b[1]);
  }
}
if (current) entries.push(current);

if (entries.length === 0) fail("no entries found");

for (const e of entries) {
  for (const need of ["Tried", "Outcome", "Lesson", "Rejected"]) {
    if (!e.bullets.has(need)) fail(`entry at line ${e.line} (${e.date}): missing "- ${need}:" bullet`);
  }
}

for (let i = 1; i < entries.length; i++) {
  if (entries[i].date < entries[i - 1].date) {
    fail(`entries out of order: ${entries[i].date} (line ${entries[i].line}) after ${entries[i - 1].date} (line ${entries[i - 1].line}) — wiki is append-only, newest last`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`wiki-check: ${f}`);
  console.error(`wiki-check: FAILED (${failures.length} problem${failures.length === 1 ? "" : "s"}, ${entries.length} entries)`);
  process.exit(1);
}
console.log(`wiki-check: OK (${entries.length} entries, schema + order valid)`);

// --- Raw traces plane: docs/ROOM-TRACES.jsonl ---
// One JSON object per non-empty, non-comment line. Comment lines start with #.
const traceFailures = [];
const tracePath = join(root, "docs", "ROOM-TRACES.jsonl");
const traceLines = readFileSync(tracePath, "utf8").split("\n");
const traceDates = [];
let traceCount = 0;
const required = ["date", "slice", "agent", "pr", "sha", "outcome", "tests", "notes"];

for (let i = 0; i < traceLines.length; i++) {
  const line = traceLines[i].trim();
  if (!line || line.startsWith("#")) continue;
  traceCount++;
  let obj;
  try {
    obj = JSON.parse(traceLines[i]);
  } catch {
    traceFailures.push(`traces line ${i + 1}: not valid JSON`);
    continue;
  }
  if (typeof obj !== "object" || Array.isArray(obj)) {
    traceFailures.push(`traces line ${i + 1}: not a JSON object`);
    continue;
  }
  for (const key of required) {
    if (!(key in obj)) traceFailures.push(`traces line ${i + 1}: missing key "${key}"`);
  }
  if (obj.tests && (typeof obj.tests.pass !== "number" || typeof obj.tests.fail !== "number")) {
    traceFailures.push(`traces line ${i + 1}: tests must be {pass:number, fail:number}`);
  }
  if (typeof obj.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.date)) {
    traceDates.push({ date: obj.date, line: i + 1 });
  } else {
    traceFailures.push(`traces line ${i + 1}: invalid date`);
  }
}

for (let i = 1; i < traceDates.length; i++) {
  if (traceDates[i].date < traceDates[i - 1].date) {
    traceFailures.push(`traces out of order: ${traceDates[i].date} (line ${traceDates[i].line}) after ${traceDates[i - 1].date} (line ${traceDates[i - 1].line})`);
  }
}

if (traceFailures.length > 0) {
  for (const f of traceFailures) console.error(`wiki-check: ${f}`);
  console.error(`wiki-check: TRACES FAILED (${traceFailures.length} problem${traceFailures.length === 1 ? "" : "s"}, ${traceCount} traces)`);
  process.exit(1);
}
console.log(`wiki-check: traces OK (${traceCount} traces, schema + order valid)`);
