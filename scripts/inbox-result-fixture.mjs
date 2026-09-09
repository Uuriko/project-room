// Scripted participants and synthetic local data only, never hosted execution.
import { randomUUID } from "node:crypto";
import { textVersion } from "../server/text-results.mjs";

export function prepareInboxResult(f, token, binding, { sourceId = "note", ready = true } = {}) {
  const roomId = "commons", workItemId = "inbox-reply-" + randomUUID();
  const source = f.store.inbox.read(token, sourceId, binding).source;
  const context = f.store.inbox.shareContext(token, sourceId, roomId, binding);
  const share = f.store.inbox.apply(token, { action: "source.share", requestId: randomUUID(), sourceId,
    sourceRevision: source.revision, roomId, audienceVersion: context.audienceVersion, paragraphs: [0] }, binding);
  const send = (actor, type, data) => f.store.command(f.keys[actor], roomId, { id: randomUUID(), type, data });
  send("owner", "work.proposed", { workItemId, title: "A warmer reply", definitionOfDone: "Warm, concise reply based only on the shared excerpt.",
    sourceMessageId: share.receipt.messageId, accountableMemberId: "producer", verifierMemberId: "reviewer", humanDecisionMakerId: "owner",
    independentVerificationRequired: true, ownerDecisionRequired: true, mode: "read" });
  const item = () => f.store.room(roomId).state.workItems[workItemId];
  const mutate = (actor, type, data = {}) => send(actor, type, { workItemId, expectedRevision: item().revision, ...data });
  mutate("producer", "work.accepted");
  const body = "Hello Maya,\n\nA quieter launch sounds good. Let’s keep one clear next step. 🪷";
  const complete = (value = body) => {
    const messageId = randomUUID(), post = send("producer", "message.posted", { messageId, workItemId, packetId: randomUUID(), basisRevision: item().revision, body: value });
    return mutate("producer", "work.completed", { evidenceKind: "room_text", evidenceMessageId: messageId, evidenceMessageEventId: post.event.id,
      evidenceVersion: textVersion(value), previousCompletionEventId: item().receipt?.eventId ?? null, producerId: "producer", summary: "A warmer reply", nextAction: "Review exact text" });
  };
  const review = (result = "pass") => mutate("reviewer", "verification.recorded", { result,
    completionEventId: item().receipt.eventId, evidenceVersion: item().receipt.evidenceVersion, summary: result === "pass" ? "Checked the exact text against shared context." : "Needs a revision." });
  const decide = (decision = "approved") => mutate("owner", "owner.decision_recorded", { decision,
    completionEventId: item().receipt.eventId, evidenceVersion: item().receipt.evidenceVersion, reason: "Reviewed for a private draft, not external sending." });
  const selected = () => f.store.inbox.results(token, sourceId, roomId, binding, workItemId).results[0];
  const adoption = (extra = {}) => ({ action: "draft.adopt", requestId: randomUUID(), sourceId, expectedRevision: f.store.inbox.read(token, sourceId, binding).draft?.revision ?? 0,
    sourceRevision: source.revision, roomId, workItemId, shareRequestId: share.receipt.requestId, resultVersion: selected().resultVersion, ...extra });
  if (ready) { complete(); review(); decide(); }
  return { body, roomId, sourceId, workItemId, share, send, mutate, item, complete, review, decide, selected, adoption };
}
