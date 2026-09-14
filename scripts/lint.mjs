// CI gate: run ESLint (eslint.config.mjs) over the repo. Any error fails the
// run; warnings are printed and allowed. `npm run lint` is the same command.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const eslint = join(root, "node_modules", "eslint", "bin", "eslint.js");
const result = spawnSync(process.execPath, [eslint, ".", ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
