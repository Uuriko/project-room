import { writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync(join(process.env.HOME, "sudo-called"), "yes\n");
process.exit(0);
