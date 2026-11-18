import { parseArgs } from "node:util";
import { join } from "node:path";
import { openPrivateJournal, privateDirectory } from "../../client/setup-journal.mjs";
import { workflowTools as actions, isRecord, hasRevision, selectedBasis, readSelectedBasis,
  fileInput, readInput, operationFingerprint } from "../selected-basis.mjs";
import { bearerHeader, loadSecret, mcpUrl } from "../auth.mjs";
import { loadConnection } from "../paths.mjs";
import { boundedJson } from "../room-response.mjs";
import { validId } from "../../src/events.js";

const actionHelp = "room act begin|resolve|review|respond < action.json\nUse the selected read's arguments and supply its required inputs. Writes run only when you call this command.";
const workHelp = "room work WORK_ID [--result]\nRead the compact task brief. Add --result to inspect exact evidence for review.";
const requestHelp = "room request REQUEST_ID [--cursor TOKEN]\nRead the selected request and follow its next page before responding.";
const validCursor = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,4096}$/.test(value);

async function readArguments(stdin) {
  const args = JSON.parse(await readInput(stdin));
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
  fetchImpl = fetch, out = console.log } = {}, action, selectedConnection) {
  const write = action !== undefined;
  const report = ({ value, ...status }, code) => {
    out(JSON.stringify(value ?? status));
    return code;
  };
  let connection;
  try { connection = selectedConnection ?? loadConnection({ project: cwd, env }); }
  catch { return report({ status: "refused", code: "saved_connection_required" }, 1); }
  const { config, name } = connection;
  if (args.roomId !== undefined && args.roomId !== config.roomId)
    return report({ status: "refused", code: "room_selection_mismatch" }, 1);
  const next = action === "respond"
    ? { tool: "room_read_request", arguments: { roomId: config.roomId, requestMessageId: args.responseToRequestId } }
    : { tool: "room_read_work", arguments: { roomId: config.roomId, workItemId: args.workItemId, brief: true } };
  let secret;
  try { secret = await loadSecret(name, config.token, env); }
  catch { return report({ status: "refused", code: "saved_connection_required" }, 1); }
  try {
    const reply = await exchange(tool, args, config, secret, fetchImpl);
    if (reply.refused) return report({ status: "refused", code: reply.refused, ...(selectedConnection ? { contractVersion: 1, nextRead: next } : {}) }, 1);
    const value = reply.value;
    const serialized = value && JSON.stringify(value);
    if (serialized && (serialized.includes(secret) || serialized.includes(config.token)))
      throw new Error("Unexpected credential content");
    if (reply.unknown) return report({ status: "unknown", ...(value ? { begin: value } : {}),
      ...(selectedConnection ? { contractVersion: 1, nextRead: next, ...(args.requestId ? { requestId: args.requestId } : {}) } : {}) }, 1);
    if (!validate(value, config)) throw new Error("Unmatched Room result");
    if (tool === "room_read_work" || tool === "room_read_request") {
      const basis = selectedBasis(value, config);
      if (basis) {
        value.cliBasis = basis;
        if (basis.actions.submit) value.submitCommand = ["room", "submit", "--from"];
      }
    }
    if (tool === "room_read_work") {
      const step = value.continuation;
      const shortcut = Object.keys(actions).find(name => actions[name] === step.tool);
      if (value.cliBasis?.actions[shortcut]) step.command = ["room", shortcut, "--from"];
      else if (step.tool === "room_read_work" && step.arguments?.workItemId === args.workItemId
          && step.arguments.includeResult === true)
        step.command = ["room", "work", args.workItemId, "--result"];
    }
    if (tool === "room_read_request") {
      delete value.responseHttpActions;
      const cursor = value.nextRead?.arguments?.cursor ?? value.page?.nextCursor;
      if (validCursor(cursor)) value.nextCommand = ["room", "request", args.requestMessageId, "--cursor", cursor];
      for (const response of value.responseActions ?? []) {
        if (response.tool === actions.respond && value.cliBasis?.actions.respond) response.command = ["room", "respond", "--from"];
      }
    }
    if (selectedConnection && action === "begin") {
      const status = value.working ? "recorded" : value.stopped === "waiting_on_prerequisites" ? "waiting" : "refused";
      return report({ value: { contractVersion: 1, status, ...value, ...(value.working ? {} : { nextRead: next }) } },
        value.working ? 0 : 1);
    }
    return report({ value }, action === "begin" && !value.working ? 1 : 0);
  } catch {
    return report(write ? { status: "unknown", code: action === "begin" ? "read_current_work" : "retry_exact_action",
      ...(selectedConnection ? { contractVersion: 1, nextRead: next,
        ...(args.requestId ? { requestId: args.requestId } : {}) } : {}) }
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
  return runWorkflow(actions[action], args, value => confirmsAction(action, args, value), io, action);
}

function confirmsAction(action, args, value) {
  if (action === "begin") return typeof value.working === "boolean" && Array.isArray(value.confirmed) && value.invented === false;
  return value.status === "recorded" && value.requestId === args.requestId && validId(value.eventId)
    && (action === "respond" ? value.requestMessageId === args.responseToRequestId : value.workItemId === args.workItemId)
    && (action !== "review" || value.currentStateVerified === false);
}

const string = { type: "string" };
const boolean = { type: "boolean" };
const namedOptions = {
  begin: { repository: string, ref: string, path: { type: "string", multiple: true }, "expires-at": string, resume: string },
  resolve: { resolution: string },
  review: { pass: boolean, fail: boolean, summary: string },
  respond: { answer: boolean, decline: boolean, "body-file": string }
};
const namedHelp = {
  begin: "room begin --from FILE [--repository REPO --ref REF --path PATH --expires-at TIME] [--resume STAGE_ID]",
  resolve: "room resolve --from FILE --resolution TEXT",
  review: "room review --from FILE --pass|--fail --summary TEXT",
  respond: "room respond --from FILE --answer|--decline --body-file FILE"
};

async function suppliedInput(action, flags, io) {
  const text = value => {
    if (typeof value !== "string" || !value.trim() || !value.isWellFormed() || value.length > 4096)
      throw new Error("Invalid action text.");
    return value;
  };
  if (action === "resolve") return { resolution: text(flags.resolution) };
  if (action === "review") {
    if (Boolean(flags.pass) === Boolean(flags.fail)) throw new Error("Choose a verdict.");
    return { result: flags.pass ? "pass" : "fail", summary: text(flags.summary) };
  }
  if (action === "respond") {
    if (Boolean(flags.answer) === Boolean(flags.decline) || !flags["body-file"]
        || flags.from === "-" && flags["body-file"] === "-") throw new Error("Choose an outcome and a body file.");
    const body = await readInput(fileInput(flags["body-file"], io), 32 * 1024);
    return { responseOutcome: flags.answer ? "answered" : "declined", body: text(body) };
  }
  const input = {};
  const scope = [["repository", "repository"], ["ref", "ref"], ["path", "paths"], ["expires-at", "expiresAt"]];
  if (scope.some(([flag]) => flags[flag] !== undefined)) {
    if (scope.some(([flag]) => flags[flag] === undefined)) throw new Error("Supply the full write scope.");
    for (const [flag, key] of scope) input[key] = flags[flag];
  }
  if (flags.resume !== undefined) {
    if (!validId(flags.resume)) throw new Error("Invalid stage ID.");
    input.invocationRequestId = flags.resume;
  }
  return input;
}

export function namedCommand(action) {
  return async (argv, io = {}) => {
    const out = io.out ?? console.log;
    if (argv.length === 1 && argv[0] === "--help") {
      out(namedHelp[action] + (action === "begin" ? "" : " [--operation ID]"));
      return 0;
    }
    const refuse = code => { out(JSON.stringify({ contractVersion: 1, status: "refused", code })); return 1; };
    let flags, connection, fixed, input;
    try {
      const { values, tokens } = parseArgs({ args: argv, tokens: true, options: { from: string,
        ...(action === "begin" ? {} : { operation: string }), ...namedOptions[action] } });
      const names = tokens.filter(token => token.kind === "option" && token.name !== "path").map(token => token.name);
      if (!values.from || new Set(names).size !== names.length
          || values.operation !== undefined && !validId(values.operation)) return refuse("invalid_action_input");
      flags = values;
    } catch { return refuse("invalid_action_input"); }
    try { connection = loadConnection({ project: io.cwd ?? process.cwd(), env: io.env ?? process.env }); }
    catch { return refuse("saved_connection_required"); }
    const { config, configDirectory } = connection;
    try { fixed = await readSelectedBasis(flags.from, action, config, io); }
    catch { return refuse("invalid_action_basis"); }
    try { input = await suppliedInput(action, flags, io); }
    catch { return refuse("invalid_action_input"); }
    const args = { ...fixed, ...input };
    const fingerprint = operationFingerprint([config.origin, config.roomId, config.memberId, action, args]);
    if (action !== "begin") args.requestId = flags.operation ?? `room-${fingerprint}`;
    let journal;
    try {
      if (flags.operation) {
        const directory = privateDirectory(join(configDirectory, "named-action-operations"));
        const key = operationFingerprint([config.origin, config.roomId, config.memberId, flags.operation]);
        journal = openPrivateJournal(join(directory, key), "action.json", "Another command owns this operation");
        const saved = journal.read();
        if (saved && saved.fingerprint !== fingerprint) return refuse("operation_input_changed");
        if (!saved) journal.save({ fingerprint });
      }
      return await runWorkflow(actions[action], args, value => confirmsAction(action, args, value), io, action, connection);
    } catch { return refuse("local_operation_unavailable"); }
    finally { journal?.close(); }
  };
}
