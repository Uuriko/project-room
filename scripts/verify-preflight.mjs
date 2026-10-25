// Cheap project gates before expensive local tests. Does not qualify a release.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyRuntimeSource } from "./runtime-package.mjs";
import { verifyGeneratedManifest } from "./candidate-manifest.mjs";

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
  const { manifest, drift } = verifyGeneratedManifest(root);
  if (drift.length) throw new Error(`Candidate manifest does not match its sources: ${drift.join(", ")}`);
  console.log(`preflight: ${result.files} runtime source files checked in ${Math.round(performance.now() - started)}ms; candidate manifest regenerated from sources (${Object.keys(manifest.assets).length} assets); cold-package tests and full qualification still required`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
