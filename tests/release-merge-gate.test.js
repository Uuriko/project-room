import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT, REQUIRED, protectionPlan, candidateReady, grantOf, problemKeyCheck, pauseCheck, claimsFromPages, guardedMerge, openAuthorizations } from '../scripts/release-merge-gate.mjs';
const candidate = { repo: 'Uuriko/project-room', pr: 4102, head: 'a'.repeat(40), base: 'b'.repeat(40) };
const grant = { kind: 'room.release-merge.v1', ...candidate, purpose: 'deploy-fix', directiveMessageId: 'owner-directive', problemKeys: ['release:landing'], workClaimId: 'source-work' };
const protection = { enforceAdmins: true, strict: false, checks: [...REQUIRED.map(context => ({ context, app_id: 15368 })), { context: CONTEXT, app_id: -1 }] };
const info = { state: 'OPEN', isDraft: false, headRefOid: candidate.head, baseRefName: 'main', mergeable: 'MERGEABLE', statusCheckRollup: REQUIRED.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })) };
function view() { return { pause: { state: 'unclaimed' }, pr: structuredClone(info), main: candidate.base, protection, identity: 'coordinator', claims: [], slot: { state: 'claimed', owner: 'coordinator', claimedAt: '2026-10-18T00:00:00Z', leaseExpiresAt: new Date(Date.now() + 3600000).toISOString(), history: [{ action: 'claimed', note: JSON.stringify(grant) }, { action: 'retention_ack', note: 'ack' }] } }; }
test('protection adds only the landing context and preserves app bindings and strictness', () => {
  const original = { strict: false, checks: REQUIRED.map(context => ({ context, app_id: 15368 })) };
  const plan = protectionPlan(original);
  assert.deepEqual(plan.checks.slice(0, 5), original.checks);
  assert.equal(plan.strict, false); assert.equal(plan.checks.at(-1).context, CONTEXT);
  assert.deepEqual(protectionPlan(plan), plan);
  assert.throws(() => protectionPlan({ strict: false, checks: [] }), /missing/);
});
test('fresh exact head/base and all actual required checks are necessary', () => {
  candidateReady(candidate, info, candidate.base, protection);
  for (const changed of [{ ...info, headRefOid: 'c'.repeat(40) }, { ...info, isDraft: true }, { ...info, mergeable: 'UNKNOWN' }]) assert.throws(() => candidateReady(candidate, changed, candidate.base, protection), /changed/);
  assert.throws(() => candidateReady(candidate, info, 'c'.repeat(40), protection), /changed/);
  assert.throws(() => candidateReady(candidate, { ...info, statusCheckRollup: info.statusCheckRollup.slice(1) }, candidate.base, protection), /not green/);
  assert.throws(() => candidateReady(candidate, { ...info, statusCheckRollup: [...info.statusCheckRollup, { name: 'test', status: 'IN_PROGRESS', conclusion: '' }] }, candidate.base, protection), /not green/);
  assert.throws(() => candidateReady(candidate, info, candidate.base, { checks: [] }), /Install/);
});
test('lease binds holder, lifetime, generation note, exact head/base and directive', () => {
  const v = view(); assert.equal(grantOf(v.slot, v.identity, candidate).pr, 4102);
  for (const changed of [{ ...v.slot, owner: 'peer' }, { ...v.slot, state: 'unclaimed' }, { ...v.slot, leaseExpiresAt: new Date().toISOString() }, { ...v.slot, history: [{ action: 'claimed', note: 'human prose is not a grant' }] }]) assert.throws(() => grantOf(changed, v.identity, candidate));
  assert.throws(() => grantOf(v.slot, v.identity, { ...candidate, base: 'c'.repeat(40) }), /does not bind/);
});
test('problem conflicts name the holder; a selected claim and retired claims are excluded', () => {
  problemKeyCheck(grant, [{ id: 'source-work', problemKey: 'release:landing', state: 'claimed' }]);
  problemKeyCheck(grant, [{ id: 'old', problemKey: 'release:landing', state: 'done' }]);
  assert.throws(() => problemKeyCheck(grant, [{ id: 'other', problemKey: 'release:landing', state: 'in_progress', owner: 'peer' }]), /held by peer in other/);
});
test('guarded merge rechecks just before mutation and revokes approval on success', async () => {
  const calls = []; let reads = 0;
  const result = await guardedMerge(candidate, { inspect: async () => { reads++; return view(); }, status: async input => calls.push(input.state), merge: async input => { calls.push(input.sha); return { merged: true }; } });
  assert.equal(reads, 2); assert.equal(result.merged, true);
  assert.deepEqual(calls, ['success', candidate.head, 'failure']);
});
test('a base or lease generation change after approval prevents merge and revokes status', async () => {
  for (const change of ['main', 'lease']) {
    const calls = []; let reads = 0;
    await assert.rejects(guardedMerge(candidate, { inspect: async () => { const v = view(); if (++reads > 1) { if (change === 'main') v.main = 'c'.repeat(40); else v.slot.claimedAt = '2026-10-18T01:00:00Z'; } return v; }, status: async input => calls.push(input.state), merge: async () => calls.push('MERGED') }));
    assert.deepEqual(calls, ['success', 'failure']);
  }
});
test('lost status or merge response still attempts revocation; expired lease never publishes success', async () => {
  for (const where of ['status', 'merge']) {
    const calls = [];
    await assert.rejects(guardedMerge(candidate, { inspect: async () => view(), status: async input => { calls.push(input.state); if (where === 'status' && input.state === 'success') throw new Error('lost'); }, merge: async () => { throw new Error('lost'); } }), /lost/);
    assert.deepEqual(calls, ['success', 'failure']);
  }
  const calls = [];
  await assert.rejects(guardedMerge(candidate, { inspect: async () => { const v = view(); v.slot.leaseExpiresAt = new Date().toISOString(); return v; }, status: async input => calls.push(input), merge: async () => calls.push('MERGED') }));
  assert.deepEqual(calls, []);
});

test('native pause refuses normal merges, stale exceptions and missing pause state', () => {
  const pause = { state: 'claimed', owner: 'coordinator', history: [{ action: 'claimed', note: JSON.stringify({ kind: 'room.release-pause.v1', directiveMessageId: 'owner-directive' }) }] };
  pauseCheck(pause, { ...grant, owner: 'coordinator' });
  assert.throws(() => pauseCheck(pause, { ...grant, owner: 'coordinator', purpose: 'normal' }), /paused/);
  assert.throws(() => pauseCheck(pause, { ...grant, owner: 'coordinator', directiveMessageId: 'old-ruling' }), /paused/);
  assert.throws(() => pauseCheck(null, grant), /native/);
  assert.throws(() => pauseCheck({ state: 'done' }, grant), /native/);
});
test('another open head with a stale success status prevents publication or merge', async () => {
  const calls = [];
  await assert.rejects(guardedMerge(candidate, { inspect: async () => ({ ...view(), openAuthorizations: [{ headRefOid: 'c'.repeat(40) }] }), status: async x => calls.push(x), merge: async () => calls.push('MERGED') }), /unreconciled/);
  assert.deepEqual(calls, []);
});

test('real CLI dry-run makes no writes; apply preserves protection and journals before API mutation', async t => {
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const directory = mkdtempSync(join(tmpdir(), 'room-merge-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'); mkdirSync(bin);
  const stored = join(directory, 'protection.json'), calls = join(directory, 'calls.jsonl'), journal = join(directory, 'journal.json');
  writeFileSync(stored, JSON.stringify({ enforce_admins: { enabled: true }, required_status_checks: { strict: false, checks: REQUIRED.map(context => ({ context, app_id: 15368 })) } }));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);const input=fs.readFileSync(0,'utf8');
const method=args.includes('--method')?args[args.indexOf('--method')+1]:'GET';
if(method==='PATCH') {const j=JSON.parse(fs.readFileSync(process.env.FIXTURE_JOURNAL));if(j.writes.at(-1).phase!=='unknown')process.exit(8);const p=JSON.parse(fs.readFileSync(process.env.FIXTURE_PROTECTION));p.required_status_checks=JSON.parse(input);fs.writeFileSync(process.env.FIXTURE_PROTECTION,JSON.stringify(p));}
fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({method,input})+'\\n');
console.log(fs.readFileSync(process.env.FIXTURE_PROTECTION,'utf8'));
`, { mode: 0o700 });
  const run = promisify(execFile), script = new URL('../scripts/release-merge-gate.mjs', import.meta.url).pathname;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_JOURNAL: journal, FIXTURE_PROTECTION: stored, FIXTURE_CALLS: calls };
  await run(process.execPath, [script, 'install', '--state', journal], { env });
  assert.equal(readFileSync(calls, 'utf8').includes('PATCH'), false);
  await run(process.execPath, [script, 'install', '--state', journal, '--apply'], { env });
  assert.equal(JSON.parse(readFileSync(journal)).phase, 'installed');
  const after = JSON.parse(readFileSync(stored)).required_status_checks; assert.equal(after.checks.length, 6);
  assert.deepEqual(after.checks.slice(0, 5), REQUIRED.map(context => ({ context, app_id: 15368 })));
  const oldJournal = readFileSync(journal, 'utf8');
  await assert.rejects(run(process.execPath, [script, 'install', '--state', journal, '--apply'], { env }), /requires reconciliation/);
  assert.equal(readFileSync(journal, 'utf8'), oldJournal);
  const disabled = JSON.parse(readFileSync(stored)); disabled.enforce_admins.enabled = false; writeFileSync(stored, JSON.stringify(disabled));
  const patchesBefore = readFileSync(calls, 'utf8').split('PATCH').length;
  await assert.rejects(run(process.execPath, [script, 'install', '--state', join(directory, 'new-plan.json')], { env }), /Administrator enforcement/);
  assert.equal(readFileSync(calls, 'utf8').split('PATCH').length, patchesBefore);
});

test('matching public pause directive does not let another slot holder land a deploy fix', async () => {
  const calls = [];
  await assert.rejects(guardedMerge(candidate, {
    inspect: async () => { const v = view(); v.identity = 'other-seat'; v.slot.owner = 'other-seat'; v.pause = { state: 'claimed', owner: 'landing-lane', history: [{ action: 'claimed', note: JSON.stringify({ kind: 'room.release-pause.v1', directiveMessageId: 'owner-directive' }) }] }; return v; },
    status: async input => calls.push(input.state), merge: async () => { calls.push('MERGED'); return { merged: true }; },
  }), /pause holder/);
  assert.deepEqual(calls, []);
});

test('administrator enforcement and complete claim pagination fail closed', () => {
  assert.throws(() => candidateReady(candidate, info, candidate.base, { ...protection, enforceAdmins: false }), /Administrator/);
  assert.throws(() => candidateReady(candidate, info, candidate.base, { ...protection, enforceAdmins: undefined }), /Administrator/);
  assert.throws(() => claimsFromPages([{ claims: [], hasMore: true }]), /Incomplete/);
  assert.throws(() => claimsFromPages([{ claims: [] }]), /Incomplete/);
  assert.deepEqual(claimsFromPages([{ claims: [{ id: 'claim' }], hasMore: false }]), [{ id: 'claim' }]);
});


test('open authorization scan follows bounded pages and catches status or check-run successes', () => {
  const pr = (number, nodes, hasNextPage = false) => ({ number, headRefOid: String(number).padStart(40, 'a'), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage } } } } }] } });
  const pages = new Map([
    [null, { nodes: [pr(1, [{ context: CONTEXT, state: 'FAILURE' }])], pageInfo: { hasNextPage: true, endCursor: 'next' } }],
    ['next', { nodes: [pr(2, [{ context: CONTEXT, state: 'SUCCESS' }]), pr(3, [{ name: CONTEXT, conclusion: 'SUCCESS' }])], pageInfo: { hasNextPage: false } }],
  ]);
  const reads = [];
  assert.deepEqual(openAuthorizations(cursor => { reads.push(cursor); return pages.get(cursor); }).map(x => x.number), [2, 3]);
  assert.deepEqual(reads, [null, 'next']);
  assert.throws(() => openAuthorizations(() => ({ nodes: [pr(1, [], true)], pageInfo: { hasNextPage: false } })), /Incomplete/);
  assert.throws(() => openAuthorizations(() => ({ nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } })), /did not advance/);
  assert.throws(() => openAuthorizations(() => undefined), /Incomplete/);
  assert.throws(() => openAuthorizations(() => { throw new Error('504'); }), /504/);
  assert.throws(() => openAuthorizations(() => ({ nodes: [{ number: 1, headRefOid: 'a'.repeat(40), commits: { nodes: [] } }], pageInfo: { hasNextPage: false } })), /Incomplete/);
});
