// Supply-chain pinning gate (lane A5 audit, 2026-10-07).
//
// Every `uses:` in .github/workflows must be pinned to a full 40-char commit
// SHA with a `# vN` version comment, following the pattern from PR #1861.
// Tag/branch refs are mutable: a compromised or re-tagged release would
// silently change what CI executes. A truncated or otherwise malformed SHA
// (e.g. the 36-char non-commit ref that shipped in soak-test.yml) fails this
// test instead of failing — or mis-resolving — at workflow runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(root, ".github", "workflows");

// owner/repo[/path]@<40-hex-sha>
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;
// trailing "# vN" (or "# vN.M") comment documenting the pinned major
const VERSION_COMMENT = /#\s*v\d+(\.\d+)*\s*$/;

function usesLines(yaml) {
  const out = [];
  yaml.split("\n").forEach((line, i) => {
    const m = line.match(/^\s*uses:\s*(\S+)\s*(#.*)?$/);
    if (m) out.push({ line: i + 1, ref: m[1], comment: (m[2] ?? "").trim() });
  });
  return out;
}

test("every workflow action is pinned to a full 40-char SHA", () => {
  const files = readdirSync(workflowsDir).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );
  assert.ok(files.length > 0, "expected workflow files in .github/workflows");
  const bad = [];
  for (const file of files) {
    const yaml = readFileSync(join(workflowsDir, file), "utf8");
    for (const { line, ref } of usesLines(yaml)) {
      if (!PINNED.test(ref)) bad.push(`${file}:${line}: not a 40-char SHA pin: ${ref}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `unpinned or malformed action refs (pin to the commit SHA):\n${bad.join("\n")}`,
  );
});

test("the pin pattern rejects tags, branches and short SHAs", () => {
  const good = [
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e",
  ];
  const bad = [
    "actions/checkout@v4", // mutable tag
    "actions/checkout@main", // mutable branch
    "actions/upload-artifact@b5c5fca5f78071c0d17c0d02a9e0dcf5e5e1", // 36-char non-SHA (soak-test.yml, 2026-10-07)
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af68", // 39 chars
    "actions/checkout@ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", // non-hex
  ];
  for (const ref of good) assert.ok(PINNED.test(ref), `should accept ${ref}`);
  for (const ref of bad) assert.ok(!PINNED.test(ref), `should reject ${ref}`);
});

test("every pinned action carries a # vN version comment", () => {
  const files = readdirSync(workflowsDir).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );
  const bad = [];
  for (const file of files) {
    const yaml = readFileSync(join(workflowsDir, file), "utf8");
    for (const { line, ref, comment } of usesLines(yaml)) {
      if (PINNED.test(ref) && !VERSION_COMMENT.test(comment)) {
        bad.push(`${file}:${line}: pinned but missing "# vN" comment: ${ref}`);
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    `pins missing the version comment from the #1861 pattern:\n${bad.join("\n")}`,
  );
});
