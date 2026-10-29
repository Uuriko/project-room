#!/usr/bin/env node
import { validId } from "../src/events.js";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { openRequestJournal } from "../client/request-runner.mjs";
import { openCodexStdio, validateCodexRuntimeConfig, checkCodexProtocol, checkCodexCredentials } from "../client/codex-stdio.mjs";
import { createCodexStatusWriter, readCodexHostStatus, stopCodexHost } from "../client/codex-host-status.mjs";
import { superviseCodexRoom, scopedCodexThreads } from "../client/codex-supervisor.mjs";
import { runCodexSharedAssistant } from "../client/codex-shared-assistant.mjs";
import { superviseCodexRequests } from "../client/codex-request-supervisor.mjs";

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--help") {
    console.log(`Usage:
  ROOM_AGENT_CONFIG="/path/room" node scripts/run-codex-room.mjs --list
  node scripts/run-codex-room.mjs --check /absolute/runtime.json
  node scripts/run-codex-room.mjs --preflight /absolute/runtime.json
  node scripts/run-codex-room.mjs --status-watch /absolute/journal.sqlite
  node scripts/run-codex-room.mjs --stop-watch /absolute/journal.sqlite
  ROOM_AGENT_CONFIG="/path/room" node scripts/run-codex-room.mjs --watch /absolute/journal.sqlite /absolute/runtime.json
  ROOM_AGENT_CONFIG="/path/room" node scripts/run-codex-room.mjs --watch-requests /absolute/journal.sqlite /absolute/runtime.json MEMBER_ID[,MEMBER_ID...] [REQUEST_ID[,REQUEST_ID...]]
  ROOM_AGENT_CONFIG="/path/room" node scripts/run-codex-room.mjs RUN_ID /absolute/journal.sqlite /absolute/runtime.json

Runtime JSON requires command (absolute Codex executable), cwd (real workspace), codexHome (dedicated private directory outside workspace and operator Codex home), policy {approvalPolicy:"never",sandbox:"read-only"|"workspace-write"}; optional model, requestTimeoutMs, turnTimeoutMs.
Authenticate the dedicated Codex home explicitly using Codex login with CODEX_HOME set to that directory and cli_auth_credentials_store="file". No operator credentials or sessions are imported.
--check starts the isolated-home App Server protocol only; it performs no model turn and does not prove provider authentication.
Optional REQUEST_ID selection limits new execution; omitting it enables all eligible requests from enabled requesters. Saved replies retain their original operation for recovery, and disabling a requester still blocks delivery.
Normal invocation executes one already-created public Room assistant run assigned to this member. --watch-requests instead receives formal requests addressed to this member from the explicitly enabled requester member IDs over Room HTTPS; it does not use Tailscale or consume ordinary messages. Run only one mode per journal and dedicated Codex profile. Keep the private journal and Codex home for exact retries and reconciliation. Interactive approvals/questions are denied with an attention notice. No unsandboxed fallback is used.`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--list") {
    const connection = agentConnectionFromEnvironment();
    const { runs } = await new RoomAgentClient(connection).assistant();
    console.log(JSON.stringify(runs.filter(run => run.coordinatorMemberId === connection.memberId).map(run => ({ runId: run.id, status: run.status, sourceMessageId: run.sourceMessageId }))));
    return;
  }
  if (["--status-watch", "--stop-watch"].includes(argv[0])) {
    if (argv.length !== 2 || !isAbsolute(argv[1])) throw new Error("Absolute journal path required");
    console.log(JSON.stringify(argv[0] === "--stop-watch" ? stopCodexHost(argv[1]) : readCodexHostStatus(argv[1])));
    return;
  }
  const preflight = argv[0] === "--preflight";
  const requestWatch = argv[0] === "--watch-requests";
  const check = argv[0] === "--check" || preflight, watch = argv[0] === "--watch" || requestWatch;
  const [runId, journal, configPath] = check ? [null, null, argv[1]] : argv;
  if (argv.length !== (check ? 2 : requestWatch ? (argv.length === 5 ? 5 : 4) : 3) || !isAbsolute(configPath ?? "") || !check && (!runId || !isAbsolute(journal ?? "")))
    throw new Error("Invalid arguments; use --help");
  const allowedRequesterIds = requestWatch ? argv[3].split(",") : undefined;
  if (requestWatch && (allowedRequesterIds.length > 20 || new Set(allowedRequesterIds).size !== allowedRequesterIds.length
    || allowedRequesterIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))))
    throw new Error("Choose 1 to 20 distinct requester member IDs");
  const allowedRequestIds = requestWatch && argv.length === 5 ? argv[4].split(",") : undefined;
  if (allowedRequestIds && (allowedRequestIds.length > 20 || new Set(allowedRequestIds).size !== allowedRequestIds.length
    || !allowedRequestIds.every(validId))) throw new Error("Choose 1 to 20 distinct valid request IDs");
  const settings = validateCodexRuntimeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const connection = check ? null : agentConnectionFromEnvironment();
  // Native setup pins the visible room identity. Validate the connection that
  // this child actually loaded, closing the file-replacement race at launch.
  if (connection && process.env.ROOM_HOST_SCOPE !== undefined) {
    let expected;
    try { expected = JSON.parse(process.env.ROOM_HOST_SCOPE); } catch { /* refuse below */ }
    const fields = ["origin", "roomId", "memberId"];
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
      || Object.keys(expected).length !== fields.length
      || fields.some(field => typeof expected[field] !== "string" || !expected[field] || expected[field] !== connection[field]))
      throw new Error("Room connection changed; reconnect the agent in My Mac");
  }
  const db = check ? null : openRequestJournal(journal);
  const threads = db ? scopedCodexThreads(db, connection) : [];
  let rpc, statusWriter;
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (watch) {
      const emit = event => {
        statusWriter ??= createCodexStatusWriter(realpathSync(`${journal}.watch`), connection, { onError: () => controller.abort() });
        statusWriter.event(event); console.log(JSON.stringify(event));
      };
      const supervise = requestWatch ? superviseCodexRequests : superviseCodexRoom;
      await supervise({ connection, db, directory: `${journal}.watch`, cwd: settings.cwd, policy: settings.policy, allowedRequesterIds, allowedRequestIds,
        signal: controller.signal, timeoutMs: settings.turnTimeoutMs, connectOnStart: true, emit,
        connect: async allowedThreadIds => {
          const transport = openCodexStdio(settings, { allowedThreadIds, onAttention: event => console.error(JSON.stringify(event)) });
          try {
            await checkCodexProtocol(transport, settings, { threadId: allowedThreadIds[0] });
            const readiness = await checkCodexCredentials(transport);
            emit({ type: "host_readiness", ...readiness });
            if (readiness.credentials === "login_required") throw Object.assign(new Error("Dedicated Codex login required"), { code: "login_required" });
            return transport;
          }
          catch (error) { await transport.close(); throw error; }
        } });
      return;
    }
    rpc = openCodexStdio(settings, { allowedThreadIds: threads, onAttention: event => {
      console.error(JSON.stringify({ ...event, message: "Interactive request denied: this host has no connected approval/input UI." }));
    } });
    const qualified = await checkCodexProtocol(rpc, settings, { threadId: threads[0] });
    if (check) {
      console.log(JSON.stringify(preflight ? { ...qualified, protocol: "qualified", ...await checkCodexCredentials(rpc) } : qualified));
    } else {
      const result = await runCodexSharedAssistant({ connection, db, rpc, cwd: settings.cwd, policy: settings.policy,
        runId, signal: controller.signal, timeoutMs: settings.turnTimeoutMs,
        emit: event => console.log(JSON.stringify(event)) });
      console.log(JSON.stringify({ status: result.result.status, runId, resultMessageId: result.result.resultMessageId ?? null }));
    }
  } finally {
    statusWriter?.close();
    try { await rpc?.close(); } finally { db?.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
