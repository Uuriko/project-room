#!/usr/bin/env node
// validate.mjs — Coordination v3 ledger validator (zero-dep Node).
// Lives ON the `coordination` branch; run by .github/workflows/validate.yml
// on every push to that branch touching ledger/**, and runnable locally:
//   node ledger/validate.mjs [ledger-dir]
// Exits 0 when every ledger/*.json file conforms, 1 otherwise.
// (Non-JSON files such as README.md, .gitkeep and this script are skipped.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] || new URL(".", import.meta.url).pathname;
const errors = [];
const KINDS = ["merge-slot", "landing-note", "hold", "release"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}
function isIso(v) { return typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v)); }
function checkCommon(obj, file) {
  if (typeof obj.actor !== "string" || !obj.actor) errors.push(`${file}: missing/empty "actor"`);
  if (typeof obj.requestId !== "string" || !obj.requestId) errors.push(`${file}: missing/empty "requestId"`);
  if (obj.version !== undefined && obj.version !== 1) errors.push(`${file}: "version" must be 1 when present`);
}
function checkClaim(obj, file) {
  checkCommon(obj, file);
  if (!KINDS.includes(obj.kind)) errors.push(`${file}: "kind" must be one of ${KINDS.join("|")}`);
  if (!Array.isArray(obj.prs) || obj.prs.length === 0 || !obj.prs.every((n) => Number.isInteger(n) && n > 0))
    errors.push(`${file}: "prs" must be a non-empty array of positive integers`);
  for (const f of ["claimed-at", "heartbeat", "expires"])
    if (!isIso(obj[f])) errors.push(`${file}: "${f}" must be an ISO-8601 timestamp`);
  if (isIso(obj["claimed-at"]) && isIso(obj.expires) && Date.parse(obj.expires) <= Date.parse(obj["claimed-at"]))
    errors.push(`${file}: "expires" must be after "claimed-at"`);
  if (obj.note !== undefined && typeof obj.note !== "string") errors.push(`${file}: "note" must be a string`);
}
function checkStatus(obj, file) {
  checkCommon(obj, file);
  if (!isIso(obj.at)) errors.push(`${file}: "at" must be an ISO-8601 timestamp`);
  if (!(typeof obj.wave === "string" || obj.wave === null)) errors.push(`${file}: "wave" must be a string or null`);
  if (!Array.isArray(obj["next-landings"])) errors.push(`${file}: "next-landings" must be an array`);
  else for (const e of obj["next-landings"]) {
    const ok = Number.isInteger(e) || (e && Number.isInteger(e.pr));
    if (!ok) errors.push(`${file}: "next-landings" entries must be integers or {pr, owner?} objects`);
  }
  if (!(typeof obj.holds === "string" || obj.holds === null)) errors.push(`${file}: "holds" must be a string or null`);
  if (!(typeof obj["main-tip-verified"] === "string" || obj["main-tip-verified"] === null))
    errors.push(`${file}: "main-tip-verified" must be a string or null`);
}

let files = [];
try { files = walk(root); } catch (e) { console.error(`cannot read ledger dir ${root}: ${e.message}`); process.exit(1); }
if (files.length === 0) { console.error("no ledger JSON files found"); process.exit(1); }
for (const file of files) {
  const rel = relative(root, file);
  let obj;
  try { obj = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { errors.push(`${rel}: invalid JSON: ${e.message}`); continue; }
  if (rel.startsWith("claims/")) {
    const m = rel.match(/^claims\/pr-(\d+)\.json$/);
    if (!m) { errors.push(`${rel}: claim files must be named claims/pr-<n>.json`); continue; }
    checkClaim(obj, rel);
    if (Array.isArray(obj.prs) && !obj.prs.includes(Number(m[1])))
      errors.push(`${rel}: filename PR ${m[1]} is not listed in "prs"`);
  } else if (/^status-[a-z0-9_-]+\.json$/i.test(rel)) {
    checkStatus(obj, rel);
    const actorFromName = rel.replace(/^status-/, "").replace(/\.json$/, "");
    if (typeof obj.actor === "string" && obj.actor.toLowerCase() !== actorFromName.toLowerCase())
      errors.push(`${rel}: "actor" (${obj.actor}) does not match filename actor (${actorFromName})`);
  } else {
    errors.push(`${rel}: unrecognised ledger file location (expected claims/pr-<n>.json or status-<actor>.json)`);
  }
}
if (errors.length) { console.error(`LEDGER INVALID (${errors.length}):`); for (const e of errors) console.error(` - ${e}`); process.exit(1); }
console.log(`LEDGER OK: ${files.length} JSON file(s) valid`);
