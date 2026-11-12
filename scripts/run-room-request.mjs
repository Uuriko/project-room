import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";
import { hostExecutionReadiness } from "../client/host-subprocess.mjs";
import { configuredHost } from "../client/host-process.mjs";
import { openRequestJournal, runRequestOnce, runRequestQueue } from "../client/request-runner.mjs";
import { createLocalVerificationHost } from "../client/local-verification-host.mjs";
import { validId } from "../src/events.js";

function executionHost(config) {
  if (config.kind === "local-verification") {
    if (Object.keys(config).some(key => !["kind","binding","verification"].includes(key))) throw Error("Invalid local recipe configuration");
    return createLocalVerificationHost(config);
  }
  return configuredHost(config);
}
function prepareHost(config) {
  if (config.kind === "local-verification") {
    try {
      const execute = executionHost(config), ready = process.platform !== "win32";
      return {execute, readiness:{version:1,backend:"local-verification",platform:process.platform,ready,
        code:ready ? "configured" : "process_group_cancellation_not_supported",
        message:"One authorized local affected-unit recipe; no sandbox or automatic queue enrollment."}};
    } catch { return {readiness:{version:1,backend:"local-verification",platform:process.platform,ready:false,
      code:"configuration_invalid",message:"Local recipe or pinned request configuration is invalid."}}; }
  }
  const readiness = hostExecutionReadiness(config);
  if (!readiness.ready) return { readiness };
  try { return { readiness, execute: configuredHost(config) }; }
  catch { return { readiness: { version: 1, backend: readiness.backend, platform: readiness.platform,
    ready: false, code: "configuration_invalid", message: "Host policy or verification configuration is invalid." } }; }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: node scripts/run-room-request.mjs --check /absolute/host.json\n       node scripts/run-room-request.mjs REQUEST_ID|--auto /absolute/private-journal.sqlite /absolute/host.json\nUses ROOM_AGENT_CONFIG or the existing Room connection environment. Host JSON: command (absolute), args (array), cwd (absolute), timeoutMs, required fixed policy, optional verification (no env). Host reads a typed untrusted context envelope on stdin and returns {body, codeResult?} on stdout. Optional verification runs operator-configured checks against a matching coding result. --auto explicitly enables sequential pickup of addressed reply requests until stopped. For a local deterministic recipe, host JSON is {kind:\"local-verification\", binding:{origin,roomId,memberId,requestMessageId,requestRevision}, verification:{checkout,expectedHead,baseSha,recipe:\"affected-unit\",timeoutMs?}}. It uses one explicit REQUEST_ID; --auto is not supported for this pinned recipe. The room stream wakes idle pickup; bounded polling recovers unavailable streams. Ordinary chat never starts a host. Retries reuse the journal; uncertain execution requires reconciliation.");
    return;
  }
  if (argv[0] === "--check" && argv.length === 2 && isAbsolute(argv[1])) {
    const config = JSON.parse(readFileSync(argv[1], "utf8"));
    const { readiness } = prepareHost(config);
    console.log(JSON.stringify(readiness));
    if (!readiness.ready) process.exitCode = 1;
    return;
  }
  const [requestMessageId, journal, hostFile] = argv;
  if (argv.length !== 3 || (requestMessageId !== "--auto" && !validId(requestMessageId)) || !isAbsolute(journal ?? "") || !isAbsolute(hostFile ?? "")) throw new Error("Invalid runner arguments; use --help");
  const config = JSON.parse(readFileSync(hostFile, "utf8"));
  // Readiness belongs before a new attempt, not before saved-result recovery.
  if (config.kind === "local-verification" && (requestMessageId === "--auto" || requestMessageId !== config.binding?.requestMessageId))
    throw Error("Local verification requires its single pinned request");
  const execute = executionHost(config);
  const connection = agentConnectionFromEnvironment();
  const db = openRequestJournal(journal), controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (requestMessageId === "--auto") await runRequestQueue({ connection, db, execute, signal: controller.signal,
      emit: result => console.log(JSON.stringify(result)) });
    else console.log(JSON.stringify(await runRequestOnce({ connection, requestMessageId, db, execute, signal: controller.signal })));
  } finally { db.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { if (error.readiness) { console.error(JSON.stringify(error.readiness)); process.exitCode = 1; return; } console.error("Request run failed. Inspect configuration and the original host attempt; retain the private journal. No successful execution or delivery is claimed."); process.exitCode = 1; });
}
