// FIX-33: path re-stat before patching.
// Re-stats the paths an agent intends to edit against a FRESH fetch of the
// remote branch, then exits non-zero naming any path that no longer resolves
// where the agent named it (renamed/moved/deleted since the agent's base).
// Rename-detection lands stale edits at paths the author never named
// (COLLIDE-6 Exp 2); this is the pre-patch guard against that.
//
// Usage:
//   node scripts/path-restat.mjs [options] <path...>
//   node scripts/path-restat.mjs --json --repo <dir> server/a.mjs docs/b.md
//
// Options:
//   --repo <dir>     repository to check (default: current directory)
//   --remote <name>  remote to fetch (default: origin)
//   --ref <branch>   branch to re-stat on the remote (default: main)
//   --base <ref>     the agent's base ref, for rename detection (default: HEAD)
//   --no-fetch       skip the fetch; check the existing <remote>/<ref> ref
//   --json           machine-readable output
//   -h, --help       usage
//
// Exit codes: 0 every path resolves; 1 one or more paths are stale;
// 2 usage error or the check itself could not run (e.g. fetch failed).
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const USAGE = `usage: node scripts/path-restat.mjs [options] <path...>
Re-stat each path against a fresh fetch of the remote branch.
Options: --repo <dir> --remote <name> (default origin) --ref <branch>
  (default main) --base <ref> (default HEAD) --no-fetch --json -h/--help
Exit: 0 all paths resolve; 1 stale paths listed; 2 usage/internal error.`;

function git(repo, args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
}

function must(repo, args, what) {
  const r = git(repo, args);
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || "").trim().split("\n")[0]}`);
  return r.stdout;
}

// Exact-match ls-tree: does <path> exist at <rev> as that literal path?
function existsAt(repo, rev, path) {
  const r = git(repo, ["ls-tree", "--name-only", "-z", rev, "--", path]);
  if (r.status !== 0) return false;
  return r.stdout.split("\0").some(line => line === path);
}

// Parse `git diff --name-status -M` into [{ from, to }] renames.
function findRenames(repo, base, tip) {
  const out = must(repo, ["diff", "--name-status", "-M", `${base}`, `${tip}`, "--"], "rename detection");
  const renames = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("R")) continue;
    const parts = line.split("\t");
    if (parts.length === 3) renames.push({ from: parts[1], to: parts[2] });
  }
  return renames;
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      repo: { type: "string" },
      remote: { type: "string", default: "origin" },
      ref: { type: "string", default: "main" },
      base: { type: "string", default: "HEAD" },
      "no-fetch": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) { console.log(USAGE); return 0; }
  const paths = positionals.map(p => (p.startsWith("./") ? p.slice(2) : p).replace(/\/+$/, ""));
  if (paths.length === 0) { console.error(USAGE); return 2; }

  const repo = values.repo || process.cwd();
  const trackingRef = `${values.remote}/${values.ref}`;
  try {
    if (!values["no-fetch"]) {
      // Fetch the remote branch head into the tracking ref: this is the
      // "fresh" snapshot every path is re-statted against.
      must(repo,
        ["fetch", "--quiet", values.remote, `refs/heads/${values.ref}:refs/remotes/${trackingRef}`],
        `fetch ${trackingRef}`);
    }
    const tip = must(repo, ["rev-parse", "--verify", trackingRef], `resolve ${trackingRef}`).trim();
    const base = must(repo, ["rev-parse", "--verify", values.base], `resolve base ${values.base}`).trim();
    const renames = base === tip ? [] : findRenames(repo, base, tip);

    const results = paths.map(path => {
      if (existsAt(repo, tip, path)) return { path, status: "ok", current: path };
      for (const { from, to } of renames) {
        if (from === path) return { path, status: "renamed", current: to };
        if (path.startsWith(from + "/")) {
          return { path, status: "renamed", current: to + path.slice(from.length) };
        }
      }
      if (existsAt(repo, base, path)) return { path, status: "deleted", current: null };
      return { path, status: "not-found", current: null };
    });

    const stale = results.filter(r => r.status !== "ok");
    if (values.json) {
      console.log(JSON.stringify({ tip, base, remote: values.remote, ref: values.ref, paths: results }, null, 2));
    } else {
      for (const r of results) {
        if (r.status === "ok") console.log(`OK: ${r.path}`);
        else if (r.status === "renamed") console.log(`STALE: ${r.path} -> renamed to ${r.current} on ${trackingRef}`);
        else if (r.status === "deleted") console.log(`STALE: ${r.path} -> deleted on ${trackingRef}`);
        else console.log(`STALE: ${r.path} -> not found at base or tip (check the spelling)`);
      }
      console.log(`path-restat: ${stale.length} stale of ${paths.length} paths (${trackingRef} @ ${tip.slice(0, 7)})`);
    }
    return stale.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(`path-restat: ERROR: ${err.message}`);
    return 2;
  }
}

process.exit(main());
