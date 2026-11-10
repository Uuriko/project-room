import { planLocalWork } from './local-work-planner.mjs';
import { runRequestOnce } from './request-runner.mjs';

// Policies are local operator choices. PR text never supplies commands or authority.
export async function discoverLocalWork({ policies, readPullRequest, now = Date.now() }) {
  if (!Array.isArray(policies) || policies.length > 50) throw Error('Supply requires at most 50 selected policies');
  const jobs = [], observations = [];
  for (const policy of policies) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(policy.repository ?? '') || !Number.isSafeInteger(policy.number) || policy.number < 1
      || !['review', 'failed_ci'].includes(policy.kind)) throw Error('Invalid selected PR policy');
    const pr = await readPullRequest(policy.repository, policy.number);
    if (!/^[a-f0-9]{40}$/.test(pr.headRefOid ?? '') || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)) throw Error('Incomplete PR observation');
    const checks = pr.statusCheckRollup ?? [];
    const failed = checks.flatMap(c => {
      if (c.__typename === 'StatusContext') return ['FAILURE', 'ERROR'].includes(c.state)
        ? [{ name: c.context, url: c.targetUrl }] : [];
      return c.status === 'COMPLETED' && ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.conclusion)
        ? [{ name: c.name, url: c.detailsUrl }] : [];
    });
    const eligible = pr.state === 'OPEN' && (policy.kind === 'review' || failed.length > 0);
    const source = `github:${policy.repository}/pull/${policy.number}/${policy.kind}`;
    observations.push({ source, revision: pr.headRefOid, observedAt: new Date(now).toISOString(),
      eligible, failedChecks: failed });
    if (eligible) jobs.push({ id: `${policy.repository.replace('/', '-')}-${policy.number}-${policy.kind}`, source,
      revision: pr.headRefOid, acceptance: policy.acceptance, valueReason: policy.valueReason, value: policy.value,
      minutes: policy.minutes, requires: policy.requires, dependencies: policy.dependencies ?? [], scopes: policy.scopes });
  }
  // Validate the entire result using the same contract as dispatch planning.
  planLocalWork({ devices: [], jobs, now });
  return { jobs, observations };
}

// A single selected formal request enters the existing durable service-claim runner.
// The caller retains its private journal and configured host; no new watcher exists.
export async function runPlannedRequest({ snapshot, deviceId, bindings, runnerOptions, refresh,
  runner = runRequestOnce, clock = Date.now }) {
  const initial = planLocalWork({ ...snapshot, now: clock() });
  const selected = initial.assignments.find(a => a.deviceId === deviceId);
  if (!selected) return { status: 'idle', reason: 'no_eligible_work' };
  const binding = bindings.find(b => b.source === selected.source && b.revision === selected.revision && b.deviceId === deviceId);
  if (!binding?.requestMessageId || !Number.isSafeInteger(binding.requestRevision) || binding.requestRevision < 0)
    return { status: 'needs_request', job: selected };
  if (runnerOptions.allowRequest || runnerOptions.selectRequest || runnerOptions.savedRequestId)
    throw Error('Selection belongs to the pinned work binding');
  return runner({ ...runnerOptions, requestMessageId: binding.requestMessageId,
    selectRequest: request => request.id === binding.requestMessageId && request.revision === binding.requestRevision,
    preflight: async () => {
      const fresh = await refresh();
      const current = planLocalWork({ ...fresh, now: clock() }).assignments.find(a => a.deviceId === deviceId);
      if (!current || current.source !== selected.source || current.revision !== selected.revision)
        throw Error('Assignment changed; replan before executing');
      await runnerOptions.preflight?.();
    }
  });
}
