// Offline exact-commit packaging. No dependency installation, upload or deployment.
// This verifier is standalone: it can be copied outside the source checkout.
// Inside the repository the pin set is generated from imports, public assets,
// and scripts/runtime-historical-pins.json. A copied verifier checks the
// package manifest instead of rebuilding that set.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, posix } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const GENERATED_AGENT_PAGE = /^docs\/agents\/[^/]+\.html$/;
const HISTORICAL_PINS = "scripts/runtime-historical-pins.json";
const IMPORT_SPEC = /(?<!["'.-])(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']/g;
const FILE_URL_SPEC = /new URL\(\s*["'](\.[^"']+\.[A-Za-z0-9]+)["']/g;

function sourceRoot() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  if (basename(scriptDir) !== "scripts") return null;
  const root = dirname(scriptDir);
  if (!existsSync(join(root, "server.mjs")) || !existsSync(join(root, "server/public-assets.mjs"))) return null;
  return root;
}

function isSourceFile(root, rel) {
  if (!rel || rel === "." || rel === "./" || rel.endsWith("/") || rel.split("/").includes("..")) return false;
  try { return statSync(join(root, rel)).isFile(); }
  catch { return false; }
}

// Public assets are declared once in server/public-assets.mjs. Parse that
// data-only array; do not import it, so this file stays dependency-free.
function declaredAssets(source, exportName) {
  const declaration = source?.match(new RegExp(`export const ${exportName} = ([\\s\\S]*?);`))?.[1];
  if (!declaration) throw new Error(`missing export const ${exportName}`);
  const expression = declaration.startsWith("Object.freeze(") ? declaration.slice(14, -1) : declaration;
  const parts = expression.match(/^\[(.*?)\.\.\.\[(.*?)\]\.map\(\s*(\w+)\s*=>\s*(["'])src\/\4\s*\+\s*\3\s*\)(.*?)\]$/s);
  if (!parts) throw new Error(`${exportName} has an unsupported public asset declaration`);
  const literals = text => {
    const values = [...text.matchAll(/["']([A-Za-z0-9_./-]+)["']/g)].map(match => match[1]);
    if (text.replace(/["'][A-Za-z0-9_./-]+["']/g, "").replace(/[\s,]/g, ""))
      throw new Error(`${exportName} has unsupported asset expressions`);
    return values;
  };
  return [...literals(parts[1]), ...literals(parts[2]).map(file => "src/" + file), ...literals(parts[5])];
}

function importClosure(root, roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel) || !isSourceFile(root, rel)) continue;
    seen.add(rel);
    if (!/\.(?:mjs|js|cjs)$/.test(rel)) continue;
    const text = readFileSync(join(root, rel), "utf8");
    const dir = dirname(rel);
    IMPORT_SPEC.lastIndex = 0;
    FILE_URL_SPEC.lastIndex = 0;
    const specs = [...text.matchAll(IMPORT_SPEC), ...text.matchAll(FILE_URL_SPEC)].map(match => match[1]);
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      let resolved = posix.normalize(posix.join(dir, spec));
      if (!isSourceFile(root, resolved)) {
        for (const ext of [".mjs", ".js", ".cjs", ".json"]) {
          if (isSourceFile(root, resolved + ext)) { resolved += ext; break; }
        }
      }
      if (isSourceFile(root, resolved) && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function loadPins(root) {
  const assets = declaredAssets(readFileSync(join(root, "server/public-assets.mjs"), "utf8"), "publicAssetPaths");
  const historicalPath = join(root, HISTORICAL_PINS);
  if (!existsSync(historicalPath)) throw new Error(`missing ${HISTORICAL_PINS}`);
  const historical = JSON.parse(readFileSync(historicalPath, "utf8"));
  if (!Array.isArray(historical) || historical.some(path => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..")))
    throw new Error(`${HISTORICAL_PINS} must be an array of repo-relative paths`);
  const roots = [...required, ...assets, ...historical].filter(path => /\.(?:mjs|js|cjs)$/.test(path) && isSourceFile(root, path));
  const closure = importClosure(root, roots);
  return { publicAssets: assets, allowed: new Set([...required, ...assets, ...historical, ...closure]) };
}

const v8Assets = ["index.html", ...["app.js", "client.js", "events.js", "conversation.js", "workflow.js", "share-links.js",
  "return-brief.js", "work-selectors.js", "work-status.js", "work-packet.js", "portable-work.js", "reminders.js", "reminder-time.js", "styles.css"].map(name => "src/" + name)];
const required = [...v8Assets, "server.mjs", "package.json", "package-lock.json",
  ...["backup", "bootstrap", "claim-scopes", "deployment", "http", "invitation-evidence", "invitation-journal", "reminders",
    "return-brief", "return-selectors", "share-links", "store", "work-context", "writer-fence"].map(name => `server/${name}.mjs`),
  ...["room-agent", "assignment-watcher", "watch-journal"].map(name => `client/${name}.mjs`),
  ...["backup-room", "provision", "audit-invitations", "agent-inbox", "agent-watch"].map(name => `scripts/${name}.mjs`),
  ...["room.mjs", "storage.mjs", "bootstrap.mjs", "build-assets.mjs", "wrangler.jsonc", "package.json", "pnpm-lock.yaml"].map(name => "cloudflare/" + name)].sort();

// Decision #36 (#3254, Option A): docs/agents/*.html are build output and are
// never committed. They stay in the pin set when public-assets.mjs names them
// so an older package that contains them still verifies. Packaging filters
// them out of the asset obligation below.
const pins = (() => {
  const root = sourceRoot();
  return root ? loadPins(root) : null;
})();
export const pinsFromSource = pins !== null;
export const publicAssets = pins?.publicAssets ?? [];
export const generatedAgentPages = new Set(publicAssets.filter(path => GENERATED_AGENT_PAGE.test(path)));
export const allowed = pins?.allowed ?? new Set();

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// The contract stays exact: any mismatch fails. Each failure names the
// offending path so a pull request can fix the import in one cycle. Pins are
// generated; a new imported module does not get a hand-written registration.
const check = (condition, detail) => {
  if (!condition) throw new Error("Runtime package does not match its exact allowlisted contract"
    + (detail ? `: ${detail}` : ""));
};
// Read the selected source's explicit asset declaration, never today's list for
// an older schema. Generated agent pages stay out of the obligation: an
// exact-commit package does not contain them (decision #36).
function assetsFor(files, permit = allowed) {
  const path = files.has("server/public-assets.mjs") ? "server/public-assets.mjs" : files.has("deploy/public-assets.mjs") ? "deploy/public-assets.mjs" : "cloudflare/build-assets.mjs";
  const name = path === "cloudflare/build-assets.mjs" ? "assetPaths" : "publicAssetPaths";
  let declared = null, parseError = null;
  try { declared = declaredAssets(files.get(path)?.toString(), name); }
  catch (error) { parseError = error; }
  check(!parseError, `${path}: ${parseError?.message ?? "unreadable asset declaration"}`);
  const assets = declared.filter(asset => !GENERATED_AGENT_PAGE.test(asset));
  check(assets.includes("index.html") && new Set(assets).size === assets.length && assets.every(asset => permit.has(asset)),
    `${path} advertises invalid or unregistered assets`);
  return assets;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hashPattern = /^[0-9a-f]{40}$/;
const manifestName = "runtime-manifest.json";

function runtimeMetadata(files) {
  const schema = /export const STORE_SCHEMA_VERSION = (\d+);/.exec(files.get("server/writer-fence.mjs").toString());
  const pkg = JSON.parse(files.get("package.json"));
  const config = JSON.parse(files.get("cloudflare/wrangler.jsonc"));
  check(["8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42"].includes(schema?.[1]) && typeof pkg.engines?.node === "string",
    `unsupported store schema ${schema?.[1] ?? "unparseable"} or missing package.json engines.node`);
  return { schemaVersion: Number(schema[1]), node: pkg.engines.node, cloudflare: { compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags, durableObjects: config.durable_objects, migrations: config.migrations } };
}

// Shared by exact-package verification and the cheap working-tree preflight.
export function verifyRuntimeImports(files) {
  // Check this codebase's literal imports, including dynamic literal imports.
  // This is not a complete JavaScript dependency parser; cold runtime tests and
  // source review remain required, especially if a computed loader is added.
  for (const [path, bytes] of files) if (/\.m?js$/.test(path)) {
    // Quoted actions such as "import" or "source.import" are not declarations.
    for (const match of bytes.toString().matchAll(/(?<!["'.-])(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith("node:") || specifier.startsWith("cloudflare:")) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
      check(specifier.startsWith(".") && files.has(resolved),
        `${path} imports ${JSON.stringify(specifier)} (resolves to ${resolved}), which is not in the allowlisted runtime package — pins are generated from imports, public assets, and scripts/runtime-historical-pins.json`);
    }
  }
}

export function verifyRuntimeSource(directory) {
  const files = new Map();
  for (const path of allowed) {
    if (existsSync(join(directory, path))) files.set(path,
      /\.m?js$/.test(path) ? readFileSync(join(directory, path)) : null);
  }
  for (const path of required) check(files.has(path), `required runtime source is missing: ${path}`);
  verifyRuntimeImports(files);
  return { files: files.size };
}

export function createRuntimePackage({ repository, commit, destination }) {
  check(pinsFromSource, "runtime pins are generated from the source checkout; run scripts/runtime-package.mjs from the repository");
  check(typeof commit === "string" && hashPattern.test(commit),
    `commit must be a full 40-char hash, got: ${String(commit).slice(0, 64)}`);
  const git = (...args) => execFileSync("git", args, { cwd: repository, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  let resolved;
  try {
    resolved = git("rev-parse", "--verify", `${commit}^{commit}`).toString().trim();
  } catch {
    throw new Error(`Baseline commit ${commit} is not in this checkout's history.`
      + ` The upgrade gates need the full history: run 'git fetch --unshallow' (or clone without --depth).`);
  }
  check(resolved === commit, `resolved commit ${resolved} does not match requested ${commit}`);
  const tree = git("rev-parse", `${commit}^{tree}`).toString().trim();
  const entries = git("ls-tree", "-r", "-z", commit, "--", ...allowed).toString().split("\0").filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    check(match && allowed.has(match[3]), `git tree entry is not in the allowlisted runtime package: ${match?.[3] ?? line}`);
    return { path: match[3], object: match[2] };
  }).sort((a, b) => a.path < b.path ? -1 : 1);
  const missingRequired = required.filter(path => !entries.some(entry => entry.path === path));
  check(missingRequired.length === 0, `required runtime files missing from the package: ${missingRequired.join(", ")}`);
  const files = new Map(entries.map(entry => [entry.path, git("cat-file", "blob", entry.object)]));
  const runtime = runtimeMetadata(files);
  check(isAbsolute(destination) && destination === resolve(destination),
    `destination must be an absolute normalized path, got: ${destination}`);
  const parent = realpathSync(dirname(destination)), output = join(parent, basename(destination));
  mkdirSync(output, { mode: 0o700 }); // Existing paths are never reused or overwritten.
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(output, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(output, path), bytes, { mode: 0o600, flag: "wx" });
  }
  const manifest = { format: 1, sourceCommit: commit, sourceTree: tree, runtime, publicAssets: assetsFor(files),
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
    limitation: "Content consistency only; not trusted provenance, recovery freshness, hosted readiness or publication approval." };
  // Last write is the completion marker. A partial directory is not a package.
  writeFileSync(join(output, manifestName), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return verifyRuntimePackage(output, { expectedCommit: commit });
}

function allowlistFor(manifest) {
  if (pinsFromSource) return allowed;
  check(Array.isArray(manifest?.files), "runtime manifest files is not an array");
  return new Set(manifest.files.map(entry => entry.path).filter(path => typeof path === "string"));
}

export function verifyRuntimePackage(directory, { expectedCommit } = {}) {
  const root = resolve(directory), info = lstatSync(root);
  check(info.isDirectory() && !info.isSymbolicLink());
  // A copied verifier has no checkout to rebuild pins from. The manifest
  // recorded at create time is the pin set for that package.
  const earlyManifest = pinsFromSource ? null : JSON.parse(readFileSync(join(root, manifestName), "utf8"));
  const permit = allowlistFor(earlyManifest);
  const actual = [];
  const walk = (prefix = "") => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        check([...permit].some(file => file.startsWith(path + "/")),
          `packaged directory ${path}/ is not a prefix of any allowlisted runtime file`);
        walk(path);
      } else {
        check(entry.isFile() && (path === manifestName || permit.has(path)),
          `packaged file ${path} is not in the allowlisted runtime package`);
        actual.push(path);
      }
    }
  };
  walk();
  check(actual.includes(manifestName), "packaged runtime is missing its runtime-manifest.json");
  const raw = readFileSync(join(root, manifestName)), manifest = JSON.parse(raw);
  check(manifest.format === 1, `runtime manifest format ${manifest.format} is not 1`);
  check(hashPattern.test(manifest.sourceCommit),
    `runtime manifest sourceCommit is not a commit hash: ${String(manifest.sourceCommit).slice(0, 64)}`);
  check(hashPattern.test(manifest.sourceTree),
    `runtime manifest sourceTree is not a tree hash: ${String(manifest.sourceTree).slice(0, 64)}`);
  check(!expectedCommit || manifest.sourceCommit === expectedCommit,
    `runtime manifest sourceCommit ${manifest.sourceCommit} does not match expected ${expectedCommit}`);
  check(Array.isArray(manifest.files), "runtime manifest files is not an array");
  const listed = manifest.files.map(entry => entry.path);
  check(new Set(listed).size === listed.length, "runtime manifest lists a file more than once");
  check(same([...listed].sort(), listed), "runtime manifest file list is not sorted");
  const missingListed = required.filter(path => !listed.includes(path));
  check(missingListed.length === 0, `runtime manifest omits required files: ${missingListed.join(", ")}`);
  const actualSorted = actual.sort(), expectedSorted = [...listed, manifestName].sort();
  check(same(actualSorted, expectedSorted),
    `packaged files differ from the manifest: missing [${expectedSorted.filter(p => !actualSorted.includes(p)).join(", ")}], extra [${actualSorted.filter(p => !expectedSorted.includes(p)).join(", ")}]`);
  const files = new Map();
  for (const entry of manifest.files) {
    check(permit.has(entry.path), `manifest entry ${entry.path} is not in the allowlisted runtime package`);
    check(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[0-9a-f]{64}$/.test(entry.sha256),
      `manifest entry ${entry.path} has invalid bytes/sha256`);
    const bytes = readFileSync(join(root, entry.path));
    check(bytes.length === entry.bytes && sha256(bytes) === entry.sha256,
      `packaged file ${entry.path} does not match its manifest bytes/sha256`);
    files.set(entry.path, bytes);
  }
  const expectedAssets = assetsFor(files, permit);
  const missingAssets = expectedAssets.filter(asset => !manifest.publicAssets.includes(asset));
  const extraAssets = manifest.publicAssets.filter(asset => !expectedAssets.includes(asset));
  check(missingAssets.length === 0 && extraAssets.length === 0,
    `runtime manifest publicAssets mismatch: missing [${missingAssets.join(", ")}], extra [${extraAssets.join(", ")}]`);
  const absentAssets = expectedAssets.filter(path => !files.has(path));
  check(absentAssets.length === 0, `runtime public assets missing from packaged files: ${absentAssets.join(", ")}`);
  verifyRuntimeImports(files);
  const actualRuntime = runtimeMetadata(files);
  check(same(manifest.runtime, actualRuntime),
    `runtime manifest metadata differs from recomputed: manifest ${JSON.stringify(manifest.runtime)} vs computed ${JSON.stringify(actualRuntime)}`);
  return { verified: true, sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree,
    schemaVersion: manifest.runtime.schemaVersion, files: listed.length, assets: manifest.publicAssets.length, manifestSha256: sha256(raw) };
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
