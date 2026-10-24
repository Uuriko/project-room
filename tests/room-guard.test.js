// room-guard turns advisory work-claim leases into a commit-time stop: a
// change that touches another member's live claim fails, the holder passes,
// and an unreachable Room never blocks local work unless --strict asks it to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { claimAccuracy, fetchOpenPrs, gitChangedFiles, overlapsByFile, parseGuardArgs, prOverlaps, runGuard, selfPrefixes } from '../scripts/room-guard.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', { id: 'add-reviewer', type: 'member.added',
    data: { memberId: 'reviewer', displayName: 'Reviewer', kind: 'human', permissions: [] } });
  const peerKey = store.issueAccessKey('commons', 'reviewer');
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { owner: new RoomAgentClient({ origin, roomId: 'commons', token: ownerKey }),
    peer: new RoomAgentClient({ origin, roomId: 'commons', token: peerKey }) };
}

// Test doubles fail loudly on any method the guard was not expected to call.
const strictDouble = methods => new Proxy(methods, {
  get(target, key) {
    if (typeof key === 'symbol' || Object.hasOwn(target, key)) return target[key];
    throw new Error(`unexpected client call: ${key}`);
  }
});

const roundOf = c => ({ expectedClaimedAt: (c.claim ?? c).claimedAt, expectedHistoryLength: ((c.claim ?? c).history?.length ?? 0) + ((c.claim ?? c).historyOmitted ?? 0) });
test('a change under another member\'s live claim fails the guard; the holder and released files pass', async t => {
  const { owner, peer } = await fixture(t);
  await owner.workClaim('held', { files: ['server/locked'], leaseHours: 2 });
  const files = ['server/locked/a.mjs', 'docs/free.md'];

  const blocked = await runGuard({ files, client: peer, memberId: 'reviewer' });
  assert.equal(blocked.code, 1);
  assert.deepEqual(blocked.conflicts.map(c => [c.file, c.heldPath, c.claimId, c.owner]), [['server/locked/a.mjs', 'server/locked', 'held', 'owner']]);
  assert.match(blocked.lines.join('\n'), /server\/locked\/a\.mjs is held by owner under held \(claims server\/locked\) until /);

  const warned = await runGuard({ files, client: peer, memberId: 'reviewer', warn: true });
  assert.deepEqual([warned.code, warned.conflicts.length], [0, 1]);
  assert.equal((await runGuard({ files, client: owner, memberId: 'owner' })).code, 0);

  await owner.releaseWorkItem('held', roundOf(await owner.workClaimGet('held')));
  assert.equal((await runGuard({ files, client: peer, memberId: 'reviewer' })).code, 0);
});

test('an unreachable or unconfigured Room passes with a notice unless --strict', async () => {
  const offline = strictDouble({ workClaims: async () => { throw new TypeError('fetch failed'); } });
  const files = ['server/a.mjs'];
  const soft = await runGuard({ files, client: offline, memberId: 'me' });
  assert.equal(soft.code, 0);
  assert.match(soft.lines[0], /Room unreachable \(service_unavailable\); not blocking/);
  assert.equal((await runGuard({ files, client: offline, memberId: 'me', strict: true })).code, 3);
  assert.equal((await runGuard({ files, client: null, unavailable: 'config_not_found' })).code, 0);
  assert.equal((await runGuard({ files, client: null, unavailable: 'config_not_found', strict: true })).code, 3);
  assert.equal((await runGuard({ files: [], client: strictDouble({}) })).code, 0, 'no changed files makes no Room call');
});

test('changed files come from the staged index, or from the branch range against --base', t => {
  const dir = mkdtempSync(join(tmpdir(), 'room-guard-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', dir, '-c', 'user.email=guard@example.com', '-c', 'user.name=Guard', ...args], { encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(['add', 'base.txt']); git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'lane']);
  writeFileSync(join(dir, 'committed.txt'), 'lane\n');
  git(['add', 'committed.txt']); git(['commit', '-q', '-m', 'lane']);
  writeFileSync(join(dir, 'staged.txt'), 'staged\n');
  writeFileSync(join(dir, 'unstaged.txt'), 'unstaged\n');
  git(['add', 'staged.txt']);
  assert.deepEqual(gitChangedFiles({ git }), ['staged.txt']);
  assert.deepEqual(gitChangedFiles({ git, base: 'main' }), ['committed.txt']);
  git(['mv', 'committed.txt', 'moved.txt']);
  assert.deepEqual(gitChangedFiles({ git }).sort(), ['committed.txt', 'moved.txt', 'staged.txt']);
});

test('a git-quoted name-status path still names the leased file', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'room-guard-quote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', dir, '-c', 'core.quotePath=true', '-c', 'user.email=guard@example.com', '-c', 'user.name=Guard', ...args], { encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server', 'café.mjs'), 'a\n');
  git(['add', 'server/café.mjs']);
  git(['commit', '-q', '-m', 'base']);
  writeFileSync(join(dir, 'server', 'café.mjs'), 'b\n');
  git(['add', 'server/café.mjs']);
  const files = gitChangedFiles({ git });
  assert.deepEqual(files, ['server/café.mjs']);
  const guard = await runGuard({
    files,
    memberId: 'reviewer',
    now: Date.parse('2026-10-10T03:50:00Z'),
    client: strictDouble({ workClaims: async () => ({ claims: [{
      id: 'held', state: 'claimed', owner: 'other',
      leaseExpiresAt: '2026-10-10T12:00:00.000Z',
      files: ['server/café.mjs']
    }] }) })
  });
  assert.equal(guard.code, 1);
  assert.equal(guard.conflicts[0].file, 'server/café.mjs');
  assert.equal(guard.conflicts[0].claimId, 'held');
  const quoted = () => 'M\t"server/tab\\tname.mjs"\n';
  assert.deepEqual(gitChangedFiles({ git: quoted }), ['server/tab\tname.mjs']);
});

test('guard arguments reject unknown options and options missing their value', () => {
  assert.deepEqual(parseGuardArgs(['--files', 'a.mjs, b.mjs', '--strict']).options.files, ['a.mjs', 'b.mjs']);
  assert.equal(parseGuardArgs(['--base', 'origin/main']).options.base, 'origin/main');
  assert.match(parseGuardArgs(['--files']).error, /needs a value/);
  assert.match(parseGuardArgs(['--base', '--strict']).error, /needs a value/);
  assert.match(parseGuardArgs(['--force']).error, /Unknown option --force/);
  assert.match(parseGuardArgs(['--files', 'a.mjs', '--base', 'main']).error, /either --files or --base/);
});

test('a lease a few minutes past its stamp still blocks, and a bad path does not crash the guard', async () => {
  const at = Date.parse('2026-10-01T12:00:00Z');
  const claim = leaseExpiresAt => ({ claims: [{ id: 'held', state: 'claimed', owner: 'owner', leaseExpiresAt, files: ['server/a.mjs'] }] });
  const client = leaseExpiresAt => strictDouble({ workClaims: async () => claim(leaseExpiresAt) });
  assert.equal((await runGuard({ files: ['server/a.mjs'], client: client('2026-10-01T11:56:00.000Z'), memberId: 'reviewer', now: at })).code, 1);
  assert.equal((await runGuard({ files: ['server/a.mjs'], client: client('2026-10-01T11:54:00.000Z'), memberId: 'reviewer', now: at })).code, 0);

  const mixed = strictDouble({ workClaims: async () => ({ claims: [
    { id: 'bad', state: 'claimed', owner: 'other', leaseExpiresAt: '2026-10-01T13:00:00.000Z', files: ['../outside', 'docs/locked.md'] },
    { id: 'text', state: 'claimed', owner: 'other', leaseExpiresAt: '2026-10-01T13:00:00.000Z', files: 'docs/locked.md' }
  ] }) });
  const blocked = await runGuard({ files: ['docs/locked.md', 'docs/free.md'], client: mixed, memberId: 'me', now: at });
  assert.equal(blocked.code, 1);
  assert.deepEqual(blocked.conflicts.map(conflict => conflict.claimId), ['bad']);
  const usage = await runGuard({ files: ['../outside'], client: strictDouble({ workClaims: async () => { throw new Error('room should not be called'); } }), memberId: 'me' });
  assert.equal(usage.code, 2);
});


// --prs and --claim: open PRs carry no lease, so they are reported, never
// blocking; a claim's file list is checked against the actual change.
const NOW = Date.parse('2026-10-20T05:00:00Z');
const board = claims => ({ workClaims: async () => claims });
const liveClaim = (id, owner, files) => ({ id, owner, state: 'claimed', files, leaseExpiresAt: '2026-10-20T10:00:00Z' });
const openPr = (number, branch, files, hoursAgo = 1) => ({ number, branch, files, updatedAt: new Date(NOW - hoursAgo * 3600000).toISOString() });

test('prOverlaps skips your own branch prefix and files already reported as claimed', () => {
  const prs = [openPr(1, 'jill/a', ['server/x.mjs', 'docs/y.md']), openPr(2, 'claude/other', ['server/x.mjs']),
    openPr(3, 'codex/b', ['server/z.mjs']), openPr(4, 'jill/c', ['server/held.mjs'])];
  const files = ['server/x.mjs', 'server/z.mjs', 'server/held.mjs'];
  assert.deepEqual(selfPrefixes('claude/mine', undefined), ['claude/']);
  assert.deepEqual(selfPrefixes('main', undefined), []);
  const overlaps = prOverlaps(prs, files, { selfBranch: 'claude/mine', claimed: new Set(['server/held.mjs']) });
  assert.deepEqual(overlaps.map(pr => [pr.number, pr.files]), [[1, ['server/x.mjs']], [3, ['server/z.mjs']]]);
  assert.deepEqual(prOverlaps(prs, files, { selfBranch: 'claude/mine', mine: [] }).map(pr => pr.number), [1, 2, 3, 4], '--mine overrides the prefix');
});

test('overlapsByFile groups a hot file onto one line, newest first', () => {
  const overlaps = [openPr(7, 'jill/old', ['server/http.mjs'], 50), openPr(8, 'jill/new', ['server/http.mjs'], 2),
    openPr(9, 'codex/mid', ['server/http.mjs'], 10), openPr(10, 'lab/x', ['server/http.mjs'], 30)];
  assert.deepEqual(overlapsByFile(overlaps, NOW), ['  server/http.mjs: 4 open PRs; newest #8 jill/new, updated 2h ago; #9 codex/mid, updated 10h ago; #10 lab/x, updated 30h ago; +1 more']);
});

test('claimAccuracy names changed files outside the claim and claimed files left unchanged', () => {
  const claims = [liveClaim('mine', 'me', ['server/a.mjs', 'docs/', 'server/unused.mjs'])];
  assert.deepEqual(claimAccuracy(claims, 'mine', ['server/a.mjs', 'docs/guide.md', 'server/http.mjs']),
    { found: true, unclaimedChanges: ['server/http.mjs'], unusedClaims: ['server/unused.mjs'] });
  assert.deepEqual(claimAccuracy(claims, 'missing', ['server/a.mjs']), { found: false });
});

test('runGuard reports PR overlaps and claim accuracy without changing the exit code', async () => {
  const claims = [liveClaim('mine', 'me', ['server/a.mjs']), liveClaim('theirs', 'them', ['server/b.mjs'])];
  const clean = await runGuard({ files: ['server/a.mjs', 'server/c.mjs'], client: board(claims), memberId: 'me', now: NOW,
    openPrs: [openPr(5, 'jill/x', ['server/c.mjs'])], selfBranch: 'claude/y', claimId: 'mine' });
  assert.equal(clean.code, 0, 'open PRs are advisory');
  assert.deepEqual(clean.prOverlaps.map(pr => pr.number), [5]);
  assert.match(clean.lines.join('\n'), /server\/c\.mjs: 1 open PR; newest #5 jill\/x/);
  assert.match(clean.lines.join('\n'), /changed but not in claim mine .*: server\/c\.mjs/);
  const blocked = await runGuard({ files: ['server/b.mjs'], client: board(claims), memberId: 'me', now: NOW, openPrs: [openPr(6, 'jill/z', ['server/b.mjs'])] });
  assert.equal(blocked.code, 1, 'a live claim still blocks');
  assert.deepEqual(blocked.prOverlaps, [], 'the claim report already covers that file');
  const offline = await runGuard({ files: ['server/a.mjs'], client: board(claims), memberId: 'me', now: NOW, prsUnavailable: 'gh CLI not installed' });
  assert.equal(offline.code, 0);
  assert.match(offline.lines.join('\n'), /open pull requests unavailable \(gh CLI not installed\); not checked/);
  const exact = await runGuard({ files: ['server/a.mjs'], client: board(claims), memberId: 'me', now: NOW, claimId: 'mine' });
  assert.match(exact.lines.join('\n'), /claim mine lists exactly the changed files/);
});

test('fetchOpenPrs pages explicitly and records renamed-from paths', async () => {
  const calls = [];
  const pulls = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, head: { ref: `b${i + 1}` }, updated_at: '2026-10-20T00:00:00Z' }));
  const gh = async args => {
    calls.push(args.join(' '));
    const path = args[1];
    if (path.startsWith('repos/o/r/pulls?state=open')) return JSON.stringify(path.endsWith('page=1') ? pulls : [{ number: 101, head: { ref: 'b101' } }]);
    const number = Number(/pulls\/(\d+)\/files/.exec(path)[1]);
    return JSON.stringify(number === 101 ? [{ filename: 'new.mjs', previous_filename: 'old.mjs' }] : [{ filename: `f${number}.mjs` }]);
  };
  const prs = await fetchOpenPrs('o/r', { gh, concurrency: 4 });
  assert.equal(prs.length, 101);
  assert.deepEqual(prs.find(pr => pr.number === 101).files, ['new.mjs', 'old.mjs']);
  assert.ok(calls.every(call => !call.includes('--paginate')), 'no Link-header pagination');
  assert.ok(calls.includes('api repos/o/r/pulls?state=open&per_page=100&page=2'));
});

test('parseGuardArgs accepts --prs, --repo, --mine and --claim and rejects misuse', () => {
  assert.deepEqual(parseGuardArgs(['--prs', '--repo', 'Uuriko/project-room', '--mine', 'claude/,lab/', '--claim', 'c1']).options,
    { strict: false, warn: false, json: false, files: undefined, base: undefined, prs: true, repo: 'Uuriko/project-room', claim: 'c1', mine: ['claude/', 'lab/'] });
  assert.match(parseGuardArgs(['--repo', 'a/b']).error, /only apply with --prs/);
  assert.match(parseGuardArgs(['--prs', '--repo', 'not a repo']).error, /OWNER\/NAME/);
  assert.match(parseGuardArgs(['--claim']).error, /needs a value/);
});
