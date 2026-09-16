// Action-item extraction (K021). A pure local heuristic: scan thread
// messages for action-item signals (imperatives, "todo", "action:",
// assignee mentions, due-date phrases) and emit candidate action items.
// No external calls, no ML. The module is pure and dependency-free.
// Frozen outputs; malformed inputs throw ExtractionError. UI wiring is a
// later slice.
class ExtractionError extends Error { constructor(code, message) { super(message); this.name = "ExtractionError"; this.code = code; } }
const fail = (code, message) => { throw new ExtractionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_extraction", message); };
// Imperative verbs that commonly start action items.
const IMPERATIVES = ["add", "ask", "assign", "build", "call", "check", "confirm",
  "create", "decide", "deploy", "document", "draft", "email", "file", "fix",
  "follow", "investigate", "merge", "ping", "prepare", "review", "schedule",
  "send", "set", "ship", "test", "update", "verify", "write"];
const ACTION_PREFIX = /^(action|todo|task)\s*[:\-]\s*/i;
const DUE_PATTERN = /\b(by|due)\s+(monday|tuesday|wednesday|thursday|friday|tomorrow|today|eod|\d{1,2}\/\d{1,2})\b/i;
const MENTION_PATTERN = /@([a-zA-Z0-9_-]+)/g;
// Score a single message. Returns null if not an action candidate.
function scoreMessage({ text, messageId, authorId }) {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;
  let score = 0;
  const signals = [];
  if (ACTION_PREFIX.test(trimmed)) { score += 3; signals.push("prefix"); }
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
  if (IMPERATIVES.includes(firstWord)) { score += 2; signals.push("imperative"); }
  const mentions = [...trimmed.matchAll(MENTION_PATTERN)].map(m => m[1]);
  if (mentions.length > 0) { score += 1; signals.push("mention"); }
  const dueMatch = trimmed.match(DUE_PATTERN);
  if (dueMatch) { score += 1; signals.push("due"); }
  if (trimmed.endsWith("?")) { score -= 2; signals.push("question"); }
  if (score < 2) return null;
  return { messageId, authorId, text: trimmed,
    title: trimmed.replace(ACTION_PREFIX, "").slice(0, 120),
    assignees: mentions, due: dueMatch ? dueMatch[0] : null,
    score, signals };
}
// Extract candidate action items from thread messages.
// messages is [{ messageId, authorId, text }].
export function extractActionItems({ messages }) {
  check(Array.isArray(messages), "messages must be an array");
  const candidates = [];
  for (const message of messages) {
    check(message !== null && typeof message === "object", "every message must be an object");
    check(typeof message.messageId === "string" && message.messageId.length > 0,
      "every message must have messageId");
    check(typeof message.text === "string", "every message must have text");
    const scored = scoreMessage({ text: message.text, messageId: message.messageId,
      authorId: message.authorId ?? null });
    if (scored) candidates.push(Object.freeze(scored));
  }
  candidates.sort((a, b) => b.score - a.score);
  return Object.freeze(candidates);
}
export { ExtractionError };
