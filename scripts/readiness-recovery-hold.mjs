import { createHash } from 'node:crypto';

// Narrow evidence gate, not a health verdict. The digest comes from the failed
// smoke step, not from the recovery caller recomputing an expected digest.
export function timeoutOnlyEvidence(raw, { digest, sha, origin, entry }) {
  if (typeof raw !== 'string' || raw.length > 1000000 || !/^[0-9a-f]{64}$/.test(digest ?? '')
      || createHash('sha256').update(raw).digest('hex') !== digest || !/^[0-9a-f]{40}$/.test(sha ?? '')) return false;
  let report;
  try { report = JSON.parse(raw); } catch { return false; }
  if (report?.ok !== false || report.sha !== sha || report.origin !== origin || report.entry !== entry
      || !Array.isArray(report.checks) || report.checks.length !== 16) return false;
  const checks = new Map(report.checks.map(check => [check?.name, check]));
  if (checks.size !== 16) return false;
  let timeouts = 0;
  const take = name => { const check = checks.get(name); checks.delete(name); return check; };
  for (const door of [origin, entry]) {
    for (const path of ['/api/version', '/api/version/worker']) {
      const check = take(`version ${door}${path}`);
      if (check?.pass !== true || check.status !== 200 || check.got !== sha) return false;
    }
    const health = take(`health ${door}/api/health`);
    if (health?.pass !== true || health.status !== 200 || health.body !== 'ok') return false;
    for (const path of ['/terms', '/privacy', '/']) {
      const check = take(`page ${door}${path}`);
      if (check?.pass !== true || check.status !== 200) return false;
    }
    const card = take(`agent-card ${door}/.well-known/agent-card.json`);
    if (card?.pass !== true || card.converged !== true || card.fetches !== 10 || !Number.isSafeInteger(card.attempts)
        || card.attempts < 10 || card.failureCount !== 0 || !Array.isArray(card.failures) || card.failures.length !== 0) return false;
    const ready = take(`ready ${door}/api/ready`);
    if (ready?.pass === true) {
      if (ready.status !== 200 || ready.body !== 'ready' || ready.do?.status !== 'ok'
          || ready.emailVerification !== 'enforced' || ready.emailVerificationScope !== 'durable-object') return false;
    } else if (ready?.pass === false && ready.status === 503 && ready.body === 'degraded'
        && ready.do?.status === 'timeout' && ready.do.timeoutMs === 1000 && ready.transport === undefined
        && ['unknown', 'enforced'].includes(ready.emailVerification)
        && ['unknown', 'durable-object'].includes(ready.emailVerificationScope)) timeouts++;
    else return false;
  }
  return checks.size === 0 && timeouts > 0;
}
