#!/usr/bin/env node
// validate.mjs — Coordination v3 ledger validator (zero-dep Node).
// Lives ON the `coordination` branch; run by .github/workflows/validate.yml
// on every push to that branch touching ledger/**, and runnable locally:
//   node ledger/validate.mjs [ledger-dir]
// Exits 0 when every ledger/*.json file conforms, 1 otherwise.
// (Non-JSON files such as README.md, .gitkeep and this script are skipped.)
//
// Canonical claim schema is "coord-claim/v1", exactly as written by
// tools/coord-claim.mjs (WS-3e alignment, 2026-10-16): the tool is the
// operational writer, and its lifecycle fields (claimId, status, history)
// are load-bearing for check/heartbeat/release. There is NO top-level
// requestId and NO kebab-case timestamps in a claim record — requestIds
// live in history[] entries. Status records keep the COORD-STATUS v1
// shape (top-level actor + requestId, kebab-case fields) unchanged.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] || new URL(".", import.meta.url).pathname;
const errors = [];
const KINDS = ["merge-slot", "landing-note", "hold", "release"];
const STATUSES = ["live", "closed"];
const ACTIONS = ["claim", "heartbeat", "release"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CLAIM_ID = /^clm_[0-9a-f]{12}$/;

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
function isNonNegInt(v) { return Number.isInteger(v) && v >= 0; }

function checkClaim(obj, file, filenamePr) {
  // Legacy (pre-alignment) markers: flag them explicitly so an old-shape
  // writer fails loudly instead of silently re-diverging the schema.
  for (const legacy of ["version", "requestId", "claimed-at"])
    if (legacy in obj) errors.push(`${file}: legacy field "${legacy}" is not part of coord-claim/v1 (requestIds live in "history", timestamps are camelCase)`);
  if (obj.schema !== "coord-claim/v1") errors.push(`${file}: "schema" must be "coord-claim/v1"`);
  if (typeof obj.claimId !== "string" || !CLAIM_ID.test(obj.claimId)) errors.push(`${file}: "claimId" must match clm_<12 hex>`);
  if (typeof obj.actor !== "string" || !obj.actor) errors.push(`${file}: missing/empty "actor"`);
  if (!KINDS.includes(obj.kind)) errors.push(`${file}: "kind" must be one of ${KINDS.join("|")}`);
  if (!isNonNegInt(obj.pr)) errors.push(`${file}: "pr" must be a non-negative integer`);
  else if (obj.pr !== filenamePr) errors.push(`${file}: "pr" (${obj.pr}) does not match filename PR (${filenamePr})`);
  // PR numbers are non-negative: #0 is the clearly-test record the tool writes.
  if (!Array.isArray(obj.prs) || obj.prs.length === 0 || !obj.prs.every(isNonNegInt))
    errors.push(`${file}: "prs" must be a non-empty array of non-negative integers`);
  else if (isNonNegInt(obj.pr) && !obj.prs.includes(obj.pr)) errors.push(`${file}: "prs" must include "pr" (${obj.pr})`);
  if (!STATUSES.includes(obj.status)) errors.push(`${file}: "status" must be one of ${STATUSES.join("|")}`);
  for (const f of ["claimedAt", "heartbeat", "expires"])
    if (!isIso(obj[f])) errors.push(`${file}: "${f}" must be an ISO-8601 timestamp`);
  // A live claim's window must be open-ended in time; a closed record's
  // expires is rewritten by release to the close time, so no ordering
  // is imposed on closed records beyond being valid timestamps.
  if (obj.status === "live" && isIso(obj.claimedAt) && isIso(obj.expires) && Date.parse(obj.expires) <= Date.parse(obj.claimedAt))
    errors.push(`${file}: "expires" must be after "claimedAt" for a live claim`);
  if (typeof obj.note !== "string") errors.push(`${file}: "note" must be a string`);
  if (obj.landedSha !== undefined && typeof obj.landedSha !== "string") errors.push(`${file}: "landedSha" must be a string when present`);
  if (obj.status === "closed" && !isIso(obj.closedAt)) errors.push(`${file}: "closedAt" must be an ISO-8601 timestamp on a closed claim`);
  if (obj.closedAt !== undefined && !isIso(obj.closedAt)) errors.push(`${file}: "closedAt" must be an ISO-8601 timestamp when present`);
  if (!Array.isArray(obj.history) || obj.history.length === 0) {
    errors.push(`${file}: "history" must be a non-empty array`);
  } else {
    obj.history.forEach((h, i) => {
      const at = `history[${i}]`;
      if (!h || typeof h !== "object") { errors.push(`${file}: "${at}" must be an object`); return; }
      if (!ACTIONS.includes(h.action)) errors.push(`${file}: "${at}.action" must be one of ${ACTIONS.join("|")}`);
      if (!isIso(h.at)) errors.push(`${file}: "${at}.at" must be an ISO-8601 timestamp`);
      if (typeof h.requestId !== "string" || !h.requestId) errors.push(`${file}: "${at}.requestId" must be a non-empty string`);
      if (h.landedSha !== undefined && typeof h.landedSha !== "string") errors.push(`${file}: "${at}.landedSha" must be a string when present`);
    });
    if (obj.history[0] && obj.history[0].action !== "claim") errors.push(`${file}: "history" must start with a "claim" entry`);
  }
}

function checkStatusCommon(obj, file) {
  if (typeof obj.actor !== "string" || !obj.actor) errors.push(`${file}: missing/empty "actor"`);
  if (typeof obj.requestId !== "string" || !obj.requestId) errors.push(`${file}: missing/empty "requestId"`);
  if (obj.version !== undefined && obj.version !== 1) errors.push(`${file}: "version" must be 1 when present`);
}
function checkStatus(obj, file) {
  checkStatusCommon(obj, file);
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
    checkClaim(obj, rel, Number(m[1]));
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
