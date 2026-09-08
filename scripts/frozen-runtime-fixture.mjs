// Test-only fixture loader. Never mutates a frozen package or changes its manifest.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
export const v8ConnectionBaseline = "efa918be3478f88ff0120dad8727a9bb366c3d25";
export async function frozenRecoveryFixture(repository, packagePath, commit = v8ConnectionBaseline) {
  const source = execFileSync("git", ["show", `${commit}:scripts/recovery-fixture.mjs`], { cwd: repository, encoding: "utf8" })
    .replace(/from "\.\.\/([^"]+)"/g, (_, path) => `from ${JSON.stringify(pathToFileURL(join(packagePath, path)).href)}`);
  return (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).createRecoveryFixture;
}
