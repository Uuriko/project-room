// Chat suggestions: one-tap replies and a "make this a task" nudge under the
// latest message, so a room works as plain chat with help on hand.
//
// Pure functions over one message. Nothing here posts or stores anything;
// src/app.js renders the chips and a tap goes through the normal composer.
//
// Reply choices come from, in order:
//   1. an explicit last line from the sender: "Options: Short | Detailed"
//      (also "Choices:", separators | or /),
//   2. an "A or B?" / "A, B, or C?" question at the end of the message,
//   3. a yes/no question ("Can you...?", "Should we...?") -> Yes / No.
// A task nudge appears for a request that reads like work ("can someone",
// "please", "by Friday", "TODO") when no work item is linked yet.
// An "Ask @Agent" chip appears when a person's question has sat unanswered.

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

// The last sentence, if it is a question.
function lastQuestion(body) {
  const text = body.trim().replace(/\s+/g, " ");
  if (!text.endsWith("?")) return null;
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.at(-1);
}

const LEADS = /^(?:(?:do|would|will|should|shall|can|could)\s+(?:you|we|i)\s+(?:want|prefer|like)(?:\s+(?:it|them|this|that|me\s+to\s+\w+))?\s+|want\s+(?:it|them|this|that|me\s+to\s+\w+)\s+|(?:do|would)\s+you\s+rather\s+|which\s+(?:one|is\s+better)\s*[,:]?\s*|(?:is\s+it|should\s+(?:it|we)\s+be)\s+|prefer\s+)/i;

function orChoices(question) {
  const body = question.replace(/\?+$/, "").trim();
  if (!/\bor\b/i.test(body)) return null;
  // Take the clause after a lead phrase, else the tail after the last comma-free verb phrase.
  const clause = body.replace(LEADS, "");
  const parts = clause.split(/\s*,\s*(?:or\s+)?|\s+or\s+/i).filter(Boolean);
  if (parts.length < 2) return null;
  // Options should be short phrases, not whole clauses.
  if (parts.some(p => p.split(/\s+/).length > 4)) return null;
  return usable(parts);
}

const YES_NO = /^(?:can|could|should|shall|would|will|do|does|did|is|are|was|were|have|has|may|want|ok|okay)\b/i;

export function replyChoices(message) {
  const body = typeof message?.body === "string" ? message.body : "";
  if (!body.trim()) return null;
  const explicit = explicitChoices(body);
  if (explicit) return explicit;
  const question = lastQuestion(body);
  if (!question) return null;
  const options = orChoices(question);
  if (options) return options;
  const opening = question.replace(/^(?:@\S+\s+|hey\s+\S+,?\s+|so,?\s+|and\s+|but\s+)+/i, "");
  // "Can someone...?" asks the room for a volunteer, not a yes or no.
  if (/\b(?:some(?:one|body)|anyone|anybody)\b/i.test(opening)) return null;
  return YES_NO.test(opening) ? ["Yes", "No"] : null;
}

const TASKLIKE = [
  /\b(?:can|could|would)\s+(?:some(?:one|body)|anyone|you)\s+(?:please\s+)?(?!tell|explain|confirm|clarify|remind)\w+/i,
  /\bplease\s+(?!let\s+me\s+know|advise)\w+/i,
  /\b(?:need|needs)\s+(?:to\s+be\s+)?(?:done|fixed|written|built|shipped|reviewed)\b/i,
  /\b(?:by|before|until)\s+(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|end of (?:day|week)|next week)\b/i,
  /^\s*(?:todo|to do|action item)\s*[:\-]/i,
];

export function suggestsTask(message) {
  const body = typeof message?.body === "string" ? message.body : "";
  if (!body.trim() || message.workItemId || message.proposal || body.length > 1200) return false;
  return TASKLIKE.some(pattern => pattern.test(body));
}

export const ASK_AGENT_AFTER_MS = 2 * 60 * 1000;

// A person's question that is still the latest message, with no thread
// replies, after ASK_AGENT_AFTER_MS. Offers one active agent that is not the
// asker and is not already mentioned; agents that can take work come first.
export function askAgentSuggestion(message, { members = {}, replyCount = 0, now = Date.now(), waitMs = ASK_AGENT_AFTER_MS } = {}) {
  const body = typeof message?.body === "string" ? message.body.trim() : "";
  if (!body.endsWith("?") || replyCount > 0) return null;
  const author = members[message.authorId];
  if (!author || author.kind === "agent") return null;
  const asked = Date.parse(message.createdAt);
  if (!Number.isFinite(asked) || now - asked < waitMs) return null;
  const agents = Object.values(members).filter(m => m.kind === "agent" && m.active !== false && m.id !== message.authorId && m.displayName);
  if (agents.some(m => body.includes(`@${m.displayName}`))) return null;
  const canWork = m => (m.permissions ?? []).includes("accept_work");
  const pick = agents.sort((a, b) => Number(canWork(b)) - Number(canWork(a)) || a.displayName.localeCompare(b.displayName))[0];
  return pick ? { memberId: pick.id, name: pick.displayName } : null;
}

// What to offer under the latest message in view. The viewer never gets
// reply choices for their own message; the task nudge needs steer.
// ask carries askAgentSuggestion's options; without it no agent is offered.
export function chatSuggestions(message, { viewerId, canCreateWork = false, dismissed = new Set(), ask = null } = {}) {
  if (!message || message.deletedAt || dismissed.has(message.id)) return null;
  const choices = message.authorId !== viewerId ? replyChoices(message) : null;
  const task = canCreateWork && suggestsTask(message);
  const agent = ask ? askAgentSuggestion(message, ask) : null;
  return choices || task || agent ? { messageId: message.id, choices: choices ?? [], task, ...(agent ? { agent } : {}) } : null;
}
