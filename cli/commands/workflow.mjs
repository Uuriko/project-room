import { parseArgs } from "node:util";
import { join } from "node:path";
import { RoomAgentClient, RoomClientError } from "../../client/room-agent.mjs";
import { openPrivateJournal, privateDirectory } from "../../client/setup-journal.mjs";
import { workflowTools as actions, isRecord, hasRevision, selectedBasis, readSelectedBasis,
  fileInput, readInput, operationFingerprint, submissionOperationKey } from "../selected-basis.mjs";
import { bearerHeader, loadSecret, mcpUrl } from "../auth.mjs";
import { loadConnection, roomShellCommand } from "../paths.mjs";
import { boundedJson } from "../room-response.mjs";
import { exactResultRecovery } from "../../src/result-availability.js";
import { validId } from "../../src/events.js";
import { edgeDoorApiPath } from "../../server/agent-discovery.mjs";
import { exactResultDestination, resultDiscussionPath } from "../../src/record-link.js";
import { roomFileChangeSelection } from "../../src/workspace-artifact-link.js";
import { validSourceObservation } from "../../src/work-packet.js";

const actionHelp = "room act begin|resolve|review|respond < action.json\nUse the selected read's arguments and supply its required inputs. Writes run only when you call this command.";
const workHelp = "room work WORK_ID [--result | --include-source [--from FILE] | --since BRIEF_VERSION | --discussion [--cursor TOKEN]]\nRead the compact task brief. Add --include-source for the linked assignment message, or --discussion for shared files and discussion. Add --result for exact review evidence.\nWith --since, retain the full brief for this task and connection. A matching briefUnchanged response reuses that text with fresh action arguments. Otherwise read the returned full brief.\nTo refresh a linked source, pass its previous JSON read with --include-source --from FILE (or - for stdin). Keep the last body for not_modified. If the source is unavailable, stop using the saved body.";
const requestHelp = "room request REQUEST_ID [--compact] [--cursor TOKEN]\n"
  + "room request --answered [--cursor TOKEN]\nList answers to requests you sent, or open one exact request. Follow the next page when offered.";
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
    const hint = tool === "room_read_result" && exactResultRecovery(value?.status, value?.code);
    if (hint) return { refused: value.code === "work_private" ? "access_denied" : value.code, hint };
    const code = value?.reason ?? value?.code ?? rpc.error?.data?.reason;
    return { refused: typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "room_refused" };
  }
  if (!isRecord(value)) throw new Error("Invalid Room result");
  return { value };
}

export function matchesOperationReceipt(value, { roomId, memberId }, id) {
  return value?.contractVersion === 1 && value.roomId === roomId && value.viewerId === memberId
    && value.operationId === id && hasRevision(value.checkedThrough) && value.currentStateVerified === false
    && (value.status === "recorded"
      ? validId(value.eventId) && typeof value.eventType === "string" && value.eventType.length > 0
        && hasRevision(value.sequence) && value.sequence > 0 && value.sequence <= value.checkedThrough
      : value.status === "not_recorded" && value.eventId === undefined && value.sequence === undefined);
}

function selectedRequest(value, { roomId, memberId }, id) {
  return value?.roomId === roomId && value.viewerId === memberId && value.request?.id === id;
}

async function reconcileAnswer(call, args, config) {
  const { value: receipt } = await call("room_receipt", { operationId: args.requestId });
  if (!matchesOperationReceipt(receipt, config, args.requestId) || receipt.status !== "recorded"
      || receipt.eventType !== "message.posted") return null;
  const { value: read } = await call("room_read_request", { requestMessageId: args.responseToRequestId, view: "compact" });
  if (!selectedRequest(read, config, args.responseToRequestId)) return null;
  const request = read.request;
  if (request.terminalEventId !== receipt.eventId || request.status !== args.responseOutcome
      || request.recipientId !== config.memberId || request.requesterId !== args.toMemberId
      || request.workItemId !== args.workItemId || request.contextEventId !== args.contextEventId
      || request.responseContextSequence !== args.contextSequence
      || request.revision !== args.expectedRequestRevision + 1 || !validId(request.responseMessageId)) return null;
  const entry = read.page?.items?.find(row => row.eventId === receipt.eventId && row.sequence === receipt.sequence);
  if (entry?.actorId !== config.memberId || entry.kind !== args.responseOutcome || entry.message?.body !== args.body) return null;
  return { contractVersion: 1, status: "recorded", requestId: args.requestId,
    requestMessageId: args.responseToRequestId, eventId: receipt.eventId,
    messageId: request.responseMessageId, sequence: receipt.sequence, recoveredFromReceipt: true,
    currentStateVerified: false, workStateChanged: false };
}

function exactDiscussionFiles(messages, { origin, roomId }, connectionName) {
  const files = new Map();
  for (const message of messages) {
    if (!validId(message?.id) || typeof message.body !== "string") continue;
    for (const [href] of message.body.matchAll(/(?<!\S)https?:\/\/[^\s]+/gi)) {
      const link = URL.parse(href);
      const target = roomFileChangeSelection(link, origin, roomId);
      if (!target || link.href !== href || files.has(href)) continue;
      files.set(link.href, { messageId: message.id, file: target.file, head: target.head,
        revision: target.revision, command: ["room", "workspace", "changes", "--link", link.href, "--connection", connectionName] });
    }
  }
  return [...files.values()];
}

async function readResultThread(config, secret, fetchImpl, path) {
  const response = await fetchImpl(config.origin.replace(/\/$/, "") + edgeDoorApiPath(config.origin, path), {
    headers: { Accept: "application/json", Authorization: bearerHeader(secret) },
    redirect: "error", signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status };
  }
  const { roomId, thread } = await boundedJson(response, 512 * 1024);
  if (roomId !== config.roomId || !thread) return null;
  const serialized = JSON.stringify(thread);
  if (serialized.includes(secret) || serialized.includes(config.token)) return null;
  return { thread };
}

async function runWorkflow(tool, args, validate, { cwd = process.cwd(), env = process.env,
  fetchImpl = fetch, out = console.log, connectionName, includeResultDiscussion = false } = {}, action, selectedConnection) {
  const shell = (...tokens) => roomShellCommand(connectionName, ...tokens);
  const write = action !== undefined;
  const report = ({ value, ...status }, code) => {
    out(JSON.stringify(value ?? status));
    return code;
  };
  let connection;
  try { connection = selectedConnection ?? loadConnection({ project: cwd, env, name: connectionName }); }
  catch { return report({ status: "refused", code: "saved_connection_required" }, 1); }
  const { config, name } = connection;
  if (args.roomId !== undefined && args.roomId !== config.roomId)
    return report({ status: "refused", code: "room_selection_mismatch" }, 1);
  const receiptHint = id => validId(id) ? { requestId: id, receiptCommand: shell("receipt", id),
    receiptRead: { tool: "room_receipt", arguments: { roomId: config.roomId, operationId: id } } } : {};
  const recovery = receiptHint(args.requestId ?? args.invocationRequestId);
  const next = action === "respond"
    ? { tool: "room_read_request", arguments: { roomId: config.roomId, requestMessageId: args.responseToRequestId } }
    : { tool: "room_read_work", arguments: { roomId: config.roomId, workItemId: args.workItemId, brief: true } };
  let secret;
  try { secret = await loadSecret(name, config.token, env); }
  catch { return report({ status: "refused", code: "saved_connection_required" }, 1); }
  const call = async (name, input) => {
    const reply = await exchange(name, input, config, secret, fetchImpl);
    const serialized = reply.value && JSON.stringify(reply.value);
    if (serialized && (serialized.includes(secret) || serialized.includes(config.token)))
      throw new Error("Unexpected credential content");
    return reply;
  };
  const readAnswerRecovery = async () => {
    if (action !== "respond" || !selectedConnection) return null;
    try { return await reconcileAnswer(call, args, config); }
    catch { return null; }
  };
  try {
    const reply = await call(tool, args);
    if (reply.refused) {
      const recovery = selectedConnection && write ? { contractVersion: 1, nextRead: next } : {};
      if (action === "respond" && selectedConnection && reply.refused === "stale_revision") {
        try {
          const { value: current } = await call("room_read_request", { ...next.arguments, view: "compact" });
          if (selectedRequest(current, config, args.responseToRequestId)) {
            const basis = selectedBasis(current, config);
            if (basis) current.cliBasis = basis;
            delete current.responseHttpActions;
            recovery.currentRead = current;
          }
        } catch { /* The explicit next read remains available. */ }
      }
      return report({ status: "refused", code: reply.refused, ...(reply.hint ? { hint: reply.hint } : {}), ...recovery }, 1);
    }
    const value = reply.value;
    if (reply.unknown) {
      if (!write) return report({ status: "unavailable", code: "room_read_unavailable" }, 1);
      const recovered = await readAnswerRecovery();
      if (recovered) return report({ value: recovered }, 0);
      return report({ status: "unknown", ...(action === "begin" && value ? { begin: value } : {}),
        contractVersion: 1, ...recovery,
        ...(action === "begin" ? receiptHint(value?.resume?.requestId) : {}),
        ...(selectedConnection ? { nextRead: next } : {}) }, 1);
    }
    if (!validate(value, config)) throw new Error("Unmatched Room result");
    if (["room_read_work", "room_read_request", "room_read_result"].includes(tool)) {
      const basis = selectedBasis(value, config);
      if (basis) {
        value.cliBasis = basis;
        if (basis.actions.submit) value.submitCommand = shell("submit", "--from");
      }
    }
    if (tool === "room_read_result") {
      const source = value.result?.text;
      const hasDiscussion = value.result?.kind === "room_text" && typeof source?.body === "string"
        && validId(source.messageId) && source.messageId === value.result.receipt?.nativeText?.messageId;
      if (hasDiscussion && !source.withdrawnAt) {
        const files = exactDiscussionFiles([{ id: source.messageId, body: source.body }], config, name);
        if (files.length) value.workspaceArtifacts = files;
      }
      if (hasDiscussion) value.discussionRead = { method: "GET", path: resultDiscussionPath(config.roomId, source.messageId),
        command: shell("result", args.workItemId, "--completion", args.completionEventId, "--discussion") };
      if (includeResultDiscussion) {
        if (!hasDiscussion) return report({ status: "unavailable", code: "result_discussion_unavailable" }, 1);
        const read = await readResultThread(config, secret, fetchImpl, value.discussionRead.path);
        if (read?.status === 413) return report({ status: "unavailable", code: "result_discussion_too_large",
          hint: "Open the original discussion in the Room to read the replies." }, 1);
        const thread = read?.thread;
        if (thread?.id !== source.messageId || thread.workItemId !== args.workItemId
            || thread.deletedAt || thread.authorId !== source.postedById || thread.body !== source.body || !Array.isArray(thread.replies))
          return report({ status: "unavailable", code: "result_discussion_unavailable" }, 1);
        value.discussion = { messageId: source.messageId, replies: thread.replies };
        const files = exactDiscussionFiles(thread.replies, config, name);
        if (files.length) value.discussion.workspaceArtifacts = files;
      }
    }
    if (tool === "room_read_result" && value.cliBasis?.actions.review)
      value.review.action.command = shell("review", "--from");
    if (tool === "room_read_work") {
      const sourceRead = value.sourceRead;
      if (sourceRead?.tool === "room_read_work" && sourceRead.arguments?.roomId === config.roomId
          && sourceRead.arguments.workItemId === args.workItemId && sourceRead.arguments.includeSource === true)
        sourceRead.command = shell("work", args.workItemId, "--include-source");
      const source = value.context?.source;
      if (args.includeSource && source) {
        delete source.cliRefresh;
        if (validSourceObservation(source.observation)) source.cliRefresh = {
          origin: config.origin, command: shell("work", args.workItemId, "--include-source", "--from", "-"),
        };
      }
      const step = value.continuation;
      const shortcut = Object.keys(actions).find(name => actions[name] === step.tool);
      if (value.cliBasis?.actions[shortcut]) step.command = shell(shortcut, "--from");
      else if (step.tool === "room_read_work" && step.arguments?.workItemId === args.workItemId
          && step.arguments.includeResult === true)
        step.command = shell("work", args.workItemId, "--result");
    }
    if (tool === "room_read_work_discussion") {
      value.workspaceArtifacts = exactDiscussionFiles(value.discussion.items.map(item => item.message), config, name);
      const cursor = value.discussion.nextCursor;
      if (validCursor(cursor))
        value.nextCommand = shell("work", args.workItemId, "--discussion", "--cursor", cursor);
    }
    if (tool === "room_read_request") {
      delete value.responseHttpActions;
      const cursor = value.nextRead?.arguments?.cursor ?? value.page?.nextCursor;
      const compactFlag = args.view === "compact" ? ["--compact"] : [];
      if (validCursor(cursor)) value.nextCommand = shell("request", args.requestMessageId, ...compactFlag, "--cursor", cursor);
      if (value.preparation?.previousExchangesNextRead && Array.isArray(value.preparation.olderExchangeReads)) {
        value.previousExchangesCommand = shell("request", args.requestMessageId);
        value.olderExchangeCommands = value.preparation.olderExchangeReads.map(read =>
          shell("request", read.arguments.requestMessageId, "--compact"));
      }
      for (const response of value.responseActions ?? []) {
        if (response.tool === actions.respond && value.cliBasis?.actions.respond) {
          response.command = shell("respond", "--from");
          if (response.arguments.responseOutcome === "answered")
            value.answerCommand = shell("answer", args.requestMessageId, "--from");
        }
      }
    }
    if (selectedConnection && action === "begin") {
      const status = value.working ? "recorded" : value.stopped === "waiting_on_prerequisites" ? "waiting" : "refused";
      return report({ value: { contractVersion: 1, status, ...value, ...(value.working ? {} : { nextRead: next }) } },
        value.working ? 0 : 1);
    }
    return report({ value }, action === "begin" && !value.working ? 1 : 0);
  } catch {
    const recovered = await readAnswerRecovery();
    if (recovered) return report({ value: recovered }, 0);
    return report(write ? { status: "unknown", code: action === "begin" ? "read_current_work" : "retry_exact_action",
      contractVersion: 1, ...recovery, ...(selectedConnection ? { nextRead: next } : {}) }
      : { status: "unavailable", code: "room_read_unavailable" }, 1);
  }
}

const receiptHelp = "room receipt OPERATION_ID [--draft|--submit]\nLook up your original write without replaying it. For a room submit operation ID, select its draft or completion.";

export async function receiptCommand(argv, io = {}) {
  const out = io.out ?? console.log;
  if (argv.length === 1 && argv[0] === "--help") { out(receiptHelp); return 0; }
  const [id, stage] = argv;
  if (!validId(id) || argv.length > 2 || (stage !== undefined && !["--draft", "--submit"].includes(stage)))
    throw new Error(receiptHelp);
  let connection;
  try { connection = loadConnection({ project: io.cwd ?? process.cwd(), env: io.env ?? process.env, name: io.connectionName }); }
  catch { out(JSON.stringify({ status: "refused", code: "saved_connection_required" })); return 1; }
  const { roomId, memberId } = connection.config;
  const operationId = stage ? `${stage.slice(2)}-${submissionOperationKey(roomId, memberId, id)}` : id;
  return runWorkflow("room_receipt", { operationId },
    value => matchesOperationReceipt(value, connection.config, operationId), io, undefined, connection);
}

export async function workCommand(argv, io = {}) {
  if (argv.length === 1 && argv[0] === "--help") { (io.out ?? console.log)(workHelp); return 0; }
  const [workItemId, flag, since] = argv;
  if (flag === "--discussion") {
    const cursor = argv[3];
    if (!validId(workItemId) || !(argv.length === 2 || argv.length === 4
        && since === "--cursor" && validCursor(cursor) && cursor.length <= 2048)) throw new Error(workHelp);
    return runWorkflow("room_read_work_discussion", { workItemId, ...(cursor ? { cursor } : {}) },
      (value, { roomId, memberId }) => value.contractVersion === 1 && value.roomId === roomId
        && value.workItemId === workItemId && value.viewerId === memberId
        && Array.isArray(value.discussion?.items), io);
  }
  if (flag === "--include-source") {
    if (!validId(workItemId) || !(argv.length === 2 || argv.length === 4 && since === "--from" && argv[3]))
      throw new Error(workHelp);
    return readAssignmentSource(workItemId, argv[3], io);
  }
  const includeResult = flag === "--result";
  const conditional = flag === "--since" && /^[a-f0-9]{64}$/.test(since ?? "");
  if (!validId(workItemId) || !(argv.length === 1 || argv.length === 2 && includeResult || argv.length === 3 && conditional))
    throw new Error(workHelp);
  return runWorkflow("room_read_work", { workItemId, brief: true, includeResult,
    ...(conditional ? { knownBriefVersion: since } : {}) }, (value, { roomId }) =>
    value.roomId === roomId && value.workItemId === workItemId && hasRevision(value.revision)
    && isRecord(value.continuation)
    && (value.briefUnchanged === true
      ? conditional && value.briefVersion === since && value.brief === undefined
      : typeof value.brief === "string")
    && (!includeResult || value.review?.workRevision === value.revision), io);
}

function matchesSourceObservation(observation, workItemId, { roomId, memberId }) {
  return validSourceObservation(observation) && observation.workItemId === workItemId
    && observation.roomId === roomId && observation.viewerId === memberId;
}

async function readAssignmentSource(workItemId, previousFile, io) {
  const out = io.out ?? console.log;
  let connection, previous;
  try { connection = loadConnection({ project: io.cwd ?? process.cwd(), env: io.env ?? process.env, name: io.connectionName }); }
  catch { out(JSON.stringify({ status: "refused", code: "saved_connection_required" })); return 1; }
  if (previousFile !== undefined) {
    try {
      const packet = JSON.parse(await readInput(fileInput(previousFile, io), 512 * 1024));
      const source = packet?.context?.source;
      if (source?.cliRefresh?.origin === connection.config.origin
          && matchesSourceObservation(source.observation, workItemId, connection.config)) previous = source.observation;
    } catch { /* Invalid or inaccessible input is rejected before the network call. */ }
    if (!previous) { out(JSON.stringify({ status: "refused", code: "source_selection_mismatch" })); return 1; }
  }
  return runWorkflow("room_read_work", { workItemId, includeSource: true, ...(previous ? { sourceObservation: previous } : {}) },
    (value, config) => {
      if (value.roomId !== config.roomId || value.viewerId !== config.memberId || value.work?.id !== workItemId
          || !hasRevision(value.work.revision) || !isRecord(value.continuation)) return false;
      const source = value.context?.source;
      if (source?.status === "included") return validId(source.message?.id) && source.message.id === value.work.sourceMessageId
        && typeof source.message.body === "string" && (source.observation == null
          ? !previous : matchesSourceObservation(source.observation, workItemId, config) && source.observation.messageId === source.message.id);
      if (source?.status === "not_modified") return previous && source.message === null
        && source.observation?.messageId === value.work.sourceMessageId
        && matchesSourceObservation(source.observation, workItemId, config)
        && Object.keys(previous).every(key => previous[key] === source.observation[key]);
      return ["not_linked", "unavailable"].includes(source?.status) && source.message === null && source.observation == null;
    }, io, undefined, connection);
}

export async function resultCommand(argv, io = {}) {
  const help = "room result RESULT_URL [--discussion]\nroom result WORK_ID --completion EVENT_ID [--discussion]\nRead the exact version using this project’s saved connection. Add --discussion to read replies to the original message. Result versions that cite the same message share its discussion.";
  const out = io.out ?? console.log;
  if (argv.length === 1 && argv[0] === "--help") { out(help); return 0; }
  const includeResultDiscussion = argv.at(-1) === "--discussion";
  if (includeResultDiscussion) argv = argv.slice(0, -1);
  let args, connection;
  if (argv.length === 1) {
    const url = URL.parse(argv[0]);
    const selected = url && exactResultDestination(url);
    if (!selected || url.username || url.password || !["https:", "http:"].includes(url.protocol)) throw new Error(help);
    try { connection = loadConnection({ project: io.cwd ?? process.cwd(), env: io.env ?? process.env, name: io.connectionName }); }
    catch { out(JSON.stringify({ status: "refused", code: "saved_connection_required" })); return 1; }
    if (url.origin !== new URL(connection.config.origin).origin || selected.roomId !== connection.config.roomId) {
      out(JSON.stringify({ status: "refused", code: "room_selection_mismatch" })); return 1;
    }
    args = selected;
  } else {
    const [workItemId, flag, completionEventId] = argv;
    if (argv.length !== 3 || flag !== "--completion" || !validId(workItemId) || !validId(completionEventId))
      throw new Error(help);
    args = { workItemId, completionEventId };
  }
  return runWorkflow("room_read_result", args, (value, { roomId, memberId }) =>
    value.viewerId === memberId && value.roomId === roomId && value.workItemId === args.workItemId
    && value.selection?.completionEventId === args.completionEventId && value.result?.receipt?.eventId === args.completionEventId,
  { ...io, includeResultDiscussion }, undefined, connection);
}

export function readCommand(argv, io = {}) {
  if (argv.length === 1 && argv[0] === "--help") {
    (io.out ?? console.log)("room read REQUEST_ID [--cursor TOKEN]\nRead this request with prior exchanges deferred. Follow the next page before answering.");
    return 0;
  }
  return requestCommand([...argv, "--compact"], io);
}

async function answeredRequestList(cursor, { cwd = process.cwd(), env = process.env, fetchImpl, out = console.log }) {
  const report = (value, status) => { out(JSON.stringify(value)); return status; };
  let connection, token;
  try {
    connection = loadConnection({ project: cwd, env });
    token = await loadSecret(connection.name, connection.config.token, env);
  } catch { return report({ status: "refused", code: "saved_connection_required" }, 1); }
  try {
    const client = new RoomAgentClient({ ...connection.config, token, fetchImpl });
    const value = await client.replyRequests({ direction: "outgoing", status: "answered", ...(cursor ? { cursor } : {}) });
    if (value.viewerId !== connection.config.memberId ||
      JSON.stringify(value).includes(token)) throw new Error("Unmatched Room result");
    for (const request of value.requests) request.command = ["room", "request", request.id];
    if (value.page?.hasMore) value.nextCommand = ["room", "request", "--answered", "--cursor", value.page.nextCursor];
    return report(value, 0);
  } catch (error) {
    if (error instanceof RoomClientError && ["invalid_reply_cursor", "reply_cursor_identity_changed"].includes(error.code))
      return report({ status: "unavailable", code: error.code, restartCommand: ["room", "request", "--answered"] }, 1);
    return report({ status: "unavailable", code: "room_read_unavailable" }, 1);
  }
}

export async function requestCommand(argv, io = {}) {
  if (argv.length === 1 && argv[0] === "--help") { (io.out ?? console.log)(requestHelp); return 0; }
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true,
    options: { answered: { type: "boolean" }, compact: { type: "boolean" }, cursor: { type: "string" } } });
  if (values.cursor !== undefined && !validCursor(values.cursor)) throw new Error(requestHelp);
  if (values.answered) {
    if (positionals.length || values.compact) throw new Error(requestHelp);
    return answeredRequestList(values.cursor, io);
  }
  const [requestMessageId] = positionals;
  if (positionals.length !== 1 || !validId(requestMessageId)) throw new Error(requestHelp);
  return runWorkflow("room_read_request", { requestMessageId, ...(values.cursor ? { cursor: values.cursor } : {}),
    ...(values.compact ? { view: "compact" } : {}) },
    (value, config) => selectedRequest(value, config, requestMessageId), io);
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

async function shareAnswerFile(requestMessageId, fileId, sha256, connection, io) {
  const report = (value, code = 1) => {
    (io.out ?? console.log)(JSON.stringify({ contractVersion: 1, requestMessageId, ...value }));
    return code;
  };
  const { name, config } = connection;
  let token;
  try { token = await loadSecret(name, config.token, io.env ?? process.env); }
  catch { return report({ status: "refused", code: "saved_connection_required" }); }
  const client = new RoomAgentClient({ ...config, token, fetchImpl: io.fetchImpl });
  let read;
  try { read = await client.replyContextForHint(requestMessageId); }
  catch (error) {
    const refused = error instanceof RoomClientError &&
      ([401, 403, 404, 410].includes(error.status) || error.code === "identity_mismatch");
    return report({ status: refused ? "refused" : "unavailable", code: "answer_unavailable" });
  }
  const request = read.request;
  const messageId = request.responseMessageId;
  const answer = read.page.items.find(item => item.kind === "answered" && item.eventId === request.terminalEventId);
  if (request.status !== "answered" || !validId(messageId) || answer?.message?.id !== messageId
      || answer.message.authorId !== config.memberId || answer.message.toMemberId !== request.requesterId
      || answer.message.deletedAt || typeof answer.message.body !== "string")
    return report({ status: "refused", code: "answer_unavailable" });

  const attachment = { fileId, messageId, sha256 };
  try {
    const observedDigest = await client.stagedAnswerFileDigest(fileId, { committedMessageId: messageId });
    if (observedDigest !== sha256) return report({ status: "refused", code: "attachment_digest_mismatch", attachment });
    await client.commitAnswerFile(fileId, messageId, sha256);
    return report({ status: "shared", attachment: { ...attachment, state: "shared" } }, 0);
  } catch (error) {
    const refused = error instanceof RoomClientError && [401, 403, 404, 409, 410, 422].includes(error.status);
    const code = refused && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)
      ? error.code : "attachment_commit_unconfirmed";
    return report({ status: refused ? "refused" : "file_pending", code, attachment });
  }
}

export const answerCommand = namedCommand("respond", true);

export function namedCommand(action, answer = false) {
  return async (argv, io = {}) => {
    const out = io.out ?? console.log;
    if (argv.length === 1 && argv[0] === "--help") {
      const shareHelp = answer ? "\nroom answer REQUEST_ID --share-staged-file FILE_ID --sha256 DIGEST" : "";
      out((answer ? "room answer REQUEST_ID --from FILE --body-file FILE" : namedHelp[action])
        + (action === "begin" ? "" : " [--operation ID]") + shareHelp);
      return 0;
    }
    const refuse = code => { out(JSON.stringify({ contractVersion: 1, status: "refused", code })); return 1; };
    let flags, connection, fixed, input;
    try {
      const { values, tokens, positionals } = parseArgs({ args: argv, tokens: true, allowPositionals: answer, options: { from: string,
        ...(action === "begin" ? {} : { operation: string }), ...namedOptions[action],
        ...(answer ? { "share-staged-file": string, sha256: string } : {}) } });
      const names = tokens.filter(token => token.kind === "option" && token.name !== "path").map(token => token.name);
      if (new Set(names).size !== names.length) return refuse("invalid_action_input");
      const sharesFile = values["share-staged-file"] !== undefined || values.sha256 !== undefined;
      if (sharesFile
        ? names.length !== 2 || !validId(values["share-staged-file"]) || !/^[a-f0-9]{64}$/.test(values.sha256 ?? "")
        : !values.from || values.operation !== undefined && !validId(values.operation)) return refuse("invalid_action_input");
      if (answer && (positionals.length !== 1 || !validId(positionals[0]) || values.answer || values.decline))
        return refuse("invalid_action_input");
      flags = answer ? { ...values, answer: true, requestMessageId: positionals[0] } : values;
    } catch { return refuse("invalid_action_input"); }
    try { connection = loadConnection({ project: io.cwd ?? process.cwd(), env: io.env ?? process.env, name: io.connectionName }); }
    catch { return refuse("saved_connection_required"); }
    if (flags["share-staged-file"] !== undefined)
      return shareAnswerFile(flags.requestMessageId, flags["share-staged-file"], flags.sha256, connection, io);
    const { config, configDirectory } = connection;
    try { fixed = await readSelectedBasis(flags.from, action, config, io); }
    catch { return refuse("invalid_action_basis"); }
    if (answer && fixed.responseToRequestId !== flags.requestMessageId) return refuse("request_selection_mismatch");
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
