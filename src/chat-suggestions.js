// Only choices explicitly written by the sender earn a reply shortcut.
// Ordinary prose never creates task, answer or agent-selection suggestions.
const MAX_CHOICES = 4;
const MAX_CHOICE_CHARS = 40;

const clean = text => text.replace(/[*_`"“”]/g, "").replace(/\s+/g, " ").trim().replace(/[.?!,;:]+$/, "");
const capital = text => text ? text[0].toUpperCase() + text.slice(1) : text;
const usable = list => {
  const out = [];
  for (const raw of list) {
    const value = capital(clean(raw));
    if (!value || value.length > MAX_CHOICE_CHARS || out.some(v => v.toLowerCase() === value.toLowerCase())) continue;
    out.push(value);
  }
  return out.length >= 2 && out.length <= MAX_CHOICES ? out : null;
};

function explicitChoices(body) {
  const last = body.trim().split("\n").at(-1) ?? "";
  const match = /^(?:options|choices)\s*:\s*(.+)$/i.exec(last.trim());
  return match ? usable(match[1].split(/\s*[|/]\s*/)) : null;
}

export function replyChoices(message) {
  return typeof message?.body === "string" ? explicitChoices(message.body) : null;
}

export function chatSuggestions(message, { viewerId, recipientId = "", dismissed = new Set() } = {}) {
  if (!message || message.deletedAt || message.authorId === viewerId || dismissed.has(message.id)) return null;
  // A public question must not offer answers in a private draft (or vice versa).
  if (message.toMemberId && message.toMemberId !== viewerId) return null;
  const replyRecipient = message.toMemberId ? message.authorId : "";
  if ((recipientId || "") !== replyRecipient) return null;
  const choices = replyChoices(message);
  return choices ? { messageId: message.id, choices } : null;
}
