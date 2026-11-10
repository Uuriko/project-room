// Pure planning over an operator-supplied snapshot. Plans grant no execution authority.
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
const key = job => `${job.source}@${job.revision}`;
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const conflict = (a, b) => a.scopes.some(x => b.scopes.some(y => overlaps(x, y)));

export function planLocalWork({ devices, jobs, receipts = [], reservations = [], now = Date.now(), freshnessMs = 120000, depth = 2 }) {
  if (!Array.isArray(devices) || !Array.isArray(jobs) || !Array.isArray(receipts) || !Array.isArray(reservations)
    || !Number.isFinite(now) || !Number.isSafeInteger(freshnessMs) || freshnessMs <= 0
    || !Number.isInteger(depth) || depth < 1 || depth > 3) throw Error('Invalid planner snapshot');
  const seenIds = new Set();
  for (const job of jobs) {
    if (!job?.id || seenIds.has(job.id) || !job.source || !job.revision || !job.acceptance || !job.valueReason
      || !Number.isFinite(job.value) || job.value <= 0 || job.value > 10
      || !Number.isFinite(job.minutes) || job.minutes <= 0 || job.minutes > 120
      || !strings(job.requires) || !strings(job.dependencies) || !strings(job.scopes) || !job.scopes.length)
      throw Error('Jobs need unique IDs, source revision, value, acceptance, bounded cost and scopes');
    seenIds.add(job.id);
  }
  // Unknown and expired attempts stay reserved until reconciled by the existing runner.
  for (const hold of reservations) {
    if (!hold?.deviceId || !hold.source || !hold.revision || !strings(hold.scopes) || !hold.scopes.length)
      throw Error('Incomplete reservation; reconcile before planning');
  }
  for (const receipt of receipts) {
    if (!receipt?.source || !receipt.revision || receipt.status !== 'verified' || !receipt.evidence)
      throw Error('Only evidence-backed verified receipts may satisfy dependencies');
  }
  const done = new Set(receipts.map(key));
  const held = new Set(reservations.map(key));
  const devicesSeen = new Set(), physicalSeen = new Set(), eligible = [], unavailable = [];
  for (const device of devices) {
    if (!device?.id || devicesSeen.has(device.id) || !strings(device.capabilities)) throw Error('Invalid or duplicate device');
    devicesSeen.add(device.id);
    const age = now - Date.parse(device.observedAt);
    let reason = null;
    if (device.verified !== true || !/^[a-f0-9]{16,64}$/.test(device.fingerprint ?? '')) reason = 'unverified_device';
    else if (!Number.isFinite(age) || age < 0 || age > freshnessMs) reason = 'stale_device';
    else if (device.available !== true || reservations.some(r => r.deviceId === device.id)) reason = 'busy_or_unavailable';
    else if (physicalSeen.has(device.fingerprint)) reason = 'duplicate_physical_device';
    // A second runtime on a busy physical machine must not obtain another slot.
    if (device.verified === true && reservations.some(r => devices.find(d => d.id === r.deviceId)?.fingerprint === device.fingerprint)) reason = 'busy_or_unavailable';
    if (reason) { unavailable.push({ deviceId: device.id, reason }); continue; }
    physicalSeen.add(device.fingerprint);
    eligible.push({ ...device, queuedMinutes: 0, jobs: [] });
  }
  const deferred = [], planned = [], selected = new Set();
  const ranked = [...jobs].sort((a, b) => b.value / b.minutes - a.value / a.minutes || a.id.localeCompare(b.id));
  for (const job of ranked) {
    let reason = done.has(key(job)) ? 'already_verified' : held.has(key(job)) ? 'reserved_or_unknown'
      : selected.has(key(job)) ? 'duplicate_source_revision'
        : job.dependencies.some(dep => !done.has(dep)) ? 'dependency_unverified'
          : reservations.some(hold => conflict(job, hold)) ? 'reserved_scope' : null;
    const choices = eligible.filter(device => device.jobs.length < depth && job.requires.every(c => device.capabilities.includes(c))
      && !planned.some(other => other.deviceId !== device.id && conflict(job, other)))
      .sort((a, b) => a.queuedMinutes - b.queuedMinutes || a.id.localeCompare(b.id));
    if (!reason && !choices.length) reason = 'no_available_compatible_slot';
    if (reason) { deferred.push({ jobId: job.id, reason }); continue; }
    const device = choices[0];
    device.jobs.push(job.id); device.queuedMinutes += job.minutes; selected.add(key(job));
    planned.push({ jobId: job.id, deviceId: device.id, source: job.source, revision: job.revision,
      scopes: job.scopes, acceptance: job.acceptance, valueReason: job.valueReason, estimatedMinutes: job.minutes,
      dispatch: 'fresh_read_and_claim_required' });
  }
  return { contractVersion: 1, plannedAt: new Date(now).toISOString(), executionAuthorized: false,
    assignments: planned, deferred, unavailable,
    coverage: eligible.map(d => ({ deviceId: d.id, queuedTasks: d.jobs.length, estimatedMinutes: d.queuedMinutes,
      refillNeeded: d.jobs.length < depth })) };
}
