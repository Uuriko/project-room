// Work claims (B006/B007). A pure work-item state machine for agent
// coordination: work starts unclaimed; an agent claims it (claimed), starts
// it (in_progress), and finishes it (done) or marks it blocked. Only the
// claiming agent may update, release, or reassign its work — anyone else's
// attempt is refused, never half-applied. This is the anti-collision core:
// two agents cannot both own the same work item. Pure, dependency-free,
// deterministic; frozen outputs. Persistence is a later slice.
const STATES = ["unclaimed", "claimed", "in_progress", "blocked", "done"];
const TRANSITIONS = {
  unclaimed: ["claimed"],
  claimed: ["in_progress", "blocked", "unclaimed"], // unclaimed = release
  in_progress: ["blocked", "done", "claimed"],       // claimed = pause
  blocked: ["in_progress", "claimed"],
  done: [],
};
class ClaimError extends Error { constructor(code, message) { super(message); this.name = "ClaimError"; this.code = code; } }
const fail = (code, message) => { throw new ClaimError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_claim_input", message); };

const workOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "work must be an object");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256, "work id must be 1..256 characters");
  check(value.state === undefined || STATES.includes(value.state), `state must be one of ${STATES.join(", ")}`);
  return { id: value.id, title: value.title ?? value.id, state: value.state ?? "unclaimed",
    owner: value.owner ?? null, history: Array.isArray(value.history) ? value.history : [] };
};
const agentOf = value => {
  check(typeof value === "string" && value.length > 0 && value.length <= 128, "agent id must be 1..128 characters");
  return value;
};
const stamp = (work, agentId, action, note) =>
  Object.freeze({ at: new Date().toISOString(), agentId, action, note: note ?? null });
const withHistory = (work, agentId, action, note) =>
  Object.freeze({ ...work, history: Object.freeze([...work.history, stamp(work, agentId, action, note)]) });
// Claim unclaimed work. Refuses already-claimed work (the anti-collision rule).
export function claimWork(work, agentId, { note } = {}) {
  const item = workOf(work), agent = agentOf(agentId);
  check(item.state === "unclaimed", `work "${item.id}" is already ${item.state} — release it first`);
  return withHistory({ ...item, state: "claimed", owner: agent }, agent, "claimed", note);
}
// Update claimed work: move state or add a note. Only the owner may update.
export function updateWork(work, agentId, { state, note } = {}) {
  const item = workOf(work), agent = agentOf(agentId);
  check(item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can update it`);
  check(item.state !== "done", `work "${item.id}" is done and immutable`);
  if (state !== undefined) {
    check(STATES.includes(state), `state must be one of ${STATES.join(", ")}`);
    check(TRANSITIONS[item.state].includes(state), `cannot move "${item.id}" from ${item.state} to ${state}`);
  }
  const next = state === undefined ? item : { ...item, state,
    owner: state === "unclaimed" ? null : item.owner }; // release clears owner
  return withHistory(next, agent, state === undefined ? "noted" : `state:${state}`, note);
}
// Reassign: the owner hands work to another agent (stays in the same state).
export function reassignWork(work, agentId, newOwner, { note } = {}) {
  const item = workOf(work), agent = agentOf(agentId), target = agentOf(newOwner);
  check(item.owner === agent, `work "${item.id}" is owned by ${item.owner ?? "nobody"} — only the owner can reassign it`);
  check(item.state !== "done", `work "${item.id}" is done and immutable`);
  return withHistory({ ...item, owner: target }, agent, `reassigned:${target}`, note);
}
// Query helpers over a list.
export function workOwnedBy(items, agentId) {
  check(Array.isArray(items), "items must be a list");
  const agent = agentOf(agentId);
  return items.map(workOf).filter(item => item.owner === agent && item.state !== "done");
}
export function unclaimedWork(items) {
  check(Array.isArray(items), "items must be a list");
  return items.map(workOf).filter(item => item.state === "unclaimed");
}
export { ClaimError, STATES, TRANSITIONS };
