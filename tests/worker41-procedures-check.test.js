// WORKER-41 (guild-06): procedures-index --check must fail clean when the
// generated index is absent, instead of an ENOENT stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "procedures-index.mjs");
const outPath = join(root, "deploy", "procedures-index.mjs");

test("procedures-index --check with a missing generated index exits 1 with a clean message", () => {
  const backup = `${outPath}.worker41-bak`;
  assert.ok(existsSync(outPath), "precondition: deploy/procedures-index.mjs exists");
  renameSync(outPath, backup);
  try {
    const r = spawnSync(process.execPath, [script, "--check"], {
      encoding: "utf8", timeout: 30000, cwd: root,
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /is missing/, "says the file is missing");
    assert.match(r.stderr, /node scripts\/procedures-index\.mjs/, "tells how to regenerate");
    assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace");
    assert.equal(existsSync(outPath), false, "--check must not regenerate the file");
  } finally {
    renameSync(backup, outPath);
  }
  assert.ok(existsSync(outPath), "generated index restored");
});

test("procedures-index --check stays green when the index is fresh", () => {
  const r = spawnSync(process.execPath, [script, "--check"], {
    encoding: "utf8", timeout: 30000, cwd: root,
  });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stdout, /fresh/);
});
