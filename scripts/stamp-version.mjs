// Stamp only a pristine, committed source checkout. No upload or deployment.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function stampVersion({ repository = root, target = join(repository, "server/version.mjs"), revision, buildId = new Date().toISOString() } = {}) {
  if (revision !== undefined && !/^[0-9a-f]{40}$/.test(revision)) throw new Error("revision must be a full commit SHA");
  if (typeof buildId !== "string" || !buildId.length || buildId.length > 128 || /[\u0000-\u001f\u007f]/.test(buildId))
    throw new Error("build ID must be 1–128 printable characters");
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  if (revision !== undefined && revision !== head) throw new Error("revision must match the checked-out HEAD");
  if (git("status", "--porcelain", "--untracked-files=all").trim()) throw new Error("Release source must be clean, including untracked files");
  const source = readFileSync(target, "utf8");
  if (source !== git("show", "HEAD:server/version.mjs")) throw new Error("Version target must match the committed source template");
  const revisionPattern = /export const SOURCE_REVISION = "[^"\n]*";/g;
  const buildPattern = /export const BUILD_ID = "[^"\n]*";/g;
  if ([...source.matchAll(revisionPattern)].length !== 1 || [...source.matchAll(buildPattern)].length !== 1)
    throw new Error("Expected exactly one version and build constant");
  const stamped = source.replace(revisionPattern, () => `export const SOURCE_REVISION = ${JSON.stringify(head)};`)
    .replace(buildPattern, () => `export const BUILD_ID = ${JSON.stringify(buildId)};`);
  // An isolated immutable candidate is still required: this cannot lock writers.
  if (git("rev-parse", "HEAD").trim() !== head || git("status", "--porcelain", "--untracked-files=all").trim())
    throw new Error("Release source changed during stamping");
  writeFileSync(target, stamped);
  return { stamped: true, sourceRevision: head, buildId };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const key = { "--revision": "revision", "--build-id": "buildId", "--repository": "repository" }[arg];
    if (key) {
      if (options[key] !== undefined || args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error("Invalid stamp option");
      options[key] = args[++i];
    } else if (!arg.startsWith("--") && options.target === undefined) options.target = resolve(arg);
    else throw new Error("Unknown or duplicate stamp argument");
  }
  console.log(JSON.stringify(stampVersion(options)));
}
