// Hardening contract for scripts/sync-design-tokens-css.mjs (guild-06 worker-18).
//
// Two latent bugs, both fail-first covered here:
//   1. CLI ignores unknown flags: a typo'd `--check` (e.g. `--chek`) silently
//      runs in WRITE mode instead of the read-only CI gate — it would rewrite
//      src/styles.css when out of sync instead of failing the build.
//      Unknown flags must fail closed: stderr usage + exit 2.
//   2. syncTokensCss duplicates the file's final character when an end marker
//      is the last line with no trailing newline (indexOf("\n") -> -1, then
//      slice(-1)); repeated runs append one more char each time.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { syncTokensCss } from "../scripts/sync-design-tokens-css.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "sync-design-tokens-css.mjs");

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("unknown flag fails closed with exit 2 and a usage message", () => {
  const r = run("--bogus");
  assert.equal(r.status, 2, `expected exit 2, got ${r.status} (stdout: ${r.stdout})`);
  assert.match(r.stderr, /usage/i);
  assert.match(r.stderr, /--bogus/);
});

test("a typo'd --check never silently becomes write mode", () => {
  const r = run("--chek");
  assert.equal(r.status, 2, "typo'd check flag must fail, not regenerate styles.css");
  assert.match(r.stderr, /--chek/);
});

test("--check stays read-only and succeeds on an in-sync tree", () => {
  const r = run("--check");
  assert.equal(r.status, 0, r.stderr);
});

test("--help prints usage and exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--check/);
});

test("end marker at EOF without trailing newline does not duplicate the final character", () => {
  const css = ":root {\n/* tokens:begin DARK */\n--x: 1;\n/* tokens:end DARK */";
  const out = syncTokensCss(css);
  assert.ok(out.endsWith("/* tokens:end DARK */"), `tail was ${JSON.stringify(out.slice(-30))}`);
});

test("splice at EOF is idempotent: a second run changes nothing", () => {
  const css = ":root {\n/* tokens:begin DARK */\n--x: 1;\n/* tokens:end DARK */";
  const once = syncTokensCss(css);
  assert.equal(syncTokensCss(once), once, "repeated sync must not grow the file");
});
