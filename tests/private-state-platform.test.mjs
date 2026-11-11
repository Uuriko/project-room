import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, linkSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertPrivatePath, ensurePrivateDirectory, atomicPrivateJson, readPrivateJson } from '../room-acp/src/private-files.mjs';
import { openJoinJournal } from '../room-acp/src/private-state.mjs';
import { openSetupJournal } from '../client/setup-journal.mjs';
import { saveAgentConnection, readAgentConnection } from '../client/agent-connection.mjs';
import { saveConnection, loadConnection } from '../room-acp/src/credentials.mjs';
import { join as joinAgent } from '../room-acp/src/join.mjs';
import { startRoom } from './room-acp-fixture.mjs';

const windows = process.platform === 'win32';
function fixture(t) {
  const outer = mkdtempSync(join(tmpdir(), 'room-private-'));
  t.after(() => rmSync(outer, {recursive: true, force: true}));
  return ensurePrivateDirectory(join(outer, 'private-接続-é'));
}
function ps(script, path) {
  return execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false)); $p=$reader.ReadToEnd(); " + script],
    {input: path, encoding: 'utf8', windowsHide: true});
}
function expose(path, directory = false, inheritedOnly = false) {
  if (!windows) { chmodSync(path, directory ? 0o755 : 0o644); return; }
  ps(`$e=[IO.${directory ? 'DirectoryInfo' : 'FileInfo'}]::new($p); $acl=$e.GetAccessControl();
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]${directory ? "'ContainerInherit,ObjectInherit'" : "'None'"},
      [Security.AccessControl.PropagationFlags]::${inheritedOnly ? 'InheritOnly' : 'None'},
      [Security.AccessControl.AccessControlType]::Allow);
    $acl.AddAccessRule($rule); $e.SetAccessControl($acl)`, path);
}

test('private atomic saves replace and reopen at exact byte limit, rejecting excess before mutation', t => {
  const root = fixture(t), path = join(root, 'saved.json');
  atomicPrivateJson(path, {revision: 1});
  atomicPrivateJson(path, {revision: 2});
  assert.deepEqual(readPrivateJson(path), {revision: 2});
  const boundary = {x: 'a'.repeat(131064)};
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 131072);
  atomicPrivateJson(path, boundary);
  assert.deepEqual(readPrivateJson(path), boundary);
  const before = readFileSync(path);
  assert.throws(() => atomicPrivateJson(path, {x: boundary.x + 'b'}), /size limit/);
  assert.deepEqual(readFileSync(path), before);
  assertPrivatePath(path);
  if (!windows) assert.equal(statSync(path).mode & 0o777, 0o600);
});

for (const kind of ['join', 'setup']) {
  test(`${kind} journal preserves checkpoint on reopen and excludes simultaneous owner`, t => {
    const root = fixture(t);
    const open = () => kind === 'join' ? openJoinJournal(root, 'synthetic') : openSetupJournal(root);
    const journal = open();
    try {
      journal.save({requestId: 'same-request', identityId: 'same-identity', phase: 'redeemed'});
      assert.throws(open, /Another .* owns/);
    } finally { journal.close(); }
    const reopened = open();
    try { assert.deepEqual(reopened.read(), {requestId: 'same-request', identityId: 'same-identity', phase: 'redeemed'}); }
    finally { reopened.close(); }
  });
}

test('process interruption releases journal lock and preserves committed identity and request', async t => {
  const root = fixture(t);
  const source = `import {openJoinJournal} from ${JSON.stringify(new URL('../room-acp/src/private-state.mjs', import.meta.url).href)};
    const journal=openJoinJournal(process.argv[1], 'interrupted');
    journal.save({identityId:'existing-seat',requestId:'stable-redemption',phase:'redeemed'});
    console.log('saved');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('saved')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(Error('Child exited before save: ' + code)));
  });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const journal = openJoinJournal(root, 'interrupted');
  try { assert.deepEqual(journal.read(), {identityId: 'existing-seat', requestId: 'stable-redemption', phase: 'redeemed'}); }
  finally { journal.close(); }
});

test('saved connection readers preserve identity and reject exposed source without repairing it', t => {
  const root = fixture(t), source = join(root, 'identity');
  const value = {version: 1, origin: 'https://room.example', roomId: 'commons', memberId: 'existing-seat', token: 'T'.repeat(43)};
  saveAgentConnection(source, value);
  assert.deepEqual(readAgentConnection(source), value);
  const env = {ROOM_ACP_HOME: join(root, 'acp')};
  const connection = {roomId: 'commons', memberId: value.memberId, credential: 'synthetic-scoped'};
  saveConnection(connection, env);
  assert.deepEqual(loadConnection({}, env), connection);
  const path = join(source, 'connection.json'), bytes = readFileSync(path);
  expose(path);
  assert.throws(() => readAgentConnection(source), /private/i);
  assert.deepEqual(readFileSync(path), bytes);
  assert.throws(() => assertPrivatePath(path), /private files/);
});

test('hard links and directory links cannot redirect credential reads or writes', t => {
  const root = fixture(t), path = join(root, 'original.json');
  atomicPrivateJson(path, {secret: 'synthetic'});
  const hard = join(root, 'hard.json'); linkSync(path, hard);
  assert.throws(() => readPrivateJson(path), /private files/);
  assert.throws(() => atomicPrivateJson(hard, {}), /private files/);
  const target = ensurePrivateDirectory(join(root, 'target')), redirect = join(root, 'redirect');
  symlinkSync(target, redirect, windows ? 'junction' : 'dir');
  assert.throws(() => ensurePrivateDirectory(redirect), /private files/);
  assert.throws(() => atomicPrivateJson(join(redirect, 'secret.json'), {}), /private files/);
});

test('foreign inherited-only grant is excluded at directory creation; existing broad ACL stays unchanged', {skip: !windows}, t => {
  const root = fixture(t), parent = ensurePrivateDirectory(join(root, 'parent'));
  expose(parent, true, true);
  const child = ensurePrivateDirectory(join(parent, 'secure-child'));
  assertPrivatePath(child, true);
  atomicPrivateJson(join(child, 'secret.json'), {secret: 'synthetic'});
  assertPrivatePath(join(child, 'secret.json'));
  const before = ps('[Console]::Write([IO.DirectoryInfo]::new($p).GetAccessControl().Sddl)', parent);
  assert.throws(() => ensurePrivateDirectory(parent), /private files/);
  assert.equal(ps('[Console]::Write([IO.DirectoryInfo]::new($p).GetAccessControl().Sddl)', parent), before);
  assert.throws(() => ensurePrivateDirectory(child, {exclusive: true}), e => e.code === 'EEXIST');
});

// Exercise the real recovery protocol on each OS, not only the file primitive.
test('lost redemption response and interrupted final save retry the same member and scoped credential', async t => {
  const f = await startRoom(t), root = fixture(t);
  const env = {...f.env, ROOM_ACP_HOME: root}, link = f.invite().link;
  let redeems = 0, rotates = 0;
  const blocked = join(root, 'commons.json');
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    if (url.endsWith('/redeem') && ++redeems === 1) throw Error('synthetic lost response');
    if (url.endsWith('/token/rotate') && ++rotates === 1) ensurePrivateDirectory(blocked);
    return response;
  };
  await assert.rejects(joinAgent({link, displayName: 'Platform recovery', env, fetchImpl}));
  await assert.rejects(joinAgent({link, displayName: 'Platform recovery', env, fetchImpl}));
  assert.equal(redeems, 2); assert.equal(rotates, 1);
  rmSync(blocked, {recursive: true});
  const recovered = await joinAgent({link, displayName: 'Platform recovery', env, fetchImpl});
  assert.equal(redeems, 2); assert.equal(rotates, 1);
  assert.equal(loadConnection({}, env).credential, recovered.credential);
  assert.match(recovered.credential, /^rak_/);
  assert.equal(Object.values(f.f.store.room('commons').state.members).filter(m => m.displayName === 'Platform recovery').length, 1);
  const again = await joinAgent({link, displayName: 'Platform recovery', env, fetchImpl});
  assert.equal(again.memberId, recovered.memberId);
  assert.equal(again.credential, recovered.credential);
  assert.equal(redeems, 2); assert.equal(rotates, 1);
});
