// Provider-shaped qualification only. No fetch, credentials, persistence or sends.
import { emailDigest, emailOpaqueId, emailInput, previewEmailReply, requireEmail, EmailContractError } from "./email-envelope.mjs";
import { normalizeGraphEmail } from "./graph-email.mjs";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (code, message) => { throw new ServiceError(409, code, message); };
const lf = value => value.replace(/\r\n?/g, "\n");
const addresses = values => values.map(({ address }) => {
  const at = address.lastIndexOf("@"); return address.slice(0, at) + address.slice(at).toLowerCase();
}).sort();
const same = (a, b) => a !== undefined && b !== undefined && emailDigest(a) === emailDigest(b);

export function prepareGraphReplyDraft({ store, token, binding, sourceId, requestId, mode = "reply" }) {
  requireEmail(validId(requestId), "invalid_email_reply_request");
  return store.readTransaction(() => {
    const auth = store.inbox.auth(token, binding), { source, draft } = store.inbox.read(token, sourceId, binding);
    if (source.adapter !== "email" || !draft?.body.trim() || draft.sourceRevision !== source.revision)
      fail("stale_email_reply", "Save a reply to the current email first.");
    const connection = store.email.connection(auth.account.id, source.envelope.connection.id);
    if (!connection || connection.mode !== "fixture" || connection.state !== "active" || connection.authEpoch !== auth.account.authEpoch)
      fail("email_connection_changed", "Reconnect and refresh this email before preparing a provider draft.");
    let preview;
    try { preview = previewEmailReply(source.envelope, connection.profile, { mode, body: draft.body }); }
    catch (error) { if (error instanceof EmailContractError) fail(error.code, "Reply context needs review."); throw error; }
    const plan = { contractVersion: 1, purpose: "fixture-reply-draft", requestId, mode,
      accountId: auth.account.id, authEpoch: auth.account.authEpoch, sourceId, sourceRevision: source.revision,
      sourceVersion: source.envelope.sourceVersion, sourceMessageId: source.envelope.message.id, draftRevision: draft.revision, connection: connection.profile,
      expected: { from: preview.from, to: preview.to, cc: preview.cc, bcc: [], subject: preview.subject,
        body: preview.body, threadId: source.envelope.message.threadId },
      create: { method: "POST", url: "https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(connection.profile.mailboxId)
        + "/messages/" + encodeURIComponent(source.envelope.message.id) + (mode === "reply" ? "/createReply" : "/createReplyAll"),
        headers: { "Content-Type": "application/json", Prefer: 'IdType="ImmutableId"' },
        body: { message: { body: { contentType: "text", content: preview.body } } } },
      requiredPermission: "Mail.ReadWrite", canExecute: false, canSend: false };
    return { ...plan, planVersion: emailDigest(plan) };
  });
}

// Re-read authority and exact local intent. A matching hash alone is not a grant.
export function currentGraphReplyDraft({ store, token, binding, plan }) {
  emailInput(plan);
  const current = prepareGraphReplyDraft({ store, token, binding, sourceId: plan?.sourceId, requestId: plan?.requestId, mode: plan?.mode });
  if (!same(current, plan)) fail("stale_email_reply_plan", "The reply or its authority changed. Prepare it again.");
  return current;
}

export function observeGraphReplyCreation({ store, token, binding, plan, response }) {
  currentGraphReplyDraft({ store, token, binding, plan }); emailInput(response);
  const unknown = { status: "creation_unconfirmed", planVersion: plan.planVersion, providerDraftId: null, canRetryCreate: false, canSend: false };
  if (response?.status !== 201 || response.idType !== "immutable" || !same(response.connection, plan.connection)) return unknown;
  try { emailOpaqueId(response.message?.id); } catch (error) { if (error instanceof EmailContractError) return unknown; throw error; }
  if (response.message.id === plan.sourceMessageId) return unknown;
  // This identity must be journaled with the original attempt before a live read.
  return { ...unknown, status: "created_unverified", providerDraftId: response.message.id };
}

export function inspectGraphReplyDraft({ store, token, binding, plan, providerDraftId, response }) {
  const current = currentGraphReplyDraft({ store, token, binding, plan });
  emailOpaqueId(providerDraftId); emailInput(response);
  const base = { planVersion: current.planVersion, providerDraftId, canRetryCreate: false, canSend: false };
  if (response?.status !== 200) return { ...base, status: "draft_unavailable", differences: [], reviewVersion: null };
  requireEmail(same(response.connection, current.connection), "email_reply_scope_changed");
  const observed = normalizeGraphEmail(current.connection, response.message, response.options);
  requireEmail(observed.message.id === providerDraftId, "email_reply_identity_changed");
  const { message: m, body, attachments } = observed, e = current.expected, differences = [];
  const check = (name, condition) => { if (!condition) differences.push(name); };
  check("draft_state", m.isDraft); check("thread", m.threadId === e.threadId);
  check("from", same(addresses([m.from]), addresses([e.from])));
  check("sender", same(addresses([m.sender]), addresses([e.from])));
  for (const field of ["to", "cc", "bcc"]) check(field, same(addresses(m[field]), addresses(e[field])));
  check("subject", m.subject === e.subject);
  check("body", body.format === "text" && lf(body.content) === lf(e.body));
  check("attachments", attachments.state === "complete" && attachments.items.length === 0);
  // No raw HTML or incoming quoted source is promoted to an actionable preview.
  const draft = { id: m.id, revision: m.revision, from: m.from, sender: m.sender, to: m.to, cc: m.cc, bcc: m.bcc,
    subject: m.subject, body: body.format === "text" ? body.content : null, format: body.format,
    attachmentState: attachments.state, attachmentCount: attachments.items.length };
  return { ...base, status: differences.length ? "needs_review" : "content_matches", differences, draft,
    reviewVersion: emailDigest({ planVersion: current.planVersion, providerDraftId, observedVersion: observed.sourceVersion, differences }) };
}
