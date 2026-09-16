import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Nothing committed may carry one person's home directory.
//
// This exists because four test files hardcoded absolute paths into sibling
// worktrees under one developer's home. They passed on the machine they were
// written on, because those worktrees really were there, and would have failed
// on every CI runner and every other checkout the moment they were committed.
// A path that only resolves on one laptop is invisible until it is not.
//
// The guard deliberately covers the COMMITTED surface only, so work in progress
// is nobody's emergency, and it turns red at the commit rather than in CI.

// Placeholder names in fixtures are fine: a test asserting that "/Users/x/..."
// is rejected is not a portability problem.
const PLACEHOLDERS = new Set([
  "x", "y", "z", "user", "users", "test", "tester", "someone",
  "me", "you", "example", "runner", "foo", "bar", "alice", "bob"
]);

// research/ holds archived build artifacts from finished exercises and is owned
// elsewhere; docs quote real paths on purpose, including the audit that found
// this. Binary and lock files have no meaningful lines.
const SKIP = /^(research\/|docs\/|node_modules\/)|\.(md|lock|png|jpg|jpeg|gif|svg|pdf|ico|woff2?)$/;

const HOME_PATH = /\/(Users|home)\/([A-Za-z0-9._-]+)\//g;

export function personalPaths(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(HOME_PATH)) {
      if (!PLACEHOLDERS.has(match[2].toLowerCase())) found.push({ line: index + 1, path: match[0] });
    }
  });
  return found;
}

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: new URL("../", import.meta.url) })
      .split("\n").filter((file) => file && !SKIP.test(file));
  } catch {
    return null;
  }
}

test("the detector actually detects, and tolerates fixtures", () => {
  // Without this the guard below could pass forever on a broken pattern.
  //
  // These are assembled from parts on purpose. The guard scans every committed
  // file including this one, so a literal personal path written out here would be
  // indistinguishable from the real defect and would fail the guard against its
  // own fixtures. Interpolation keeps the sequence out of the file while the
  // assertion still exercises the exact shape that caused the original problem.
  // It caught precisely that on its first run over its own commit.
  const home = (root, user, rest) => `/${root}/${user}/${rest}`;
  assert.equal(personalPaths(`const p = "${home("Users", "johnpotter", "src/thing.mjs")}";`).length, 1);
  assert.equal(personalPaths(`const p = "${home("home", "dana", ".local/bin/claude")}";`).length, 1);
  assert.equal(personalPaths('configDir: "/Users/x/.grok/config.toml"').length, 0, "placeholder fixtures are allowed");
  assert.equal(personalPaths('const p = "/Users/runner/work/repo";').length, 0, "CI runner homes are allowed");
  assert.equal(personalPaths('new URL("../../sibling/server/store.mjs", import.meta.url)').length, 0);
  assert.equal(personalPaths("join(homedir(), '.local', 'bin', 'claude')").length, 0, "the portable form passes");
});

test("no committed file carries one developer's home directory", (t) => {
  const files = trackedFiles();
  if (!files) return t.skip("git is unavailable, so the committed surface cannot be listed");

  // Anti-rot: if the skip list or the listing ever swallows the repo, say so
  // rather than passing on an empty scan.
  assert.ok(files.length > 100, `only ${files.length} files scanned; the filter has eaten the repo`);

  const offences = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    } catch {
      continue; // unreadable or binary, nothing to scan
    }
    for (const hit of personalPaths(text)) offences.push(`  ${file}:${hit.line}  ${hit.path}`);
  }

  assert.deepEqual(offences, [], `committed files contain a personal home directory:\n${offences.join("\n")}\n\n` +
    "Resolve a sibling path from the repo with new URL(\"../../name/file.mjs\", import.meta.url), " +
    "take a binary from an environment variable with a homedir() default, and skip rather than fail " +
    "when an optional sibling worktree is absent.");
});
