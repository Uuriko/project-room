#!/usr/bin/env node
// validate-receipt.mjs — validate a worker receipt against docs/RECEIPT-SCHEMA.md v1.
// Usage: node scripts/validate-receipt.mjs receipt.json
//        cat receipt.json | node scripts/validate-receipt.mjs
// Exit 0: VALID (<bytes> bytes). Exit 1: one specific error per violated rule.
// Node stdlib only.
import { readFileSync } from "node:fs";

const MAX_BYTES = 2048;
const KNOWN = new Set([
  "v", "workerId", "waveId", "status", "summary", "filesChanged", "tests",
  "claimsFiled", "branch", "headSha", "openQuestions", "msElapsed",
  "pr", "ts", "metrics",
]);
const errors = [];
const err = (m) => errors.push(m);

function str(v, name, min, max) {
  if (typeof v !== "string") return err(`${name}: expected string, got ${typeof v}`), null;
  if (v.length < min) err(`${name}: ${v.length} chars, min ${min}`);
  if (v.length > max) err(`${name}: ${v.length} chars, max ${max}`);
  return v;
}
function strArr(v, name, maxItems, maxLen) {
  if (!Array.isArray(v)) return err(`${name}: expected array, got ${typeof v}`), null;
  if (v.length > maxItems) err(`${name}: ${v.length} items, max ${maxItems}`);
  v.forEach((x, i) => str(x, `${name}[${i}]`, 1, maxLen));
  return v;
}
function int(v, name, min = 0) {
  if (!Number.isInteger(v) || v < min) err(`${name}: expected integer >= ${min}, got ${JSON.stringify(v)}`);
  return v;
}

async function main() {
  let raw;
  const file = process.argv[2];
  if (file) {
    try { raw = readFileSync(file, "utf8"); }
    catch (e) { console.error(`ERROR: cannot read ${file}: ${e.message}`); process.exit(1); }
  } else {
    raw = await new Promise((res) => { let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => res(s)); });
  }
  let r;
  try { r = JSON.parse(raw); }
  catch (e) { console.error(`ERROR: invalid JSON: ${e.message}`); process.exit(1); }
  if (r === null || typeof r !== "object" || Array.isArray(r)) {
    console.error("ERROR: receipt must be a JSON object"); process.exit(1);
  }

  for (const k of Object.keys(r)) if (!KNOWN.has(k)) err(`unknown field: ${JSON.stringify(k)}`);

  if (r.v !== 1) err(`v: expected 1, got ${JSON.stringify(r.v)}`);
  str(r.workerId, "workerId", 1, 64);
  str(r.waveId, "waveId", 1, 64);
  if (!["completed", "errored", "blocked"].includes(r.status))
    err(`status: expected completed|errored|blocked, got ${JSON.stringify(r.status)}`);
  str(r.summary, "summary", 1, 280);
  strArr(r.filesChanged, "filesChanged", 50, 200);
  if (r.tests === null || typeof r.tests !== "object" || Array.isArray(r.tests)) {
    err(`tests: expected object {run, passed, failed}, got ${JSON.stringify(r.tests)}`);
  } else {
    const t = r.tests;
    for (const k of ["run", "passed", "failed"]) int(t[k], `tests.${k}`);
    if (Object.keys(t).some((k) => !["run", "passed", "failed"].includes(k)))
      err(`tests: unknown sub-field(s): ${Object.keys(t).filter((k) => !["run","passed","failed"].includes(k)).join(", ")}`);
    if (Number.isInteger(t.run) && Number.isInteger(t.passed) && Number.isInteger(t.failed) &&
        t.passed + t.failed > t.run)
      err(`tests: passed(${t.passed}) + failed(${t.failed}) > run(${t.run})`);
  }
  strArr(r.claimsFiled, "claimsFiled", 32, 64);
  str(r.branch, "branch", 1, 100);
  if (typeof r.headSha !== "string" || !/^[0-9a-f]{7,40}$/.test(r.headSha))
    err(`headSha: expected 7-40 lowercase hex, got ${JSON.stringify(r.headSha)}`);
  const oq = strArr(r.openQuestions, "openQuestions", 3, 140);
  if (r.status === "blocked" && Array.isArray(oq) && oq.length === 0)
    err(`openQuestions: must be non-empty when status is "blocked" (the blocker is the content)`);
  int(r.msElapsed, "msElapsed");

  if (r.pr !== undefined) {
    if (typeof r.pr === "number") { if (!Number.isInteger(r.pr) || r.pr < 0) err(`pr: expected non-negative int, got ${r.pr}`); }
    else str(r.pr, "pr", 1, 20);
  }
  if (r.ts !== undefined) {
    if (typeof r.ts !== "string" || Number.isNaN(Date.parse(r.ts))) err(`ts: expected ISO-8601 string, got ${JSON.stringify(r.ts)}`);
  }
  if (r.metrics !== undefined) {
    if (r.metrics === null || typeof r.metrics !== "object" || Array.isArray(r.metrics))
      err(`metrics: expected object, got ${JSON.stringify(r.metrics)}`);
  }

  if (errors.length) {
    console.error("INVALID:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
  if (bytes > MAX_BYTES) {
    console.error(`INVALID:\n  - size: ${bytes} bytes, max ${MAX_BYTES}`);
    process.exit(1);
  }
  console.log(`VALID (${bytes} bytes)`);
}

main();
