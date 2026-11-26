import { createHash } from "node:crypto";
import { join } from "node:path";
import { bearerHeader, loadSecret, mcpUrl } from "../auth.mjs";
import { loadConnection, roomShellCommand } from "../paths.mjs";
import { matchesOperationReceipt } from "./workflow.mjs";
import { boundedJson } from "../room-response.mjs";
import { openPrivateJournal, privateDirectory } from "../../client/setup-journal.mjs";
import { readInput, hasRevision, isRecord, selectedBasis, readSelectedBasis, operationFingerprint, submissionOperationKey } from "../selected-basis.mjs";
import { validId } from "../../src/events.js";

const HELP = `room submit --from WORK.json [--operation ID] < result.json
Compatibility: room submit WORK_ID --operation ID < result.json
JSON fields are body, summary, nextAction, producerId (member ID or null),
and optional maxCodeUnits. The compatibility form also requires expectedRevision.
Older Rooms check the revision before posting. Updated Rooms check it atomically when posting.
Use the same ID and JSON after an uncertain result. A receipt records submission.`;

const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
const nonblank = text => typeof text === "string" && text.trim().length > 0 && text.isWellFormed();
const validText = text => nonblank(text) && text.length <= 4096;
const ACCESS_REFUSALS = new Set(["access_denied", "work_private", "http_401", "http_403"]);

async function readIntent(stdin, selectedRevision) {
  const input = JSON.parse(await readInput(stdin, 96 * 1024));
  const fields = ["body", "summary", "nextAction", "producerId", "maxCodeUnits", ...(selectedRevision === undefined ? ["expectedRevision"] : [])];
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !fields.includes(key))) throw new Error("Invalid result JSON.");
  const { body, summary, nextAction, producerId, maxCodeUnits = 4096 } = input;
  const expectedRevision = selectedRevision ?? input.expectedRevision;
  if (!nonblank(body) || !validText(summary) || !validText(nextAction)
      || !(producerId === null || validId(producerId))
      || !hasRevision(expectedRevision)
      || !Number.isInteger(maxCodeUnits) || maxCodeUnits < 1 || maxCodeUnits > 4096)
    throw new Error("Invalid result fields.");
  return { body, summary, nextAction, producerId, expectedRevision, maxCodeUnits };
}

async function callRoom({ config, secret, fetchImpl }, name, args) {
  const id = "room-submit";
  const response = await fetchImpl(mcpUrl(config.origin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: bearerHeader(secret) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name, arguments: { roomId: config.roomId, ...args } } })
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 400 && response.status < 500 && response.status !== 408)
      return { refused: `http_${response.status}` };
    throw new Error("Uncertain Room response");
  }
  const rpc = await boundedJson(response);
  if (rpc?.id !== id || rpc.jsonrpc !== "2.0" || Object.hasOwn(rpc, "error") === Object.hasOwn(rpc, "result"))
    throw new Error("Invalid Room response");
  const value = rpc.result?.structuredContent;
  if (rpc.error || rpc.result?.isError) {
    if (value?.status === "unconfirmed" || value?.status >= 500) throw new Error("Uncertain Room response");
    const detail = rpc.error?.data;
    if (name === "room_post_message" && rpc.error?.code === -32602 && detail?.tool === name
        && detail.reason === "invalid_arguments" && Array.isArray(detail.unexpected) && detail.unexpected.length === 1
        && detail.unexpected[0] === "expectedRevision" && Array.isArray(detail.missing) && detail.missing.length === 0
        && isRecord(detail.invalid) && Object.keys(detail.invalid).length === 0)
      return { unsupportedDraftRevision: true };
    const code = value?.reason ?? value?.code ?? rpc.error?.data?.reason;
    return { refused: typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "room_refused" };
  }
  if (!value || (name !== "room_read_work" && value.contractVersion !== 1)) throw new Error("Invalid Room response");
  return { value };
}

async function postDraft(call, config, draft, expectedRevision) {
  const guarded = await call("room_post_message", { ...draft, expectedRevision });
  if (!guarded.unsupportedDraftRevision) return guarded;

  // An older server explicitly rejected the new field before dispatch. Check
  // current eligibility, preserving recovery of any previously recorded post.
  const work = await call("room_read_work", { workItemId: draft.workItemId, brief: true });
  if (work.refused) return work;
  if (work.value.roomId !== config.roomId || work.value.workItemId !== draft.workItemId
      || !hasRevision(work.value.revision) || !work.value.continuation) throw new Error("Unmatched work read");
  const basis = selectedBasis(work.value, config)?.actions.submit;
  if (basis?.workItemId !== draft.workItemId || basis.expectedRevision !== expectedRevision) {
    const prior = await call("room_receipt", { operationId: draft.id });
    if (prior.refused) return prior;
    if (!matchesOperationReceipt(prior.value, config, draft.id)) throw new Error("Unmatched draft receipt");
    if (prior.value.status !== "recorded" || prior.value.eventType !== "message.posted")
      return { refused: "result_draft_unavailable" };
  }
  return { ...(await call("room_post_message", draft)), legacyPreflight: true };
}

function matchesEvidence(basis, operation) {
  return basis?.workItemId === operation.workItemId
    && basis.expectedRevision === operation.expectedRevision
    && basis.evidenceMessageId === operation.draftId && validId(basis.evidenceMessageEventId)
    && basis.evidenceVersion === operation.evidenceVersion
    && (basis.previousCompletionEventId === null || validId(basis.previousCompletionEventId));
}

export async function submitCommand(argv, { cwd = process.cwd(), env = process.env, connectionName,
  stdin = process.stdin, fetchImpl = fetch, out = console.log } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { out(HELP); return 0; }
  const selected = argv[0] === "--from";
  let [workItemId, flag, operationId] = argv;
  if (selected) {
    operationId = argv[3];
    if (!argv[1] || argv[1] === "-" || !(argv.length === 2
        || argv.length === 4 && argv[2] === "--operation" && validId(operationId))) throw new Error(HELP);
    workItemId = undefined;
  } else if (argv.length !== 3 || flag !== "--operation" || !validId(workItemId) || !validId(operationId)) {
    throw new Error(HELP);
  }
  const report = (status, stage, extra = {}) => {
    out(JSON.stringify({ contractVersion: 1, status, stage, workItemId, operationId, ...extra }));
    return status === "recorded" ? 0 : 1;
  };
  let connection;
  try { connection = loadConnection({ project: cwd, env, name: connectionName }); }
  catch { return report("refused", "input", { code: "saved_connection_required" }); }
  const { config, configDirectory, name } = connection;
  let basisInput;
  if (selected) {
    try { basisInput = await readSelectedBasis(argv[1], "submit", config, { cwd, stdin }); }
    catch { return report("refused", "input", { code: "invalid_action_basis" }); }
    workItemId = basisInput.workItemId;
  }
  let intent;
  try { intent = await readIntent(stdin, basisInput?.expectedRevision); }
  catch { return report("refused", "input", { code: "invalid_result_json" }); }
  if (operationId === undefined)
    operationId = `selected-${operationFingerprint([config.origin, config.roomId, config.memberId, workItemId, intent])}`;
  const { body, summary, nextAction, producerId, expectedRevision, maxCodeUnits } = intent;
  if (body.length > maxCodeUnits)
    return report("refused", "input", { code: "result_too_large", maxCodeUnits,
      codeUnits: body.length, targetCodeUnits: Math.max(1, Math.floor(maxCodeUnits * 0.8)) });

  const { roomId, memberId } = config;
  const base = submissionOperationKey(roomId, memberId, operationId);
  const requestId = `submit-${base}`;
  const draftId = `draft-${base}`;
  const fingerprint = hash(JSON.stringify([workItemId, intent]));
  const operation = { workItemId, expectedRevision, draftId, evidenceVersion: `sha256:${hash(body)}` };
  const next = { tool: "room_read_work", arguments: { roomId, workItemId, brief: true },
    command: roomShellCommand(name, "work", workItemId) };
  const draftRead = { tool: "room_read_result", arguments: { roomId, workItemId, draftMessageId: draftId },
    command: roomShellCommand(name, "result", workItemId, "--draft", draftId) };
  let journal;
  let stage = "local";
  const refuse = (code, extra = {}) => report("refused", stage, { code, ...extra,
    ...(ACCESS_REFUSALS.has(code)
      ? { hint: "Check access for this saved Room connection before retrying the same operation." }
      : { next }) });
  try {
    const directory = privateDirectory(join(configDirectory, "result-operations"));
    journal = openPrivateJournal(join(directory, base), "result.json", "Another submit owns this operation");
    const saved = journal.read();
    if (saved && saved.fingerprint !== fingerprint)
      return report("refused", stage, { code: "operation_input_changed" });
    if (!saved) journal.save({ fingerprint });
    const secret = await loadSecret(name, config.token, env);
    const call = (tool, args) => callRoom({ config, secret, fetchImpl }, tool, args);
    const attributes = { requestId, summary, nextAction, producerId };
    let basis = saved?.basis;
    if (!basis) {
      stage = "draft";
      const posted = await postDraft(call, config, { workItemId, id: draftId, body, maxResultCodeUnits: maxCodeUnits }, expectedRevision);
      if (posted.refused) return refuse(posted.refused);
      const post = posted.value;
      if (post.roomId !== roomId || post.actorId !== memberId || post.workItemId !== workItemId
          || post.requestId !== draftId || post.messageId !== draftId || post.status !== (post.duplicate ? "duplicate" : "posted")
          || !validId(post.eventId) || typeof post.duplicate !== "boolean" || !post.resultDraft)
        throw new Error("Unmatched draft receipt");

      basis = post.resultDraft.submission;
      if (post.duplicate) {
        stage = "reconcile_draft";
        const draft = await call("room_read_result", { workItemId, draftMessageId: draftId });
        if (draft.refused) return refuse(draft.refused);
        const { current, result, selection } = draft.value;
        const text = result?.text;
        if (draft.value.roomId !== roomId || draft.value.workItemId !== workItemId
            || selection?.draftMessageId !== draftId || result?.kind !== "draft" || text?.body !== body)
          throw new Error("Unmatched draft read");
        if (current?.next?.action === "in_progress" && current.next.memberId === memberId) {
          basis = { workItemId, expectedRevision: current.workRevision, evidenceMessageId: text.messageId,
            evidenceMessageEventId: text.messageEventId, evidenceVersion: text.evidenceVersion,
            previousCompletionEventId: current.completionEventId };
        }
      }
      if (!matchesEvidence(basis, operation) || basis.evidenceMessageEventId !== post.eventId)
        return report("refused", stage, { code: "draft_recorded_basis_unavailable", draftId, draftRead, next,
          ...(posted.legacyPreflight && {
            hint: "This older Room checks fresh drafts before posting. The draft was recorded. No result was submitted."
          }) });
      // Keep the exact write before the request leaves the host.
      journal.save({ fingerprint, basis, attributes });
    } else if (!matchesEvidence(basis, operation)
        || Object.keys(attributes).some(key => attributes[key] !== saved.attributes?.[key])) {
      return report("refused", stage, { code: "operation_journal_mismatch" });
    }

    stage = "submit";
    const submitted = await call("room_submit_text_result", { ...basis, ...attributes });
    if (submitted.refused) return refuse(submitted.refused, { draftId,
      ...(!ACCESS_REFUSALS.has(submitted.refused) && { draftRead }) });
    const receipt = submitted.value;
    if (receipt.status !== "recorded" || receipt.result?.read?.arguments?.roomId !== roomId
        || receipt.workItemId !== workItemId || receipt.requestId !== requestId
        || !validId(receipt.eventId) || receipt.eventId.includes(secret)
        || receipt.eventId.includes(config.token) || receipt.result?.completionEventId !== receipt.eventId
        || receipt.result.evidenceVersion !== basis.evidenceVersion || typeof receipt.duplicate !== "boolean")
      throw new Error("Unmatched submission receipt");
    return report("recorded", stage, { roomId, draftId, completionEventId: receipt.eventId,
      duplicate: receipt.duplicate, evidenceVersion: basis.evidenceVersion, currentStateVerified: false,
      next: { tool: "room_read_result", arguments: { roomId, workItemId, completionEventId: receipt.eventId },
        ...(connectionName && { command: roomShellCommand(connectionName, "result", workItemId, "--completion", receipt.eventId) }) } });
  } catch {
    return report(stage === "local" ? "refused" : "unknown", stage, {
      code: stage === "local" ? "local_operation_unavailable" : "retry_same_operation",
      ...(stage === "local" ? {} : {
        receiptCommand: roomShellCommand(connectionName, "receipt", operationId, stage === "submit" ? "--submit" : "--draft"),
        receiptRead: { tool: "room_receipt", arguments: { roomId, operationId: stage === "submit" ? requestId : draftId } }
      }) });
  } finally {
    journal?.close();
  }
}
