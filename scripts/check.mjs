import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : /\.(mjs|js)$/.test(e.name) ? [join(path, e.name)] : []); }
for (const path of ["server.mjs", ...["src", "server", "scripts", "tests"].flatMap(files)]) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
const result = spawnSync(process.execPath, ["--test"], { stdio: "inherit" });
process.exit(result.status ?? 1);
