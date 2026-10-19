// Cheap project gates before expensive local tests. Does not qualify a release.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { verifyRuntimeSource } from "./runtime-package.mjs";
import { buildCandidateManifest, manifestDrift, MANIFEST_PATH } from "./candidate-manifest.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const started = performance.now();
if (Number(process.versions.node.split(".")[0]) !== 24)
  console.warn(`qualification: Node ${process.versions.node}; CI qualifies Node 24. Use Node 24 for comparable results. package.json may permit other versions.`);
for (const script of ["check-deps.mjs", "untested-modules-lint.mjs"]) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
try {
  const result = verifyRuntimeSource(root);
  const drift = manifestDrift(buildCandidateManifest(root), JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")));
  if (drift.length) throw new Error(`Candidate manifest drift: ${drift.join(", ")}. Run node scripts/candidate-manifest.mjs --write and inspect the diff.`);
  console.log(`preflight: ${result.files} runtime source files checked in ${Math.round(performance.now() - started)}ms; cold-package tests and full qualification still required`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
