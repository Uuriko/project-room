#!/usr/bin/env node
// telemetry/verify.mjs — acceptance harness for the telemetry-bus guild.
//
// Run: node telemetry/verify.mjs
//   TELEM_DIR=telemetry/selftest node telemetry/verify.mjs   (self-test mode: A+B only)
//
// Verifies the shared Finding Record spec against the sibling workers'
// components (schema, submit, dashboard, docs). Zero dependencies.
// Reads only; never writes to production (checked by F).

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

const DIR = process.env.TELEM_DIR || "telemetry";
const SELFTEST = process.env.TELEM_DIR !== undefined;

const REQUIRED_FIELDS = ["id", "guild", "claim", "evidence", "numbers", "timestamp"];
const CATEGORIES = ["correctness", "performance", "security", "dx", "protocol", "onboarding", "other"];
const CONFIDENCES = ["high", "medium", "low"];
const ID_RE = /^[a-z0-9-]+$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

let passed = 0, failed = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function read(p) { return readFileSync(p, "utf8"); }
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype;
}

// --- The Finding Record spec, as shared in the guild brief ---
function validateRecord(rec, label) {
  const errs = [];
  if (!isPlainObject(rec)) return [`${label}: not a JSON object`];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in rec)) errs.push(`${label}: missing required field "${f}"`);
  }
  if ("id" in rec && (typeof rec.id !== "string" || !ID_RE.test(rec.id)))
    errs.push(`${label}: id must match ^[a-z0-9-]+$`);
  if ("guild" in rec && typeof rec.guild !== "string")
    errs.push(`${label}: guild must be a string`);
  if ("claim" in rec && (typeof rec.claim !== "string" || rec.claim.length < 10))
    errs.push(`${label}: claim must be a string of length >= 10`);
  if ("evidence" in rec && (typeof rec.evidence !== "string" || rec.evidence.length < 10))
    errs.push(`${label}: evidence must be a string of length >= 10`);
  if ("numbers" in rec && !isPlainObject(rec.numbers))
    errs.push(`${label}: numbers must be a plain object`);
  if ("timestamp" in rec) {
    const t = rec.timestamp;
    if (typeof t !== "string" || !ISO_TS_RE.test(t) || Number.isNaN(Date.parse(t)))
      errs.push(`${label}: timestamp must be ISO8601 UTC parseable (e.g. 2026-10-07T21:00:00Z)`);
  }
  if ("category" in rec && !CATEGORIES.includes(rec.category))
    errs.push(`${label}: category must be one of ${CATEGORIES.join(",")}`);
  if ("confidence" in rec && !CONFIDENCES.includes(rec.confidence))
    errs.push(`${label}: confidence must be one of ${CONFIDENCES.join(",")}`);
  if ("agent" in rec && typeof rec.agent !== "string")
    errs.push(`${label}: agent must be a string`);
  if ("roomSeq" in rec && !Number.isInteger(rec.roomSeq))
    errs.push(`${label}: roomSeq must be an integer`);
  return errs;
}
function parseJsonFile(p, label) {
  try { return { ok: true, value: JSON.parse(read(p)) }; }
  catch (e) { return { ok: false, error: `${label}: JSON parse error: ${e.message}` }; }
}

// --- A. Schema file ---
function checkA() {
  const name = "A: finding-schema.json is the canonical spec";
  const p = join(DIR, "finding-schema.json");
  const alt = join(DIR, "schema.json"); // selftest alias
  const sp = existsSync(p) ? p : (existsSync(alt) ? alt : null);
  if (!sp) return check(name, false, "schema file not found");
  const pj = parseJsonFile(sp, basename(sp));
  if (!pj.ok) return check(name, false, pj.error);
  const s = pj.value;
  const errs = [];
  if (!isPlainObject(s)) errs.push("schema is not an object");
  else {
    const props = s.properties;
    if (!isPlainObject(props)) errs.push("schema.properties missing or not an object");
    else for (const f of REQUIRED_FIELDS)
      if (!(f in props)) errs.push(`schema.properties missing "${f}"`);
    const req = s.required;
    if (!Array.isArray(req)) errs.push("schema.required missing or not an array");
    else {
      const got = [...req].sort().join(","), want = [...REQUIRED_FIELDS].sort().join(",");
      if (got !== want) errs.push(`schema.required must be exactly [${REQUIRED_FIELDS.join(",")}], got [${req.join(",")}]`);
    }
    if (isPlainObject(props) && isPlainObject(props.numbers)) {
      const nt = props.numbers.type;
      if (nt !== "object") errs.push(`schema.properties.numbers.type must be "object", got ${JSON.stringify(nt)}`);
    } else errs.push("schema.properties.numbers missing");
  }
  check(name, errs.length === 0, errs.join("; "));
}

// --- B. Examples: valid pass, invalid are REJECTED ---
function checkB() {
  const name = "B: examples pass spec; invalid examples are rejected";
  const exDir = join(DIR, "examples");
  const invDir = join(exDir, "invalid");
  if (!existsSync(exDir) || !statSync(exDir).isDirectory())
    return check(name, false, "examples/ dir missing");
  const validFiles = readdirSync(exDir).filter(f => f.endsWith(".json")).map(f => join(exDir, f));
  const invalidFiles = (existsSync(invDir) && statSync(invDir).isDirectory())
    ? readdirSync(invDir).filter(f => f.endsWith(".json")).map(f => join(invDir, f)) : [];
  const errs = [];
  if (validFiles.length === 0) errs.push("no valid examples found");
  for (const f of validFiles) {
    const pj = parseJsonFile(f, basename(f));
    if (!pj.ok) { errs.push(pj.error); continue; }
    errs.push(...validateRecord(pj.value, basename(f)));
  }
  if (invalidFiles.length === 0) errs.push("invalid/ dir empty or missing — rejection not demonstrated");
  for (const f of invalidFiles) {
    const pj = parseJsonFile(f, basename(f));
    let rej;
    if (!pj.ok) rej = true; // unparseable JSON is also a rejection
    else rej = validateRecord(pj.value, basename(f)).length > 0;
    if (!rej) errs.push(`${basename(f)} was ACCEPTED but must be rejected`);
  }
  check(name, errs.length === 0, errs.join("; "));
}

// --- C. findings.jsonl (optional): parse, unique ids, spec-valid ---
function checkC() {
  const name = "C: findings.jsonl records (if present)";
  const p = join(DIR, "findings.jsonl");
  if (!existsSync(p)) { check(name, true, "absent — optional"); return; }
  const errs = [];
  const seen = new Set();
  read(p).split("\n").forEach((line, i) => {
    const ln = i + 1;
    if (!line.trim()) return;
    let rec;
    try { rec = JSON.parse(line); }
    catch (e) { errs.push(`line ${ln}: JSON parse error`); return; }
    errs.push(...validateRecord(rec, `line ${ln}`));
    if (isPlainObject(rec) && typeof rec.id === "string") {
      if (seen.has(rec.id)) errs.push(`line ${ln}: duplicate id "${rec.id}"`);
      seen.add(rec.id);
    }
  });
  check(name, errs.length === 0, errs.join("; "));
}

// --- D. Dashboard ---
function checkD() {
  const name = "D: dashboard.html hooks";
  const p = join(DIR, "dashboard.html");
  if (!existsSync(p)) return check(name, false, "dashboard.html missing");
  const html = read(p);
  const missing = [];
  if (!html.includes("Swarm Telemetry Bus")) missing.push('"Swarm Telemetry Bus"');
  if (!html.includes("findings.json")) missing.push('"findings.json" reference');
  for (const h of ["data-guild=", "data-category=", "data-confidence="])
    if (!html.includes(h)) missing.push(`"${h}"`);
  check(name, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "");
}

// --- E. submit.mjs usage exits nonzero; collect.mjs exists ---
function checkE() {
  const name = "E: submit.mjs usage fails cleanly; collect.mjs exists";
  const sub = join(DIR, "submit.mjs");
  const col = join(DIR, "collect.mjs");
  const errs = [];
  if (!existsSync(sub)) errs.push("submit.mjs missing");
  else {
    const r = spawnSync(process.execPath, [sub], { encoding: "utf8" });
    if (r.status === 0) errs.push("submit.mjs exited 0 with no args (expected nonzero)");
  }
  if (!existsSync(col)) errs.push("collect.mjs missing");
  check(name, errs.length === 0, errs.join("; "));
}

// --- F. Never writes to production ---
function checkF() {
  const name = "F: no component writes to production";
  const errs = [];
  const postRe = /method\s*:\s*["']POST["']/i;
  const prodRe = /room\.trydemigod\.com/;
  let files = [];
  try { files = readdirSync(DIR).filter(f => f.endsWith(".mjs")).map(f => join(DIR, f)); }
  catch { /* dir missing handled by other checks */ }
  for (const f of files) {
    const src = read(f);
    if (postRe.test(src) && prodRe.test(src))
      errs.push(`${basename(f)} contains POST targeting room.trydemigod.com`);
  }
  check(name, errs.length === 0, errs.join("; "));
}

console.log(`telemetry-bus acceptance harness — TELEM_DIR=${DIR}`);
console.log(SELFTEST ? "(self-test mode: A+B only — sibling components not present)" : "(full mode: A–F)");
console.log("---");
checkA();
checkB();
if (!SELFTEST) { checkC(); checkD(); checkE(); checkF(); }
console.log("---");
console.log(`VERIFY: ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
