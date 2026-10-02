import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(join(process.env.HOME, "argv-log"), `defaults ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
if (args[0] === "read") process.exit(1);
process.exit(0);
