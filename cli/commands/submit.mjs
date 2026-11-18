import { createHash } from "node:crypto";
import { join } from "node:path";
import { bearerHeader, loadSecret, mcpUrl } from "../auth.mjs";
import { loadConnection } from "../paths.mjs";
import { boundedJson } from "../room-response.mjs";
import { openPrivateJournal, privateDirectory } from "../../client/setup-journal.mjs";
import { validId } from "../../src/events.js";

const HELP = `room submit WORK_ID --operation ID < result.json
JSON fields are body, summary, nextAction, producerId (member ID or null),
expectedRevision (from the selected work read), and optional maxCodeUnits.
Use the same ID and JSON after an uncertain result. A receipt records submission.`;

const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
const nonblank = text => typeof text === "string" && text.trim().length > 0 && text.isWellFormed();
const validText = text => nonblank(text) && text.length <= 4096;

async function readIntent(stdin) {
  if (stdin.isTTY) throw new Error("Pipe the result JSON from a file.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 96 * 1024) throw new Error("Result JSON is too large.");
    chunks.push(buffer);
  }
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const fields = ["body", "summary", "nextAction", "producerId", "expectedRevision", "maxCodeUnits"];
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !fields.includes(key))) throw new Error("Invalid result JSON.");
  const { body, summary, nextAction, producerId, expectedRevision, maxCodeUnits = 4096 } = input;
  if (!nonblank(body) || !validText(summary) || !validText(nextAction)
      || !(producerId === null || validId(producerId))
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER
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
  if (rpc?.id !== id || rpc.jsonrpc !== "2.0") throw new Error("Invalid Room response");
  const value = rpc.result?.structuredContent;
  if (rpc.error || rpc.result?.isError) {
    if (value?.status === "unconfirmed" || value?.status >= 500) throw new Error("Uncertain Room response");
    const code = value?.reason ?? value?.code ?? rpc.error?.data?.reason;
    return { refused: typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "room_refused" };
  }
  if (!value || value.contractVersion !== 1) throw new Error("Invalid Room response");
  return { value };
}

function matchesEvidence(basis, operation) {
  return basis?.workItemId === operation.workItemId
    && basis.expectedRevision === operation.expectedRevision
    && basis.evidenceMessageId === operation.draftId && validId(basis.evidenceMessageEventId)
    && basis.evidenceVersion === operation.evidenceVersion
    && (basis.previousCompletionEventId === null || validId(basis.previousCompletionEventId));
}

export async function submitCommand(argv, { cwd = process.cwd(), env = process.env,
  stdin = process.stdin, fetchImpl = fetch, out = console.log } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { out(HELP); return 0; }
  const [workItemId, flag, operationId] = argv;
  if (argv.length !== 3 || flag !== "--operation" || !validId(workItemId) || !validId(operationId))
    throw new Error(HELP);

  const report = (status, stage, extra = {}) => {
    out(JSON.stringify({ contractVersion: 1, status, stage, workItemId, operationId, ...extra }));
    return status === "recorded" ? 0 : 1;
  };
  let intent;
  try { intent = await readIntent(stdin); }
  catch { return report("refused", "input", { code: "invalid_result_json" }); }
  const { body, summary, nextAction, producerId, expectedRevision, maxCodeUnits } = intent;
  if (body.length > maxCodeUnits)
    return report("refused", "input", { code: "result_too_large", maxCodeUnits,
      codeUnits: body.length, targetCodeUnits: Math.max(1, Math.floor(maxCodeUnits * 0.8)) });

  const { config, configDirectory, name } = loadConnection({ project: cwd, env });
  const { roomId, memberId } = config;
  const base = hash(JSON.stringify([roomId, memberId, operationId]));
  const requestId = `submit-${base}`;
  const draftId = `draft-${base}`;
  const fingerprint = hash(JSON.stringify([workItemId, intent]));
  const operation = { workItemId, expectedRevision, draftId, evidenceVersion: `sha256:${hash(body)}` };
  const next = { tool: "room_read_work", arguments: { roomId, workItemId, brief: true } };
  let journal;
  let stage = "local";
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
      const posted = await call("room_post_message", { workItemId, id: draftId, body,
        maxResultCodeUnits: maxCodeUnits });
      if (posted.refused) return report("refused", stage, { code: posted.refused, next });
      const post = posted.value;
      if (post.roomId !== roomId || post.actorId !== memberId || post.workItemId !== workItemId
          || post.requestId !== draftId || post.messageId !== draftId || post.status !== (post.duplicate ? "duplicate" : "posted")
          || !validId(post.eventId) || typeof post.duplicate !== "boolean" || !post.resultDraft)
        throw new Error("Unmatched draft receipt");

      basis = post.resultDraft.submission;
      if (post.duplicate) {
        stage = "reconcile_draft";
        const draft = await call("room_read_result", { workItemId, draftMessageId: draftId });
        if (draft.refused) return report("refused", stage, { code: draft.refused, next });
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
        return report("refused", stage, { code: "draft_recorded_basis_unavailable", draftId, next });
      // Keep the exact write before the request leaves the host.
      journal.save({ fingerprint, basis, attributes });
    } else if (!matchesEvidence(basis, operation)
        || Object.keys(attributes).some(key => attributes[key] !== saved.attributes?.[key])) {
      return report("refused", stage, { code: "operation_journal_mismatch" });
    }

    stage = "submit";
    const submitted = await call("room_submit_text_result", { ...basis, ...attributes });
    if (submitted.refused) return report("refused", stage, { code: submitted.refused, draftId, next });
    const receipt = submitted.value;
    if (receipt.status !== "recorded" || receipt.result?.read?.arguments?.roomId !== roomId
        || receipt.workItemId !== workItemId || receipt.requestId !== requestId
        || !validId(receipt.eventId) || receipt.eventId.includes(secret)
        || receipt.eventId.includes(config.token) || receipt.result?.completionEventId !== receipt.eventId
        || receipt.result.evidenceVersion !== basis.evidenceVersion || typeof receipt.duplicate !== "boolean")
      throw new Error("Unmatched submission receipt");
    return report("recorded", stage, { roomId, draftId, completionEventId: receipt.eventId,
      duplicate: receipt.duplicate, evidenceVersion: basis.evidenceVersion, currentStateVerified: false,
      next: { tool: "room_read_result", arguments: { roomId, workItemId, completionEventId: receipt.eventId } } });
  } catch {
    return report(stage === "local" ? "refused" : "unknown", stage, {
      code: stage === "local" ? "local_operation_unavailable" : "retry_same_operation" });
  } finally {
    journal?.close();
  }
}
