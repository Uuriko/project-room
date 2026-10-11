#!/usr/bin/env node
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

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--help") {
    console.log(`Usage:
  ROOM_AGENT_CONFIG="/path/room" node scripts/run-codex-room.mjs --list
  node scripts/run-codex-room.mjs --check /absolute/runtime.json
  node scripts/run-codex-room.mjs --preflight /absolute/runtime.json
  node scripts/run-codex-room.mjs --status-watch /absolute/journal.sqlite
  node scripts/run-codex-room.mjs --stop-watch /absolute/journal.sqlite
  ROOM_AGENT_CONFIG="/path/room" node scripts/run-codex-room.mjs --watch /absolute/journal.sqlite /absolute/runtime.json
  ROOM_AGENT_CONFIG="/path/room" node scripts/run-codex-room.mjs RUN_ID /absolute/journal.sqlite /absolute/runtime.json

Runtime JSON requires command (absolute Codex executable), cwd (real workspace), codexHome (dedicated private directory outside workspace and operator Codex home), policy {approvalPolicy:"never",sandbox:"read-only"|"workspace-write"}; optional model, requestTimeoutMs, turnTimeoutMs.
Authenticate the dedicated Codex home explicitly using Codex login with CODEX_HOME set to that directory and cli_auth_credentials_store="file". No operator credentials or sessions are imported.
--check starts the isolated-home App Server protocol only; it performs no model turn and does not prove provider authentication.
Normal invocation executes one already-created public Room assistant run assigned to this member. Keep the private journal and Codex home for exact retries and reconciliation. Interactive approvals/questions are denied with an attention notice. No unsandboxed fallback is used.`);
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
  const check = argv[0] === "--check" || preflight, watch = argv[0] === "--watch";
  const [runId, journal, configPath] = check ? [null, null, argv[1]] : argv;
  if (argv.length !== (check ? 2 : 3) || !isAbsolute(configPath ?? "") || !check && (!runId || !isAbsolute(journal ?? "")))
    throw new Error("Invalid arguments; use --help");
  const settings = validateCodexRuntimeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const connection = check ? null : agentConnectionFromEnvironment();
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
      await superviseCodexRoom({ connection, db, directory: `${journal}.watch`, cwd: settings.cwd, policy: settings.policy,
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
