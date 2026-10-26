import { randomUUID } from 'node:crypto';
import { repositoryResource } from './journal.mjs';

export const DEFAULT_WORKFLOWS = Object.freeze([
  '.github/workflows/test.yml', '.github/workflows/pr-gates.yml', '.github/workflows/schema-gate.yml'
]);

// Workflow identity and attempt matter: check names alone collapse independent
// suites and can mix a cancelled attempt with a current running attempt.
export function workflowVerdict(runs, head, required = DEFAULT_WORKFLOWS) {
  if (!Array.isArray(required) || !required.length) throw new Error('Required workflow policy missing');
  const evidence = required.map(path => {
    const candidates = runs.filter(run => run.path === path && run.event === 'pull_request' && run.head_sha === head);
    if (candidates.some(run => !Number.isSafeInteger(run.run_number) || !Number.isSafeInteger(run.run_attempt) || !Number.isSafeInteger(run.id))) throw new Error('Invalid workflow observation');
    candidates.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
    const run = candidates[0];
    return run ? { path, id: run.id, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion } : { path, status: 'missing', conclusion: null };
  });
  const failures = evidence.filter(run => run.status === 'completed' && ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(run.conclusion));
  const cancelled = evidence.some(run => run.status === 'completed' && run.conclusion === 'cancelled');
  const missing = evidence.some(run => run.status === 'missing');
  const waiting = evidence.some(run => run.status !== 'completed' && run.status !== 'missing');
  const state = failures.length ? 'checks-failed' : waiting ? 'waiting-checks' : cancelled ? 'checks-cancelled' : missing ? 'missing-checks' : evidence.every(run => run.conclusion === 'success') ? 'checks-passed' : 'checks-incomplete';
  return { state, evidence };
}

// Every watched open PR remains durable and gets another check, even when it is
// failing/cancelled/missing checks. This is observational, never merge authority.
export async function reconcilePulls({ journal, reader, installation, ref, numbers = [], requiredWorkflows = DEFAULT_WORKFLOWS, intervalMs = 240000, maximum = 20 }) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error('Invalid reconciliation bounds');
  if (!Array.isArray(numbers) || numbers.length > maximum || numbers.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Invalid pull selection');
  const resource = repositoryResource({ installation, repository: reader.repository, ref });
  const prefix = `watch:${resource}:`;
  const explicit = new Set(numbers);
  const watched = [];
  let after = '';
  for (;;) {
    const page = journal.list(resource, { after, limit: 100 });
    watched.push(...page.filter(row => row.id.startsWith(prefix)).map(row => row.value.data));
    if (page.length < 100) break;
    after = page.at(-1).id;
  }
  const now = journal.now();
  const due = watched.filter(row => row.nextPollAt !== null && row.nextPollAt <= now && !explicit.has(row.number)).sort((a, b) => a.nextPollAt - b.nextPollAt || a.number - b.number);
  const selected = [...explicit, ...due.map(row => row.number)].slice(0, maximum);
  const results = [];
  for (const number of selected) {
    const lease = journal.acquire(resource, `reconcile:${randomUUID()}`, 60000);
    if (!lease) break;
    const id = `${prefix}${number}`, previous = journal.read(id);
    try {
      let observation;
      try {
        const pull = await reader.pull(number);
        if (pull.base.repo.full_name.toLowerCase() !== reader.repository.toLowerCase() || pull.base.ref !== ref) {
          observation = { state: 'target-changed', head: pull.head.sha, base: pull.base.sha, evidence: [] };
        } else if (pull.state !== 'open') {
          observation = { state: pull.merged ? 'merged' : 'closed', head: pull.head.sha, base: pull.base.sha, evidence: [] };
        } else {
          const runs = await reader.runs(pull.head.sha);
          const current = await reader.pull(number);
          if (current.head.sha !== pull.head.sha || current.base.sha !== pull.base.sha || current.state !== pull.state || current.base.ref !== ref) {
            observation = { state: 'changed-during-read', head: current.head.sha, base: current.base.sha, evidence: [] };
          } else {
            observation = { ...workflowVerdict(runs, pull.head.sha, requiredWorkflows), head: pull.head.sha, base: pull.base.sha };
          }
        }
      } catch (error) {
        observation = { state: 'observation-error', reason: error?.kind ?? 'provider-error', head: previous?.value.data.head ?? null, base: previous?.value.data.base ?? null, evidence: [], retryAfterMs: Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0 };
      }
      const terminal = ['closed', 'merged', 'target-changed'].includes(observation.state);
      const value = { number, ...observation, observedAt: journal.now(), nextPollAt: terminal ? null : journal.now() + Math.max(intervalMs, observation.retryAfterMs ?? 0), mergeAuthorized: false };
      journal.write(lease, id, previous?.revision ?? 0, value);
      const before = previous?.value.data;
      const changed = !before || before.state !== value.state || before.head !== value.head || before.base !== value.base || JSON.stringify(before.evidence) !== JSON.stringify(value.evidence);
      results.push({ ...value, changed });
    } finally {
      try { journal.release(lease); } catch (error) { if (!/Stale delivery lease/.test(error.message)) throw error; }
    }
  }
  return { mode: 'shadow', watched: new Set([...watched.map(row => row.number), ...numbers]).size, observations: results, deferredDue: Math.max(0, explicit.size + due.length - selected.length) };
}
