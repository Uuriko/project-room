// Stamp immutable release metadata into server/version.mjs at bundle/deploy
// time. Run immediately before bundling/uploading; commit the source first -
// the stamped revision must name an existing commit, never a working tree.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname, basename, isAbsolute } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// M-55: parse --flag value pairs structurally. The old
// `args.find(a => !a.startsWith("--"))` mistook option values
// (e.g. `--revision <sha>`) for the positional target whenever the target
// came after a flag.
const KNOWN_FLAGS = new Set(["--revision", "--build-id"]);
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--") { positionals.push(...args.slice(i + 1)); break; }
  if (a.startsWith("--")) {
    if (!KNOWN_FLAGS.has(a)) throw new Error(`unknown option: ${a}`);
    i++; // consume the flag's value
    continue;
  }
  positionals.push(a);
}
if (positionals.length > 1) throw new Error("expected at most one positional target");
const targetArg = positionals[0] ?? null;
const target = targetArg ? (isAbsolute(targetArg) ? targetArg : join(process.cwd(), targetArg)) : join(root, "server", "version.mjs");
const opt = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const revision = opt("--revision") ?? execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
const buildId = opt("--build-id") ?? new Date().toISOString();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("revision must be a full commit SHA");
const source = readFileSync(target, "utf8");
// M-56: JSON.stringify the interpolated values — the old template dropped the
// raw buildId into a JS string literal, so a quote/backslash in --build-id
// broke the file (or worse). revision is already restricted to 40 hex chars.
const stamped = source
  .replace(/export const SOURCE_REVISION = "[^"]*";/, `export const SOURCE_REVISION = ${JSON.stringify(revision)};`)
  .replace(/export const BUILD_ID = "[^"]*";/, `export const BUILD_ID = ${JSON.stringify(buildId)};`);
if (stamped === source) throw new Error("version constants not found - file shape changed?");
// M-56: validate a temp copy BEFORE touching the target, then swap it in
// atomically. The old code overwrote the target first and validated after —
// a validation failure left a broken version.mjs behind. Sweep stale temp
// files from killed runs first (never touch a live pid's).
const tmpBase = `${basename(target)}.stamp-tmp-`;
for (const f of readdirSync(dirname(target))) {
  if (!f.startsWith(tmpBase) || !f.endsWith(".mjs")) continue;
  const pid = Number(f.slice(tmpBase.length, -".mjs".length));
  if (pid === process.pid) continue;
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  if (!alive) { try { unlinkSync(join(dirname(target), f)); } catch { /* already gone */ } }
}
const tmp = `${target}.stamp-tmp-${process.pid}.mjs`;
writeFileSync(tmp, stamped);
try {
  await import(pathToFileURL(tmp).href).then(m => {
    if (m.SOURCE_REVISION !== revision || m.BUILD_ID !== buildId) throw new Error("stamped file failed re-import verification");
  });
  renameSync(tmp, target);
} finally {
  try { unlinkSync(tmp); } catch { /* renamed into place, or never created */ }
}
console.log(JSON.stringify({ stamped: true, sourceRevision: revision, buildId }));
