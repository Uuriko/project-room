import { appendFileSync } from "node:fs";
import { join } from "node:path";

appendFileSync(join(process.env.HOME, "argv-log"), `screencapture ${process.argv.slice(2).join(" ")}\n`);
process.exit(1);
