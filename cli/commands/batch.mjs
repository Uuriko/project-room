import { readFile } from "node:fs/promises";
import { agentConnectionFromEnvironment } from "../../client/agent-connection.mjs";
import { RoomAgentClient } from "../../client/room-agent.mjs";
import { runAgentBatch, validateBatch } from "../../client/agent-batch.mjs";
import { loadConnection } from "../paths.mjs";
import { loadSecret } from "../auth.mjs";

const help = `room batch --file <commands.json> [--concurrency 1..8]
Submit independent commands in one invocation. Input is a JSON array of
{id,type,data}; IDs must be unique and saved before submission.
Uses the saved room login connection or ROOM_AGENT_CONFIG/environment.
Prints compact per-command receipts. Not atomic; unknown outcomes need
reconciliation with the original IDs and payloads. No automatic retry.`;

export async function batchCommand(argv, io = {}) {
  const out = io.out ?? console.log;
  if (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0])) { out(help); return 0; }
  let file, concurrency = 4;
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!["--file", "--concurrency"].includes(flag) || seen.has(flag) || !value || value.startsWith("--"))
      throw new Error(help);
    seen.add(flag);
    if (flag === "--file") file = value;
    else concurrency = Number(value);
  }
  if (!file) throw new Error(help);
  const raw = await (io.readFile ?? readFile)(file, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Batch input exceeds 1 MiB");
  let commands;
  try { commands = JSON.parse(raw); } catch { throw new Error("Batch file must contain a JSON array"); }
  validateBatch(commands, concurrency); // Reject malformed envelopes before any write.
  const env = io.env ?? process.env;
  let client = io.client;
  if (!client) {
    let config;
    if (Object.keys(env).some(key => key.startsWith("ROOM_AGENT_"))) config = agentConnectionFromEnvironment(env);
    else {
      const saved = loadConnection({ project: io.cwd ?? process.cwd(), env });
      config = { ...saved.config, token: await loadSecret(saved.name, saved.config.token, env) };
    }
    client = new RoomAgentClient(config);
  }
  const report = await runAgentBatch(client, commands, { concurrency, signal: io.signal ?? AbortSignal.timeout(60000) });
  // No response bodies or arbitrary error messages in the default CLI output.
  out(JSON.stringify({ counts: report.counts, results: report.results.map(({ result, ...receipt }) => ({ ...receipt,
    ...(Number.isSafeInteger(result?.sequence) ? { sequence: result.sequence } : {}),
    ...(typeof result?.duplicate === "boolean" ? { duplicate: result.duplicate } : {}) })) }));
  return report.counts.accepted === commands.length ? 0 : 1;
}
