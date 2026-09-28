// tests/ci-action-pinning.test.js — supply-chain guard for CI workflows.
//
// Contract: every third-party GitHub Action ref in .github/workflows/ is
// pinned to an immutable commit SHA (40 hex), never a mutable tag or branch,
// and the mcp-publisher binary comes from a pinned release with checksum
// verification. Guards the RC-2026-09-26-1121 hardening (#266 findings
// 5850202632 + 5850203502): a tag move on actions/checkout et al. (or a
// replaced `latest` release asset) would silently change what runs in CI,
// including the OIDC-backed MCP registry publish path.
//
// Regression shape it catches: a lane edits a workflow and writes
// `actions/checkout@v4` (or restores `releases/latest`) out of habit — the
// suite fails on the exact file:line of the unpinned ref.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = join(HERE, "..", ".github", "workflows");
const SHA_PIN = /^[0-9a-f]{40}$/;

const workflowFiles = () =>
  readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

// `uses:` values from a workflow file (stops before any `# vN` comment).
const actionRefs = (text) =>
  [...text.matchAll(/^\s*-\s*uses:\s*([^\s#]+)/gm)].map((m) => m[1]);

test("every third-party action ref is pinned to a commit SHA, never a mutable tag", () => {
  const files = workflowFiles();
  assert.ok(files.length > 0, "expected workflow files under .github/workflows");
  for (const f of files) {
    const refs = actionRefs(readFileSync(join(WORKFLOWS, f), "utf8"));
    if (refs.length === 0) continue; // no third-party actions: nothing to pin
    for (const ref of refs) {
      if (ref.startsWith("./") || ref.startsWith("docker://")) continue; // local/docker actions are not tag-pinned upstream
      const at = ref.lastIndexOf("@");
      assert.ok(at > 0, `${f}: malformed uses ref: ${ref}`);
      const pin = ref.slice(at + 1);
      assert.ok(SHA_PIN.test(pin), `${f}: action ref is not SHA-pinned (mutable tag/branch): ${ref}`);
    }
  }
});

test("mcp-registry-publish fetches mcp-publisher from a pinned release with checksum verification", () => {
  const text = readFileSync(join(WORKFLOWS, "mcp-registry-publish.yml"), "utf8");
  assert.ok(!text.includes("releases/latest"),
    "mcp-publisher must come from a pinned release tag, not the floating releases/latest URL");
  assert.ok(text.includes("sha256sum -c"),
    "mcp-publisher download must be checksum-verified before extraction");
});
