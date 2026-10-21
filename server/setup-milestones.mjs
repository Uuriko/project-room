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

// Event types that count as evidence for each milestone.
const EVIDENCE = Object.freeze({
  connected: new Set(["agent.connected", "agent.joined", "identity.redeemed"]),
  firstExchange: new Set(["reply.posted", "work.result", "message.posted"]),
  backgroundRun: new Set(["schedule.run"]),
});

function at(event) {
  const value = Number(event?.at ?? event?.createdAt);
  return Number.isFinite(value) ? value : null;
}

// events: [{ type, at, agentId, data }] for one agent. setupReport: the parsed
// setup.report, if any.
export function setupMilestones(events, { agentId, setupReport = null } = {}) {
  const mine = (Array.isArray(events) ? events : []).filter(event => event && (!agentId || event.agentId === agentId));
  const result = {};
  for (const name of MILESTONES) {
    const hits = mine.filter(event => EVIDENCE[name].has(event.type) && at(event) !== null)
      .filter(event => name !== "firstExchange" || event.type !== "message.posted" || event.data?.inReplyTo)
      .sort((a, b) => at(a) - at(b));
    result[name] = Object.freeze({ label: LABELS[name], done: hits.length > 0, at: hits.length ? at(hits[0]) : null });
  }
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
    return { from: "firstExchange", text: `The schedule is saved but no check has run yet. Wait one interval (${setupReport.intervalMinutes} minutes), then look at the agent's own run history.` };
  }
  return { from: "firstExchange", text: "Exchanges work. No background check has been reported. Paste the setup intro again if you want the agent to check on its own." };
}
