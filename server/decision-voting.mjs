// Decision register (K008). A pure decision/voting module: a decision
// has a question and options; agents vote for one option (one vote per
// agent, changeable until closed); closing tallies the votes and records
// the winner. All state is caller-owned (a Map); the module is pure and
// dependency-free. Frozen outputs; malformed inputs throw DecisionError.
// Voting UI wiring is a later slice.
class DecisionError extends Error { constructor(code, message) { super(message); this.name = "DecisionError"; this.code = code; } }
const fail = (code, message) => { throw new DecisionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_decision", message); };
// Create a decision register. store is a caller-owned Map (decisionId -> decision).
export function createDecisions({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const decisions = store ?? new Map();
  const checkId = id => check(typeof id === "string" && id.length > 0, "id must be a non-empty string");
  // Propose a decision with options.
  const propose = ({ decisionId, question, options, proposedBy }) => {
    checkId(decisionId);
    check(typeof question === "string" && question.length > 0 && question.length <= 500,
      "question must be 1-500 chars");
    check(Array.isArray(options) && options.length >= 2 && options.length <= 10 &&
      options.every(o => typeof o === "string" && o.length > 0 && o.length <= 200),
      "options must be 2-10 non-empty strings");
    check(typeof proposedBy === "string" && proposedBy.length > 0, "proposedBy must be a non-empty string");
    check(!decisions.has(decisionId), `decision "${decisionId}" already exists`);
    const decision = Object.freeze({ decisionId, question, proposedBy,
      options: Object.freeze([...options]), state: "open",
      votes: Object.freeze({}), outcome: null });
    decisions.set(decisionId, decision);
    return decision;
  };
  const get = decisionId => {
    checkId(decisionId); check(decisions.has(decisionId), `unknown decision "${decisionId}"`);
    return decisions.get(decisionId);
  };
  // Cast (or change) a vote. Refuses votes on closed decisions.
  const vote = (decisionId, { agentId, option }) => {
    const current = get(decisionId);
    check(current.state === "open", `decision "${decisionId}" is closed`);
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    check(current.options.includes(option), `option "${option}" is not on the ballot`);
    const updated = Object.freeze({ ...current,
      votes: Object.freeze({ ...current.votes, [agentId]: option }) });
    decisions.set(decisionId, updated);
    return updated;
  };
  // Close and tally. Winner is the option with the most votes; ties
  // resolve to the earliest-listed tied option (deterministic).
  const close = decisionId => {
    const current = get(decisionId);
    check(current.state === "open", `decision "${decisionId}" is already closed`);
    const tally = {};
    for (const option of current.options) tally[option] = 0;
    for (const option of Object.values(current.votes)) tally[option] += 1;
    let winner = current.options[0];
    for (const option of current.options) {
      if (tally[option] > tally[winner]) winner = option;
    }
    const updated = Object.freeze({ ...current, state: "closed",
      outcome: Object.freeze({ winner, tally: Object.freeze({ ...tally }),
        votesCast: Object.keys(current.votes).length }) });
    decisions.set(decisionId, updated);
    return updated;
  };
  return Object.freeze({ propose, get, vote, close, size: () => decisions.size });
}
export { DecisionError };
