import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { validId } from "../src/events.js";

export const workflowTools = Object.freeze({
  begin: "room_begin_work",
  resolve: "room_resolve_blocker",
  review: "room_record_verification",
  respond: "room_respond_to_request"
});

export const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const hasRevision = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
export const operationFingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const submissionOperationKey = (roomId, memberId, operationId) => operationFingerprint([roomId, memberId, operationId]);

export async function readInput(input, limit = 256 * 1024) {
  if (input.isTTY) throw new Error("Pipe the input.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error("Input too large.");
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export function fileInput(file, { cwd = process.cwd(), stdin = process.stdin } = {}) {
  return file === "-" ? stdin : createReadStream(resolve(cwd, file));
}

function workActions(value, config) {
  const { workItemId, revision, continuation: step } = value;
  if (!validId(workItemId) || !hasRevision(revision) || step?.addressedToViewer !== true
      || step.memberId !== config.memberId || step.workRevision !== revision) return {};
  const basis = { roomId: config.roomId, workItemId, expectedRevision: revision };
  if (step.action === "in_progress" && !step.tool) return { submit: basis };
  const fixed = step.arguments;
  if (fixed?.roomId !== config.roomId || fixed.workItemId !== workItemId || fixed.expectedRevision !== revision) return {};
  if (step.tool === workflowTools.begin) return { begin: basis };
  if (step.tool === workflowTools.resolve && step.action === "revise") return { resolve: basis };
  if (step.tool === workflowTools.review && step.action === "verify" && validId(fixed.completionEventId)
      && typeof fixed.evidenceVersion === "string" && fixed.evidenceVersion.trim()
      && value.review?.workRevision === revision && value.review.completionEventId === fixed.completionEventId
      && value.review.result?.receipt?.evidenceVersion === fixed.evidenceVersion) {
    return { review: { ...basis, completionEventId: fixed.completionEventId, evidenceVersion: fixed.evidenceVersion } };
  }
  return {};
}

function requestActions(value, config) {
  const { request, current, responseActions, page } = value;
  const basis = current?.answerBasis;
  if (page?.hasMore !== false || !basis || !validId(request?.id) || request.status !== "open"
      || request.recipientId !== config.memberId || value.viewerId !== config.memberId
      || !hasRevision(basis.expectedRequestRevision) || basis.expectedRequestRevision !== request.revision
      || !validId(basis.contextEventId) || basis.contextEventId !== current.contextEventId
      || !hasRevision(basis.contextSequence) || basis.contextSequence < 1 || basis.contextSequence !== current.contextSequence
      || !validId(request.requesterId) || !(request.workItemId === null || validId(request.workItemId))
      || !Array.isArray(responseActions)) return {};
  const respond = { roomId: config.roomId, responseToRequestId: request.id,
    expectedRequestRevision: basis.expectedRequestRevision, contextEventId: basis.contextEventId,
    contextSequence: basis.contextSequence, toMemberId: request.requesterId, workItemId: request.workItemId };
  for (const outcome of ["answered", "declined"]) {
    if (!responseActions.some(row => row.tool === workflowTools.respond
        && row.arguments?.responseOutcome === outcome
        && Object.entries(respond).every(([key, value]) => row.arguments[key] === value))) return {};
  }
  return { respond };
}

export function selectedBasis(value, config) {
  if (value?.roomId !== config.roomId) return null;
  const actions = value.request ? requestActions(value, config) : workActions(value, config);
  return Object.keys(actions).length ? { version: 1, origin: config.origin, memberId: config.memberId, actions } : null;
}

export async function readSelectedBasis(file, verb, config, io) {
  const packet = JSON.parse(await readInput(fileInput(file, io), 512 * 1024));
  const basis = selectedBasis(packet, config);
  const supplied = packet?.cliBasis;
  const fixed = basis?.actions[verb];
  const recorded = supplied?.actions?.[verb];
  if (!fixed || supplied?.version !== basis.version || supplied.origin !== basis.origin
      || supplied.memberId !== basis.memberId || !isRecord(recorded)
      || Object.keys(recorded).length !== Object.keys(fixed).length
      || Object.entries(fixed).some(([key, value]) => recorded[key] !== value)) {
    throw new Error("Invalid selected basis.");
  }
  return fixed;
}
