// Deterministic planning only. Reservations and provider effects must be committed
// by the durable authority before a returned admission can execute.
const active = new Set(['reserved', 'dispatching', 'queued', 'running', 'unknown']);
const positiveInteger = (n, name) => {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${name}`);
};

export function validateDependencies(items) {
  const byId = new Map();
  for (const item of items) {
    if (typeof item.id !== 'string' || !item.id || byId.has(item.id)) throw new Error('Invalid or duplicate delivery ID');
    if (!Array.isArray(item.dependencies)) throw new Error('Dependencies must be an array');
    byId.set(item.id, item);
  }
  const visiting = new Set(), visited = new Set();
  const walk = id => {
    if (visiting.has(id)) throw new Error('Delivery dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (typeof dependency !== 'string') throw new Error('Invalid dependency ID');
      if (byId.has(dependency)) walk(dependency);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) walk(id);
  return byId;
}

export function planAdmissions({ items, attempts, capacity, now, agingMs = 60000, paused = false }) {
  positiveInteger(capacity, 'capacity'); positiveInteger(agingMs, 'aging interval');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid scheduler time');
  const byId = validateDependencies(items);
  const occupied = attempts.filter(attempt => active.has(attempt.state));
  // Include unknown and cancelled-but-not-confirmed attempts in usage. A local
  // cancel request does not establish that a hosted runner released its slot.
  for (const attempt of occupied) positiveInteger(attempt.slots, 'attempt slots');
  let remaining = Math.max(0, capacity - occupied.reduce((total, attempt) => total + attempt.slots, 0));
  const reasons = Object.create(null), admissions = [];
  const running = new Set(occupied.flatMap(attempt => attempt.itemIds));
  const candidates = [];
  for (const item of items) {
    if (item.state !== 'eligible') continue;
    positiveInteger(item.slots, 'item slots');
    if (!Number.isSafeInteger(item.enqueuedAt) || !Number.isSafeInteger(item.priority) || Math.abs(item.priority) > 100) throw new Error('Invalid scheduling rank');
    if (paused) reasons[item.id] = 'paused';
    else if (running.has(item.id)) reasons[item.id] = 'already-active';
    else if (item.dependencies.some(id => byId.get(id)?.state !== 'merged' && byId.get(id)?.state !== 'verified')) reasons[item.id] = 'dependency';
    else if (item.slots > capacity) reasons[item.id] = 'pool-too-small';
    else candidates.push(item);
  }
  const score = item => item.priority + Math.floor(Math.max(0, now - item.enqueuedAt) / agingMs);
  candidates.sort((a, b) => score(b) - score(a) || a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id));
  for (const item of candidates) {
    if (item.slots > remaining) {
      reasons[item.id] = 'capacity';
      // Do not perpetually fill around an older multi-slot request. Preserve
      // headroom until it can run; account-wide policy may use separate pools.
      remaining = 0;
      continue;
    }
    admissions.push({ itemId: item.id, slots: item.slots });
    remaining -= item.slots;
  }
  return { admissions, reasons, occupiedSlots: occupied.reduce((sum, attempt) => sum + attempt.slots, 0), remainingSlots: remaining };
}

export function invalidatedDescendants(attempts, failedId) {
  const invalid = new Set([failedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const attempt of attempts) {
      if (!invalid.has(attempt.id) && attempt.predecessors.some(id => invalid.has(id))) {
        invalid.add(attempt.id); changed = true;
      }
    }
  }
  invalid.delete(failedId);
  return [...invalid].sort();
}

export function nextWindow({ current, maximum, outcome }) {
  positiveInteger(current, 'window'); positiveInteger(maximum, 'maximum window');
  if (!['success', 'integration-failure', 'infrastructure-failure'].includes(outcome)) throw new Error('Invalid window outcome');
  if (outcome === 'integration-failure') return Math.max(1, Math.floor(Math.min(current, maximum) / 2));
  if (outcome === 'success') return Math.min(maximum, current + 1);
  return Math.min(current, maximum);
}

export function isolateBatch(itemIds) {
  if (!Array.isArray(itemIds) || new Set(itemIds).size !== itemIds.length) throw new Error('Invalid batch');
  if (itemIds.length <= 1) return itemIds.map(id => [id]);
  const midpoint = Math.ceil(itemIds.length / 2);
  return [itemIds.slice(0, midpoint), itemIds.slice(midpoint)];
}

// Required checks must be supplied from trusted repository policy, not the PR.
// Neutral/skipped are not accepted as proof that a required validation ran.
export function integrationVerdict({ candidate, observation, requiredChecks }) {
  if (!candidate || !['head', 'base', 'sha'].every(key => typeof candidate[key] === 'string' && /^[0-9a-f]{40}$/.test(candidate[key]))) return { ready: false, reason: 'invalid-candidate' };
  if (!observation || !Array.isArray(observation.checks)) return { ready: false, reason: 'invalid-observation' };
  if (candidate.head !== observation.head || candidate.base !== observation.base || candidate.sha !== observation.sha) return { ready: false, reason: 'candidate-changed' };
  if (!Array.isArray(requiredChecks) || !requiredChecks.length) return { ready: false, reason: 'missing-policy' };
  for (const required of requiredChecks) {
    if (!required.name || !Number.isSafeInteger(required.appId)) return { ready: false, reason: 'untrusted-policy' };
    const matches = observation.checks.filter(check => check.name === required.name && check.appId === required.appId && check.sha === candidate.sha);
    if (!matches.length) return { ready: false, reason: 'missing-check', check: required.name };
    const ordered = matches.toSorted((a, b) => b.runId - a.runId);
    const latest = ordered[0];
    if (!Number.isSafeInteger(latest.runId) || ordered.some(check => !Number.isSafeInteger(check.runId))) return { ready: false, reason: 'invalid-check' };
    if (latest.status !== 'completed' || latest.conclusion !== 'success') return { ready: false, reason: 'check-not-successful', check: required.name };
  }
  return { ready: true, reason: 'checks-passed' };
}
