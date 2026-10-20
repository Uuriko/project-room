#!/usr/bin/env node
// Suggest a claim's exact file list from the current branch's diff, so agents
// claim what they change: no more, no less. Prints JSON {files, warnings}.
//   node scripts/claim-from-diff.mjs [--base origin/main] [--claims claims.json]
// --claims takes the room's open claims (GET /api/rooms/{id}/claims output)
// and adds collision warnings for files someone else holds.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { collisionWarnings } from "../server/collision-warnings.mjs";

export function filesFromNameStatus(text) {
  const files = new Set();
  for (const line of String(text).split("\n")) {
    const cols = line.split("\t").filter(Boolean);
    if (cols.length < 2) continue;
    for (const f of cols.slice(1)) files.add(f.trim()); // renames list old and new
  }
  return [...files].filter(Boolean).sort();
}

export function suggestClaim(nameStatus, claims = []) {
  const files = filesFromNameStatus(nameStatus);
  return { files, warnings: collisionWarnings(files, claims).map(w => w.text) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const base = arg("--base") ?? "origin/main";
  const diff = execFileSync("git", ["diff", "--name-status", "-M", `${base}...HEAD`], { encoding: "utf8" });
  const raw = arg("--claims") ? JSON.parse(readFileSync(arg("--claims"), "utf8")) : [];
  const claims = Array.isArray(raw) ? raw : raw.claims ?? [];
  process.stdout.write(JSON.stringify(suggestClaim(diff, claims), null, 2) + "\n");
}
