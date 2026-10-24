#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openEvolution, events } from '../client/evolution/store.mjs';
import { installRepositoryPackage } from '../client/evolution/repository-package.mjs';
import { activate, evaluate } from '../client/evolution/registry.mjs';
import { configure, submit, runJob } from '../client/evolution/executor.mjs';

// Isolated, reproducible git fixture. No shared checkout or live installation.
const directory = resolve(process.argv[2]); mkdirSync(directory, { recursive: true, mode: 0o700 });
const repository = join(directory, 'repository'); mkdirSync(repository, { mode: 0o700 });
const git = (...args) => execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
git('init', '-q'); git('config', 'user.name', 'Project Room pilot'); git('config', 'user.email', 'pilot@localhost');
mkdirSync(join(repository, 'tests')); writeFileSync(join(repository, 'tests', 'acceptance.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('verified result',()=>assert.equal(2+2,4));\n");
git('add', '.'); git('commit', '-qm', 'First verification fixture'); const one = git('rev-parse', 'HEAD');
writeFileSync(join(repository, 'README'), 'Second representative source revision\n'); git('add', '.'); git('commit', '-qm', 'Second source revision'); const two = git('rev-parse', 'HEAD');
const store = openEvolution(join(directory, 'device'));
try {
  configure(store, { rooms: ['pilot'], capabilities: ['repository-verify'], maxJobs: 1, cpuSlots: 2, memoryBytes: 1024 ** 3, reserveMemoryBytes: 0, paused: false });
  const first = installRepositoryPackage(store, { repository, tests: ['tests/acceptance.test.mjs'], memoryBytes: 128 * 1024 ** 2 });
  const second = installRepositoryPackage(store, { repository, tests: ['tests/acceptance.test.mjs'], memoryBytes: 128 * 1024 ** 2, version: 'v2' });
  activate(store, { capability: 'repository-verify', hash: first.hash, expectedRevision: 0, bootstrap: true, reason: 'pilot bootstrap' });
  const pinned = submit(store, { room: 'pilot', operation: 'queued-before-promotion', capability: 'repository-verify', input: { revision: one } });
  const pairs = [], results = [];
  for (const [i, revision] of [one, two].entries()) {
    const baseline = submit(store, { room: 'pilot', operation: 'baseline-' + i, capability: 'repository-verify', input: { revision } });
    const candidate = submit(store, { room: 'pilot', operation: 'candidate-' + i, capability: 'repository-verify', input: { revision }, candidateHash: second.hash });
    for (const job of [baseline, candidate]) results.push(await runJob(store, job.id));
    pairs.push({ baselineJob: baseline.id, candidateJob: candidate.id });
  }
  const evaluation = evaluate(store, { capability: 'repository-verify', baseline: first.hash, candidate: second.hash, pairs });
  activate(store, { capability: 'repository-verify', hash: second.hash, expectedRevision: 1, percent: 10, reason: 'pilot canary' });
  activate(store, { capability: 'repository-verify', hash: second.hash, expectedRevision: 2, percent: 100, reason: 'pilot equivalent artifacts; no performance gain claimed' });
  const old = await runJob(store, pinned.id);
  const report = { evaluation, oldJobStayedPinned: old.job.pin === first.hash, oldJobState: old.job.state,
    results: results.map(r => ({ jobId: r.job.id, state: r.job.state, result: r.job.result })), events: events(store),
    boundary: 'Local git fixture; no physical second laptop or production release verified.' };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report: join(directory, 'report.json'), evaluation: evaluation.passed, oldJobStayedPinned: report.oldJobStayedPinned, completedJobs: results.filter(r => r.job.state === 'completed').length + Number(old.job.state === 'completed') }));
} finally { store.close(); }
