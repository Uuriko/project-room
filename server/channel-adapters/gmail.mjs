// Gmail API shaped adapter. Normalizes recorded users.messages resources only:
// no OAuth, tokens, fetch or send API lives here.
import { createEmailEnvelope, emailConnection, emailInput, emailLimits, emailOpaqueId, emailSourceId, emailText, readEmailEnvelope, requireEmail } from "../email-envelope.mjs";
import { requireContract } from "../channel-connection.mjs";

export const channel = "email";
export const provider = "gmail-api";
// Registry interface shared with the Graph adapter: the same email envelope,
// its reader, its source identity and its folder scope.
export const readEnvelope = readEmailEnvelope;
export const sourceId = emailSourceId;
export const scope = envelope => envelope.message.folderId;
export const gmailConnection = value => { const c = emailConnection(value); requireEmail(c.provider === provider, "unsupported_channel"); return c; };

// Raw users.messages shapes. Header names are case-insensitive; the first
// occurrence wins and values stay opaque data, never re-encoded as MIME.
const headerMap = headers => {
  requireEmail(Array.isArray(headers) && headers.length <= 500, "invalid_gmail_headers");
  const map = new Map();
  for (const header of headers) {
    const name = emailText(header?.name, 240).toLowerCase();
    requireEmail(typeof header.value === "string", "invalid_gmail_headers");
    const value = emailText(header.value, 8192, { empty: true });
    if (!map.has(name)) map.set(name, value);
  }
  return map;
};
// One RFC 5322 mailbox: "Display Name <addr>" or a bare addr-spec. Exotic
// syntax is refused instead of guessed; the envelope validates the addr-spec.
function mailbox(value) {
  requireEmail(typeof value === "string" && value.trim(), "invalid_gmail_address");
  const trimmed = value.trim(), angled = trimmed.match(/^([\s\S]*)<([^<>\s]+)>\s*$/);
  if (angled) return { name: angled[1].trim().replace(/^"(.*)"$/, "$1"), address: angled[2] };
  requireEmail(!/[<>]/.test(trimmed), "invalid_gmail_address");
  return { name: "", address: trimmed };
}
// Comma-split that respects quoted strings and angle-addr groups, so a display
// name containing a comma never becomes two recipients.
function mailboxList(value) {
  if (value === null || value === undefined || value === "") return [];
  requireEmail(typeof value === "string", "invalid_gmail_address");
  const parts = [];
  let current = "", quoted = false, depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== "\\") quoted = !quoted;
    else if (!quoted && ch === "<") depth++;
    else if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !quoted && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  requireEmail(parts.length <= emailLimits.recipients, "invalid_gmail_address");
  return parts.map(part => part.trim()).filter(part => part).map(mailbox);
}
// RFC 5322 Date header to the envelope's ISO instant. A hostile date is a 422
// contract error, never a RangeError or a silently normalized calendar date.
const instant = value => {
  if (value === null || value === undefined) return null;
  requireEmail(typeof value === "string" && value.trim(), "invalid_gmail_date");
  const at = Date.parse(value);
  requireEmail(Number.isFinite(at), "invalid_gmail_date");
  return new Date(at).toISOString();
};
const internalInstant = value => {
  if (value === null || value === undefined) return null;
  requireEmail(typeof value === "string" && /^\d{1,15}$/.test(value), "invalid_gmail_date");
  const at = Number(value);
  requireEmail(Number.isSafeInteger(at), "invalid_gmail_date");
  return new Date(at).toISOString();
};
// Gmail body data is base64url. Decoded text must stay well-formed UTF-8.
const bodyData = value => {
  requireEmail(typeof value === "string" && /^[A-Za-z0-9\-_]*$/.test(value), "invalid_gmail_body");
  let text;
  try { text = Buffer.from(value, "base64url").toString("utf8"); } catch { requireEmail(false, "invalid_gmail_body"); }
  requireEmail(text.isWellFormed(), "invalid_gmail_body");
  return text;
};
function* mimeParts(part) {
  requireEmail(part && typeof part === "object" && !Array.isArray(part), "invalid_gmail_payload");
  yield part;
  if (part.parts !== undefined) {
    requireEmail(Array.isArray(part.parts) && part.parts.length <= 100, "invalid_gmail_payload");
    for (const child of part.parts) yield* mimeParts(child);
  }
}
// First text/plain part wins; text/html is the fallback. The snippet is a
// preview and never substitutes for body content.
function textBodies(payload) {
  const found = { text: null, html: null };
  for (const part of mimeParts(payload)) {
    const mime = typeof part.mimeType === "string" ? part.mimeType.toLowerCase().split(";")[0].trim() : "";
    const data = part.body?.data;
    if (typeof data !== "string" || !data) continue;
    if (mime === "text/plain" && found.text === null) found.text = bodyData(data);
    else if (mime === "text/html" && found.html === null) found.html = bodyData(data);
  }
  return found;
}
function attachments(payload) {
  const items = [];
  for (const part of mimeParts(payload)) {
    const filename = part.filename;
    if (typeof filename !== "string" || !filename) continue;
    const size = part.body?.size;
    items.push({ id: typeof part.partId === "string" && part.partId ? part.partId : "part-" + (items.length + 1), kind: "file",
      name: filename, contentType: typeof part.mimeType === "string" ? part.mimeType : "application/octet-stream",
      size: Number.isSafeInteger(size) && size >= 0 ? size : 0, inline: false, contentId: null });
  }
  return { state: "complete", hint: items.length > 0, items };
}
// Map one users.messages.get resource onto the shared email envelope. The
// Gmail label scope (default INBOX) plays the role of the Graph folderId.
export function normalizeGmailMessage(connection, message, { labelId = "INBOX" } = {}) {
  emailInput({ connection, message, labelId });
  const profile = gmailConnection(connection);
  emailOpaqueId(labelId);
  requireEmail(message && typeof message === "object", "gmail_hydration_required");
  requireEmail(typeof message.id === "string" && message.id, "gmail_hydration_required");
  requireEmail(typeof message.historyId === "string" && message.historyId, "gmail_hydration_required");
  requireEmail(typeof message.threadId === "string" && message.threadId, "gmail_hydration_required");
  requireEmail(Array.isArray(message.labelIds), "gmail_hydration_required");
  const payload = message.payload;
  requireEmail(payload && typeof payload === "object", "gmail_hydration_required");
  const headers = headerMap(payload.headers), get = name => headers.get(name) || null;
  // The snippet is validated as a string but never projected into the envelope.
  requireEmail(message.snippet === undefined || typeof message.snippet === "string", "invalid_gmail_message");
  const bodies = textBodies(payload);
  requireEmail(bodies.text !== null || bodies.html !== null, "gmail_body_required");
  const from = get("from");
  requireEmail(from !== null, "gmail_sender_required");
  const references = get("references"), inReplyTo = get("in-reply-to");
  return createEmailEnvelope({ connection: profile,
    message: { id: emailOpaqueId(message.id), revision: emailOpaqueId(message.historyId), threadId: emailOpaqueId(message.threadId),
      internetMessageId: get("message-id"), folderId: labelId, subject: get("subject") ?? "",
      sentAt: instant(get("date")), receivedAt: internalInstant(message.internalDate) ?? instant(get("date")),
      from: mailbox(from), sender: mailbox(get("sender") ?? from), replyTo: mailboxList(get("reply-to")),
      to: mailboxList(get("to")), cc: mailboxList(get("cc")), bcc: mailboxList(get("bcc")),
      isDraft: message.labelIds.includes("DRAFT"), isRead: !message.labelIds.includes("UNREAD") },
    body: bodies.text !== null ? { format: "text", content: bodies.text } : { format: "html", content: bodies.html },
    replyHeaders: { state: "complete", inReplyTo: inReplyTo ? [inReplyTo] : [], references: references ? [references] : [] },
    attachments: attachments(payload) });
}

// A users.messages.list page is a batch of invalidations plus the next page
// token cursor. The cursor is the opaque nextPageToken; when it is absent the
// page is complete and the cursor is null.
export function gmailListChanges(connectionValue, labelId, response) {
  emailInput(response);
  const connection = gmailConnection(connectionValue);
  emailOpaqueId(labelId);
  requireEmail(response && typeof response === "object" && Array.isArray(response.messages) && response.messages.length <= 500, "invalid_gmail_list");
  const token = response.nextPageToken;
  requireEmail(token === undefined || typeof token === "string", "invalid_gmail_list");
  if (token !== undefined) qualifyGmailCursor(token);
  const changes = response.messages.map(entry => ({ messageId: emailOpaqueId(entry?.id), action: "hydrate" }));
  return { contractVersion: 1, connection, folderId: labelId, changes, cursor: token ?? null, complete: token === undefined };
}
export function qualifyGmailCursor(cursor) {
  requireEmail(typeof cursor === "string" && cursor.length > 0 && cursor.length <= 4096, "invalid_gmail_cursor");
  return cursor;
}

// Recorded mailbox: a fixture standing in for users.messages.list and
// users.messages.get. It mirrors RecordedGraphMailbox (page/message keyed
// recordings, no network, no tokens).
export class RecordedGmailMailbox {
  #connection; #pages; #messages;
  kind = provider;
  constructor(recording) {
    emailInput(recording);
    this.#connection = gmailConnection(recording.connection);
    const index = (rows, field) => {
      requireEmail(Array.isArray(rows) && rows.length <= 1000, "invalid_gmail_recording");
      const result = new Map();
      for (const row of rows) {
        requireEmail(row && (row[field] === null || typeof row[field] === "string") && !result.has(row[field])
          && row.response && typeof row.response === "object", "invalid_gmail_recording");
        result.set(row[field], structuredClone(row.response));
      }
      return result;
    };
    this.#pages = index(recording.pages, "pageToken"); this.#messages = index(recording.messages, "id");
  }
  get connection() { return structuredClone(this.#connection); }
  async page(pageToken) {
    requireEmail(pageToken === null || typeof pageToken === "string", "invalid_gmail_cursor");
    requireEmail(this.#pages.has(pageToken), "gmail_recording_page_missing");
    return structuredClone(this.#pages.get(pageToken));
  }
  async message(id) {
    requireEmail(typeof id === "string", "invalid_gmail_cursor");
    requireEmail(this.#messages.has(id), "gmail_recording_message_missing");
    return structuredClone(this.#messages.get(id));
  }
}
// Bound adapter: the uniform interface every channel driver presents to the importer.
export function bind({ reader, connection, labelId = "INBOX" }) {
  requireContract(reader instanceof RecordedGmailMailbox, "gmail_fixture_reader_required");
  const profile = gmailConnection(connection);
  emailOpaqueId(labelId);
  return {
    channel, provider,
    normalize: raw => normalizeGmailMessage(profile, raw.message ?? raw, { labelId }),
    sourceId: messageId => emailSourceId(profile, messageId),
    scope: () => labelId,
    async changes({ cursor = null } = {}) {
      if (cursor !== null) qualifyGmailCursor(cursor);
      const response = await reader.page(cursor);
      requireContract(response?.status === 200, "gmail_fixture_page_failed");
      return gmailListChanges(profile, labelId, response.body);
    },
    async hydrate(messageId) {
      const hydrated = await reader.message(messageId);
      if (hydrated?.status === 404) return null;
      requireContract(hydrated?.status === 200 && hydrated.message?.id === messageId, "gmail_fixture_hydration_failed");
      return hydrated;
    },
    async submit() { requireContract(false, "channel_sending_unavailable"); },
    async lookup() { requireContract(false, "channel_sending_unavailable"); }
  };
}
