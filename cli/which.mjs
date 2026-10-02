import { existsSync } from "node:fs";
import { join } from "node:path";

export function commandOnPath(name, env = process.env) {
  const path = env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}
