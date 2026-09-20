import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Fail fast with a clear message on old Node (task #42): package.json
// declares engines >=24.19.0, and npm only warns without engine-strict.
{
  const [major, minor, patch] = process.version.slice(1).split(".").map(Number);
  const ok = major > 24 || (major === 24 && (minor > 19 || (minor === 19 && patch >= 0)));
  if (!ok) {
    console.error(`Project Room requires Node >=24.19.0 (running ${process.version}). See package.json engines.`);
    process.exit(1);
  }
}

function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : /\.(mjs|js)$/.test(e.name) ? [join(path, e.name)] : []); }
const cloudflare = readdirSync("cloudflare", { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith(".mjs")).map(e => join("cloudflare", e.name));
const deploy = readdirSync("deploy", { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith(".mjs")).map(e => join("deploy", e.name));
for (const path of ["server.mjs", ...["src", "server", "client", "scripts", "tests"].flatMap(files), ...cloudflare, ...deploy]) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
const coverage = spawnSync(process.execPath, ["scripts/journey-coverage.mjs"], { stdio: "inherit" });
if (coverage.status !== 0) process.exit(coverage.status || 1);
const shadows = spawnSync(process.execPath, ["scripts/check-no-shadow-imports.mjs"], { stdio: "inherit" });
if (shadows.status !== 0) process.exit(shadows.status || 1);
// --- Route documentation gate (re-audit 2026-09-14, M4) ---
// Every /api route template server/http.mjs serves is described in
// docs/openapi.yaml, and nothing described there has gone unserved.
const routeDocs = spawnSync(process.execPath, ["scripts/route-docs-check.mjs"], { stdio: "inherit" });
if (routeDocs.status !== 0) process.exit(routeDocs.status || 1);
// --- end route documentation gate ---
const schema = spawnSync(process.execPath, ["scripts/check-schema-version.mjs"], { stdio: "inherit" });
if (schema.status !== 0) process.exit(schema.status || 1);
// Lint gate (eslint.config.mjs): correctness-only rules, errors fail, warnings allowed.
// Skipped with a notice when the eslint devDependency is not installed (no `npm ci`).
{
  const lint = spawnSync(process.execPath, ["scripts/lint.mjs", "--skip-if-missing"], { stdio: "inherit" });
  if (lint.status !== 0) process.exit(lint.status || 1);
}
// Secret-scan gate (H005 wiring, 2026-09-16): scans the repo tree for
// accidentally committed secrets. Fails the build on any finding.
const secretScan = spawnSync(process.execPath, ["scripts/secret-scan-check.mjs"], { stdio: "inherit" });
if (secretScan.status !== 0) process.exit(secretScan.status || 1);
// Open-route inventory (B48): every `security: []` route in docs/openapi.yaml
// is named in docs/ROUTE-AUTH-TABLE.md and docs/INVITE-ONLY-CHECKLIST.md §1.
const openRoutes = spawnSync(process.execPath, ["scripts/open-routes.mjs", "--check"], { stdio: "inherit" });
if (openRoutes.status !== 0) process.exit(openRoutes.status || 1);
// Room Wiki gate (D2): the experience-compiler planes stay schema-valid and ordered.
const wiki = spawnSync(process.execPath, ["scripts/check-wiki.mjs"], { stdio: "inherit" });
if (wiki.status !== 0) process.exit(wiki.status || 1);
// CI runs the root suite in the dedicated unit job; local check runs it here.
if (process.env.CI) {
  console.log("check: skipping node --test in CI (covered by test jobs)");
  process.exit(0);
}
const result = spawnSync(process.execPath, ["--test"], { stdio: "inherit" });
process.exit(result.status ?? 1);
