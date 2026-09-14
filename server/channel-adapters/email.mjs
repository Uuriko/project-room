// Email (Microsoft Graph shaped) adapter over the existing offline modules.
import { readEmailEnvelope, emailSourceId, emailConnection, createEmailEnvelope, emailDigest, emailLimits } from "../email-envelope.mjs";
import { parseMimeMessage, truncateUtf8 } from "../mime-message.mjs";
import { graphFolderChanges, normalizeGraphEmail } from "../graph-email.mjs";
import { RecordedGraphMailbox } from "../graph-fixture-sync.mjs";
import { requireContract } from "../channel-connection.mjs";

export const channel = "email";
export const provider = "microsoft-graph";
export const readEnvelope = readEmailEnvelope;
export const sourceId = emailSourceId;
export const scope = envelope => envelope.message.folderId;
// Bound adapter over a recorded mailbox; the Graph fixture driver in
// graph-fixture-sync.mjs remains the exercised email path.
export function bind({ reader, connection, folderId }) {
  requireContract(reader instanceof RecordedGraphMailbox, "email_fixture_reader_required");
  const profile = emailConnection(connection);
  return {
    channel, provider,
    normalize: raw => normalizeGraphEmail(profile, raw.message, raw.options),
    sourceId: messageId => emailSourceId(profile, messageId),
    scope: () => folderId,
    async changes({ cursor = null } = {}) {
      const response = await reader.page(cursor);
      requireContract(response?.status === 200, "email_fixture_page_failed");
      return graphFolderChanges(profile, folderId, response.body, { idType: "immutable" });
    },
    async hydrate(messageId) {
      const hydrated = await reader.message(messageId);
      if (hydrated?.status === 404 && hydrated.code === "ErrorItemNotFound") return null;
      requireContract(hydrated?.status === 200 && hydrated.message?.id === messageId, "email_fixture_hydration_failed");
      return hydrated;
    },
    async submit() { requireContract(false, "channel_sending_unavailable"); },
    async lookup() { requireContract(false, "channel_sending_unavailable"); }
  };
}

// Email Routing source: raw RFC 5322 messages delivered by Cloudflare Email
// Routing to the Worker's email() handler. It sits beside the Graph fixture
// behind the same adapter interface. Inbound is live once routing is enabled
// and the handler is mounted; outbound stays unavailable (B23).

export const emailRoutingFolderId = "email-routing";
export const emailRoutingCapabilities = Object.freeze({ transport: "cloudflare-email-routing", inbound: "live-via-routing", outbound: "none",
  read: true, send: false, threads: true, edit: false });
const mailbox = value => ({ name: value?.name ?? "", address: value.address });
const timestamp = value => {
  const at = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
  requireContract(Number.isFinite(at), "email_routing_received_at_required");
  return new Date(at).toISOString();
};
// Map one parsed inbound message onto the shared email envelope. The SMTP
// envelope sender/recipient stand in when the header lacks a usable address.
export function normalizeRoutedEmail(connection, parsed, { envelopeFrom = "", envelopeTo, receivedAt, rawDigest }) {
  const profile = emailConnection(connection);
  requireContract(parsed && typeof parsed === "object" && parsed.headers && Array.isArray(parsed.attachments), "email_routing_parse_required");
  requireContract(typeof rawDigest === "string" && /^[a-f0-9]{64}$/.test(rawDigest), "email_routing_digest_required");
  const from = parsed.from ?? (typeof envelopeFrom === "string" && envelopeFrom ? { name: "", address: envelopeFrom.replace(/^<|>$/g, "") } : null);
  requireContract(from, "email_routing_sender_required");
  const to = parsed.to.length ? parsed.to : [{ name: "", address: String(envelopeTo ?? "").replace(/^<|>$/g, "") }];
  const id = parsed.messageId ? parsed.messageId.slice(1, -1) : "raw-" + rawDigest;
  const recipientBudget = emailLimits.recipients - parsed.replyTo.length, toList = to.slice(0, recipientBudget);
  const body = parsed.text !== null ? { format: "text", content: parsed.text } : parsed.html !== null ? { format: "html", content: parsed.html } : { format: "text", content: "" };
  const items = parsed.attachments.map((a, i) => ({ id: "part-" + (i + 1), kind: "file", name: a.name, contentType: a.contentType, size: a.size, inline: a.inline, contentId: a.contentId }));
  return createEmailEnvelope({ connection: profile,
    message: { id, revision: rawDigest, threadId: (parsed.references[0] ?? parsed.inReplyTo[0] ?? "<" + id + ">").slice(1, -1) || id,
      internetMessageId: parsed.messageId, folderId: emailRoutingFolderId, subject: truncateUtf8(parsed.subject, 4096).value,
      sentAt: parsed.date, receivedAt: timestamp(receivedAt), from: mailbox(from), sender: mailbox(parsed.sender ?? from), replyTo: parsed.replyTo,
      to: toList.map(mailbox), cc: parsed.cc.slice(0, recipientBudget - toList.length).map(mailbox), bcc: [],
      isDraft: false, isRead: false },
    body, replyHeaders: { state: "complete", inReplyTo: parsed.inReplyTo, references: parsed.references },
    attachments: { state: "complete", hint: items.some(item => !item.inline), items } });
}
export const rawEmailDigest = raw => emailDigest(Buffer.from(typeof raw === "string" ? Buffer.from(raw, "utf8") : raw).toString("base64"));
// Bound adapter over messages already delivered by routing (raw bytes plus the
// SMTP envelope). Same driver shape as the Graph and Telegram fixtures; the
// cursor is the count of delivered messages, so one page imports them all.
export function bindRouting({ connection, messages }) {
  const profile = emailConnection(connection);
  requireContract(Array.isArray(messages) && messages.length <= 50, "email_routing_page_limit");
  const parsed = new Map();
  for (const delivered of messages) {
    requireContract(delivered && typeof delivered === "object" && typeof delivered.to === "string", "email_routing_message_required");
    const message = parseMimeMessage(delivered.raw), rawDigest = rawEmailDigest(delivered.raw);
    const envelope = normalizeRoutedEmail(profile, message, { envelopeFrom: delivered.from, envelopeTo: delivered.to, receivedAt: delivered.receivedAt, rawDigest });
    parsed.set(envelope.message.id, envelope);
  }
  return {
    channel, provider, capabilities: emailRoutingCapabilities,
    normalize: raw => readEmailEnvelope(raw),
    sourceId: messageId => emailSourceId(profile, messageId),
    scope: () => emailRoutingFolderId,
    async changes({ cursor = null } = {}) {
      const done = cursor === String(parsed.size);
      return { changes: done ? [] : [...parsed.keys()].map(messageId => ({ messageId, action: "hydrate" })), cursor: String(parsed.size), complete: true };
    },
    async hydrate(messageId) { return parsed.get(messageId) ?? null; },
    async submit() { requireContract(false, "channel_sending_unavailable"); },
    async lookup() { requireContract(false, "channel_sending_unavailable"); }
  };
}
