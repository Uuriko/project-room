// room presence: read a host hook payload (JSON) on stdin and print the derived presence
// as one JSON line. Agent-first and offline; prints nothing secret.
import { derivePresence, fromHookPayload } from "../../client/auto-presence.mjs";

async function readStdin(stdin) {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data;
}

export async function presenceCommand(argv, { stdin = process.stdin, out = console.log } = {}) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--title") { flags.title = argv[++i]; continue; }
    throw new Error("Use room presence [--title <session title>] < hook-payload.json");
  }
  const raw = (await readStdin(stdin)).trim();
  let payload = {};
  if (raw) { try { payload = JSON.parse(raw); } catch { throw new Error("room presence reads a JSON hook payload on stdin"); } }
  const { title, todos } = fromHookPayload(payload);
  out(JSON.stringify(derivePresence({ title: flags.title ?? title, todos })));
  return 0;
}
