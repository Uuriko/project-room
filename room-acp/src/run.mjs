// `room-acp run`: load the saved connection, pick the agent, run the bridge.
import { candidates, probe } from "./agents.mjs";
import { loadConnection } from "./credentials.mjs";
import { Bridge } from "./bridge.mjs";
import { logger } from "./redact.mjs";

export async function run(options, { print, env = process.env, fetchImpl = fetch, onBridge = null } = {}) {
  const connection = loadConnection({ roomId: options.room }, env);
  if (!connection) { print("Not joined. Run: room-acp <invite link>"); return 1; }
  const list = candidates({ agent: options.agent ?? connection.agent, agentCmd: options.agentCmd, env });
  let candidate = null;
  for (const entry of list) { if ((await probe(entry, { env, timeoutMs: entry.command === "npx" ? 120000 : 10000 })).ok) { candidate = entry; break; } }
  if (!candidate) { print("No working ACP agent found. Run `room-acp doctor`, or pass --agent / --agent-cmd."); return 1; }
  const log = logger(line => print(line));
  const bridge = new Bridge({ connection, candidate, cwd: options.cwd ?? process.cwd(), env, mode: options.mode, respondTo: options.respondTo, maxSessions: options.maxSessions, fetchImpl, log });
  onBridge?.(bridge);
  const stop = () => bridge.stop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  print(`room-acp: ${candidate.label} is listening in room ${connection.roomId} as ${connection.displayName}. Mention it in the Room. Ctrl-C to stop.`);
  try { const reason = await bridge.run(); return reason === "access_ended" ? 3 : 0; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
