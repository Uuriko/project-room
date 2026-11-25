import { resultDiscussionPath } from "../src/record-link.js";
import { releaseSmokePlan, releaseOutcome } from "./release-smoke.mjs";
import { messageRepository } from "./message-repository.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { nativeTextEvidence, validResultBody, proposalContext, reportedProducer, validateResultSegments } from "../src/work-packet.js";
import { nextWorkStep, workActions, workThreadHref } from "../src/workflow.js";
import { messageInHistory } from "./history-visibility.mjs";
import { WORK_REVISION_TYPES } from "../src/events.js";

const check = condition => { if (!condition) throw new Error("Native result evidence requires reconciliation"); };
export const textVersion = body => {
  check(validResultBody(body));
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
};

// Retained events, not the truncated browser tail, bind old messages to their post.
export function storedText(db, state, workItemId, messageId, messageEventId = null, messageRecords = null) {
  const row = messageEventId
    ? db.prepare("SELECT sequence,id,body FROM events WHERE room_id=? AND id=?").get(state.room.id, messageEventId)
    : db.prepare("SELECT sequence,id,body FROM events WHERE room_id=? AND json_extract(body,'$.type')='message.posted' AND coalesce(json_extract(body,'$.data.messageId'),id)=?").get(state.room.id, messageId);
  check(row);
  const post = JSON.parse(row.body), message = (messageRecords ?? messageRepository({ db }, state.room.id, state)).get(messageId);
  validateStoredTextIdentity({roomId:state.room.id,workItemId,messageId,row,message,post});
  let previous = null;
  if (["packetId", "basisRevision", "allowOlderBasis"].some(key => Object.hasOwn(post.data, key))) {
    const prior = db.prepare(`SELECT body FROM events WHERE room_id=? AND sequence<? AND json_extract(body,'$.data.workItemId')=? AND (json_extract(body,'$.type')='work.proposed' OR (json_extract(body,'$.type') IN (${WORK_REVISION_TYPES.map(() => "?").join(",")}) AND json_type(body,'$.data.expectedRevision')='integer')) ORDER BY sequence DESC LIMIT 1`).get(state.room.id, row.sequence, workItemId, ...WORK_REVISION_TYPES);
    check(prior); previous = JSON.parse(prior.body);
  }
  return storedTextFromEvidence({roomId:state.room.id,workItemId,messageId,row,message,post,previous,
    citedVersion:message?.deletedAt && post.data.body == null ? citedEvidenceVersion(state,messageId) : null});
}

function validateStoredTextIdentity({roomId,workItemId,messageId,row,message,post}) {
  // A withdrawn message is a tombstone. PRIV-1 nulls the log body; older
  // withdrawals still have the string there. Either way the body returned
  // to a reader is null.
  const withdrawn = Boolean(message?.deletedAt);
  check(message && post.type === "message.posted" && post.roomId === roomId && post.id === row.id
    && (post.data.messageId || post.id) === messageId && post.data.workItemId === workItemId && message.workItemId === workItemId
    && (withdrawn ? message.body === null : post.data.body === message.body) && post.actorId === message.authorId && post.at === message.createdAt
    && (post.data.replyToId || null) === message.replyToId && (post.data.toMemberId || null) === message.toMemberId);
  return withdrawn;
}

// Shared exact leaf: callers supply independently addressed evidence; no scans.
export function storedTextFromEvidence({roomId,workItemId,messageId,row,message,post=JSON.parse(row.body),previous=null,citedVersion=null}) {
  check(row);
  const withdrawn=validateStoredTextIdentity({roomId,workItemId,messageId,row,message,post});
  let proposal = null;
  if (["packetId", "basisRevision", "allowOlderBasis"].some(key => Object.hasOwn(post.data, key))) {
    check(previous);
    proposal = proposalContext(post.data, { revision: previous.type === "work.proposed" ? 0 : previous.data.expectedRevision + 1 });
  }
  check(isDeepStrictEqual(message.proposal ?? null, proposal));
  // PRIV-1: a redacted log no longer holds the text. The hash stays on the
  // receipt; the byte length stays on the message.
  if (withdrawn && post.data.body == null) {
    check(post.data.redacted === true && message.body === null);
    const version = citedVersion;
    check(typeof version === "string" && /^sha256:[0-9a-f]{64}$/.test(version));
    check(Number.isInteger(message.redactedByteLength) && message.redactedByteLength > 0);
    return { messageId, messageEventId: post.id, postedById: post.actorId, createdAt: post.at,
      body: null, byteLength: message.redactedByteLength, evidenceVersion: version, evidence: "removed",
      proposal, postSequence: row.sequence, withdrawnAt: message.deletedAt, withdrawnBy: message.deletedBy };
  }
  return { messageId, messageEventId: post.id, postedById: post.actorId, createdAt: post.at,
    body: withdrawn ? null : post.data.body, byteLength: Buffer.byteLength(post.data.body, "utf8"),
    evidenceVersion: textVersion(post.data.body), proposal, postSequence: row.sequence,
    ...(withdrawn ? { withdrawnAt: message.deletedAt, withdrawnBy: message.deletedBy } : {}) };
}

function citedEvidenceVersion(state, messageId) {
  for (const work of Object.values(state.workItems ?? {})) {
    for (const receipt of [...(work.receiptHistory ?? []), work.receipt]) {
      if (receipt?.nativeText?.messageId === messageId && typeof receipt.evidenceVersion === "string") return receipt.evidenceVersion;
    }
  }
  return null;
}

export function verifyTextCompletion(db, state, work, data, { allowWithdrawn = false } = {}) {
  const nativeText = nativeTextEvidence(state, work, data, { allowWithdrawn });
  const text = storedText(db, state, work.id, data.evidenceMessageId, data.evidenceMessageEventId);
  check(text.evidenceVersion === data.evidenceVersion);
  return { nativeText, text };
}

// The result text follows the room's own visibility rules when a named viewer
// reads it. A targeted message (a DM) is visible only to its author and
// addressee; the owner is not exempt (RC-2026-09-19-070). The PRIV-2 history
// floor applies. A withdrawn message keeps its absence shape for its parties,
// so only the party rule and the floor are checked here; body checks stay in
// storedText. No viewer named means an internal call (audit, replay): no gate.
function textVisibleToViewer(db, state, messageId, viewerId, floor, messageRecords = null) {
  if (viewerId === null) return true;
  const message = (messageRecords ?? messageRepository({ db }, state.room.id, state)).get(messageId);
  if (!message) return false;
  if (message.toMemberId && message.authorId !== viewerId && message.toMemberId !== viewerId) return false;
  return messageInHistory(message, floor);
}

// A correction is grounded in the failed verdict on the immediately preceding
// result. Historical-only checks never drove a correction. Reuse the selected
// result's audience rules for the old text before exposing a review of it.
function precedingCorrection(db, state, work, receipt, viewerId, floor, messageRecords) {
  const previous = work.receiptHistory.at(-1);
  if (!previous || !receipt || receipt.eventId !== work.receipt?.eventId) return null;
  if (receipt.nativeText && receipt.nativeText.previousCompletionEventId !== previous.eventId) return null;
  const finding = work.verificationHistory.findLast(entry =>
    !entry.historical && entry.completionEventId === previous.eventId && entry.evidenceVersion === previous.evidenceVersion);
  if (finding?.result !== "fail") return null;
  if (previous.nativeText) {
    const { messageId } = previous.nativeText;
    const oldMessage = (messageRecords ?? messageRepository({ db }, state.room.id, state)).get(messageId);
    if (oldMessage?.deletedAt || !textVisibleToViewer(db, state, messageId, viewerId, floor, messageRecords)) return null;
  }
  // The blocker disappears on resolution. Its verifier-authored instruction
  // remains on the exact verdict event, including for older saved rooms.
  const verdict = db.prepare(`SELECT sequence, json_extract(body,'$.data.nextAction') AS nextAction
    FROM events WHERE room_id=? AND id=?`).get(state.room.id, finding.eventId);
  if (!verdict || verdict.sequence < (floor?.sequence ?? 0)) return null;
  return {
    ...(previous.nativeText ? { sourceMessageId: previous.nativeText.messageId } : {}),
    ...(finding.reworkRequested !== false && typeof verdict.nextAction === "string" && verdict.nextAction.trim()
      ? { nextAction: verdict.nextAction } : {}),
    verificationEventId: finding.eventId, verifierId: finding.verifierId,
    completionEventId: previous.eventId, summary: finding.summary, untrusted: true,
    nextRead: { tool: "room_read_result", arguments: { roomId: state.room.id, workItemId: work.id, completionEventId: previous.eventId } }
  };
}

const RELEASE_CHECKS_PREFIX = "room-release-checks/1\n";
const RELEASE_STAGES = ["build", "browser", "deploy"];

// Release proof can arrive after review. A linked Room message preserves
// the original exact result and verdict and can be read through their scope.
function selectedReleaseChecks(db, state, work, result, viewerId, floor, messageRecords) {
  if (result.kind !== "room_text" || !result.text.body) return null;
  const candidates = new Set([...result.text.body.matchAll(/(?:^Candidate revision: |"sourceRevision"\s*:\s*")([a-f0-9]{40})(?:"|\r?$)/gm)].map(match => match[1]));
  if (candidates.size !== 1) return null;
  const [candidateRevision] = candidates;
  const { receipt, text } = result;
  const reporters = new Set([state.room.ownerId, work.proposedById, work.accountableMemberId, receipt.reportedById].filter(Boolean));
  // Existing work/event index bounds lookup to this one task and result.
  const rows = db.prepare(`SELECT id,body FROM events
    WHERE room_id=? AND json_extract(body,'$.data.workItemId')=?
      AND json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.replyToId')=?
      AND json_extract(body,'$.actorId') IN (SELECT value FROM json_each(?))
      AND sequence>? AND substr(json_extract(body,'$.data.body'),1,?)=?
    ORDER BY sequence DESC LIMIT 20`).all(state.room.id, work.id, text.messageId, JSON.stringify([...reporters]), text.postSequence,
      RELEASE_CHECKS_PREFIX.length, RELEASE_CHECKS_PREFIX);
  const messages = messageRecords ?? messageRepository({ db }, state.room.id, state);
  const checks = new Map();
  let latest = null, smokeTest = null;
  for (const row of rows) {
    const posted = JSON.parse(row.body);
    const messageId = posted.data.messageId || row.id;
    const message = messages.get(messageId);
    if (!message || message.deletedAt || message.editedAt || message.body !== posted.data.body
      || !textVisibleToViewer(db, state, messageId, viewerId, floor, messageRecords)) continue;
    let report;
    try { report = JSON.parse(message.body.slice(RELEASE_CHECKS_PREFIX.length)); } catch { continue; }
    if (report?.completionEventId !== receipt.eventId || report.evidenceVersion !== receipt.evidenceVersion
      || report.candidateRevision !== candidateRevision) continue;
    const entries = RELEASE_STAGES.filter(stage => report.checks?.[stage] !== undefined);
    if (entries.some(stage => {
      const check = report.checks[stage];
      return !["passed", "failed"].includes(check?.status) || check.candidateRevision !== candidateRevision
        || typeof check.summary !== "string" || !check.summary.trim() || check.summary.length > 600
        || !/^sha256:[a-f0-9]{64}$/.test(check.evidenceDigest ?? "");
    })) continue;
    latest ??= { messageId, recordedAt: message.createdAt, reportedById: message.authorId };
    smokeTest ??= releaseSmokePlan(report.smokeTest);
    // An omitted stage does not supersede an earlier report for that stage.
    for (const stage of entries) {
      if (checks.has(stage)) continue;
      const check = report.checks[stage];
      const evidenceId = check.evidenceMessageId;
      const evidence = typeof evidenceId === "string" && evidenceId.length <= 128 ? messages.get(evidenceId) : null;
      const binding = `room-release-receipt/1 ${stage} ${receipt.eventId} ${candidateRevision} ${check.evidenceDigest}\n`;
      if (!evidence || evidence.deletedAt || evidence.editedAt || evidence.authorId !== message.authorId
        || evidence.workItemId !== work.id || evidence.replyToId !== text.messageId || !evidence.body?.startsWith(binding)
        || !textVisibleToViewer(db, state, evidenceId, viewerId, floor, messages)) {
        checks.set(stage, { stage, status: "pending" });
        continue;
      }
      checks.set(stage, { stage, status: check.status, summary: check.summary, evidenceDigest: check.evidenceDigest,
        reportedById: message.authorId, reportMessageId: messageId, evidenceMessageId: evidenceId, href: `#pr-record/message/${encodeURIComponent(evidenceId)}` });
    }
    if (checks.size === RELEASE_STAGES.length && smokeTest) break;
  }
  return latest ? { ...latest, candidateRevision, ...(smokeTest ? { smokeTest } : {}),
    checks: RELEASE_STAGES.map(stage => checks.get(stage) ?? { stage, status: "pending" }),
    completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion, untrusted: true } : null;
}

// Read the last start for this completion interval, without borrowing a
// start from a previous result when a correction was submitted directly.
function selectedStart(db, roomId, workItemId, completionEventId, floor) {
  const row = db.prepare(`SELECT id,sequence,json_extract(body,'$.type') AS type,
      json_extract(body,'$.actorId') AS actorId,json_extract(body,'$.at') AS at
    FROM events WHERE room_id=? AND json_extract(body,'$.data.workItemId')=?
      AND sequence < (SELECT sequence FROM events WHERE room_id=? AND id=?)
      AND json_extract(body,'$.type') IN ('work.started','work.completed')
    ORDER BY sequence DESC LIMIT 1`).get(roomId, workItemId, roomId, completionEventId);
  if (row?.type !== 'work.started' || row.sequence < (floor?.sequence ?? 0)) return null;
  return { eventId: row.id, sequence: row.sequence, actorId: row.actorId, at: row.at };
}

// Surface the exact verdict that governed this completion. A later audit
// of a historical result did not govern that result or the current gate.
function selectedVerdict(db, roomId, work, receipt, floor) {
  const matches = verdict => verdict && !verdict.historical
    && verdict.completionEventId === receipt.eventId && verdict.evidenceVersion === receipt.evidenceVersion;
  const verdict = matches(work.verification) ? work.verification : work.verificationHistory.findLast(matches);
  if (!verdict) return null;
  if (floor) {
    const row = db.prepare("SELECT sequence FROM events WHERE room_id=? AND id=?").get(roomId, verdict.eventId);
    if (!row || row.sequence < floor.sequence) return null;
  }
  const { eventId, result, verifierId, completionEventId, evidenceVersion, independenceConfirmed } = verdict;
  return { eventId, result, verifierId, completionEventId, evidenceVersion, independenceConfirmed };
}

export function selectedWorkResult({ db, state, workItemId, sequence, now, completionEventId, draftMessageId, viewerId = null, reviewer = null, floor = null, messageRecords = null, readOutcomeWork = null }) {
  const work = state.workItems[workItemId];
  let result;
  const deny = () => { throw new Error("Result text is hidden from this viewer"); };
  if (draftMessageId !== null) {
    if (!textVisibleToViewer(db, state, draftMessageId, viewerId, floor, messageRecords)) deny();
    result = { kind: "draft", text: storedText(db, state, workItemId, draftMessageId, null, messageRecords) };
  } else {
    const receipt = completionEventId === null ? work.receipt : [...work.receiptHistory, work.receipt].find(receipt => receipt?.eventId === completionEventId);
    if (completionEventId !== null && !receipt) return null;
    result = !receipt ? { kind: "none" } : { kind: receipt.nativeText ? "room_text" : "external", receipt: structuredClone(receipt),
      ...(receipt.nativeText ? { text: storedText(db, state, workItemId, receipt.nativeText.messageId, receipt.nativeText.messageEventId, messageRecords) } : {}) };
    if (receipt?.nativeText) {
      if (!textVisibleToViewer(db, state, receipt.nativeText.messageId, viewerId, floor, messageRecords)) deny();
      check(result.text.evidenceVersion === receipt.evidenceVersion);
    }
  }
  const next = nextWorkStep(work, now);
  const selectionStatus = result.receipt
    ? (result.receipt.eventId === work.receipt?.eventId ? "current" : "historical")
    : result.kind;
  const review = selectionStatus === "current" && next.action === "verify"
    && result.text?.body !== null && workActions(work, reviewer, now).some(([action]) => action === "verify")
    ? { criteria: work.definitionOfDone, runtimeDispatchFence: true,
        origin: { proposedById: work.proposedById, createdAt: work.createdAt, mode: work.mode,
          independentVerificationRequired: work.independentVerificationRequired === true },
        action: { tool: "room_record_verification", arguments: { roomId: state.room.id, workItemId,
          expectedRevision: work.revision, completionEventId: result.receipt.eventId,
          evidenceVersion: result.receipt.evidenceVersion }, inputRequired: ["result", "summary"] },
        guidance: "Check each criterion against evidence for this exact completion. Producer claims and external references require independent verification. Summarize what passed, failed, was skipped, or could not be verified. The Room rechecks authority and revision when recording the verdict." }
    : null;
  const correction = result.text?.body === null ? null
    : precedingCorrection(db, state, work, result.receipt, viewerId, floor, messageRecords);
  const releaseChecks = selectedReleaseChecks(db, state, work, result, viewerId, floor, messageRecords);
  const outcome = readOutcomeWork && selectionStatus === "current"
    ? releaseOutcome({ releaseChecks, work, readWork: readOutcomeWork, now, ownerId: state.room.ownerId,
        visibleSmokeEvidence: smoke => {
          const id = smoke.receipt?.nativeText?.messageId;
          const message = id && (messageRecords ?? messageRepository({ db }, state.room.id, state)).get(id);
          return Boolean(message && message.workItemId === smoke.id && !message.deletedAt && !message.editedAt
            && textVisibleToViewer(db, state, id, viewerId, floor, messageRecords));
        } }) : null;
  const visibleReceipt = result.text?.body === null ? null : result.receipt;
  const start = visibleReceipt ? selectedStart(db, state.room.id, workItemId, visibleReceipt.eventId, floor) : null;
  const verdict = visibleReceipt ? selectedVerdict(db, state.room.id, work, visibleReceipt, floor) : null;
  const pendingCorrection = selectionStatus === "current" && next.action === "revise"
    && verdict?.result === "fail" && work.blocker?.eventId === verdict.eventId
    ? { verificationEventId: verdict.eventId, completionEventId: verdict.completionEventId,
        evidenceVersion: verdict.evidenceVersion, summary: work.blocker.reason,
        nextAction: work.blocker.nextAction, untrusted: true,
        ...(workActions(work, reviewer, now).some(([action]) => action === "resolve")
          ? { action: { tool: "room_resolve_blocker", arguments: {
              roomId: state.room.id, workItemId, expectedRevision: work.revision
            }, inputRequired: ["resolution"] } } : {}) }
    : null;
  return { contractVersion: 1, roomId: state.room.id, workItemId,
    workThread: { workItemId, href: workThreadHref(workItemId), ...(start ? { start } : {}), ...(verdict ? { verdict } : {}),
      ...(correction ? { correction } : {}), ...(pendingCorrection ? { pendingCorrection } : {}),
      ...(releaseChecks ? { releaseChecks } : {}), ...(outcome ? { outcome } : {}) },
    selection: { completionEventId, draftMessageId, status: selectionStatus }, result,
    ...(result.kind === "room_text" && typeof result.text?.body === "string"
      ? { discussionRead: { method: "GET", path: resultDiscussionPath(state.room.id, result.text.messageId) } } : {}),
    ...(review ? { review } : {}),
    current: { evaluatedAt: new Date(now).toISOString(), evaluatedThrough: sequence, workRevision: work.revision,
      completionEventId: work.receipt?.eventId ?? null, next },
    scope: { membership: "room", selectedWorkOnly: true, externalExecution: false, contentAuthority: "untrusted-data" } };
}

// Check every native receipt, including history hidden behind a legacy checkpoint.
export function auditTextResults(db, state, history) {
  const previous = new Map(), projected = new Map(), audited = new Set();
  for (const work of Object.values(state.workItems)) for (const receipt of [...work.receiptHistory, work.receipt]) {
    if (!receipt?.nativeText) continue;
    check(!projected.has(receipt.eventId)); projected.set(receipt.eventId, work.id);
  }
  for (const row of history) {
    const event = JSON.parse(row.body);
    if (event.type !== "work.completed") continue;
    const data = event.data, work = state.workItems[data.workItemId], parent = previous.get(data.workItemId) ?? null;
    if (data.evidenceKind === "room_text") {
      check(work && projected.get(event.id) === work.id && !audited.has(event.id)); audited.add(event.id);
      // allowWithdrawn: the state itself says whether the text was later taken
      // out of the room. A completion recorded before that still has to
      // reconstruct exactly, including the withdrawal the deletion wrote onto
      // it - the whole point of this audit is that the stored receipt is
      // nothing but a replay of the log.
      const { nativeText, text } = verifyTextCompletion(db, state, { ...work, receipt: parent ? { eventId: parent } : null }, data, { allowWithdrawn: true });
      const receipt = [...work.receiptHistory, work.receipt].find(receipt => receipt?.eventId === event.id);
      auditTextReceipt({event,row,receipt,nativeText,text});
    }
    previous.set(data.workItemId, event.id);
  }
  check(audited.size === projected.size);
}

// Exact receipt projection equality shared by full and durable audit paths.
export function auditTextReceipt({event,row,receipt,nativeText,text}) {
  const data=event.data;
      // Legacy stored receipts predate result segments; treat a missing
      // segments field as the null backfill the new applier writes.
      const normalized = { ...receipt, segments: receipt?.segments ?? null };
      check(text.postSequence < row.sequence && isDeepStrictEqual(normalized, {
        reportedById: event.actorId, ...reportedProducer(data),
        summary: data.summary, evidenceUrl: null, nativeText, evidenceVersion: data.evidenceVersion,
        checksClaimed: data.checksClaimed || [], segments: validateResultSegments(data.segments),
        nextAction: data.nextAction, eventId: event.id
      }));
}
