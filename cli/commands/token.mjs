import { loadConnection } from "../paths.mjs";
import { loadSecret } from "../auth.mjs";

export async function tokenCommand(argv, { env = process.env, cwd = process.cwd(), out = message => process.stdout.write(message) } = {}) {
  if (argv.length) throw new Error("Use room token with no arguments.");
  const loaded = loadConnection({ project: cwd, env });
  const secret = await loadSecret(loaded.name, loaded.config.token, env);
  out(secret + "\n");
  return 0;
}
