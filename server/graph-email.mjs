// Normalize fully hydrated Graph JSON. This module never fetches URLs or sends mail.
import { createEmailEnvelope, emailConnection, emailInput, emailOpaqueId, emailText, exactEmailFields, requireEmail } from "./email-envelope.mjs";

const recipient = value => { requireEmail(value?.emailAddress); return { name: value.emailAddress.name ?? "", address: value.emailAddress.address }; };
const recipients = values => { requireEmail(Array.isArray(values)); return values.map(recipient); };
function replyHeaders(values) {
  if (values === undefined) return { state: "not_loaded", inReplyTo: [], references: [] };
  requireEmail(Array.isArray(values) && values.length <= 500);
  const result = { state: "complete", inReplyTo: [], references: [] };
  for (const header of values) {
    const name = emailText(header?.name, 240).toLowerCase();
    // Header values stay opaque data. Unfold legal line folding; never form MIME.
    requireEmail(typeof header.value === "string");
    const value = emailText(header.value.replace(/\r\n[ \t]+/g, " "), 8192, { empty: true });
    if (name === "in-reply-to" && value.trim()) result.inReplyTo.push(value);
    if (name === "references" && value.trim()) result.references.push(value);
  }
  return result;
}
function attachments(message, observation) {
  if (observation === null) return { state: "not_loaded", hint: message.hasAttachments, items: [] };
  requireEmail(exactEmailFields(observation, ["messageId", "messageRevision", "complete", "items"]), "invalid_email_attachment_observation");
  requireEmail(observation && observation.messageId === message.id && observation.messageRevision === message.changeKey, "email_attachment_version_changed");
  requireEmail(typeof observation.complete === "boolean" && Array.isArray(observation.items));
  return { state: observation.complete ? "complete" : "partial", hint: message.hasAttachments,
    items: observation.items.map(item => {
      const kind = { "#microsoft.graph.fileAttachment": "file", "#microsoft.graph.itemAttachment": "item", "#microsoft.graph.referenceAttachment": "reference" }[item?.["@odata.type"]];
      requireEmail(kind, "unsupported_email_attachment");
      return { id: item.id, kind, name: item.name, contentType: item.contentType ?? null, size: item.size,
        inline: item.isInline, contentId: item.contentId ?? null };
    }) };
}
export function normalizeGraphEmail(connection, message, { idType, attachmentObservation = null } = {}) {
  emailInput({ connection, message, attachmentObservation });
  requireEmail(idType === "immutable", "email_immutable_ids_required");
  requireEmail(message && !Object.hasOwn(message, "@removed") && message.body, "email_hydration_required");
  return createEmailEnvelope({ connection,
    message: { id: message.id, revision: message.changeKey, threadId: message.conversationId,
      internetMessageId: message.internetMessageId ?? null, folderId: message.parentFolderId,
      subject: message.subject, sentAt: message.sentDateTime ?? null, receivedAt: message.receivedDateTime ?? null,
      from: recipient(message.from), sender: recipient(message.sender), replyTo: recipients(message.replyTo),
      to: recipients(message.toRecipients), cc: recipients(message.ccRecipients), bcc: recipients(message.bccRecipients),
      isDraft: message.isDraft, isRead: message.isRead },
    body: { format: typeof message.body.contentType === "string" ? message.body.contentType.toLowerCase() : null, content: message.body.content },
    replyHeaders: replyHeaders(message.internetMessageHeaders), attachments: attachments(message, attachmentObservation) });
}

// Folder delta entries are invalidations, not complete messages or global tombstones.
// A persistence driver must hydrate changes, commit a page with its cursor atomically,
// and keep missing-folder observations separate from local draft retention.
export function graphFolderChanges(connectionValue, folderId, page, { idType } = {}) {
  emailInput(page);
  const connection = emailConnection(connectionValue); emailOpaqueId(folderId);
  requireEmail(idType === "immutable", "email_immutable_ids_required");
  requireEmail(page && Array.isArray(page.value) && page.value.length <= 1000, "invalid_email_delta");
  const next = page["@odata.nextLink"], delta = page["@odata.deltaLink"];
  requireEmail(typeof next === "string" && delta === undefined || typeof delta === "string" && next === undefined, "invalid_email_delta");
  const cursor = emailText(next ?? delta, 16384);
  // Preserve the opaque cursor; callers must qualify its origin/path before fetching.
  const changes = Array.from(page.value, value => {
    const messageId = emailOpaqueId(value?.id);
    if (Object.hasOwn(value, "@removed")) {
      requireEmail(value["@removed"]?.reason === "deleted", "unsupported_email_delta");
      return { messageId, action: "absent-from-folder" };
    }
    return { messageId, action: "hydrate" };
  });
  return { contractVersion: 1, connection, folderId, changes, cursor, complete: delta !== undefined };
}
