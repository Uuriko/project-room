// src/polls.js — Poll message helpers. A poll is a message with kind "poll"
// carrying a poll payload { question, options: [{ label, emoji }], allowMultiple }.
// Votes are ordinary message.reaction_set events on an option's emoji; this
// module validates poll creation, assigns the option emojis, and aggregates
// the visible votes. Pure: no store, no HTTP, no side effects.
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_LABEL_CHARS = 120;
export const POLL_MAX_QUESTION_CHARS = 500;

// Digit keycap emoji, the stable vote keys (1..10). Single graphemes that
// canonicalReaction accepts.
const KEYCAP = digit => `${digit}\uFE0F\u20E3`;
export const POLL_OPTION_EMOJIS = Object.freeze(
  Array.from({ length: POLL_MAX_OPTIONS }, (_, i) => KEYCAP(String(i + 1)))
);

function fail(message) {
  throw new Error(message);
}

// Validate a caller-supplied poll payload and normalize it into the stored
// record shape { question, options: [{ label, emoji }], allowMultiple }.
// Throws a plain Error naming the bad field.
export function normalizePoll(data) {
  const poll = data?.poll;
  if (!poll || typeof poll !== "object" || Array.isArray(poll)) fail("Poll requires a poll payload { question, options }");
  const question = typeof poll.question === "string" ? poll.question.trim() : "";
  if (!question) fail("Poll requires a non-empty question");
  if (question.length > POLL_MAX_QUESTION_CHARS) fail("Poll question is too long");
  const labels = poll.options;
  if (!Array.isArray(labels)) fail("Poll requires an options array");
  if (labels.length < POLL_MIN_OPTIONS) fail(`Poll requires at least ${POLL_MIN_OPTIONS} options`);
  if (labels.length > POLL_MAX_OPTIONS) fail(`Poll allows at most ${POLL_MAX_OPTIONS} options`);
  const seen = new Set();
  const options = labels.map(raw => {
    const label = typeof raw === "string" ? raw.trim() : "";
    if (!label) fail("Poll option labels must be non-empty strings");
    if (label.length > POLL_MAX_LABEL_CHARS) fail("Poll option label is too long");
    const folded = label.toLowerCase();
    if (seen.has(folded)) fail("Poll option labels must not duplicate");
    seen.add(folded);
    return label;
  }).map((label, i) => ({ label, emoji: POLL_OPTION_EMOJIS[i] }));
  return { question, options, allowMultiple: poll.allowMultiple === true };
}

// Aggregate the votes recorded on a poll message. Returns null for anything
// that is not a poll message. Voters and options keep insertion order; a
// member's vote lives under exactly one option on single-choice polls.
export function pollTally(message) {
  if (!message || typeof message !== "object" || message.kind !== "poll") return null;
  const poll = message.poll;
  if (!poll || !Array.isArray(poll.options)) return null;
  const reactions = message.reactions && typeof message.reactions === "object" ? message.reactions : {};
  const results = poll.options.map(option => {
    const voters = Array.isArray(reactions[option.emoji]) ? [...reactions[option.emoji]] : [];
    return { label: option.label, emoji: option.emoji, votes: voters.length, voters };
  });
  return { question: poll.question, allowMultiple: poll.allowMultiple === true, results, total: results.reduce((sum, r) => sum + r.votes, 0) };
}

// The vote keys belonging to this poll message (a subset of its reactions).
export function pollOptionEmojis(message) {
  if (!message || message.kind !== "poll" || !Array.isArray(message.poll?.options)) return [];
  return message.poll.options.map(option => option.emoji);
}
