// Stamp immutable release metadata into server/version.mjs at bundle/deploy
// time. Run immediately before bundling/uploading; commit the source first -
// the stamped revision must name an existing commit, never a working tree.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, isAbsolute } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const targetArg = args.find(a => !a.startsWith("--"));
const target = targetArg ? (isAbsolute(targetArg) ? targetArg : join(process.cwd(), targetArg)) : join(root, "server", "version.mjs");
const opt = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const revision = opt("--revision") ?? execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
const buildId = opt("--build-id") ?? new Date().toISOString();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("revision must be a full commit SHA");
const source = readFileSync(target, "utf8");
const stamped = source
  .replace(/export const SOURCE_REVISION = "[^"]*";/, `export const SOURCE_REVISION = "${revision}";`)
  .replace(/export const BUILD_ID = "[^"]*";/, `export const BUILD_ID = "${buildId}";`);
if (stamped === source) throw new Error("version constants not found - file shape changed?");
writeFileSync(target, stamped);
await import(target).then(m => {
  if (m.SOURCE_REVISION !== revision || m.BUILD_ID !== buildId) throw new Error("stamped file failed re-import verification");
});
console.log(JSON.stringify({ stamped: true, sourceRevision: revision, buildId }));
