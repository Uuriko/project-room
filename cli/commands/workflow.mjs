import { bearerHeader, loadSecret, mcpUrl } from "../auth.mjs";
import { loadConnection } from "../paths.mjs";
import { boundedJson } from "../room-response.mjs";
import { validId } from "../../src/events.js";

const actions = Object.freeze({
  begin: "room_begin_work",
  resolve: "room_resolve_blocker",
  review: "room_record_verification",
  respond: "room_respond_to_request"
});
const actionHelp = "room act begin|resolve|review|respond < action.json\nUse the selected read's arguments and supply its required inputs. Writes run only when you call this command.";
const workHelp = "room work WORK_ID [--result]\nRead the compact task brief. Add --result to inspect exact evidence for review.";
const requestHelp = "room request REQUEST_ID [--cursor TOKEN]\nRead the selected request and follow its next page before responding.";
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hasRevision = value => Number.isSafeInteger(value) && value >= 0;
const validCursor = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,4096}$/.test(value);

async function readArguments(stdin) {
  if (stdin.isTTY) throw new Error("Pipe the action JSON.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 256 * 1024) throw new Error("Action too large.");
    chunks.push(buffer);
  }
  const args = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (!isRecord(args)) throw new Error("Invalid action JSON.");
  return args;
}

function validBasis(action, args) {
  if (action === "respond") return validId(args.responseToRequestId) && validId(args.requestId)
    && hasRevision(args.expectedRequestRevision) && validId(args.contextEventId)
    && hasRevision(args.contextSequence) && args.contextSequence > 0
    && validId(args.toMemberId) && (args.workItemId === null || validId(args.workItemId));
  if (!validId(args.workItemId)) return false;
  if (action === "begin") return true;
  if (!hasRevision(args.expectedRevision) || !validId(args.requestId)) return false;
  return action === "resolve" || (validId(args.completionEventId) && typeof args.evidenceVersion === "string");
}

async function exchange(tool, args, config, secret, fetchImpl) {
  const id = "room-workflow";
  const response = await fetchImpl(mcpUrl(config.origin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: bearerHeader(secret) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: tool, arguments: { ...args, roomId: config.roomId } } })
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 400 && response.status < 500 && response.status !== 408)
      return { refused: `http_${response.status}` };
    throw new Error("Room unavailable");
  }
  const rpc = await boundedJson(response, 512 * 1024);
  if (rpc?.jsonrpc !== "2.0" || rpc.id !== id) throw new Error("Invalid Room response");
  const value = rpc.result?.structuredContent;
  if (rpc.error || rpc.result?.isError) {
    if (value?.status === "unconfirmed" || value?.status >= 500 || value?.stopped === "unknown") {
      return { unknown: true, value: value?.stopped === "unknown" ? value : undefined };
    }
    const code = value?.reason ?? value?.code ?? rpc.error?.data?.reason;
    return { refused: typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "room_refused" };
  }
  if (!isRecord(value)) throw new Error("Invalid Room result");
  return { value };
}

async function runWorkflow(tool, args, validate, { cwd = process.cwd(), env = process.env,
  fetchImpl = fetch, out = console.log } = {}, action) {
  const write = action !== undefined;
  const report = ({ value, ...status }, code) => {
    out(JSON.stringify(value ?? status));
    return code;
  };
  let connection;
  try { connection = loadConnection({ project: cwd, env }); }
  catch { return report({ status: "refused", code: "saved_connection_required" }, 1); }
  const { config, name } = connection;
  if (args.roomId !== undefined && args.roomId !== config.roomId)
    return report({ status: "refused", code: "room_selection_mismatch" }, 1);
  let secret;
  try { secret = await loadSecret(name, config.token, env); }
  catch { return report({ status: "refused", code: "saved_connection_required" }, 1); }
  try {
    const reply = await exchange(tool, args, config, secret, fetchImpl);
    if (reply.refused) return report({ status: "refused", code: reply.refused }, 1);
    const value = reply.value;
    const serialized = value && JSON.stringify(value);
    if (serialized && (serialized.includes(secret) || serialized.includes(config.token)))
      throw new Error("Unexpected credential content");
    if (reply.unknown) return report({ status: "unknown", ...(value ? { begin: value } : {}) }, 1);
    if (!validate(value, config)) throw new Error("Unmatched Room result");
    if (tool === "room_read_work") {
      const step = value.continuation;
      const shortcut = Object.keys(actions).find(name => actions[name] === step.tool);
      if (shortcut && step.arguments?.workItemId === args.workItemId
          && (step.arguments.roomId === undefined || step.arguments.roomId === config.roomId)) step.command = ["room", "act", shortcut];
      else if (step.tool === "room_read_work" && step.arguments?.workItemId === args.workItemId
          && step.arguments.includeResult === true)
        step.command = ["room", "work", args.workItemId, "--result"];
    }
    if (tool === "room_read_request") {
      delete value.responseHttpActions;
      const cursor = value.nextRead?.arguments?.cursor ?? value.page?.nextCursor;
      if (validCursor(cursor)) value.nextCommand = ["room", "request", args.requestMessageId, "--cursor", cursor];
      for (const response of value.responseActions ?? []) {
        if (response.tool === actions.respond) response.command = ["room", "act", "respond"];
      }
    }
    return report({ value }, action === "begin" && !value.working ? 1 : 0);
  } catch {
    return report(write ? { status: "unknown", code: action === "begin" ? "read_current_work" : "retry_exact_action" }
      : { status: "unavailable", code: "room_read_unavailable" }, 1);
  }
}

export async function workCommand(argv, io = {}) {
  if (argv.length === 1 && argv[0] === "--help") { (io.out ?? console.log)(workHelp); return 0; }
  const [workItemId, flag] = argv;
  if (!validId(workItemId) || argv.length > 2 || flag !== undefined && flag !== "--result") throw new Error(workHelp);
  const includeResult = flag === "--result";
  return runWorkflow("room_read_work", { workItemId, brief: true, includeResult }, (value, { roomId }) =>
    value.roomId === roomId && value.workItemId === workItemId && hasRevision(value.revision)
    && typeof value.brief === "string" && isRecord(value.continuation)
    && (!includeResult || value.review?.workRevision === value.revision), io);
}

export async function requestCommand(argv, io = {}) {
  if (argv.length === 1 && argv[0] === "--help") { (io.out ?? console.log)(requestHelp); return 0; }
  const [requestMessageId, flag, cursor] = argv;
  if (!validId(requestMessageId) || !(argv.length === 1 || argv.length === 3 && flag === "--cursor" && validCursor(cursor)))
    throw new Error(requestHelp);
  return runWorkflow("room_read_request", { requestMessageId, ...(cursor ? { cursor } : {}) },
    (value, { roomId, memberId }) => value.roomId === roomId && value.viewerId === memberId
      && value.request?.id === requestMessageId, io);
}

export async function actCommand(argv, io = {}) {
  if (argv.length === 1 && argv[0] === "--help") { (io.out ?? console.log)(actionHelp); return 0; }
  const [action] = argv;
  if (argv.length !== 1 || !Object.hasOwn(actions, action)) throw new Error(actionHelp);
  let args;
  try {
    args = await readArguments(io.stdin ?? process.stdin);
    if (!validBasis(action, args)) throw new Error("Missing action basis.");
  } catch {
    (io.out ?? console.log)(JSON.stringify({ status: "refused", code: "invalid_action_basis" }));
    return 1;
  }
  return runWorkflow(actions[action], args, value => action === "begin"
    ? typeof value.working === "boolean" && Array.isArray(value.confirmed) && value.invented === false
    : value.status === "recorded" && value.requestId === args.requestId && validId(value.eventId)
      && (action === "respond" ? value.requestMessageId === args.responseToRequestId : value.workItemId === args.workItemId), io, action);
}
