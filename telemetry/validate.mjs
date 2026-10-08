// telemetry/validate.mjs — zero-dependency validator for the telemetry bus
// finding schema. Usage: node telemetry/validate.mjs <finding.json>
// Prints PASS or FAIL with reasons; exits 0 on PASS, 1 on FAIL.
import { readFileSync } from "node:fs";

const ID_RE = /^[a-z0-9-]+$/;
const CATEGORIES = ["correctness", "performance", "security", "dx", "protocol", "onboarding", "other"];
const CONFIDENCES = ["high", "medium", "low"];

function check(finding) {
  const reasons = [];
  if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
    return ["root must be a JSON object"];
  }
  for (const key of ["id", "guild", "claim", "evidence", "timestamp"]) {
    if (typeof finding[key] !== "string" || finding[key].length === 0) {
      reasons.push(`missing or empty required string field: "${key}"`);
    }
  }
  if (typeof finding.id === "string" && !ID_RE.test(finding.id)) {
    reasons.push(`"id" must match ^[a-z0-9-]+$ (got "${finding.id}")`);
  }
  if (typeof finding.claim === "string" && finding.claim.length < 10) {
    reasons.push(`"claim" too short (${finding.claim.length} < 10)`);
  }
  if (typeof finding.evidence === "string" && finding.evidence.length < 10) {
    reasons.push(`"evidence" too short (${finding.evidence.length} < 10)`);
  }
  if (typeof finding.numbers !== "object" || finding.numbers === null || Array.isArray(finding.numbers)) {
    reasons.push(`"numbers" must be an object (got ${Array.isArray(finding.numbers) ? "array" : typeof finding.numbers})`);
  } else {
    for (const [k, v] of Object.entries(finding.numbers)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        reasons.push(`"numbers.${k}" must be a finite number (got ${JSON.stringify(v)})`);
      }
    }
  }
  if (typeof finding.timestamp === "string") {
    const t = Date.parse(finding.timestamp);
    if (Number.isNaN(t)) {
      reasons.push(`"timestamp" is not parseable as a date-time (got "${finding.timestamp}")`);
    }
  }
  if (finding.category !== undefined && !CATEGORIES.includes(finding.category)) {
    reasons.push(`"category" must be one of ${CATEGORIES.join(", ")} (got ${JSON.stringify(finding.category)})`);
  }
  if (finding.confidence !== undefined && !CONFIDENCES.includes(finding.confidence)) {
    reasons.push(`"confidence" must be one of ${CONFIDENCES.join(", ")} (got ${JSON.stringify(finding.confidence)})`);
  }
  if (finding.agent !== undefined && (typeof finding.agent !== "string" || finding.agent.length === 0)) {
    reasons.push(`"agent" must be a non-empty string when present`);
  }
  if (finding.roomSeq !== undefined && !Number.isInteger(finding.roomSeq)) {
    reasons.push(`"roomSeq" must be an integer when present`);
  }
  if (finding.source !== undefined && (typeof finding.source !== "string" || finding.source.length === 0)) {
    reasons.push(`"source" must be a non-empty string when present`);
  }
  return reasons;
}

const file = process.argv[2];
if (!file) {
  console.error("FAIL: usage: node telemetry/validate.mjs <finding.json>");
  process.exit(1);
}

let finding;
try {
  finding = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`FAIL ${file}: not valid JSON (${e.message})`);
  process.exit(1);
}

const reasons = check(finding);
if (reasons.length === 0) {
  console.log(`PASS ${file}`);
  process.exit(0);
}
console.error(`FAIL ${file}:`);
for (const r of reasons) console.error(`  - ${r}`);
process.exit(1);
