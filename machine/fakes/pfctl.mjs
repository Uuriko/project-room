import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(join(process.env.HOME, "argv-log"), `pfctl ${args.map(arg => JSON.stringify(arg)).join(" ")}\n`);
process.exit(0);
