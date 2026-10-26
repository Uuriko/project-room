// Trusted coordinator boundary: providers receive opaque credential access through
// their constructor, never from queued item bodies or PR-authored workflow inputs.
export class ProviderFailure extends Error {
  constructor(kind, message, { retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderFailure';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export function retryDecision(error, { attempt, now, maximumAttempts = 4, baseDelayMs = 1000, maximumDelayMs = 60000 }) {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) throw new Error('Invalid retry policy');
  if (!Number.isFinite(now) || !Number.isFinite(baseDelayMs) || baseDelayMs < 1 || !Number.isFinite(maximumDelayMs) || maximumDelayMs < baseDelayMs) throw new Error('Invalid retry timing');
  if (!['rate-limit', 'infrastructure'].includes(error?.kind) || attempt >= maximumAttempts) return { retry: false, reason: error?.kind ?? 'unknown' };
  const exponential = Math.min(maximumDelayMs, baseDelayMs * (2 ** Math.min(attempt - 1, 30)));
  const providerDelay = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
  return { retry: true, at: now + Math.max(exponential, providerDelay) };
}

// execute() is intentionally at-most-once per journal effect. Reconciliation is
// separate; errors and lost replies never turn an uncertain action back to pending.
export async function executeEffect({ journal, lease, effectId, provider }) {
  const effect = journal.dispatch(lease, effectId);
  let receipt;
  try { receipt = await provider.execute(effect.body, { operationId: effectId }); }
  catch (error) { return { state: 'unknown', reason: error?.kind ?? 'unknown' }; }
  // Renewal/ownership may have changed while the network was in flight. A stale
  // process cannot publish the receipt; the next owner must query the provider.
  journal.resolve(lease, effectId, receipt);
  return { state: 'resolved', receipt };
}

export async function reconcileEffect({ journal, lease, effectId, provider }) {
  journal.assertLease(lease);
  const effect = journal.effect(effectId);
  if (!effect || effect.resource !== lease.resource || effect.state !== 'unknown') throw new Error('No uncertain effect to reconcile');
  const result = await provider.reconcile(effect.body, { operationId: effectId });
  if (!result || result.authoritative !== true) return { state: 'unknown' };
  journal.resolve(lease, effectId, result.receipt);
  return { state: 'resolved', receipt: result.receipt };
}

export class GitHubDeliveryReader {
  constructor({ request, repository, maximumPages = 20 }) {
    if (typeof request !== 'function' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub adapter configuration');
    if (!Number.isSafeInteger(maximumPages) || maximumPages < 1 || maximumPages > 100) throw new Error('Invalid GitHub page bound');
    this.request = request;
    this.repository = repository;
    this.maximumPages = maximumPages;
  }

  async get(path) {
    const response = await this.request({ method: 'GET', path });
    if (response.status === 401 || response.status === 403 && !response.headers?.['retry-after'] && response.headers?.['x-ratelimit-remaining'] !== '0') throw new ProviderFailure('authorization', 'GitHub authorization failed');
    if (response.status === 429 || response.status === 403) {
      const delay = Number(response.headers?.['retry-after']);
      throw new ProviderFailure('rate-limit', 'GitHub rate limit', { retryAfterMs: Number.isFinite(delay) ? delay * 1000 : null });
    }
    if (response.status >= 500) throw new ProviderFailure('infrastructure', 'GitHub unavailable');
    if (response.status !== 200) throw new ProviderFailure('policy', `GitHub read refused (${response.status})`);
    return response.body;
  }

  async pages(path, field) {
    const rows = [];
    for (let page = 1; page <= this.maximumPages; page += 1) {
      const body = await this.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = field ? body[field] : body;
      if (!Array.isArray(batch)) throw new ProviderFailure('contract', 'Invalid GitHub page');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new ProviderFailure('incomplete', 'GitHub pagination bound reached; result is incomplete');
  }

  async pull(number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR number');
    return this.get(`/repos/${this.repository}/pulls/${number}`);
  }

  async checks(sha) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid commit SHA');
    const rows = await this.pages(`/repos/${this.repository}/commits/${sha}/check-runs?filter=all`, 'check_runs');
    return rows.map(row => ({ name: row.name, appId: row.app?.id, sha: row.head_sha, runId: row.id, status: row.status, conclusion: row.conclusion }));
  }

  async jobs(runId) {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid run ID');
    return this.pages(`/repos/${this.repository}/actions/runs/${runId}/jobs?filter=latest`, 'jobs');
  }
}
