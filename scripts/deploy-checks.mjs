// F007: reproducible deploy checks — lockfile + asset hash verification.
//
// Verifies that what gets deployed is what was pinned:
//   (a) package-lock.json exists and is in sync with package.json
//       (dependency sections/specs match, name/version match), and
//   (b) deploy assets hash to the SHA-256 values pinned in a manifest file
//       (default .asset-hashes.json), so a deploy can be re-verified
//       byte-for-byte before it ships.
//
// Usage:
//   node scripts/deploy-checks.mjs [--root <dir>] [--assets <csv>]
//       [--manifest <path>] [--check | --write] [--lockfile-only | --assets-only]
//   node scripts/deploy-checks.mjs --write --assets "server.mjs,deploy/"
//   node scripts/deploy-checks.mjs --check            # CI gate
//
// Env fallbacks: DEPLOY_CHECK_ROOT, DEPLOY_CHECK_ASSETS, DEPLOY_CHECK_MANIFEST.
// Exit codes: 0 all checks pass, 1 a check failed, 2 usage error.
// When --assets is omitted the deploy/ directory is hashed if it exists;
// otherwise the asset check is skipped with a note.
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_VERSION = 1;
export const DEFAULT_MANIFEST_NAME = ".asset-hashes.json";
const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// --- Pure hashing -----------------------------------------------------------

// SHA-256 hex of a Buffer/Uint8Array/string.
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

// SHA-256 hex of a file. Throws when the file cannot be read.
export function hashFile(absPath, { fs = nodeFs } = {}) {
  return sha256Hex(fs.readFileSync(absPath));
}

// Recursively list regular files under absDir as posix relative paths.
// Symlinks, sockets, and other non-regular entries are reported as skipped.
function listFilesUnder(absDir, fs, prefix = "") {
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = [];
  const skipped = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      const sub = listFilesUnder(abs, fs, rel);
      files.push(...sub.files);
      skipped.push(...sub.skipped);
    } else if (entry.isFile()) {
      files.push(rel);
    } else {
      skipped.push(rel);
    }
  }
  return { files, skipped };
}

// Compute SHA-256 hashes for asset paths. Directory entries expand to every
// regular file beneath them. Paths in the returned hashes map are posix-style
// paths relative to root, sorted. Returns { hashes, missing, skipped } where
// missing/skipped are sorted arrays of posix relative paths.
export function computeAssetHashes(paths, { fs = nodeFs, root = process.cwd() } = {}) {
  const hashes = {};
  const missing = [];
  const skipped = [];
  for (const raw of paths) {
    const rel = String(raw).split(sep).join("/");
    const abs = resolve(root, rel);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (stat.isDirectory()) {
      const { files, skipped: dirSkipped } = listFilesUnder(abs, fs);
      skipped.push(...dirSkipped.map(p => `${rel}/${p}`));
      for (const f of files) {
        const fileRel = `${rel}/${f}`;
        try {
          hashes[fileRel] = hashFile(join(abs, f), { fs });
        } catch {
          missing.push(fileRel);
        }
      }
    } else if (stat.isFile()) {
      try {
        hashes[rel] = hashFile(abs, { fs });
      } catch {
        missing.push(rel);
      }
    } else {
      skipped.push(rel);
    }
  }
  const sorted = {};
  for (const key of Object.keys(hashes).sort()) sorted[key] = hashes[key];
  return { hashes: sorted, missing: missing.sort(), skipped: skipped.sort() };
}

// --- Manifest ----------------------------------------------------------------

// Read and validate a manifest file. Throws with a clear message when the
// file is missing, unparsable, or has the wrong shape.
export function readManifest(manifestPath, { fs = nodeFs } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`manifest not found at ${manifestPath} — run with --write first`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest at ${manifestPath} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || !parsed.assets || typeof parsed.assets !== "object") {
    throw new Error(`manifest at ${manifestPath} has no "assets" object`);
  }
  return parsed;
}

// Write a manifest file (pretty JSON, trailing newline). Returns the manifest.
export function writeManifest(manifestPath, manifest, { fs = nodeFs } = {}) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

// Build a manifest object for a hashes map.
export function buildManifest(hashes, { generatedAt = new Date().toISOString() } = {}) {
  const assets = {};
  for (const key of Object.keys(hashes).sort()) assets[key] = hashes[key];
  return {
    version: MANIFEST_VERSION,
    generator: "scripts/deploy-checks.mjs",
    generatedAt,
    root: ".",
    assetCount: Object.keys(assets).length,
    assets,
  };
}

// Pure diff of an expected (manifest) assets map against actual hashes.
// missing: expected paths that could not be hashed (unreadable/missing).
// Returns { ok, added, changed, removed, missing } — all sorted arrays.
export function diffManifests(expected, actual, missing = []) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const path of Object.keys(actual)) {
    if (!Object.hasOwn(expected, path)) added.push(path);
    else if (actual[path] !== expected[path]) changed.push(path);
  }
  for (const path of Object.keys(expected)) {
    if (!Object.hasOwn(actual, path)) removed.push(path);
  }
  const ok = added.length === 0 && changed.length === 0 && removed.length === 0 && missing.length === 0;
  return { ok, added: added.sort(), changed: changed.sort(), removed: removed.sort(), missing: [...missing].sort() };
}

// --- Lockfile sync -----------------------------------------------------------

// Flat map of "section:name" -> spec for a package.json object.
function depSpecMap(pkg) {
  const map = new Map();
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps)) map.set(`${section}:${name}`, String(spec));
  }
  return map;
}

// Root dependency map for a parsed lockfile: v2/v3 use packages[""], v1 (or
// unknown shapes) fall back to the top-level dependencies map.
function lockRootDeps(lock) {
  if (lock.packages && typeof lock.packages === "object" && lock.packages[""]) {
    return { kind: "packages", root: lock.packages[""] };
  }
  if (lock.dependencies && typeof lock.dependencies === "object") {
    return { kind: "legacy", root: lock.dependencies };
  }
  return { kind: "none", root: {} };
}

// True when a spec is an exact pinned version ("1.2.3"), where the lockfile's
// resolved version must equal the spec verbatim.
function isExactSpec(spec) {
  return /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(spec);
}

// Check that package-lock.json exists and is in sync with package.json.
// Returns { ok, checks: [{ name, ok, detail }] } — pure apart from fs/root.
export function checkLockfileSync({ fs = nodeFs, root = process.cwd() } = {}) {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
  const done = () => ({ ok: checks.every(c => c.ok), checks });

  const lockPath = resolve(root, "package-lock.json");
  const pkgPath = resolve(root, "package.json");
  if (!fs.existsSync(lockPath)) {
    check("lockfile-present", false, "package-lock.json is missing");
    return done();
  }
  check("lockfile-present", true);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    check("package-json-parseable", false, err.message);
    return done();
  }
  check("package-json-parseable", true);
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (err) {
    check("lockfile-parseable", false, err.message);
    return done();
  }
  check("lockfile-parseable", true);
  check("lockfile-name", lock.name === pkg.name, `package.json name=${JSON.stringify(pkg.name)} lockfile name=${JSON.stringify(lock.name)}`);
  check("lockfile-version", lock.version === pkg.version, `package.json version=${JSON.stringify(pkg.version)} lockfile version=${JSON.stringify(lock.version)}`);

  const { kind, root: lockRoot } = lockRootDeps(lock);
  const mismatches = [];
  const extras = [];
  const pkgSpecs = depSpecMap(pkg);
  if (kind === "packages") {
    for (const [key, spec] of pkgSpecs) {
      const colon = key.indexOf(":");
      const section = key.slice(0, colon);
      const name = key.slice(colon + 1);
      const sectionLock = lockRoot[section];
      const locked = sectionLock && typeof sectionLock === "object" ? sectionLock[name] : undefined;
      if (locked !== spec) mismatches.push(`${section}.${name}: package.json ${JSON.stringify(spec)} vs lockfile ${JSON.stringify(locked)}`);
    }
    for (const section of DEP_SECTIONS) {
      const lockedSection = lockRoot[section];
      if (!lockedSection || typeof lockedSection !== "object") continue;
      for (const name of Object.keys(lockedSection)) {
        if (!pkgSpecs.has(`${section}:${name}`)) extras.push(`${section}.${name}`);
      }
    }
  } else {
    // Legacy v1 shape: lockfile stores resolved versions per dependency.
    for (const [key, spec] of pkgSpecs) {
      const name = key.slice(key.indexOf(":") + 1);
      const entry = lockRoot[name];
      if (!entry) {
        mismatches.push(`${name}: declared in package.json but missing from lockfile`);
      } else if (isExactSpec(spec) && entry.version !== spec) {
        mismatches.push(`${name}: package.json ${JSON.stringify(spec)} vs lockfile ${JSON.stringify(entry.version)}`);
      }
    }
    for (const name of Object.keys(lockRoot)) {
      if (![...pkgSpecs.keys()].some(k => k.slice(k.indexOf(":") + 1) === name)) extras.push(name);
    }
  }
  check("dependencies-in-sync", mismatches.length === 0, mismatches.length ? mismatches.join("; ") : `${pkgSpecs.size} spec(s) match`);
  check("no-extraneous-root-deps", extras.length === 0, extras.length ? `lockfile lists undeclared: ${extras.join(", ")}` : "none");
  return done();
}

// --- Orchestrator -------------------------------------------------------------

// Run the configured checks. Pure apart from fs reads.
// Options: { root, assets (paths), manifestPath, checkLockfile, checkAssets, fs }.
// Returns { ok, root, manifestPath, lockfile, assets }.
export function runDeployChecks({
  root = process.cwd(),
  assets = [],
  manifestPath = join(root, DEFAULT_MANIFEST_NAME),
  checkLockfile = true,
  checkAssets = true,
  fs = nodeFs,
} = {}) {
  const result = { ok: true, root, manifestPath, lockfile: null, assets: null };
  if (checkLockfile) {
    result.lockfile = checkLockfileSync({ fs, root });
    if (!result.lockfile.ok) result.ok = false;
  }
  if (checkAssets) {
    const assetResult = { ok: true, note: "", compared: null, missing: [], skipped: [] };
    if (assets.length === 0) {
      assetResult.note = "no deploy assets configured (pass --assets or create a deploy/ directory)";
    } else {
      let manifest;
      try {
        manifest = readManifest(manifestPath, { fs });
      } catch (err) {
        assetResult.ok = false;
        assetResult.note = err.message;
        result.assets = assetResult;
        result.ok = false;
        return result;
      }
      const { hashes, missing, skipped } = computeAssetHashes(assets, { fs, root });
      assetResult.missing = missing;
      assetResult.skipped = skipped;
      assetResult.compared = diffManifests(manifest.assets, hashes, missing);
      assetResult.assetCount = Object.keys(hashes).length;
      assetResult.ok = assetResult.compared.ok;
      if (!assetResult.ok) result.ok = false;
    }
    result.assets = assetResult;
  }
  return result;
}

function printUsage() {
  process.stdout.write(`deploy-checks: reproducible deploy checks — lockfile + asset hash verification (F007)

Usage:
  node scripts/deploy-checks.mjs [--root <dir>] [--assets <csv>] [--manifest <path>]
      [--check | --write] [--lockfile-only | --assets-only]

  --check          verify lockfile sync and asset hashes against the manifest (default)
  --write          (re)generate the manifest from current asset hashes
  --assets         comma-separated asset paths (files or directories), relative to --root
  --manifest       manifest path (default <root>/.asset-hashes.json)
  --lockfile-only  run only the lockfile check
  --assets-only    run only the asset hash check

Env fallbacks: DEPLOY_CHECK_ROOT, DEPLOY_CHECK_ASSETS, DEPLOY_CHECK_MANIFEST.
Without --assets, the deploy/ directory is hashed when it exists.
Exit codes: 0 all checks pass, 1 a check failed, 2 usage error.
`);
}

function failLines(result) {
  const lines = [];
  if (result.lockfile && !result.lockfile.ok) {
    for (const c of result.lockfile.checks) {
      if (!c.ok) lines.push(`  [lockfile] ${c.name}: ${c.detail}`);
    }
  }
  const assets = result.assets;
  if (assets && !assets.ok) {
    if (assets.note && !assets.compared) lines.push(`  [assets] ${assets.note}`);
    const diff = assets.compared;
    if (diff) {
      for (const p of diff.changed) lines.push(`  [assets] changed: ${p}`);
      for (const p of diff.added) lines.push(`  [assets] added (not in manifest): ${p}`);
      for (const p of diff.removed) lines.push(`  [assets] removed from disk: ${p}`);
      for (const p of diff.missing) lines.push(`  [assets] missing/unreadable: ${p}`);
    }
  }
  return lines;
}

async function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      root: { type: "string" },
      assets: { type: "string" },
      manifest: { type: "string" },
      check: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      "lockfile-only": { type: "boolean", default: false },
      "assets-only": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) { printUsage(); return; }
  if (values.check && values.write) {
    process.stderr.write("deploy-checks: --check and --write are mutually exclusive\n");
    process.exitCode = 2;
    return;
  }
  if (values["lockfile-only"] && values["assets-only"]) {
    process.stderr.write("deploy-checks: --lockfile-only and --assets-only are mutually exclusive\n");
    process.exitCode = 2;
    return;
  }
  const root = resolve(values.root || process.env.DEPLOY_CHECK_ROOT || process.cwd());
  const manifestPath = values.manifest || process.env.DEPLOY_CHECK_MANIFEST || join(root, DEFAULT_MANIFEST_NAME);
  const assetsCsv = values.assets ?? process.env.DEPLOY_CHECK_ASSETS;
  let assets;
  if (assetsCsv != null && assetsCsv !== "") {
    assets = assetsCsv.split(",").map(s => s.trim()).filter(s => s !== "");
  } else {
    assets = nodeFs.existsSync(join(root, "deploy")) ? ["deploy"] : [];
  }

  if (values.write) {
    if (values["lockfile-only"]) {
      process.stderr.write("deploy-checks: --write has nothing to write with --lockfile-only\n");
      process.exitCode = 2;
      return;
    }
    if (assets.length === 0) {
      process.stderr.write("deploy-checks: --write needs at least one asset (--assets <csv> or a deploy/ directory)\n");
      process.exitCode = 2;
      return;
    }
    const { hashes, missing, skipped } = computeAssetHashes(assets, { fs: nodeFs, root });
    if (missing.length > 0) {
      process.stderr.write(`deploy-checks: cannot write manifest, ${missing.length} asset(s) missing or unreadable: ${missing.join(", ")}\n`);
      process.exitCode = 1;
      return;
    }
    const manifest = writeManifest(manifestPath, buildManifest(hashes), { fs: nodeFs });
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "write", manifestPath, assetCount: manifest.assetCount, skipped })}\n`);
    return;
  }

  const result = runDeployChecks({
    root,
    assets,
    manifestPath,
    checkLockfile: !values["assets-only"],
    checkAssets: !values["lockfile-only"],
    fs: nodeFs,
  });
  process.stdout.write(`${JSON.stringify({ ok: result.ok, mode: "check", ...result })}\n`);
  if (!result.ok) {
    process.stderr.write("deploy-checks: FAILED\n");
    for (const line of failLines(result)) process.stderr.write(`${line}\n`);
    process.exitCode = 1;
  }
}

// Only run the CLI when executed directly (tests import the functions above).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
