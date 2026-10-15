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

// An exact release version (optionally v-prefixed), never a floating ref.
const PINNED_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// Lines that actually configure or execute something. YAML/shell comment
// lines are prose: a guard string quoted in a comment must neither satisfy
// nor trip this test (the workflow's own comment mentions the old floating
// `latest` URL, and a commented-out `sha256sum -c` verifies nothing).
const activeLines = (text) =>
  text.split("\n").filter((line) => !line.trimStart().startsWith("#"));

// The named step's block, up to the next step (or end of file).
const stepBlock = (text, name) => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(name));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s+-\s+name:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
};

test("mcp-registry-publish fetches mcp-publisher from a pinned release with checksum verification", () => {
  const text = readFileSync(join(WORKFLOWS, "mcp-registry-publish.yml"), "utf8");
  const active = activeLines(text).join("\n");

  // No floating release reference in any active line. The substring the old
  // test banned, "releases/latest", never matched the real floating URL
  // shape "releases/download/latest/…", so both shapes are rejected here.
  assert.ok(!active.includes("releases/latest"),
    "mcp-publisher must come from a pinned release tag, not the floating releases/latest URL");
  assert.ok(!/releases\/download\/latest(?:[/"'\s]|$)/.test(active),
    "mcp-publisher must come from a pinned release tag, not the floating releases/download/latest URL");

  // Every release-download segment is an exact version or the version
  // variable whose pin is asserted below — never `latest` or another var.
  for (const m of active.matchAll(/releases\/download\/([^\s/"']+)/g)) {
    const segment = m[1];
    assert.ok(segment === "${MCP_PUB_VERSION}" || PINNED_VERSION.test(segment),
      `mcp-publisher download ref is not pinned to an exact release: ${segment}`);
  }

  // The version variable itself is a pinned literal: MCP_PUB_VERSION="latest"
  // passed the old substring test and must fail here. Every assignment is
  // checked, so a later re-assignment to a floating ref cannot hide behind
  // an earlier pinned one (shell keeps the last value).
  const versions = [...active.matchAll(/^\s*MCP_PUB_VERSION=["']([^"']+)["']\s*$/gm)]
    .map((m) => m[1]);
  assert.ok(versions.length > 0, "mcp-registry-publish.yml: MCP_PUB_VERSION assignment not found");
  for (const version of versions) {
    assert.ok(PINNED_VERSION.test(version),
      `MCP_PUB_VERSION is not pinned to an exact release version: ${version}`);
  }

  // The checksum check must live in the install step itself (not a comment
  // or a different step) and must apply to the downloaded tarball.
  const step = stepBlock(text, "Install mcp-publisher");
  assert.ok(step, "mcp-registry-publish.yml: 'Install mcp-publisher' step not found");
  const code = activeLines(step).join("\n");
  assert.ok(/curl\b[^\n]*\$\{?TARBALL\}?/.test(code),
    "install step must download the mcp-publisher tarball");
  const checksumsCurl = code.split("\n")
    .find((line) => /curl\b/.test(line) && /(\$\{BASE\}|releases\/download\/)/.test(line) && line.includes("checksums"));
  assert.ok(checksumsCurl,
    "install step must download the checksums file from the same pinned release");
  const checksumsFile = checksumsCurl.match(/(?:-o\s+|>\s*)"?([^\s"]+)/)?.[1];
  assert.ok(checksumsFile, "install step must save the downloaded checksums to a file");
  // Binding forms: grep the tarball's own entry out of the downloaded
  // checksums file and pipe it to `sha256sum -c`, or run `sha256sum -c`
  // directly on that same downloaded file. Checking some other file whose
  // name merely contains "checksums" does not verify the tarball.
  const verify = code.match(/grep\b[\s\S]*?\$\{?TARBALL\}?[\s\S]*?checksums[\s\S]*?\|\s*sha256sum\s+-c\b/)
    ?? code.match(new RegExp(`sha256sum\\s+-c\\s+["']?${checksumsFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:["'\\s]|$)`));
  assert.ok(verify,
    "install step must checksum-verify the downloaded tarball: 'sha256sum -c' must consume the checksums entry for ${TARBALL} (a stray occurrence in a comment or another step does not count)");
  const extractAt = code.search(/\btar\b[^\n]*\$\{?TARBALL\}?/);
  assert.ok(extractAt > -1, "install step must extract the downloaded tarball");
  assert.ok(code.indexOf(verify[0]) < extractAt,
    "checksum verification of the tarball must run before it is extracted");
});
