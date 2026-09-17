// CI gate: run ESLint (eslint.config.mjs) over the repo. Any error fails the
// run; warnings are printed and allowed. `npm run lint` is the same command.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const eslint = join(root, "node_modules", "eslint", "bin", "eslint.js");
// `--skip-if-missing` (used by scripts/check.mjs) lets a checkout that never
// ran `npm ci` finish the rest of `npm run check` with a visible notice instead
// of failing; the dedicated CI lint job and `npm run lint` still enforce.
const args = process.argv.slice(2);
const skipIfMissing = args.includes("--skip-if-missing");
if (!existsSync(eslint)) {
  if (skipIfMissing) { console.warn("lint gate skipped: eslint is not installed (run `npm ci`); `npm run lint` and the CI lint job enforce it"); process.exit(0); }
  console.error("Lint gate: eslint is not installed. Run `npm ci` first.");
  process.exit(1);
}
const result = spawnSync(process.execPath, [eslint, ".", ...args.filter(a => a !== "--skip-if-missing")], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
