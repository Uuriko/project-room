// Patch-series apply checker (backlog TST-14).
// Agents without push rights hand off fixes as `git format-patch` files or
// mboxes. This script checks each series against a base revision (default
// origin/main) and reports one state per series:
//   clean          every patch applies in order with `git am --3way`
//   applied        every patch already has a matching commit on the base (patch-id)
//   partly-applied some patches match commits on the base; the rest apply clean
//   conflict       a patch does not apply; the report names it and its files
//   malformed      the file holds no patch that git can read
// The check runs in a temporary detached worktree. It never changes the
// current branch, index or working tree, and it removes the worktree after.
// Output: one line per series, or a JSON report (schema room.patch-check/1)
// with --json. Exit 0 = no conflict or malformed series, 1 = at least one,
// 2 = bad usage.
//
// Usage: node scripts/check-patch-series.mjs [--base origin/main] [--json] [--history 2000] <file.patch|file.mbox>...
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "room.patch-check/1";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "patch-check", GIT_AUTHOR_EMAIL: "patch-check@invalid", GIT_COMMITTER_NAME: "patch-check", GIT_COMMITTER_EMAIL: "patch-check@invalid" };

function git(cwd, args, input) {
  return execFileSync("git", args, { cwd, input, env: GIT_ENV, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

// Split an mbox or single format-patch file into its patches.
export function splitSeries(text) {
  const parts = text.split(/^(?=From [0-9a-f]{40} )/m).filter(part => /^From [0-9a-f]{40} /.test(part));
  return parts.map(part => {
    const subject = (part.match(/^Subject: (?:\[PATCH[^\]]*\] )?(.*)$/m)?.[1] ?? "").trim();
    const files = [...part.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(m => m[1]);
    return { subject, files, text: part };
  });
}

function patchId(cwd, text) {
  const out = git(cwd, ["patch-id", "--stable"], text).trim();
  return out ? out.split(/\s+/)[0] : null;
}

// patch-ids of the last `history` non-merge commits on base.
export function basePatchIds(repo, base, history = 2000) {
  const log = git(repo, ["log", "-p", "--no-merges", `--max-count=${history}`, "--format=commit %H", base]);
  const ids = new Set();
  if (!log.trim()) return ids;
  for (const line of git(repo, ["patch-id", "--stable"], log).split("\n")) {
    const id = line.trim().split(/\s+/)[0];
    if (id) ids.add(id);
  }
  return ids;
}

export function checkSeries(repo, file, { base = "origin/main", known = null, history = 2000 } = {}) {
  const name = basename(file);
  const patches = splitSeries(readFileSync(file, "utf8"));
  if (patches.length === 0) return { file: name, state: "malformed", patches: 0, detail: "no format-patch header found" };
  const ids = known ?? basePatchIds(repo, base, history);
  const appliedIdx = [];
  patches.forEach((p, i) => { const id = patchId(repo, p.text); p.patchId = id; if (id && ids.has(id)) appliedIdx.push(i); });
  if (appliedIdx.length === patches.length) return { file: name, state: "applied", patches: patches.length, applied: patches.length };
  const dir = mkdtempSync(join(tmpdir(), "patch-check-"));
  const wt = join(dir, "wt");
  try {
    git(repo, ["worktree", "add", "--quiet", "--detach", wt, base]);
    for (let i = 0; i < patches.length; i++) {
      if (appliedIdx.includes(i)) continue;
      const am = spawnSync("git", ["am", "--3way", "--quiet", "--keep-cr"], { cwd: wt, input: patches[i].text, env: GIT_ENV, encoding: "utf8" });
      if (am.status !== 0) {
        const conflicted = spawnSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: wt, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
        const reason = (am.stderr || am.stdout || "").split("\n").find(l => /error|conflict|does not apply|patch failed|corrupt/i.test(l))?.trim() ?? "git am failed";
        spawnSync("git", ["am", "--abort"], { cwd: wt, env: GIT_ENV });
        return { file: name, state: "conflict", patches: patches.length, applied: appliedIdx.length, failedAt: i + 1, subject: patches[i].subject, files: conflicted.length ? conflicted : patches[i].files, detail: reason.slice(0, 200) };
      }
    }
    return { file: name, state: appliedIdx.length ? "partly-applied" : "clean", patches: patches.length, applied: appliedIdx.length, tree: git(wt, ["rev-parse", "--short=8", "HEAD^{tree}"]).trim() };
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: repo });
    spawnSync("git", ["worktree", "prune"], { cwd: repo });
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkAll(repo, files, { base = "origin/main", history = 2000 } = {}) {
  const baseRev = git(repo, ["rev-parse", "--short=8", `${base}^{commit}`]).trim();
  const known = basePatchIds(repo, base, history);
  const series = files.map(file => checkSeries(repo, file, { base, known, history }));
  const count = state => series.filter(s => s.state === state).length;
  return { schema: SCHEMA, base, baseRev, checked: series.length, clean: count("clean"), applied: count("applied"), partlyApplied: count("partly-applied"), conflict: count("conflict"), malformed: count("malformed"), series };
}

export function formatLine(s) {
  if (s.state === "conflict") return `conflict ${s.file} patch ${s.failedAt}/${s.patches} "${s.subject}" files=${s.files.join(",")}`;
  if (s.state === "malformed") return `malformed ${s.file} ${s.detail}`;
  const tail = s.tree ? ` tree=${s.tree}` : "";
  return `${s.state} ${s.file} patches=${s.patches}${s.applied ? ` already-on-base=${s.applied}` : ""}${tail}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const take = flag => { const i = args.indexOf(flag); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const base = take("--base") ?? "origin/main";
  const history = Number(take("--history") ?? 2000);
  const json = args.includes("--json");
  const files = args.filter(a => a !== "--json");
  if (!files.length || !Number.isInteger(history) || history < 1 || files.some(f => !existsSync(f))) {
    console.error("usage: node scripts/check-patch-series.mjs [--base origin/main] [--json] [--history 2000] <file.patch|file.mbox>...");
    process.exit(2);
  }
  let report;
  try { report = checkAll(process.cwd(), files.map(f => resolve(f)), { base, history }); }
  catch (error) { console.error(`patch-check: ${String(error.stderr || error.message).trim().split("\n")[0]}`); process.exit(2); }
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`patch-check base ${report.base} @ ${report.baseRev}: ${report.checked} series, ${report.clean} clean, ${report.applied} applied, ${report.partlyApplied} partly-applied, ${report.conflict} conflict, ${report.malformed} malformed`);
    for (const s of report.series) console.log(`  ${formatLine(s)}`);
  }
  process.exit(report.conflict || report.malformed ? 1 : 0);
}
