import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from '../room-acp/src/join.mjs';
import { loadConnection } from '../room-acp/src/credentials.mjs';
import { startRoom } from './room-acp-fixture.mjs';

function journalDirectory(home, apiBase, code) {
  const key = createHash('sha256').update(JSON.stringify([apiBase, code])).digest('hex');
  return pathJoin(home, '.join-' + key);
}

for (const variant of ['receipt-symlink', 'receipt-hardlink', 'lock-symlink', 'directory-symlink']) {
  test(`independent boundary: ${variant} refuses before any network and preserves the target`, async t => {
    const f = await startRoom(t), { code, link } = f.invite();
    const external = mkdtempSync(pathJoin(tmpdir(), 'acp-private-target-'));
    t.after(() => rmSync(external, { recursive: true, force: true }));
    const target = pathJoin(external, 'target');
    writeFileSync(target, 'untouched synthetic private state', { mode: 0o600 });
    const directory = journalDirectory(f.home, f.origin, code);
    if (variant === 'directory-symlink') symlinkSync(external, directory);
    else {
      mkdirSync(directory, { mode: 0o700 });
      const dest = pathJoin(directory, variant === 'lock-symlink' ? 'owner.sqlite' : 'receipt.json');
      if (variant === 'receipt-hardlink') linkSync(target, dest);
      else symlinkSync(target, dest);
    }
    let calls = 0;
    await assert.rejects(join({ link, displayName: 'Independent link boundary', env: f.env,
      fetchImpl: async () => { calls++; throw Error('network should not be reached'); } }), /private|links/);
    assert.equal(calls, 0);
    assert.equal(readFileSync(target, 'utf8'), 'untouched synthetic private state');
    assert.equal(loadConnection({}, f.env), null);
  });
}

test('independent boundary: copied pending state for another origin refuses without consuming either invite', async t => {
  const a = await startRoom(t), b = await startRoom(t);
  const first = a.invite(), second = b.invite();
  await assert.rejects(join({ link: first.link, displayName: 'Origin-bound', env: a.env,
    fetchImpl: async () => { throw Error('offline before redemption'); } }));
  const from = journalDirectory(a.home, a.origin, first.code);
  const to = journalDirectory(a.home, b.origin, second.code);
  mkdirSync(to, { mode: 0o700 });
  writeFileSync(pathJoin(to, 'receipt.json'), readFileSync(pathJoin(from, 'receipt.json')), { mode: 0o600 });
  let calls = 0;
  await assert.rejects(join({ link: second.link, displayName: 'Origin-bound', env: a.env,
    fetchImpl: async () => { calls++; throw Error('must reject before network'); } }), /Saved invitation setup differs/);
  assert.equal(calls, 0);
  rmSync(to, { recursive: true });
  assert.ok((await join({ link: first.link, displayName: 'Origin-bound', env: a.env })).memberId);
  assert.ok((await join({ link: second.link, displayName: 'Other origin', env: b.env })).memberId);
});

test('independent boundary: process exits immediately after final connection rename and retry reuses the saved redemption', async t => {
  const f = await startRoom(t), { link } = f.invite();
  const joinUrl = new URL('../room-acp/src/join.mjs', import.meta.url).href;
  const finalPath = pathJoin(f.home, 'commons.json');
  // Fault injection stays in the child process. Production source is unchanged.
  const code = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(b===${JSON.stringify(finalPath)})process.exit(73);};syncBuiltinESMExports();
    const {join: joinInvitation}=await import(${JSON.stringify(joinUrl)});
    await joinInvitation({link:${JSON.stringify(link)},displayName:'Interrupted final save',env:{ROOM_ACP_HOME:${JSON.stringify(f.home)}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
  let error = '';
  child.stderr.on('data', x => { error += x; });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  clearTimeout(timer);
  assert.equal(status, 73, error);
  const saved = loadConnection({}, f.env);
  assert.ok(saved?.credential);
  const folder = readdirSync(f.home).find(x => x.startsWith('.join-'));
  const pending = JSON.parse(readFileSync(pathJoin(f.home, folder, 'receipt.json'), 'utf8'));
  assert.ok(pending.joined);
  assert.equal(pending.completed, undefined);
  let redemptions = 0, rotations = 0;
  const recovered = await join({ link, displayName: 'Interrupted final save', env: f.env,
    fetchImpl: async (url, init) => { if (url.endsWith('/redeem')) redemptions++; if (url.endsWith('/token/rotate')) rotations++; return fetch(url, init); } });
  assert.equal(redemptions, 0); assert.equal(rotations, 0);
  assert.equal(recovered.memberId, saved.memberId);
  assert.equal(recovered.identityId, saved.identityId);
  assert.equal(recovered.credential, saved.credential);
  assert.equal(recovered.hostId, saved.hostId);
  assert.equal(Object.values(f.f.store.room('commons').state.members).filter(x => x.displayName === 'Interrupted final save').length, 1);
  const completed = JSON.parse(readFileSync(pathJoin(f.home, folder, 'receipt.json'), 'utf8'));
  assert.equal(completed.joined, undefined); assert.equal(completed.recovery, undefined);
  assert.equal(completed.completed.memberId, saved.memberId);
});

test('independent boundary: recovery token for the wrong member cannot become a saved connection', async t => {
  const f = await startRoom(t), first = f.invite(), second = f.invite();
  const otherHome = mkdtempSync(pathJoin(tmpdir(), 'acp-other-member-'));
  t.after(() => rmSync(otherHome, { recursive: true, force: true }));
  const other = await join({ link: second.link, displayName: 'Other member', env: { ROOM_ACP_HOME: otherHome } });
  let calls = 0;
  await assert.rejects(join({ link: first.link, displayName: 'Expected member', env: f.env,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith('/redeem')) {
        calls++;
        const value = await response.json();
        value.mcpToken.credential = other.credential;
        return Response.json(value);
      }
      return response;
    } }), error => error.code === 'identity_mismatch');
  assert.equal(calls, 1);
  assert.equal(loadConnection({}, f.env), null);
});
