// Offline exact-commit packaging. No dependency installation, upload or deployment.
// This verifier is standalone: it can be copied outside the source checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, posix } from "node:path";
import { pathToFileURL } from "node:url";

export const publicAssets = ["index.html", ...["app.js", "client.js", "events.js", "conversation.js", "workflow.js", "share-links.js",
  "return-brief.js", "work-selectors.js", "work-status.js", "work-packet.js", "portable-work.js", "reminders.js", "reminder-time.js", "styles.css"].map(name => "src/" + name)];
const required = [...publicAssets, "server.mjs", "package.json", "package-lock.json",
  ...["backup", "bootstrap", "claim-scopes", "deployment", "http", "invitation-evidence", "invitation-journal", "reminders",
    "return-brief", "return-selectors", "share-links", "store", "work-context", "writer-fence"].map(name => `server/${name}.mjs`),
  ...["room-agent", "assignment-watcher", "watch-journal"].map(name => `client/${name}.mjs`),
  ...["backup-room", "provision", "audit-invitations", "agent-inbox", "agent-watch"].map(name => `scripts/${name}.mjs`),
  ...["room.mjs", "storage.mjs", "bootstrap.mjs", "build-assets.mjs", "wrangler.jsonc", "package.json", "pnpm-lock.yaml"].map(name => "cloudflare/" + name)].sort();
// Historical v8 packages predate these files. Literal-import closure below makes
// them mandatory when the selected source imports them, without rewriting history.
const optional = ["server/maintenance.mjs", "server/recovery.mjs", "client/agent-connection.mjs"];
const allowed = new Set([...required, ...optional]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const check = condition => { if (!condition) throw new Error("Runtime package does not match its exact allowlisted contract"); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hashPattern = /^[0-9a-f]{40}$/;
const manifestName = "runtime-manifest.json";

function runtimeMetadata(files) {
  const schema = /export const STORE_SCHEMA_VERSION = (\d+);/.exec(files.get("server/writer-fence.mjs").toString());
  const pkg = JSON.parse(files.get("package.json"));
  const config = JSON.parse(files.get("cloudflare/wrangler.jsonc"));
  check(schema?.[1] === "8" && typeof pkg.engines?.node === "string");
  return { schemaVersion: 8, node: pkg.engines.node, cloudflare: { compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags, durableObjects: config.durable_objects, migrations: config.migrations } };
}

export function createRuntimePackage({ repository, commit, destination }) {
  check(typeof commit === "string" && hashPattern.test(commit));
  const git = (...args) => execFileSync("git", args, { cwd: repository, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  check(git("rev-parse", "--verify", `${commit}^{commit}`).toString().trim() === commit);
  const tree = git("rev-parse", `${commit}^{tree}`).toString().trim();
  const entries = git("ls-tree", "-r", "-z", commit, "--", ...allowed).toString().split("\0").filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(line); check(match && allowed.has(match[3]));
    return { path: match[3], object: match[2] };
  }).sort((a, b) => a.path < b.path ? -1 : 1);
  check(required.every(path => entries.some(entry => entry.path === path)));
  const files = new Map(entries.map(entry => [entry.path, git("cat-file", "blob", entry.object)]));
  const runtime = runtimeMetadata(files);
  check(isAbsolute(destination) && destination === resolve(destination));
  const parent = realpathSync(dirname(destination)), output = join(parent, basename(destination));
  mkdirSync(output, { mode: 0o700 }); // Existing paths are never reused or overwritten.
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(output, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(output, path), bytes, { mode: 0o600, flag: "wx" });
  }
  const manifest = { format: 1, sourceCommit: commit, sourceTree: tree, runtime, publicAssets,
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
    limitation: "Content consistency only; not trusted provenance, recovery freshness, hosted readiness or publication approval." };
  // Last write is the completion marker. A partial directory is not a package.
  writeFileSync(join(output, manifestName), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return verifyRuntimePackage(output, { expectedCommit: commit });
}

export function verifyRuntimePackage(directory, { expectedCommit } = {}) {
  const root = resolve(directory), info = lstatSync(root);
  check(info.isDirectory() && !info.isSymbolicLink());
  const actual = [];
  const walk = (prefix = "") => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        check([...allowed].some(file => file.startsWith(path + "/"))); walk(path);
      } else { check(entry.isFile() && (path === manifestName || allowed.has(path))); actual.push(path); }
    }
  };
  walk();
  check(actual.includes(manifestName));
  const raw = readFileSync(join(root, manifestName)), manifest = JSON.parse(raw);
  check(manifest.format === 1 && hashPattern.test(manifest.sourceCommit) && hashPattern.test(manifest.sourceTree)
    && (!expectedCommit || manifest.sourceCommit === expectedCommit) && same(manifest.publicAssets, publicAssets) && Array.isArray(manifest.files));
  const listed = manifest.files.map(entry => entry.path);
  check(new Set(listed).size === listed.length && same([...listed].sort(), listed) && required.every(path => listed.includes(path))
    && same(actual.sort(), [...listed, manifestName].sort()));
  const files = new Map();
  for (const entry of manifest.files) {
    check(allowed.has(entry.path) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[0-9a-f]{64}$/.test(entry.sha256));
    const bytes = readFileSync(join(root, entry.path));
    check(bytes.length === entry.bytes && sha256(bytes) === entry.sha256); files.set(entry.path, bytes);
  }
  // Check this codebase's literal imports, including dynamic literal imports.
  // This is not a complete JavaScript dependency parser; cold runtime tests and
  // source review remain required, especially if a computed loader is added.
  for (const [path, bytes] of files) if (/\.m?js$/.test(path)) {
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith("node:") || specifier.startsWith("cloudflare:")) continue;
      check(specifier.startsWith(".") && files.has(posix.normalize(posix.join(posix.dirname(path), specifier))));
    }
  }
  check(same(manifest.runtime, runtimeMetadata(files)));
  return { verified: true, sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree,
    schemaVersion: manifest.runtime.schemaVersion, files: listed.length, assets: publicAssets.length, manifestSha256: sha256(raw) };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const [action, ...args] = process.argv.slice(2);
  try {
    let result;
    if (action === "create" && args.length === 3) result = createRuntimePackage({ repository: args[0], commit: args[1], destination: args[2] });
    else if (action === "verify" && args.length >= 1 && args.length <= 2) result = verifyRuntimePackage(args[0], { expectedCommit: args[1] });
    else throw new Error("Usage: runtime-package.mjs create REPOSITORY EXACT_COMMIT NEW_ABSOLUTE_DIRECTORY | verify DIRECTORY [EXACT_COMMIT]");
    console.log(JSON.stringify(result));
  } catch { console.error("Runtime package operation failed. No upload, deployment or overwrite was requested. Inspect the private output before retrying."); process.exitCode = 1; }
}
