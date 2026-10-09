// Pins findPackageDir's contract: the license-attribution walk-up must never
// hang. The old loop's `dir !== '.'` guard is never false at the filesystem
// root (dirname('/') === '/'), so a pnpm-style input whose realpath lives
// outside the repo spun forever with no output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPackageDir } from "../scripts/build-gmail-sanitizer.mjs";

test("findPackageDir resolves the owning package of a bundled input", () => {
  const root = mkdtempSync(join(tmpdir(), "sanitizer-pkg-"));
  const pkgDir = join(root, "node_modules", "sanitize-html");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "sanitize-html", version: "2.0.0" })
  );
  assert.equal(findPackageDir(join(pkgDir, "dist", "index.js")), pkgDir);
});

test("findPackageDir throws instead of hanging when no package.json exists to the root", () => {
  // Regression: the old walk-up loop never terminated for absolute inputs
  // with no package.json above them (esbuild resolves symlinks, so pnpm's
  // out-of-tree realpaths reach this shape). Fails loud now.
  // NOTE: built under /tmp, not os.tmpdir() — the test env sets TMPDIR
  // inside the repo, whose own package.json would (correctly) be found.
  const root = mkdtempSync("/tmp/sanitizer-nopkg-");
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  assert.throws(
    () => findPackageDir(join(root, "node_modules", "x", "index.js")),
    /no package\.json/
  );
  rmSync(root, { recursive: true, force: true });
});

test("findPackageDir returns null when a relative walk leaves the tree", () => {
  // Preserves the old skip behavior for relative inputs with no owning
  // package between the file and '.'.
  assert.equal(findPackageDir(join("node_modules", "no-such-pkg-zzz", "index.js")), null);
});
