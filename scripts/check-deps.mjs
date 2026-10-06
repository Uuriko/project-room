// Fail fast when node_modules is stale relative to package.json.
//
// Root cause it guards: a dependency (e.g. the `yaml` devDependency added in
// PR #1351) can be missing from a developer's node_modules when the install
// predates the commit that declared it. Tests then die with a bare
// ERR_MODULE_NOT_FOUND deep in an import statement instead of telling you to
// re-install. A clean `npm ci` always fixes it; this check just says so up
// front, before the test runner starts.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));

const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);
for (const name of Object.keys(pkg.optionalDependencies ?? {})) declared.delete(name);

const missing = [...declared].filter((name) => !existsSync(join(root, "..", "node_modules", name)));

if (missing.length > 0) {
  console.error(
    `check-deps: ${missing.length} declared dependenc${missing.length === 1 ? "y is" : "ies are"} missing from node_modules: ${missing.join(", ")}`
  );
  console.error("check-deps: your install is stale — run `npm install` (or `npm ci`) and try again.");
  process.exit(1);
}
console.log(`check-deps: ok (${declared.size} declared dependencies present)`);
