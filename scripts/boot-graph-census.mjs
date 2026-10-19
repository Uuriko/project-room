// BG-1 — boot-graph census, Miniflare leg (fix programme v2, readpath.md
// §3 + §5 item 3; drains NEW-RC-5). The node leg is tests/boot-graph
// .test.js; this leg covers the Worker boot graph. It is registered in
// cloudflare/package.json's test list and lives in scripts/ because it
// is suite tooling, not a runtime module (no *.check.mjs ships in the
// runtime package; scripts/runtime-package.mjs is the shipped set).
//
// Method (named, per the M9 number rule): esbuild bundle closure — the
// same bundling the suite itself uses to build fixtures for Miniflare.
// The production set is the bundle of the real entry, cloudflare
// /room.mjs. The fixture set is the union of every *.test-fixture.mjs
// bundle in this directory (each bundle's own head file excluded: a
// harness head is not graph). Several fixtures import the real entry
// and re-export ProjectRoom, so the suite genuinely drives the
// production graph; the census fails if the production bundle ever
// grows a module no fixture bundle drives, or the reverse beyond the
// allowlist. Scope: server.mjs, server/, src/, cloudflare/.
//
// Intentional differences live in tests/boot-graph-allowlist.json
// (suites: ["cloudflare"]) under the same edit rules as the node leg:
// owner + reason per entry, stale entries fail.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cfDir = join(repo, "cloudflare");
// esbuild is the cloudflare package's devDependency; resolve it from
// there explicitly so this script runs the same from scripts/.
const { build } = createRequire(join(cfDir, "package.json"))("esbuild");
const inScope = path => path === "server.mjs" || path.startsWith("server/") || path.startsWith("src/") || path.startsWith("cloudflare/");

async function bundleSet(entry) {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "neutral",
    external: ["node:*", "cloudflare:*"], metafile: true, absWorkingDir: repo, logLevel: "silent",
  });
  return new Set(Object.keys(result.metafile.inputs).filter(inScope));
}

test("boot-graph census (cloudflare): the production Worker bundle adds no module the fixture bundles do not already drive", { timeout: 300_000 }, async () => {
  const production = await bundleSet(join(cfDir, "room.mjs"));
  const fixture = new Set();
  const heads = readdirSync(cfDir).filter(name => name.endsWith(".test-fixture.mjs")).sort();
  for (const name of heads) {
    const set = await bundleSet(join(cfDir, name));
    set.delete(`cloudflare/${name}`);
    for (const module of set) fixture.add(module);
  }

  const productionOnly = [...production].filter(m => !fixture.has(m)).sort();
  const fixtureOnly = [...fixture].filter(m => !production.has(m)).sort();

  const allowlist = JSON.parse(readFileSync(join(repo, "tests/boot-graph-allowlist.json"), "utf8"));
  const entries = allowlist.entries.filter(entry => entry.suites.includes("cloudflare"));
  for (const entry of entries) {
    assert.ok(entry.module && entry.side && entry.owner && entry.reason,
      `allowlist entry must name module, side, owner and reason: ${JSON.stringify(entry)}`);
  }
  const allowed = side => new Set(entries.filter(entry => entry.side === side).map(entry => entry.module));
  const residualProduction = productionOnly.filter(m => !allowed("production-only").has(m));
  const residualFixture = fixtureOnly.filter(m => !allowed("fixture-only").has(m));
  const stale = [
    ...[...allowed("production-only")].filter(m => !productionOnly.includes(m)).map(m => `${m} (production-only)`),
    ...[...allowed("fixture-only")].filter(m => !fixtureOnly.includes(m)).map(m => `${m} (fixture-only)`),
  ];

  console.log(`boot-graph census (cloudflare): production=${production.size} fixture-union=${fixture.size} production-only=${productionOnly.length} fixture-only=${fixtureOnly.length} allowlisted=${entries.length} residual=${residualProduction.length + residualFixture.length}`);

  assert.deepEqual(residualProduction, [], `production Worker bundle modules no fixture bundle drives (fix the divergence or register with owner + reason in tests/boot-graph-allowlist.json): ${residualProduction.join(", ")}`);
  assert.deepEqual(residualFixture, [], `fixture-only modules with no allowlist entry: ${residualFixture.join(", ")}`);
  assert.deepEqual(stale, [], `stale allowlist entries (the difference no longer exists — remove the entry): ${stale.join(", ")}`);
});
