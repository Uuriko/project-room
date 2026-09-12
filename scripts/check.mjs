import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : /\.(mjs|js)$/.test(e.name) ? [join(path, e.name)] : []); }
const cloudflare = readdirSync("cloudflare", { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith(".mjs")).map(e => join("cloudflare", e.name));
for (const path of ["server.mjs", ...["src", "server", "client", "scripts", "tests"].flatMap(files), ...cloudflare]) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
const coverage = spawnSync(process.execPath, ["scripts/journey-coverage.mjs"], { stdio: "inherit" });
if (coverage.status !== 0) process.exit(coverage.status || 1);
const shadows = spawnSync(process.execPath, ["scripts/check-no-shadow-imports.mjs"], { stdio: "inherit" });
if (shadows.status !== 0) process.exit(shadows.status || 1);
const result = spawnSync(process.execPath, ["--test"], { stdio: "inherit" });
process.exit(result.status ?? 1);
