import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(join(process.env.HOME, "argv-log"), `defaults ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
if (args[0] === "read") process.exit(1);
// Test hook: a $HOME/defaults-fail-<key> marker file simulates a failed
// `defaults write` for that key so partial-apply paths can be exercised.
if (args[0] === "write" && existsSync(join(process.env.HOME, `defaults-fail-${args[2]}`))) process.exit(1);
process.exit(0);
