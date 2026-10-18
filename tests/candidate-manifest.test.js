import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { manifestDrift } from "../scripts/candidate-manifest.mjs";

const SCHEMA = "export const STORE_SCHEMA_VERSION = 27;\n";
const PKG = JSON.stringify({ name: "fake", engines: { node: ">=24.19.0" } });
const WORKFLOW = "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: 24\n";

function fakeRoot(t, overrides = {}) {
  const root = join(tmpdir(), `candidate-manifest-${crypto.randomUUID()}`);
  const files = {
    "package.json": PKG, "package-lock.json": "{\"lockfileVersion\":3}",
    ".github/workflows/test.yml": WORKFLOW, "server/writer-fence.mjs": SCHEMA,
    "cloudflare/room.mjs": "// room", "cloudflare/storage.mjs": "// storage",
    "cloudflare/bootstrap.mjs": "// boot", "cloudflare/build-assets.mjs": "// build",
    "cloudflare/wrangler.jsonc": "{}", "cloudflare/package.json": "{}", "cloudflare/pnpm-lock.yaml": "lock",
    ...overrides,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// publicAssets is imported from the real tree; the fake root cannot satisfy it.
// Exercise the pure machinery through its injectable parts instead.
import { pinRuntime, pinSchema, pinFiles } from "../scripts/candidate-manifest.mjs";

test("runtime and schema pins are exact and deterministic", t => {
  const root = fakeRoot(t);
  assert.deepEqual(pinRuntime(root), { node: ">=24.19.0", ci: "24" });
  assert.equal(pinSchema(root), 27);
  assert.deepEqual(pinRuntime(root), pinRuntime(root));
});

test("file pins change when bytes change and are sorted", t => {
  const root = fakeRoot(t);
  const before = pinFiles(root, ["package.json", "package-lock.json"]);
  assert.deepEqual(Object.keys(before), ["package-lock.json", "package.json"]);
  assert.match(before["package.json"], /^sha256:[0-9a-f]{64}$/);
  writeFileSync(join(root, "package.json"), PKG + " ");
  assert.notEqual(pinFiles(root, ["package.json"])["package.json"], before["package.json"]);
});

test("CI runtime must satisfy engines.node", t => {
  const root = fakeRoot(t, { ".github/workflows/test.yml": WORKFLOW.replace("24", "22") });
  assert.throws(() => pinRuntime(root), /CI node version/);
});

test("schema pin refuses a missing version marker", t => {
  const root = fakeRoot(t, { "server/writer-fence.mjs": "// nothing here" });
  assert.throws(() => pinSchema(root), /STORE_SCHEMA_VERSION/);
});

test("drift names the changed file, added file and removed file", t => {
  const root = fakeRoot(t);
  const expected = { contractVersion: 1, runtime: pinRuntime(root), storeSchemaVersion: 27,
    assets: pinFiles(root, ["package.json"]), deployment: pinFiles(root, ["cloudflare/room.mjs"]),
    packages: pinFiles(root, ["package-lock.json"]) };
  const actual = JSON.parse(JSON.stringify(expected));
  assert.deepEqual(manifestDrift(expected, actual), []);
  actual.assets["package.json"] = "sha256:" + "0".repeat(64);
  actual.deployment["cloudflare/extra.mjs"] = "sha256:" + "1".repeat(64);
  delete actual.packages["package-lock.json"];
  const drift = manifestDrift(expected, actual);
  assert.ok(drift.includes("assets:package.json"));
  assert.ok(drift.includes("deployment:cloudflare/extra.mjs"));
  assert.ok(drift.includes("packages:package-lock.json"));
});

test("drift refuses malformed manifests without reading sections", () => {
  assert.deepEqual(manifestDrift({}, null), ["manifest is not an object"]);
  assert.ok(manifestDrift({}, { contractVersion: 2, runtime: {}, storeSchemaVersion: 1, assets: {}, deployment: {}, packages: {} }).includes("contractVersion"));
});

test("generated deployment manifest pins the recovery helper and production workflow bytes", async () => {
  const { buildCandidateManifest } = await import("../scripts/candidate-manifest.mjs");
  const root = new URL("..", import.meta.url).pathname;
  const manifest = buildCandidateManifest(root);
  const files = ["scripts/deploy-recovery.mjs", ".github/workflows/deploy-prod.yml"];
  const actual = pinFiles(root, files);
  for (const file of files) assert.equal(manifest.deployment[file], actual[file], file);
});

test("candidate manifest generation is deterministic: same tree, same bytes", async () => {
  // CH-1: the manifest is generated at CI/freeze time, never committed — the
  // committed copy's only consumer was the old drift test, and every pin
  // change made it a merge-up serialization point. What must hold instead is
  // determinism: building twice from the same tree yields byte-identical
  // output, so a manifest generated anywhere (CI artifact, freeze checkout)
  // pins exactly the same candidate. Bug sweep lane 14 F3 (#3902) coverage is
  // preserved differently: the generated manifest is built from the real tree
  // here, so stale or missing pins fail as build errors, not silent drift.
  const { buildCandidateManifest } = await import("../scripts/candidate-manifest.mjs");
  const root = new URL("..", import.meta.url).pathname;
  const first = buildCandidateManifest(root);
  const second = buildCandidateManifest(root);
  assert.deepEqual(manifestDrift(first, second), []);
  assert.equal(JSON.stringify(first, null, 2) + "\n", JSON.stringify(second, null, 2) + "\n");
});

test("no committed candidate manifest: the file is generated, not versioned", () => {
  // Guards the CH-1 invariant directly. If this fails because a freeze run
  // wrote the file locally, delete it — do not commit it. (.gitignore also
  // covers the path; this test catches a force-add.)
  assert.equal(existsSync(new URL("../scripts/CANDIDATE-MANIFEST.json", import.meta.url)), false,
    "scripts/CANDIDATE-MANIFEST.json must not be committed; generate it with node scripts/candidate-manifest.mjs --write");
});
