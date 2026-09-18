// Room -> Messenger send payloads. Pure and fixture-driven: builds the
// provider send payload (Messenger Platform send API shape) — no HTTP, no
// page access token. Text plus optional quick replies.
import { requireContract } from "./channel-connection.mjs";

export const messengerSendLimits = Object.freeze({ textChars: 2000, quickReplies: 13, quickReplyTitle: 20, quickReplyPayload: 1000 });
const psid = value => { requireContract(typeof value === "string" && /^[0-9]{1,32}$/.test(value), "invalid_messenger_outbound"); return value; };
const text = value => { requireContract(typeof value === "string" && value.isWellFormed() && value.trim().length > 0
  && [...value].length <= messengerSendLimits.textChars, "invalid_messenger_outbound"); return value; };
const messagingTypes = Object.freeze(["RESPONSE", "UPDATE", "MESSAGE_TAG"]);
function quickReply(value) {
  requireContract(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_messenger_outbound");
  const title = text(value.title);
  requireContract([...title].length <= messengerSendLimits.quickReplyTitle, "invalid_messenger_outbound");
  requireContract(typeof value.payload === "string" && value.payload.length > 0
    && Buffer.byteLength(value.payload) <= messengerSendLimits.quickReplyPayload, "invalid_messenger_outbound");
  return Object.freeze({ content_type: "text", title, payload: value.payload });
}
// Build the send payload for one room message. quickReplies is an optional
// array of { title, payload }; messagingType defaults to RESPONSE.
export function buildMessengerSend({ recipientId, text: messageText, quickReplies = [], messagingType = "RESPONSE" }) {
  requireContract(messagingTypes.includes(messagingType), "invalid_messenger_outbound");
  requireContract(Array.isArray(quickReplies) && quickReplies.length <= messengerSendLimits.quickReplies, "invalid_messenger_outbound");
  const replies = quickReplies.map(quickReply);
  const message = replies.length ? { text: text(messageText), quick_replies: replies } : { text: text(messageText) };
  return Object.freeze({ recipient: Object.freeze({ id: psid(recipientId) }), messaging_type: messagingType, message: Object.freeze(message) });
}
