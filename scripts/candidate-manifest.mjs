// Frozen candidate manifest: pin runtime, assets, schema and package hashes so
// tests and deployment preparation refer to the same bytes. Deterministic: the
// same tree always produces the same manifest, so drift is a byte comparison.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicAssets } from "./runtime-package.mjs";

export const MANIFEST_PATH = "docs/CANDIDATE-MANIFEST.json";
const DEPLOYMENT_FILES = ["cloudflare/room.mjs", "cloudflare/storage.mjs", "cloudflare/bootstrap.mjs",
  "cloudflare/build-assets.mjs", "cloudflare/wrangler.jsonc", "cloudflare/package.json", "cloudflare/pnpm-lock.yaml"];
const PACKAGE_FILES = ["package.json", "package-lock.json"];

const sha256 = buffer => "sha256:" + createHash("sha256").update(buffer).digest("hex");
const read = (root, path) => readFileSync(join(root, path));

export function pinRuntime(root) {
  const pkg = JSON.parse(read(root, "package.json").toString());
  const node = pkg.engines?.node;
  if (typeof node !== "string" || !node.trim()) throw new Error("package.json must pin engines.node");
  const workflow = read(root, ".github/workflows/test.yml").toString();
  const ci = /node-version:\s*(\d+)/.exec(workflow)?.[1];
  if (!ci || !node.includes(ci)) throw new Error("CI node version must satisfy engines.node");
  return { node, ci };
}

export function pinSchema(root) {
  const fence = read(root, "server/writer-fence.mjs").toString();
  const version = Number(/export const STORE_SCHEMA_VERSION = (\d+);/.exec(fence)?.[1]);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("STORE_SCHEMA_VERSION not found");
  return version;
}

export function pinFiles(root, paths) {
  const pins = {};
  for (const path of [...paths].sort()) pins[path] = sha256(read(root, path));
  return pins;
}

export function buildCandidateManifest(root) {
  return {
    contractVersion: 1,
    runtime: pinRuntime(root),
    storeSchemaVersion: pinSchema(root),
    assets: pinFiles(root, publicAssets),
    deployment: pinFiles(root, DEPLOYMENT_FILES),
    packages: pinFiles(root, PACKAGE_FILES),
  };
}

const EXPECTED_KEYS = ["contractVersion", "runtime", "storeSchemaVersion", "assets", "deployment", "packages"];
export function manifestDrift(expected, actual) {
  const drift = [];
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return ["manifest is not an object"];
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify([...EXPECTED_KEYS].sort())) drift.push("manifest keys differ");
  if (actual.contractVersion !== 1) drift.push("contractVersion");
  if (actual.storeSchemaVersion !== expected.storeSchemaVersion) drift.push("storeSchemaVersion");
  if (JSON.stringify(actual.runtime) !== JSON.stringify(expected.runtime)) drift.push("runtime");
  for (const section of ["assets", "deployment", "packages"]) {
    const a = expected[section] ?? {}, b = actual[section] ?? {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (a[key] !== b[key]) drift.push(`${section}:${key}`);
  }
  return drift;
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isMain) {
  const root = process.cwd(), manifest = buildCandidateManifest(root);
  if (process.argv.includes("--write")) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`froze ${MANIFEST_PATH}: schema ${manifest.storeSchemaVersion}, ${Object.keys(manifest.assets).length} assets, ${Object.keys(manifest.deployment).length} deployment files`);
  } else console.log(JSON.stringify(manifest, null, 2));
}
