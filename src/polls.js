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

// Render a poll message for the room timeline. Returns "" for anything that
// is not a poll message. Open polls render one vote button per option, wired
// to the existing reaction path (data-message-action="react" carries the
// option emoji); the viewer's own vote is marked aria-pressed. Closed polls
// render the results with no vote buttons. esc() escapes every user string;
// no inline styles (the app's CSP) and no new event wiring.
export function pollHtml(message, esc, viewerId) {
  const tally = pollTally(message);
  if (!tally) return "";
  const closed = Boolean(message?.poll?.closedAt);
  const total = tally.total;
  const items = tally.results.map(result => {
    const mine = result.voters.includes(viewerId);
    const pct = total > 0 ? Math.round((result.votes / total) * 100) : 0;
    const summary = `${result.votes} ${result.votes === 1 ? "vote" : "votes"}${total > 0 ? ` · ${pct}%` : ""}`;
    const inner = `<span class="poll-emoji" aria-hidden="true">${esc(result.emoji)}</span>`
      + `<span class="poll-label">${esc(result.label)}</span>`
      + `<span class="poll-count">${esc(summary)}</span>`;
    if (closed) return `<li><div class="poll-option">${inner}</div></li>`;
    return `<li><button type="button" class="poll-option${mine ? " poll-mine" : ""}" data-message-action="react"`
      + ` data-message-id="${esc(message.id)}" data-reaction="${esc(result.emoji)}" aria-pressed="${mine}"`
      + ` aria-label="Vote for ${esc(result.label)}, ${esc(summary)}">${inner}</button></li>`;
  }).join("");
  const meta = `${total} ${total === 1 ? "vote" : "votes"}`
    + ` · ${tally.allowMultiple ? "multiple choice" : "single choice"}`
    + (closed ? ` · <span class="poll-closed">Closed</span>` : "");
  return `<div class="poll" role="group" aria-label="Poll: ${esc(tally.question)}">`
    + `<p class="poll-question">${esc(tally.question)}</p>`
    + `<ul class="poll-options">${items}</ul>`
    + `<p class="poll-meta">${meta}</p></div>`;
}
