import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT, REQUIRED, roomRead, protectionPlan, landingProtection, candidateReady, grantOf, problemKeyCheck, pauseCheck, claimsFromPages, collisionClaims, guardedMerge, openAuthorizations } from '../scripts/release-merge-gate.mjs';
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
  assert.throws(() => candidateReady(candidate, info, candidate.base, { checks: [] }), /Administrator/);
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
  for (const change of ['main', 'head', 'lease', 'expiry', 'grant']) {
    const calls = []; let reads = 0;
    await assert.rejects(guardedMerge(candidate, { inspect: async () => { const v = view(); if (++reads > 1) { if (change === 'main') v.main = 'c'.repeat(40); else if (change === 'head') v.pr.headRefOid = 'c'.repeat(40); else if (change === 'expiry') v.slot.leaseExpiresAt = new Date().toISOString(); else if (change === 'grant') v.slot.history[0].note = JSON.stringify({ ...grant, directiveMessageId: 'changed-directive' }); else v.slot.claimedAt = '2026-10-18T01:00:00Z'; } return v; }, status: async input => calls.push(input.state), merge: async () => calls.push('MERGED') }));
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


test('dry run validates once and records the verified grant without publishing authorization', async () => {
  const calls = []; let reads = 0;
  const result = await guardedMerge(candidate, {
    inspect: async () => { reads++; return view(); },
    validated: value => calls.push(value), status: async () => assert.fail('dry run published'), merge: async () => assert.fail('dry run merged'),
  }, { apply: false });
  assert.equal(reads, 1); assert.equal(result.dryRun, true); assert.equal(calls[0].head, candidate.head);
});

test('journal persistence failure prevents publication; invalid initial state is never recorded as validated', async () => {
  for (const invalid of [false, true]) {
    const calls = [];
    await assert.rejects(guardedMerge(candidate, {
      inspect: async () => { const v = view(); if (invalid) v.main = 'c'.repeat(40); return v; },
      validated: () => { calls.push('journal'); throw new Error('disk failure'); },
      status: async () => calls.push('status'), merge: async () => calls.push('merge'),
    }));
    assert.deepEqual(calls, invalid ? [] : ['journal']);
  }
});

test('actual merge CLI performs two complete scans, journals the validated grant and revokes after a changed head', async t => {
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = mkdtempSync(join(tmpdir(), 'release-cli-inspect-'));
  const bin = join(root, 'bin'), connection = join(root, 'connection');
  mkdirSync(bin); mkdirSync(connection, { mode: 0o700 });
  const requests = [];
  let keys = grant.problemKeys;
  const server = createServer((req, res) => {
    requests.push(req.url); res.setHeader('content-type', 'application/json');
    const v = view(); v.slot.history[0].note = JSON.stringify({ ...grant, problemKeys: keys });
    if (req.url === '/api/session') return res.end(JSON.stringify({ authMode: 'room', roomId: 'muse-room',
      member: { id: 'coordinator', kind: 'agent', active: true, revision: 0, permissions: [] },
      expiresAt: Date.now() + 3600000, account: null, csrf: null, sessionBinding: null, sessionRevision: null }));
    if (req.url.endsWith('/MERGE-SLOT')) return res.end(JSON.stringify(v.slot));
    if (req.url.endsWith('/RELEASE-PAUSE')) return res.end(JSON.stringify(v.pause));
    if (req.url.includes('/work-claims?')) return res.end(JSON.stringify({ roomId: 'muse-room', claims: [], hasMore: false }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(connection, 'connection.json'), JSON.stringify({ version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: 'muse-room', memberId: 'coordinator', token: 'x'.repeat(43) }), { mode: 0o600 });
  const fixture = join(root, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ info, base: candidate.base, protection: { enforce_admins: { enabled: true }, required_status_checks: { strict: false, checks: [{ context: CONTEXT, app_id: null }] } } }));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2), f=JSON.parse(fs.readFileSync(process.env.FIXTURE_DATA));
const prior=fs.existsSync(process.env.FIXTURE_CALLS)?fs.readFileSync(process.env.FIXTURE_CALLS,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
const mutation=a.includes('--method'), input=mutation?JSON.parse(fs.readFileSync(0,'utf8')):null;
if(mutation){const j=JSON.parse(fs.readFileSync(process.env.FIXTURE_JOURNAL));if(!j.grant||j.grant.head!==${JSON.stringify(candidate.head)}||j.writes.at(-1).phase!=='unknown')process.exit(8);}
fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({a,input})+'\\n');
let out;
if(a[0]==='pr') {out=f.info;if(process.env.CHANGE_HEAD==='1'&&prior.some(x=>x.a[0]==='pr'))out={...out,headRefOid:'c'.repeat(40)};}
else if(a.includes('graphql'))out={data:{repository:{pullRequests:{nodes:[],pageInfo:{hasNextPage:false}}}}};
else if(a.some(x=>x.endsWith('/protection')))out=f.protection;
else if(a.some(x=>x.endsWith('/git/ref/heads/main')))out={object:{sha:f.base}};
else if(mutation&&a.includes('PUT'))out={merged:true,sha:'d'.repeat(40)};
else if(mutation)out={state:input.state};
else process.exit(9);
console.log(JSON.stringify(out));
`, { mode: 0o700 });
  const run = promisify(execFile), script = new URL('../scripts/release-merge-gate.mjs', import.meta.url).pathname;
  for (const keyMode of ['present', 'absent', 'empty']) for (const statusRequired of [true, false]) for (const changed of [false, true]) {
    keys = keyMode === 'present' ? grant.problemKeys : keyMode === 'empty' ? [] : undefined;
    writeFileSync(fixture, JSON.stringify({ info, base: candidate.base, protection: { enforce_admins: { enabled: true }, required_status_checks: statusRequired ? { strict: false, checks: [{ context: CONTEXT }] } : null } }));
    requests.length = 0;
    const calls = join(root, `calls-${keyMode}-${statusRequired}-${changed}.jsonl`), journal = join(root, `journal-${keyMode}-${statusRequired}-${changed}.json`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_DATA: fixture, FIXTURE_CALLS: calls, FIXTURE_JOURNAL: journal, CHANGE_HEAD: changed ? '1' : '0' };
    const command = run(process.execPath, [script, 'merge', '--pr', String(candidate.pr), '--head', candidate.head, '--base', candidate.base, '--state', journal, '--connection', connection, '--apply'], { env });
    if (changed) await assert.rejects(command, /head\/base/); else await command;
    const observed = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(observed.filter(x => x.a.includes('graphql')).length, statusRequired ? 2 : 0);
    // One explicit identity check plus the SDK's fresh preflight on each
    // of each remaining selected read per inspection remains intact.
    assert.equal(requests.filter(url => url === '/api/session').length, keyMode === 'present' ? 12 : 6);
    assert.equal(requests.filter(url => url.includes('/work-claims?')).length, keyMode === 'present' ? 6 : 0);
    assert.deepEqual(observed.filter(x => x.input?.context === CONTEXT).map(x => x.input.state), statusRequired ? ['success', 'failure'] : []);
    assert.equal(observed.filter(x => x.a.includes('PUT')).length, changed ? 0 : 1);
    const saved = JSON.parse(readFileSync(journal));
    assert.equal(saved.grant.head, candidate.head);
    if (statusRequired) assert.equal(saved.writes.at(-1).input.state, 'failure');
    else assert.equal(saved.writes.length, changed ? 0 : 1);
  }
});

test('null required checks means none; incomplete protection and disabled admin enforcement refuse', () => {
  const p = landingProtection({ required_status_checks: null, enforce_admins: { enabled: true } });
  candidateReady(candidate, { ...info, statusCheckRollup: [] }, candidate.base, p);
  assert.throws(() => landingProtection({}), /Complete/);
  assert.throws(() => landingProtection({ required_status_checks: {} }), /Complete/);
  assert.throws(() => candidateReady(candidate, info, candidate.base, { ...p, enforceAdmins: false }), /Administrator/);
});
test('status-free merge still refuses required check, pause, ownership and protection races', async () => {
  for (const change of ['check', 'pause', 'owner', 'protection', 'base', 'expiry', 'grant']) {
    let reads = 0; const writes = [];
    await assert.rejects(guardedMerge(candidate, { inspect: async () => {
      const v = view(); v.protection = { ...protection, checks: protection.checks.filter(x => x.context !== CONTEXT) };
      if (++reads === 2) {
        if (change === 'check') v.pr.statusCheckRollup[0].conclusion = 'FAILURE';
        if (change === 'pause') v.pause = null;
        if (change === 'owner') v.slot.owner = 'peer';
        if (change === 'protection') v.protection = protection;
        if (change === 'base') v.main = 'c'.repeat(40);
        if (change === 'expiry') v.slot.leaseExpiresAt = new Date().toISOString();
        if (change === 'grant') v.slot.history[0].note = JSON.stringify({ ...grant, directiveMessageId: 'changed' });
      }
      return v;
    }, status: async x => writes.push(x), merge: async x => writes.push(x) }));
    assert.deepEqual(writes, []);
  }
});

test('collision scans validate keys and retain conflicts and incomplete-page refusals', async () => {
  let reads = 0;
  const read = async () => { reads++; return { claims: [{ id: 'peer', owner: 'peer', state: 'claimed', problemKey: 'release:landing' }], hasMore: false }; };
  for (const problemKeys of [null, 'key', [''], [123]]) await assert.rejects(collisionClaims({ ...grant, problemKeys }, read), /problemKeys/);
  assert.equal(reads, 0);
  const claims = await collisionClaims(grant, read);
  assert.equal(reads, 3);
  assert.throws(() => problemKeyCheck(grant, claims), /held by peer/);
  await assert.rejects(collisionClaims(grant, async () => ({ claims: [], hasMore: true })), /Incomplete/);
});


test('Room read failure retains safe phase/status/code without logging private remote diagnostics', async () => {
  const error = Object.assign(new Error('Bearer SECRET response body'), {
    status: 503, code: 'request_failed', retryAfterMs: 1000,
    hint: 'SECRET hint', response: { token: 'SECRET' }, url: 'https://SECRET.invalid' });
  const writes = [];
  await assert.rejects(guardedMerge(candidate, {
    inspect: () => roomRead('merge-slot', async () => { throw error; }),
    validated: () => writes.push('journal'), status: () => writes.push('status'), merge: () => writes.push('merge'),
  }), failure => {
    assert.equal(failure.message, 'Room read failed {"phase":"merge-slot","status":503,"code":"request_failed","retryAfterMs":1000}');
    assert.equal(failure.cause, error);
    assert.equal(failure.message.includes('SECRET'), false);
    return true;
  });
  assert.deepEqual(writes, []);
});
test('Room read diagnostics distinguish timeout and sanitize malformed metadata without changing successful reads', async () => {
  const result = { state: 'unclaimed' };
  assert.equal(await roomRead('release-pause', async () => result), result);
  for (const [error, detail] of [
    [new DOMException('private URL', 'TimeoutError'), { code: 'timeout' }],
    [new TypeError('private URL'), { code: 'transport_failed' }],
    [Object.assign(new Error('SECRET'), { status: '503 SECRET', code: 'SECRET token\n', retryAfterMs: -1 }), {}],
  ]) await assert.rejects(roomRead('connection', async () => { throw error; }), failure => {
    assert.equal(failure.message, `Room read failed ${JSON.stringify({ phase: 'connection', ...detail })}`);
    return true;
  });
});
