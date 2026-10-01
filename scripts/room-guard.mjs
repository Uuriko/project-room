#!/usr/bin/env node
// room-guard: refuse a commit (or flag a PR) that touches files another
// member holds under a live room work claim. Advisory leases become a hard
// stop at the moment it matters, the way a pre-commit hook guards a branch.
//
//   pre-commit:  node scripts/room-guard.mjs            (staged files)
//   CI / PR:     node scripts/room-guard.mjs --base origin/main
//   explicit:    node scripts/room-guard.mjs --files a.mjs,b.mjs
//
// Exit 0 clean, 1 conflict, 2 usage, 3 Room unreachable with --strict.
// Without --strict an unreachable Room prints a notice and passes, so a
// network blip never blocks local work; --warn reports conflicts and passes.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { agentConnectionFromEnvironment, connectionDiagnostic } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { CoordError, guardConflicts, normalizePath } from "../client/room-coord.mjs";

export const USAGE = "Usage: room-guard [--files a,b | --base REF] [--strict] [--warn] [--json]";

export function gitChangedFiles({ base, git = defaultGit } = {}) {
  // --name-status so a rename contributes both paths. The new name alone
  // would let a move out of a claimed directory pass the guard.
  const args = base
    ? ["diff", "--name-status", "--find-renames", "--diff-filter=ACMRD", `${base}...HEAD`]
    : ["diff", "--cached", "--name-status", "--find-renames", "--diff-filter=ACMRD"];
  const seen = new Set();
  const paths = [];
  for (const line of git(args).split("\n")) {
    if (!line) continue;
    for (const part of line.split("\t").slice(1)) {
      const path = part.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function defaultGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function parseGuardArgs(argv) {
  const options = { strict: false, warn: false, json: false, files: undefined, base: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") options.strict = true;
    else if (arg === "--warn") options.warn = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--files" || arg === "--base") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return { error: `${arg} needs a value` };
      i += 1;
      if (arg === "--files") options.files = value.split(",").map(item => item.trim()).filter(Boolean);
      else options.base = value;
    } else return { error: `Unknown option ${arg}` };
  }
  if (options.files && options.base) return { error: "Pass either --files or --base, not both" };
  return { options };
}

const describe = conflict => `${conflict.file} is held by ${conflict.owner} under ${conflict.claimId}`
  + `${conflict.heldPath !== conflict.file ? ` (claims ${conflict.heldPath})` : ""}`
  + `${conflict.leaseExpiresAt ? ` until ${conflict.leaseExpiresAt}` : ""}`;

// Pure decision: returns { code, lines, conflicts } so the CLI and tests share it.
export async function runGuard({ files, client, memberId, strict = false, warn = false, now, unavailable } = {}) {
  if (!files.length) return { code: 0, lines: ["room-guard: no changed files"], conflicts: [] };
  try { files.forEach(normalizePath); }
  catch (error) {
    if (error instanceof CoordError) return { code: 2, lines: [`room-guard: ${error.message}`], conflicts: [] };
    throw error;
  }
  if (!client) {
    const lines = [`room-guard: Room connection unavailable (${unavailable ?? "not configured"})${strict ? "" : "; not blocking"}`];
    return { code: strict ? 3 : 0, lines, conflicts: [] };
  }
  let claims;
  try { claims = await client.workClaims(); }
  catch (error) {
    const code = connectionDiagnostic(error).code;
    return { code: strict ? 3 : 0, lines: [`room-guard: Room unreachable (${code})${strict ? "" : "; not blocking"}`], conflicts: [] };
  }
  const conflicts = guardConflicts(claims, files, { memberId, now });
  if (!conflicts.length) return { code: 0, lines: [`room-guard: ${files.length} file(s) clear of other members' live claims`], conflicts };
  const lines = [
    `room-guard: ${conflicts.length} file(s) are claimed by another member`,
    ...conflicts.map(conflict => `  ${describe(conflict)}`),
    "  Ask the owner in the room, wait for the lease, or take a handoff: room-coord handoff <id> --to <you>"
  ];
  return { code: warn ? 0 : 1, lines, conflicts };
}

async function main() {
  const parsed = parseGuardArgs(process.argv.slice(2));
  if (parsed.error) { console.error(`${parsed.error}\n${USAGE}`); process.exitCode = 2; return; }
  const { options } = parsed;
  const files = options.files ?? gitChangedFiles({ base: options.base });
  let client = null;
  let memberId;
  let unavailable;
  try {
    const config = agentConnectionFromEnvironment();
    client = new RoomAgentClient(config);
    memberId = config.memberId;
  } catch (error) { unavailable = connectionDiagnostic(error).code; }
  const result = await runGuard({ files, client, memberId, strict: options.strict, warn: options.warn, unavailable });
  if (options.json) console.log(JSON.stringify({ code: result.code, conflicts: result.conflicts }, null, 2));
  else (result.code ? console.error : console.log)(result.lines.join("\n"));
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
