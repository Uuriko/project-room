// Polls inside rooms (K009). A pure poll manager: create polls with
// options, cast votes (one per voter per poll, changeable), close polls,
// and tally results. All state is caller-owned (a Map); the module is
// pure and dependency-free. Frozen outputs; malformed inputs throw
// PollError. Room/message integration is a later slice.
class PollError extends Error { constructor(code, message) { super(message); this.name = "PollError"; this.code = code; } }
const fail = (code, message) => { throw new PollError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_poll", message); };
// Create a poll manager. store is a caller-owned Map (pollId -> poll).
export function createPolls({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const polls = store ?? new Map();
  let pollCounter = 0;
  const getPoll = pollId => {
    check(typeof pollId === "string" && pollId.length > 0, "pollId must be a non-empty string");
    check(polls.has(pollId), `unknown poll "${pollId}"`);
    return polls.get(pollId);
  };
  // Create a poll.
  const create = ({ question, options, createdBy }) => {
    check(typeof question === "string" && question.trim().length > 0, "question must be a non-empty string");
    check(Array.isArray(options) && options.length >= 2 && options.length <= 10,
      "options must have 2-10 entries");
    check(options.every(o => typeof o === "string" && o.trim().length > 0),
      "every option must be a non-empty string");
    check(typeof createdBy === "string" && createdBy.length > 0, "createdBy must be a non-empty string");
    const pollId = `poll-${++pollCounter}`;
    const poll = { pollId, question: question.trim(),
      options: Object.freeze(options.map(o => o.trim())),
      createdBy, closed: false, votes: new Map() };
    polls.set(pollId, poll);
    return Object.freeze({ pollId, question: poll.question, options: poll.options,
      createdBy, closed: false });
  };
  // Cast or change a vote.
  const vote = (pollId, { voterId, optionIndex }) => {
    const poll = getPoll(pollId);
    check(!poll.closed, `poll "${pollId}" is closed`);
    check(typeof voterId === "string" && voterId.length > 0, "voterId must be a non-empty string");
    check(Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < poll.options.length,
      "optionIndex out of range");
    poll.votes.set(voterId, optionIndex);
    return Object.freeze({ pollId, voterId, optionIndex });
  };
  // Close a poll.
  const close = pollId => {
    const poll = getPoll(pollId);
    check(!poll.closed, `poll "${pollId}" is already closed`);
    poll.closed = true;
    return tally(pollId);
  };
  // Tally results.
  const tally = pollId => {
    const poll = getPoll(pollId);
    const counts = poll.options.map(() => 0);
    for (const optionIndex of poll.votes.values()) counts[optionIndex]++;
    return Object.freeze({ pollId, question: poll.question,
      options: poll.options, closed: poll.closed,
      counts: Object.freeze(counts), totalVotes: poll.votes.size });
  };
  return Object.freeze({ create, vote, close, tally });
}
export { PollError };
