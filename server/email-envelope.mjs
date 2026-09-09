// Data contract only: no credentials, network, persistence or send authority.
import { createHash } from "node:crypto";

export const emailLimits = Object.freeze({ bodyBytes: 262144, recipients: 200, attachments: 100, inputBytes: 2097152 });
export class EmailContractError extends TypeError {
  constructor(code) { super(code); this.name = "EmailContractError"; this.code = code; }
}
export const requireEmail = (condition, code = "invalid_email") => { if (!condition) throw new EmailContractError(code); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const exactEmailFields = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function emailText(value, max, { empty = false, multiline = false } = {}) {
  requireEmail(typeof value === "string" && value.isWellFormed() && (empty || value.trim().length > 0)
    && Buffer.byteLength(value) <= max && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value));
  return value;
}
export function emailInput(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new EmailContractError("invalid_email"); }
  requireEmail(typeof serialized === "string" && Buffer.byteLength(serialized) <= emailLimits.inputBytes, "email_input_limit");
  return value;
}
const canonical = value => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : object(value)
  ? "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}" : JSON.stringify(value);
export const emailDigest = value => createHash("sha256").update(canonical(value)).digest("hex");
export const emailSourceId = (connection, messageId) => {
  const c = emailConnection(connection);
  return "email-" + emailDigest([c.accountId, c.provider, c.mailboxId, emailOpaqueId(messageId)]);
};
const localId = value => { requireEmail(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)); return value; };
export const emailOpaqueId = value => emailText(value, 2048);
const count = (value, max) => {
  requireEmail(Array.isArray(value) && value.length <= max && Array.from(value.keys()).every(i => Object.hasOwn(value, i)));
  return value;
};
const boolean = value => { requireEmail(typeof value === "boolean"); return value; };
const timestamp = value => {
  if (value === null) return null;
  emailText(value, 40);
  requireEmail(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value)));
  // Reject JavaScript's silent normalization of impossible calendar dates.
  requireEmail(new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
  return value;
};
export function emailAddress(value) {
  requireEmail(exactEmailFields(value, ["name", "address"]));
  const name = emailText(value.name, 1024, { empty: true }), address = emailText(value.address, 320);
  // These are provider-parsed addr-specs, never a comma-split RFC header parser.
  // Unqualified exotic addr-spec syntax is refused instead of guessed.
  requireEmail(/^[^\s@<>(),;:"\\\[\]]+@[^\s@<>(),;:"\\\[\]]+$/.test(address), "unsupported_email_address");
  return { name, address };
}
const addresses = value => count(value, emailLimits.recipients).map(emailAddress);
// Keep the local part case-sensitive; domain case does not change identity.
const addressKey = value => { const at = value.address.lastIndexOf("@"); return value.address.slice(0, at) + "@" + value.address.slice(at + 1).toLowerCase(); };
export function emailConnection(value) {
  requireEmail(exactEmailFields(value, ["accountId", "id", "revision", "provider", "mailboxId", "identity", "aliases"]), "invalid_email_connection");
  requireEmail(value.provider === "microsoft-graph" && Number.isSafeInteger(value.revision) && value.revision > 0, "invalid_email_connection");
  return { accountId: localId(value.accountId), id: localId(value.id), revision: value.revision,
    provider: value.provider, mailboxId: emailOpaqueId(value.mailboxId), identity: emailAddress(value.identity), aliases: addresses(value.aliases) };
}
function attachment(value) {
  requireEmail(exactEmailFields(value, ["id", "kind", "name", "contentType", "size", "inline", "contentId"]));
  requireEmail(["file", "item", "reference"].includes(value.kind) && Number.isSafeInteger(value.size) && value.size >= 0);
  return { id: emailOpaqueId(value.id), kind: value.kind, name: emailText(value.name, 2048, { empty: true }),
    contentType: value.contentType === null ? null : emailText(value.contentType, 240), size: value.size,
    inline: boolean(value.inline), contentId: value.contentId === null ? null : emailText(value.contentId, 2048) };
}
const messageFields = ["id", "revision", "threadId", "internetMessageId", "folderId", "subject", "sentAt", "receivedAt",
  "from", "sender", "replyTo", "to", "cc", "bcc", "isDraft", "isRead"];
export function createEmailEnvelope(input) {
  emailInput(input);
  requireEmail(exactEmailFields(input, ["connection", "message", "body", "replyHeaders", "attachments"]));
  const connection = emailConnection(input.connection), m = input.message;
  requireEmail(exactEmailFields(m, messageFields));
  const message = { id: emailOpaqueId(m.id), revision: emailOpaqueId(m.revision), threadId: emailOpaqueId(m.threadId),
    internetMessageId: m.internetMessageId === null ? null : emailText(m.internetMessageId, 2048), folderId: emailOpaqueId(m.folderId),
    subject: emailText(m.subject, 4096, { empty: true }), sentAt: timestamp(m.sentAt), receivedAt: timestamp(m.receivedAt),
    from: emailAddress(m.from), sender: emailAddress(m.sender), replyTo: addresses(m.replyTo), to: addresses(m.to),
    cc: addresses(m.cc), bcc: addresses(m.bcc), isDraft: boolean(m.isDraft), isRead: boolean(m.isRead) };
  requireEmail([message.replyTo, message.to, message.cc, message.bcc].reduce((n, a) => n + a.length, 0) <= emailLimits.recipients, "email_recipient_limit");
  requireEmail(exactEmailFields(input.body, ["format", "content"]) && ["text", "html"].includes(input.body.format));
  const body = { format: input.body.format, content: emailText(input.body.content, emailLimits.bodyBytes, { empty: true, multiline: true }) };
  const h = input.replyHeaders;
  requireEmail(exactEmailFields(h, ["state", "inReplyTo", "references"]) && ["not_loaded", "complete"].includes(h.state));
  const replyHeaders = { state: h.state, inReplyTo: count(h.inReplyTo, 10).map(v => emailText(v, 8192)), references: count(h.references, 10).map(v => emailText(v, 8192)) };
  requireEmail(h.state !== "not_loaded" || !replyHeaders.inReplyTo.length && !replyHeaders.references.length);
  const a = input.attachments;
  requireEmail(exactEmailFields(a, ["state", "hint", "items"]) && ["not_loaded", "partial", "complete"].includes(a.state));
  const attachments = { state: a.state, hint: boolean(a.hint), items: count(a.items, emailLimits.attachments).map(attachment) };
  requireEmail(new Set(attachments.items.map(item => item.id)).size === attachments.items.length, "duplicate_email_attachment");
  requireEmail(a.state !== "not_loaded" || !attachments.items.length);
  // hasAttachments=false excludes inline attachments in Graph; it is only a hint.
  requireEmail(a.state !== "complete" || attachments.hint === attachments.items.some(item => !item.inline), "email_attachment_observation_conflict");
  const content = { connection, message, body, replyHeaders, attachments };
  const sourceId = emailSourceId(connection, message.id);
  return { contractVersion: 1, channel: "email", sourceId, sourceVersion: emailDigest(content), ...content };
}
export function readEmailEnvelope(value) {
  requireEmail(exactEmailFields(value, ["contractVersion", "channel", "sourceId", "sourceVersion", "connection", "message", "body", "replyHeaders", "attachments"]));
  const clean = createEmailEnvelope({ connection: value.connection, message: value.message, body: value.body, replyHeaders: value.replyHeaders, attachments: value.attachments });
  requireEmail(value.contractVersion === 1 && value.channel === "email" && value.sourceId === clean.sourceId && value.sourceVersion === clean.sourceVersion, "email_version_mismatch");
  return clean;
}

// Review projection, not a dispatch envelope or proof of Mail.Send permission.
// A future service must reauthenticate the account and connection before use.
export function previewEmailReply(value, connectionValue, options = {}) {
  requireEmail(object(options) && Object.keys(options).every(k => ["mode", "body"].includes(k)), "unsupported_email_reply_options");
  const { mode = "reply", body = "" } = options;
  const source = readEmailEnvelope(value), connection = emailConnection(connectionValue), message = source.message;
  requireEmail(emailDigest(source.connection) === emailDigest(connection), "email_connection_changed");
  requireEmail(["reply", "replyAll"].includes(mode) && !message.isDraft, "email_reply_unavailable");
  emailText(body, emailLimits.bodyBytes, { empty: true, multiline: true });
  const own = new Set([connection.identity, ...connection.aliases].map(addressKey)), seen = new Set(own);
  const unique = values => values.filter(v => { const key = addressKey(v); if (seen.has(key)) return false; seen.add(key); return true; });
  const target = message.replyTo.length ? message.replyTo : [message.from];
  const to = unique(mode === "replyAll" ? [...target, ...message.to] : target), cc = mode === "replyAll" ? unique(message.cc) : [];
  requireEmail(to.length + cc.length > 0, "email_reply_needs_recipient");
  const preview = { contractVersion: 1, purpose: "review-only", sourceId: source.sourceId, sourceVersion: source.sourceVersion,
    connectionId: connection.id, connectionRevision: connection.revision, mode, from: connection.identity, to, cc, bcc: [],
    subject: message.subject, body, attachments: [],
    replyContext: { provider: connection.provider, mailboxId: connection.mailboxId, messageId: message.id,
      messageRevision: message.revision, threadId: message.threadId, internetMessageId: message.internetMessageId,
      headers: source.replyHeaders },
    needs: ["current-account-and-connection-authority", "provider-draft-reconciliation", "explicit-send-approval"] };
  return { ...preview, previewVersion: emailDigest(preview) };
}
