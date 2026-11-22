// Setup milestones: connected, first exchange, background check ran.
//
// Each milestone is set only by an observed event, never by a setting or a
// promise. Troubleshooting starts from the last step that really happened.

export const MILESTONES = Object.freeze(["connected", "firstExchange", "backgroundRun"]);

const LABELS = Object.freeze({
  connected: "Connected",
  firstExchange: "First exchange",
  backgroundRun: "Background check ran",
});

// Evidence comes from the room journal ({ type, actorId, at: ISO, data })
// and, for background runs, from the agent's host heartbeats.
const JOIN_TYPES = new Set(["member.added", "member.joined_via_invitation"]);
const EXCHANGE_TYPES = new Set(["work.completed"]);

function at(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function earliest(times) {
  const valid = times.filter(t => t !== null);
  return valid.length ? Math.min(...valid) : null;
}

// events: journal events for the room. heartbeats: [{ at, cadenceSeconds }]
// for this agent's hosts; a host that reports on a cadence is a scheduled
// check, and its first report is the first observed background run.
// setupReport: the parsed setup report, if any.
export function setupMilestones(events, { agentId, setupReport = null, heartbeats = [] } = {}) {
  const list = Array.isArray(events) ? events.filter(e => e && typeof e === "object") : [];
  const joined = earliest(list.filter(e => JOIN_TYPES.has(e.type) && e.data?.memberId === agentId).map(e => at(e.at)));
  const acted = earliest(list.filter(e => e.actorId === agentId).map(e => at(e.at)));
  const exchanged = earliest(list.filter(e => e.actorId === agentId
    && ((e.type === "message.posted" && typeof e.data?.replyToId === "string") || EXCHANGE_TYPES.has(e.type))).map(e => at(e.at)));
  const ran = earliest((Array.isArray(heartbeats) ? heartbeats : [])
    .filter(h => h && Number(h.cadenceSeconds) > 0).map(h => at(h.at)));
  const connectedAt = earliest([joined, acted]);
  const step = (name, time) => Object.freeze({ label: LABELS[name], done: time !== null, at: time });
  const result = { connected: step("connected", connectedAt), firstExchange: step("firstExchange", exchanged), backgroundRun: step("backgroundRun", ran) };
  const scheduleSaved = Boolean(setupReport?.scheduleSaved);
  return Object.freeze({ ...result, scheduleSaved, next: nextStep(result, setupReport) });
}

// One plain next step, starting from the last observed milestone.
export function nextStep(state, setupReport = null) {
  if (!state.connected?.done) {
    return { from: null, text: "Nothing has connected yet. Open the agent's connect link on the computer where it runs and finish sign-in there." };
  }
  if (!state.firstExchange?.done) {
    return { from: "connected", text: "The agent is connected but has not answered anything yet. Ask it one small question in the room and have it reply." };
  }
  if (state.backgroundRun?.done) return { from: "backgroundRun", text: null };
  if (setupReport && setupReport.scheduleSaved === false) {
    return { from: "firstExchange", text: `The agent could not save its check schedule: ${setupReport.limitation || "no reason given"}. It still works when you open it.` };
  }
  if (setupReport?.scheduleSaved) {
    return { from: "firstExchange", text: `The schedule is saved but no check has run yet. ${Number.isInteger(setupReport.intervalMinutes) ? `Wait one interval (${setupReport.intervalMinutes} minutes)` : "Wait one interval"}, then look at the agent's own run history.` };
  }
  return { from: "firstExchange", text: "Exchanges work. No background check has been reported. Paste the setup intro again if you want the agent to check on its own." };
}
