// Deliberately invented provider history. Not a provider driver or runtime asset.
import { randomUUID } from "node:crypto";
import { createEmailEnvelope } from "../server/email-envelope.mjs";
import { prepareGraphReplyDraft } from "../server/graph-reply-draft.mjs";

export function seedRecordedReply({ store, token, binding, sourceId }) {
  const source = store.inbox.read(token, sourceId, binding);
  if (!source.draft) store.inbox.apply(token, { action: "draft.save", requestId: randomUUID(), sourceId,
    sourceRevision: source.source.revision, expectedRevision: 0, body: "That sounds good. Let’s start with one small step." }, binding);
  const plan = prepareGraphReplyDraft({ store, token, binding, sourceId, requestId: randomUUID() });
  const apply = request => store.inbox.reply(token, { requestId: randomUUID(), sourceId, ...request }, binding);
  apply({ action: "reply.reserve", requestId: plan.requestId, mode: plan.mode, planVersion: plan.planVersion });
  apply({ action: "reply.dispatch", attemptId: plan.requestId, expectedRevision: 0 });
  const providerDraftId = "fixture-provider-" + randomUUID();
  apply({ action: "reply.created", attemptId: plan.requestId, expectedRevision: 1, planVersion: plan.planVersion, providerDraftId });
  const basis = { connection: plan.connection,
    message: { ...source.source.envelope.message, id: providerDraftId, revision: "fixture-draft-v1", isDraft: true,
      from: plan.expected.from, sender: plan.expected.from, replyTo: [], to: plan.expected.to, cc: plan.expected.cc, bcc: [],
      subject: "Re: " + plan.expected.subject }, body: { format: "text", content: plan.expected.body },
    replyHeaders: { state: "complete", inReplyTo: [], references: [] }, attachments: { state: "complete", hint: false, items: [] } };
  const observe = (change = {}) => {
    const attempt = store.inbox.replyHistory(plan.accountId, sourceId).get(plan.requestId);
    const value = change === null ? null : createEmailEnvelope({ ...structuredClone(basis), ...change,
      message: { ...structuredClone(basis.message), ...change.message } });
    return apply({ action: "reply.observed", attemptId: plan.requestId, expectedRevision: attempt.revision, observation: value });
  };
  observe(); return { plan, providerDraftId, observe };
}
