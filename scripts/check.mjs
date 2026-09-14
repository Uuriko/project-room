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
const result = spawnSync(process.execPath, ["--test"], { stdio: "inherit" });
process.exit(result.status ?? 1);
