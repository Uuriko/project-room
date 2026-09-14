// Inbound mail via Cloudflare Email Routing: resolve the recipient address to
// an email connection, parse the raw message with the minimal MIME reader, map
// it onto the shared envelope and build the page.apply request the existing
// importer already accepts. No network, no credentials, no send authority.
// The Worker email() handler that feeds this lives in cloudflare/room.mjs
// (proposal in docs/EMAIL-ROUTING.md); nothing here receives mail on its own.
import { MimeError, addressPattern, mimeLimits, parseMimeMessage } from "./mime-message.mjs";
import { emailConnection, emailDigest } from "./email-envelope.mjs";
import { emailRoutingFolderId, normalizeRoutedEmail, rawEmailDigest } from "./channel-adapters/email.mjs";
import { validId } from "../src/events.js";

export const emailRoutingLimits = Object.freeze({ rawBytes: mimeLimits.rawBytes, addressBytes: 320, folderMessages: 1000 });
// Reasons handed to message.setReject(): short, ASCII, no message content.
export const emailRoutingRejections = Object.freeze({
  unknownRecipient: "Unknown recipient", tooLarge: "Message too large", malformed: "Message could not be parsed",
  unavailable: "Mailbox temporarily unavailable" });
export class EmailRoutingError extends Error {
  constructor(code, reason) { super(code); this.name = "EmailRoutingError"; this.code = code; this.reason = reason; }
}
const reject = (code, reason) => { throw new EmailRoutingError(code, reason); };

// Routing key: angle brackets removed, whole address lower-cased. Identity in
// the envelope keeps the local part as written; only routing is case-insensitive.
export function routingKey(address) {
  const value = typeof address === "string" ? address.trim().replace(/^<|>$/g, "") : "";
  if (!value || Buffer.byteLength(value) > emailRoutingLimits.addressBytes || !addressPattern.test(value)) return null;
  return value.toLowerCase();
}
// Exact address, then plus-addressing (local+tag@domain -> local@domain), then
// a catch-all the connection declares as the alias "*@domain".
export function recipientCandidates(address) {
  const key = routingKey(address);
  if (!key) return [];
  const at = key.lastIndexOf("@"), local = key.slice(0, at), domain = key.slice(at + 1), plus = local.indexOf("+");
  const candidates = [{ match: "exact", address: key }];
  if (plus > 0) candidates.push({ match: "plus", address: local.slice(0, plus) + "@" + domain, tag: local.slice(plus + 1) });
  candidates.push({ match: "catch-all", address: "*@" + domain });
  return candidates;
}
export const connectionAddresses = profile => [profile.identity, ...profile.aliases].map(a => routingKey(a.address)).filter(Boolean);
// A lookup over in-memory profiles (tests, small deployments): address -> profile | null.
export const lookupFromProfiles = profiles => address => profiles.find(profile => connectionAddresses(profile).includes(routingKey(address))) ?? null;
export async function resolveRoutedConnection(to, lookup) {
  if (typeof lookup !== "function") throw new TypeError("connection lookup function required");
  for (const candidate of recipientCandidates(to)) {
    const found = await lookup(candidate.address);
    if (!found) continue;
    const profile = emailConnection(found);
    // Never trust a lookup that hands back a connection not listing the address.
    if (!connectionAddresses(profile).includes(candidate.address)) continue;
    return { connection: profile, match: candidate.match, address: candidate.address, tag: candidate.tag ?? null };
  }
  return null;
}
const rawBytes = raw => typeof raw === "string" ? Buffer.byteLength(raw) : raw instanceof ArrayBuffer ? raw.byteLength : raw instanceof Uint8Array ? raw.length : NaN;

// { from, to, raw, rawSize, receivedAt } is the Worker's message shape after
// the raw stream has been read. Returns { decision, ... } and never throws for
// a message that is merely unroutable or malformed.
export async function routeInboundEmail({ from = "", to, raw, rawSize, receivedAt }, { lookup, limits = emailRoutingLimits } = {}) {
  try {
    const declared = Number.isSafeInteger(rawSize) ? rawSize : rawBytes(raw);
    if (!Number.isFinite(declared) || declared > limits.rawBytes || rawBytes(raw) > limits.rawBytes) reject("email_routing_too_large", emailRoutingRejections.tooLarge);
    const routed = await resolveRoutedConnection(to, lookup);
    if (!routed) reject("email_routing_unknown_recipient", emailRoutingRejections.unknownRecipient);
    let parsed;
    try { parsed = parseMimeMessage(raw, { limits: { rawBytes: limits.rawBytes } }); }
    catch (error) {
      if (!(error instanceof MimeError)) throw error;
      reject(error.code, error.code === "mime_raw_limit" ? emailRoutingRejections.tooLarge : emailRoutingRejections.malformed);
    }
    const rawDigest = rawEmailDigest(raw);
    let envelope;
    try { envelope = normalizeRoutedEmail(routed.connection, parsed, { envelopeFrom: from, envelopeTo: routingKey(to) ?? to, receivedAt, rawDigest }); }
    catch (error) {
      if (error?.name !== "EmailContractError") throw error;
      reject(error.code, emailRoutingRejections.malformed);
    }
    // Idempotency: one request per Message-ID per connection; without one, per raw content.
    const requestId = "email-routing-" + emailDigest([routed.connection.accountId, routed.connection.id, parsed.messageId ?? "raw:" + rawDigest]);
    if (!validId(requestId)) reject("email_routing_request_id", emailRoutingRejections.malformed);
    return { decision: { accept: true, reason: null }, code: null, match: routed.match, tag: routed.tag, connection: routed.connection, envelope, requestId,
      messageId: parsed.messageId, rawDigest, preview: parsed.preview, truncated: parsed.truncated };
  } catch (error) {
    if (!(error instanceof EmailRoutingError)) throw error;
    return { decision: { accept: false, reason: error.reason }, code: error.code, match: null, tag: null, connection: null, envelope: null, requestId: null,
      messageId: null, rawDigest: null, preview: null, truncated: false };
  }
}
// Fill in the importer's optimistic-concurrency fields from the connection's
// current state (store.email.state(...) shape) and the source's current
// revision. A prior receipt for the request id means the message is a duplicate.
export function completeRoutedImport(routed, { folder = null, expectedCursor = null, needsReset = false, sourceRevision = 0, priorReceipt = null } = {}) {
  if (!routed?.decision?.accept) throw new EmailRoutingError("email_routing_not_accepted", routed?.decision?.reason ?? null);
  if (priorReceipt) return { duplicate: true, receipt: priorReceipt, request: null };
  const { envelope, requestId, connection } = routed;
  return { duplicate: false, receipt: null, request: { action: "page.apply", requestId, connectionId: connection.id, connectionRevision: connection.revision,
    folderId: emailRoutingFolderId, expectedRevision: folder?.revision ?? 0, expectedCursor, cursor: requestId, complete: true, reset: needsReset,
    observations: [{ kind: "message", envelope, expectedSourceRevision: sourceRevision }] } };
}
// Convenience for a store with an account session: state, prior receipt,
// source revision, then apply. The Worker path needs a system import authority
// (B20) before it can call this without an owner session.
export function applyRoutedEmail({ store, token, binding, routed }) {
  if (!routed?.decision?.accept) return { applied: false, duplicate: false, receipt: null, decision: routed?.decision ?? null };
  const state = store.email.state(token, routed.connection.id, emailRoutingFolderId, binding);
  const prior = store.email.priorReceipt(routed.connection.accountId, routed.requestId);
  let sourceRevision = 0;
  try { sourceRevision = store.inbox.read(token, routed.envelope.sourceId, binding).source.revision; }
  catch (error) { if (error.status !== 404) throw error; }
  const completed = completeRoutedImport(routed, { folder: state.folder, expectedCursor: state.expectedCursor, needsReset: state.needsReset, sourceRevision, priorReceipt: prior });
  if (completed.duplicate) return { applied: false, duplicate: true, receipt: completed.receipt, decision: routed.decision };
  const result = store.email.apply(token, completed.request, binding);
  return { applied: true, duplicate: result.duplicate, receipt: result.receipt, decision: routed.decision };
}
