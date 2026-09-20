import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";
import { configuredHost } from "../client/host-process.mjs";
import { openRequestJournal, runRequestOnce } from "../client/request-runner.mjs";
import { validId } from "../src/events.js";

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: node scripts/run-room-request.mjs REQUEST_ID /absolute/private-journal.sqlite /absolute/host.json\nUses ROOM_AGENT_CONFIG or the existing Room connection environment. Host JSON: command (absolute), args (array), cwd (absolute), timeoutMs, optional env. Host reads prepared JSON on stdin and returns {body} on stdout. Retries reuse the journal; uncertain execution requires reconciliation.");
    return;
  }
  const [requestMessageId, journal, hostFile] = argv;
  if (argv.length !== 3 || !validId(requestMessageId) || !isAbsolute(journal ?? "") || !isAbsolute(hostFile ?? "")) throw new Error("Invalid runner arguments; use --help");
  const execute = configuredHost(JSON.parse(readFileSync(hostFile, "utf8")));
  const connection = agentConnectionFromEnvironment();
  const db = openRequestJournal(journal), controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    console.log(JSON.stringify(await runRequestOnce({ connection, requestMessageId, db, execute, signal: controller.signal })));
  } finally { db.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Request run failed. Inspect configuration and the original host attempt; retain the private journal. No successful execution or delivery is claimed."); process.exitCode = 1; });
}
