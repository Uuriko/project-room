// Test-only fixture loader. Never mutates a frozen package or changes its manifest.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
export const v8ConnectionBaseline = "efa918be3478f88ff0120dad8727a9bb366c3d25";
export const v9TextBaseline = "06551bb9255aefd92e945df158f4db47066606da";
export const v10CharterBaseline = "b538ee8792abee6dfefc152fd9c90e73ba4d4bc5";
export async function frozenRecoveryFixture(repository, packagePath, commit = v8ConnectionBaseline) {
  const source = execFileSync("git", ["show", `${commit}:scripts/recovery-fixture.mjs`], { cwd: repository, encoding: "utf8" })
    .replace(/from "\.\.\/([^"]+)"/g, (_, path) => `from ${JSON.stringify(pathToFileURL(join(packagePath, path)).href)}`);
  return (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).createRecoveryFixture;
}
