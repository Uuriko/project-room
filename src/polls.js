// src/polls.js — Poll message helpers. A poll is a message with kind "poll"
// carrying a poll payload { question, options: [{ label }], allowMultiple }.
// Votes are poll.voted { messageId, option, active } events stored as
// message.pollVotes. Pure: no store, no HTTP, no side effects.
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_LABEL_CHARS = 120;
export const POLL_MAX_QUESTION_CHARS = 500;

function fail(message) {
  throw new Error(message);
}

// Validate a caller-supplied poll payload and normalize it into the stored
// record shape { question, options: [{ label }], allowMultiple }.
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
  }).map(label => ({ label }));
  return { question, options, allowMultiple: poll.allowMultiple === true };
}

// Aggregate the votes recorded on a poll message. Returns null for anything
// that is not a poll message. Voters and options keep insertion order; a
// member's vote lives under exactly one option on single-choice polls.
export function pollTally(message) {
  if (!message || typeof message !== "object" || message.kind !== "poll") return null;
  const poll = message.poll;
  if (!poll || !Array.isArray(poll.options)) return null;
  const results = poll.options.map((option, i) => {
    const voters = Array.isArray(message.pollVotes?.[i]) ? [...message.pollVotes[i]] : [];
    return { label: option.label, votes: voters.length, voters };
  });
  return { question: poll.question, allowMultiple: poll.allowMultiple === true, results, total: results.reduce((sum, r) => sum + r.votes, 0) };
}
