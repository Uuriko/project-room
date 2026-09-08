import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { nativeTextEvidence, validResultBody, proposalContext } from "../src/work-packet.js";
import { nextWorkStep } from "../src/workflow.js";

const check = condition => { if (!condition) throw new Error("Native result evidence requires reconciliation"); };
export const textVersion = body => {
  check(validResultBody(body));
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
};

// Retained events, not the truncated browser tail, bind old messages to their post.
export function storedText(db, state, workItemId, messageId, messageEventId = null) {
  const row = messageEventId
    ? db.prepare("SELECT sequence,id,body FROM events WHERE room_id=? AND id=?").get(state.room.id, messageEventId)
    : db.prepare("SELECT sequence,id,body FROM events WHERE room_id=? AND json_extract(body,'$.type')='message.posted' AND coalesce(json_extract(body,'$.data.messageId'),id)=?").get(state.room.id, messageId);
  check(row);
  const post = JSON.parse(row.body), message = state.messages.find(message => message.id === messageId);
  check(message && post.type === "message.posted" && post.roomId === state.room.id && post.id === row.id
    && (post.data.messageId || post.id) === messageId && post.data.workItemId === workItemId && message.workItemId === workItemId
    && post.data.body === message.body && post.actorId === message.authorId && post.at === message.createdAt
    && (post.data.replyToId || null) === message.replyToId && (post.data.toMemberId || null) === message.toMemberId);
  let proposal = null;
  if (["packetId", "basisRevision", "allowOlderBasis"].some(key => Object.hasOwn(post.data, key))) {
    const prior = db.prepare("SELECT body FROM events WHERE room_id=? AND sequence<? AND json_extract(body,'$.data.workItemId')=? AND (json_extract(body,'$.type')='work.proposed' OR json_type(body,'$.data.expectedRevision')='integer') ORDER BY sequence DESC LIMIT 1").get(state.room.id, row.sequence, workItemId);
    check(prior);
    const previous = JSON.parse(prior.body);
    proposal = proposalContext(post.data, { revision: previous.type === "work.proposed" ? 0 : previous.data.expectedRevision + 1 });
  }
  check(isDeepStrictEqual(message.proposal ?? null, proposal));
  return { messageId, messageEventId: post.id, postedById: post.actorId, createdAt: post.at,
    body: message.body, byteLength: Buffer.byteLength(message.body, "utf8"), evidenceVersion: textVersion(message.body), proposal,
    postSequence: row.sequence };
}

export function verifyTextCompletion(db, state, work, data) {
  const nativeText = nativeTextEvidence(state, work, data);
  const text = storedText(db, state, work.id, data.evidenceMessageId, data.evidenceMessageEventId);
  check(text.evidenceVersion === data.evidenceVersion);
  return { nativeText, text };
}

export function selectedWorkResult({ db, state, workItemId, sequence, now, completionEventId, draftMessageId }) {
  const work = state.workItems[workItemId];
  let result;
  if (draftMessageId !== null) result = { kind: "draft", text: storedText(db, state, workItemId, draftMessageId) };
  else {
    const receipt = completionEventId === null ? work.receipt : [...work.receiptHistory, work.receipt].find(receipt => receipt?.eventId === completionEventId);
    if (completionEventId !== null && !receipt) return null;
    result = !receipt ? { kind: "none" } : { kind: receipt.nativeText ? "room_text" : "external", receipt: structuredClone(receipt),
      ...(receipt.nativeText ? { text: storedText(db, state, workItemId, receipt.nativeText.messageId, receipt.nativeText.messageEventId) } : {}) };
    if (receipt?.nativeText) check(result.text.evidenceVersion === receipt.evidenceVersion);
  }
  return { contractVersion: 1, roomId: state.room.id, workItemId,
    selection: { completionEventId, draftMessageId }, result,
    current: { evaluatedAt: new Date(now).toISOString(), evaluatedThrough: sequence, workRevision: work.revision,
      completionEventId: work.receipt?.eventId ?? null, next: nextWorkStep(work, now) },
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
      const { nativeText, text } = verifyTextCompletion(db, state, { ...work, receipt: parent ? { eventId: parent } : null }, data);
      const receipt = [...work.receiptHistory, work.receipt].find(receipt => receipt?.eventId === event.id);
      check(text.postSequence < row.sequence && isDeepStrictEqual(receipt, {
        reportedById: event.actorId, producerId: data.producerId, producerAttribution: data.producerId === null ? "unknown" : "reported",
        summary: data.summary, evidenceUrl: null, nativeText, evidenceVersion: data.evidenceVersion,
        checksClaimed: data.checksClaimed || [], nextAction: data.nextAction, eventId: event.id
      }));
    }
    previous.set(data.workItemId, event.id);
  }
  check(audited.size === projected.size);
}
