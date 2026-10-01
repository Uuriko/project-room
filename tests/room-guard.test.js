// room-guard turns advisory work-claim leases into a commit-time stop: a
// change that touches another member's live claim fails, the holder passes,
// and an unreachable Room never blocks local work unless --strict asks it to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { gitChangedFiles, parseGuardArgs, runGuard } from '../scripts/room-guard.mjs';

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

  await owner.releaseWorkItem('held');
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
});

test('guard arguments reject unknown options and options missing their value', () => {
  assert.deepEqual(parseGuardArgs(['--files', 'a.mjs, b.mjs', '--strict']).options.files, ['a.mjs', 'b.mjs']);
  assert.equal(parseGuardArgs(['--base', 'origin/main']).options.base, 'origin/main');
  assert.match(parseGuardArgs(['--files']).error, /needs a value/);
  assert.match(parseGuardArgs(['--base', '--strict']).error, /needs a value/);
  assert.match(parseGuardArgs(['--force']).error, /Unknown option --force/);
});
