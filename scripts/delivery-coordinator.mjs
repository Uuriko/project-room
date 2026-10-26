#!/usr/bin/env node
// Operational shadow runner. Reads GitHub, persists observations, and explains
// admission decisions. It deliberately has no provider mutation implementation.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DeliveryJournal, repositoryResource } from '../delivery/journal.mjs';
import { DeliveryCapacity } from '../delivery/capacity.mjs';
import { GitHubDeliveryReader } from '../delivery/execution.mjs';
import { reconcilePulls } from '../delivery/reconcile.mjs';
import { planAdmissions } from '../delivery/scheduler.mjs';

export async function shadowReconcile({ journal, reader, installation, ref, capacity, slotsPerPr = 1, now = Date.now() }) {
  if (!Number.isSafeInteger(slotsPerPr) || slotsPerPr < 1) throw new Error('Invalid slots per PR');
  const resource = repositoryResource({ installation, repository: reader.repository, ref });
  const lease = journal.acquire(resource, `shadow:${randomUUID()}`, 60000);
  if (!lease) throw new Error('Repository coordinator is busy');
  try {
    const pulls = await reader.pages(`/repos/${reader.repository}/pulls?state=open&base=${encodeURIComponent(ref)}`);
    const items = pulls.map(pull => ({ id: `pr:${pull.number}`, number: pull.number,
      head: pull.head.sha, base: pull.base.sha, dependencies: [], slots: slotsPerPr,
      priority: 0, enqueuedAt: Date.parse(pull.created_at),
      state: !pull.draft && pull.labels.some(label => label.name === 'ready-to-land') ? 'eligible' : 'requested' }));
    const pool = new DeliveryCapacity(journal, `github-account:${installation}`, { maximumSlots: capacity });
    const reservations = pool.snapshot().reservations;
    const attempts = Object.entries(reservations).filter(([, entry]) => entry.state !== 'released')
      .map(([id, entry]) => ({ id, state: 'reserved', itemIds: [], slots: entry.slots }));
    const plan = planAdmissions({ items, attempts, capacity, now });
    const snapshot = { mode: 'shadow', observedAt: now, repository: reader.repository, ref,
      assumptions: { slotsPerPr, capacity, capacityIncludesOnlyCoordinatorReservations: true,
        existingGitHubRunsNotCounted: true, dependenciesNotImported: true }, items, plan };
    const id = `shadow:${resource}`;
    journal.transaction(() => {
      const { items: observedItems, ...summary } = snapshot;
      journal.write(lease, id, journal.read(id)?.revision ?? 0, { ...summary, itemCount: observedItems.length });
      for (const item of observedItems) {
        const itemId = `${id}:${item.id}`;
        journal.write(lease, itemId, journal.read(itemId)?.revision ?? 0, { ...item, observedAt: now });
      }
    });
    return snapshot;
  } finally {
    // A long provider read can outlive ownership. Preserve the original error
    // and leave expiry recovery to the next process rather than releasing it.
    try { journal.release(lease); } catch (error) { if (!/Stale delivery lease/.test(error.message)) throw error; }
  }
}

async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) {
    console.log('Usage: npm run delivery:shadow -- --database PATH --installation ID --repository OWNER/REPO --ref main --capacity N [--slots-per-pr N] [--inspect-pr N,N]');
    console.log('Read-only GitHub reconciliation; local database writes only. Admission is illustrative until existing runs and dependencies are imported.');
    return;
  }
  const allowed = new Set(['database', 'installation', 'repository', 'ref', 'capacity', 'slots-per-pr', 'inspect-pr']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    if (!args[index]?.startsWith('--') || !allowed.has(key) || !args[index + 1] || Object.hasOwn(options, key)) throw new Error('Invalid command arguments; use --help');
    options[key] = args[index + 1];
  }
  for (const name of ['database', 'installation', 'repository', 'ref', 'capacity']) if (!options[name]) throw new Error(`Missing --${name}`);
  const token = process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const reader = new GitHubDeliveryReader({ repository: options.repository, request: async ({ path }) => {
    const response = await fetch(`https://api.github.com${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'
    } });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
  } });
  const db = new DatabaseSync(options.database);
  chmodSync(options.database, 0o600);
  db.exec('PRAGMA busy_timeout=5000');
  const journal = new DeliveryJournal(db, { transaction: fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } });
  try {
    journal.initialize();
    const result = await shadowReconcile({ journal, reader, installation: options.installation, ref: options.ref,
      capacity: Number(options.capacity), slotsPerPr: Number(options['slots-per-pr'] ?? 1) });
    const reconciliation = await reconcilePulls({ journal, reader, installation: options.installation, ref: options.ref,
      numbers: options['inspect-pr'] ? options['inspect-pr'].split(',').map(Number) : [] });
    console.log(JSON.stringify({ ...result, reconciliation }, null, 2));
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Delivery shadow stopped: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1; });
}
