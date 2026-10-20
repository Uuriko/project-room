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
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { agentConnectionFromEnvironment, connectionDiagnostic } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { CoordError, guardConflicts, normalizePath } from "../client/room-coord.mjs";

export const USAGE = "Usage: room-guard [--files a,b | --base REF] [--strict] [--warn] [--json] [--prs [--repo OWNER/NAME]] [--claim ID]\n"
  + "  --prs     also list files that other open pull requests change (advisory: open PRs carry no lease)\n"
  + "  --mine    branch prefixes that are yours, e.g. claude/ (default: the current branch's prefix)\n"
  + "  --claim   compare your claim's file list with the changed files (advisory)";

// Git C-quotes a name-status path when it is not plain ASCII. Octal escapes
// are UTF-8 bytes. A still-quoted token does not match the leased path.
function unquoteGitPath(token) {
  if (token.length < 2 || token[0] !== '"' || token.at(-1) !== '"') return token;
  const body = token.slice(1, -1);
  const bytes = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "\\") {
      const code = body.charCodeAt(i);
      if (code > 0xff) return token;
      bytes.push(code);
      i += 1;
      continue;
    }
    const next = body[i + 1];
    if (next == null) return token;
    if (next === "n") { bytes.push(0x0a); i += 2; continue; }
    if (next === "t") { bytes.push(0x09); i += 2; continue; }
    if (next === "r") { bytes.push(0x0d); i += 2; continue; }
    if (next === "\\" || next === '"') { bytes.push(next.charCodeAt(0)); i += 2; continue; }
    if (next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (oct.length < 3 && j < body.length && body[j] >= "0" && body[j] <= "7") {
        oct += body[j];
        j += 1;
      }
      const value = Number.parseInt(oct, 8);
      if (!Number.isInteger(value) || value > 0xff) return token;
      bytes.push(value);
      i = j;
      continue;
    }
    return token;
  }
  return Buffer.from(bytes).toString("utf8");
}

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
      const path = unquoteGitPath(part.trim());
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
  const options = { strict: false, warn: false, json: false, files: undefined, base: undefined, prs: false, repo: undefined, claim: undefined, mine: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") options.strict = true;
    else if (arg === "--warn") options.warn = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--prs") options.prs = true;
    else if (arg === "--repo" || arg === "--claim" || arg === "--mine") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return { error: `${arg} needs a value` };
      i += 1;
      if (arg === "--repo") {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return { error: "--repo must be OWNER/NAME" };
        options.repo = value;
      } else if (arg === "--mine") options.mine = value.split(",").map(item => item.trim()).filter(Boolean);
      else options.claim = value;
    }
    else if (arg === "--files" || arg === "--base") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return { error: `${arg} needs a value` };
      i += 1;
      if (arg === "--files") options.files = value.split(",").map(item => item.trim()).filter(Boolean);
      else options.base = value;
    } else return { error: `Unknown option ${arg}` };
  }
  if (options.files && options.base) return { error: "Pass either --files or --base, not both" };
  if ((options.repo || options.mine) && !options.prs) return { error: "--repo and --mine only apply with --prs" };
  return { options };
}

const describe = conflict => `${conflict.file} is held by ${conflict.owner} under ${conflict.claimId}`
  + `${conflict.heldPath !== conflict.file ? ` (claims ${conflict.heldPath})` : ""}`
  + `${conflict.leaseExpiresAt ? ` until ${conflict.leaseExpiresAt}` : ""}`;

// Pure decision: returns { code, lines, conflicts } so the CLI and tests share it.
// A held path covers a file when they are equal or the held path is a
// directory prefix of it (same rule as guardConflicts).
const coversPath = (held, file) => held === file || file.startsWith(held.endsWith("/") ? held : `${held}/`);

// Files other open pull requests change. Open PRs carry no lease, so these
// are advisory: they never change the exit code. Files already reported as
// claimed by another member are left to that report.
// Your own PRs are skipped: the current branch, and every branch under the
// same agent prefix ("claude/x" skips "claude/*"), since agents here share
// one GitHub account and branch prefixes are how they tell their PRs apart.
export function selfPrefixes(selfBranch, mine) {
  if (Array.isArray(mine)) return mine;
  return selfBranch && selfBranch.includes("/") ? [`${selfBranch.split("/")[0]}/`] : [];
}

export function prOverlaps(openPrs, files, { selfBranch = null, mine, claimed = new Set() } = {}) {
  const wanted = new Set(files.map(normalizePath));
  const prefixes = selfPrefixes(selfBranch, mine);
  const isMine = branch => Boolean(branch) && (branch === selfBranch || prefixes.some(prefix => branch.startsWith(prefix)));
  const overlaps = [];
  for (const pr of Array.isArray(openPrs) ? openPrs : []) {
    if (!pr || isMine(pr.branch)) continue;
    const touched = [...new Set((pr.files ?? []).map(normalizePath))].filter(file => wanted.has(file) && !claimed.has(file)).sort();
    if (touched.length) overlaps.push({ number: pr.number, branch: pr.branch ?? null, updatedAt: pr.updatedAt ?? null, files: touched });
  }
  return overlaps.sort((a, b) => a.number - b.number);
}

// How a claim's file list matches the change: files changed outside the
// claim (invisible to everyone else's guard) and claimed files not changed
// (holding them blocks others for nothing).
export function claimAccuracy(claims, claimId, files) {
  const claim = (Array.isArray(claims) ? claims : claims?.items ?? claims?.claims ?? []).find(item => item?.id === claimId);
  if (!claim) return { found: false };
  const held = [...new Set((claim.files ?? []).map(normalizePath))];
  const changed = [...new Set(files.map(normalizePath))];
  return {
    found: true,
    unclaimedChanges: changed.filter(file => !held.some(path => coversPath(path, file))).sort(),
    unusedClaims: held.filter(path => !changed.some(file => coversPath(path, file))).sort(),
  };
}

const prAge = (updatedAt, nowMs) => {
  const ms = nowMs - Date.parse(updatedAt ?? "");
  if (!Number.isFinite(ms) || ms < 0) return "";
  const hours = Math.round(ms / 3600000);
  return hours < 48 ? `, updated ${hours}h ago` : `, updated ${Math.round(hours / 24)}d ago`;
};

// Group PR overlaps by file, newest PRs first, so a hot shared file shows
// as one line instead of fifty.
export function overlapsByFile(overlaps, nowMs, { shown = 3 } = {}) {
  const byFile = new Map();
  for (const pr of overlaps) for (const file of pr.files) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(pr);
  }
  return [...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([file, prs]) => {
    const newest = [...prs].sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
    const listed = newest.slice(0, shown).map(pr => `#${pr.number} ${pr.branch ?? ""}${prAge(pr.updatedAt, nowMs)}`.trim());
    return `  ${file}: ${prs.length} open PR${prs.length === 1 ? "" : "s"}; newest ${listed.join("; ")}${prs.length > shown ? `; +${prs.length - shown} more` : ""}`;
  });
}

export async function runGuard({ files, client, memberId, strict = false, warn = false, now, unavailable, openPrs, prsUnavailable, selfBranch, mine, claimId } = {}) {
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
  const lines = conflicts.length ? [
    `room-guard: ${conflicts.length} file(s) are claimed by another member`,
    ...conflicts.map(conflict => `  ${describe(conflict)}`),
    "  Ask the owner in the room, wait for the lease, or take a handoff: room-coord handoff <id> --to <you>"
  ] : [`room-guard: ${files.length} file(s) clear of other members' live claims`];
  const extra = {};
  if (openPrs !== undefined || prsUnavailable) {
    if (prsUnavailable) lines.push(`room-guard: open pull requests unavailable (${prsUnavailable}); not checked`);
    else {
      const nowMs = typeof now === "number" ? now : Date.now();
      const overlaps = prOverlaps(openPrs, files, { selfBranch, mine, claimed: new Set(conflicts.map(conflict => conflict.file)) });
      extra.prOverlaps = overlaps;
      if (overlaps.length) {
        lines.push(`room-guard: ${overlaps.length} other open pull request(s) change the same files (advisory, no lease)`);
        lines.push(...overlapsByFile(overlaps, nowMs));
        lines.push("  Ask in the room who is still working on them before you edit; a stale PR can be ignored or closed by its owner");
      } else lines.push(`room-guard: no other open pull request changes these files (${openPrs.length} checked)`);
    }
  }
  if (claimId) {
    const accuracy = claimAccuracy(claims, claimId, files);
    extra.claimAccuracy = accuracy;
    if (!accuracy.found) lines.push(`room-guard: claim ${claimId} not found on the board`);
    else if (!accuracy.unclaimedChanges.length && !accuracy.unusedClaims.length) lines.push(`room-guard: claim ${claimId} lists exactly the changed files`);
    else {
      if (accuracy.unclaimedChanges.length) lines.push(`room-guard: changed but not in claim ${claimId} (others' guards cannot see these): ${accuracy.unclaimedChanges.join(", ")}`);
      if (accuracy.unusedClaims.length) lines.push(`room-guard: in claim ${claimId} but not changed (held for nothing): ${accuracy.unusedClaims.join(", ")}`);
      lines.push("  Files cannot be edited on a claim: create a corrected claim and close this one");
    }
  }
  return { code: conflicts.length && !warn ? 1 : 0, lines, conflicts, ...extra };
}

const execFileAsync = promisify(execFile);

// Open pull requests and their changed files, through the GitHub CLI.
export async function fetchOpenPrs(repo, { gh = (args) => execFileAsync("gh", args, { maxBuffer: 32 * 1024 * 1024 }).then(r => r.stdout), concurrency = 8 } = {}) {
  // Explicit page numbers instead of --paginate: some GitHub proxies refuse
  // the numeric-id URLs that pagination Link headers point at.
  const pages = async path => {
    const rows = [];
    for (let page = 1; page <= 30; page += 1) {
      const batch = JSON.parse(await gh(["api", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`]));
      rows.push(...batch);
      if (batch.length < 100) break;
    }
    return rows;
  };
  const prs = (await pages(`repos/${repo}/pulls?state=open`))
    .map(pr => ({ number: pr.number, branch: pr.head?.ref ?? null, updatedAt: pr.updated_at ?? null, files: [] }));
  let next = 0;
  const worker = async () => {
    while (next < prs.length) {
      const pr = prs[next++];
      pr.files = (await pages(`repos/${repo}/pulls/${pr.number}/files`)).flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, prs.length) }, worker));
  return prs;
}

function originRepo() {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const match = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(result.stdout?.trim() ?? "");
  return match ? match[1] : null;
}

function currentBranch() {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  const branch = result.stdout?.trim();
  return result.status === 0 && branch && branch !== "HEAD" ? branch : null;
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
  let openPrs;
  let prsUnavailable;
  if (options.prs) {
    const repo = options.repo ?? originRepo();
    if (!repo) prsUnavailable = "no GitHub origin; pass --repo OWNER/NAME";
    else {
      try { openPrs = await fetchOpenPrs(repo); }
      catch (error) { prsUnavailable = error?.code === "ENOENT" ? "gh CLI not installed" : "gh api failed"; }
    }
  }
  const result = await runGuard({ files, client, memberId, strict: options.strict, warn: options.warn, unavailable,
    openPrs, prsUnavailable, selfBranch: currentBranch(), mine: options.mine, claimId: options.claim });
  if (options.json) console.log(JSON.stringify({ code: result.code, conflicts: result.conflicts,
    ...(result.prOverlaps ? { prOverlaps: result.prOverlaps } : {}), ...(result.claimAccuracy ? { claimAccuracy: result.claimAccuracy } : {}) }, null, 2));
  else (result.code ? console.error : console.log)(result.lines.join("\n"));
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
