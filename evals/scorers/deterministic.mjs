// Deterministic scorers. Scores are exact 0 or 1 — no model judgment,
// so these evals need no leniency calibration. Each scorer checks the
// observable trajectory contract, not the solver's internals.

const sequenceOf = (trajectory) => trajectory.map((step) => step.tool);

/** Join→claim→finish journey: expected call order, exclusive lease, receipt. */
export function scoreClaimJourney(_task, outcome) {
  const expected = ['room.join', 'room.claim', 'room.claim', 'room.finish'];
  const actual = sequenceOf(outcome.trajectory);
  if (actual.join(',') !== expected.join(',')) return 0;

  const [, ownClaim, rivalClaim, finish] = outcome.trajectory;
  if (!ownClaim.result.ok) return 0;
  if (rivalClaim.result.ok || rivalClaim.result.error !== 'already-claimed') return 0;
  if (!finish.result.ok || !finish.result.receipt) return 0;
  return 1;
}

/** MCP journey: list before call, call a listed tool, call succeeds. */
export function scoreMcpJourney(_task, outcome) {
  const trajectory = outcome.trajectory ?? [];
  if (trajectory.length < 2) return 0;
  if (trajectory[0].tool !== 'tools/list' || trajectory[1].tool !== 'tools/call') return 0;

  const listed = new Set((trajectory[0].result.tools ?? []).map((t) => t.name));
  const call = trajectory[1];
  if (!listed.has(call.args.name)) return 0; // must call a tool it saw listed
  if (!call.result.ok) return 0;
  return 1;
}
