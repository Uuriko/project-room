// Real local Room HTTP; synthetic identities. No model or live credential use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from '../room-acp/src/join.mjs';
import { main } from '../room-acp/src/cli.mjs';
import { loadConnection, saveConnection } from '../room-acp/src/credentials.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { startRoom } from './room-acp-fixture.mjs';
const identityCount = f => f.f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n;
const file = (f, room = 'commons') => pathJoin(f.home, room + '.json');
const operation = (f, filter = () => true) => readdirSync(f.home).filter(name => /^\.join-[a-f0-9]{64}$/.test(name))
  .map(name => ({ path: pathJoin(f.home, name, 'receipt.json'), value: JSON.parse(readFileSync(pathJoin(f.home, name, 'receipt.json'), 'utf8')) })).find(entry => filter(entry.value));
async function enroll(f) { return join({ link: f.invite().link, displayName: 'Synthetic saved identity', env: f.env }); }
function secondRoom(f) {
  f.f.store.initialize(initialRoom('second'));
  const owner = f.f.store.issueAccessKey('second', 'owner');
  const invite = f.f.store.invites.create(owner, 'second', { profile: 'contribute' });
  return { ...invite, link: f.origin + '/join/' + invite.code, owner };
}

test('CLI --room actually forwards the selected identity; same-room409 preserves saved bytes and invitation', async t => {
  const f = await startRoom(t), saved = await enroll(f), before = readFileSync(file(f)), invitation = f.invite();
  let authenticated = false;
  const fetchImpl = (url, options) => {
    if (url.endsWith('/api/agent-invites/redeem')) authenticated = options.headers.authorization === 'Bearer ' + saved.identitySecret;
    return fetch(url, options);
  };
  const code = await main([invitation.link, '--room', 'commons', '--name', 'Synthetic renamed display'], { env: f.env, print() {}, joinOnly: true, fetchImpl });
  assert.equal(code, 1); assert.equal(authenticated, true);
  assert.deepEqual(readFileSync(file(f)), before); assert.equal(identityCount(f), 1);
  assert.equal(f.f.store.invites.preview(invitation.code).roomId, 'commons');
});

test('explicit saved identity joins another room, and completed retry does not replace either credential file', async t => {
  const f = await startRoom(t), saved = await enroll(f), before = readFileSync(file(f)), invitation = secondRoom(f);
  const request = { link: invitation.link, displayName: 'Synthetic selected second room', roomId: 'commons', env: f.env };
  const joined = await join(request), secondBytes = readFileSync(file(f, 'second'));
  const replay = await join(request);
  assert.equal(joined.identityId, saved.identityId); assert.equal(replay.memberId, joined.memberId);
  assert.equal(identityCount(f), 1); assert.deepEqual(readFileSync(file(f)), before);
  assert.deepEqual(readFileSync(file(f, 'second')), secondBytes);
});

test('default saved-target overwrite refuses before the invitation is burned', async t => {
  const f = await startRoom(t); await enroll(f);
  const before = readFileSync(file(f)), invitation = f.invite(); let redeems = 0;
  await assert.rejects(join({ link: invitation.link, displayName: 'Another display name', env: f.env, fetchImpl: (url, options) => {
    if (url.endsWith('/api/agent-invites/redeem')) redeems++;
    return fetch(url, options);
  } }), /already saved/);
  assert.equal(redeems, 0); assert.equal(identityCount(f), 1); assert.deepEqual(readFileSync(file(f)), before);
  assert.equal(f.f.store.invites.preview(invitation.code).roomId, 'commons');
});

test('origin mismatch and forged identity metadata refuse before sending a redeem or changing saved bytes', async t => {
  const f = await startRoom(t), saved = await enroll(f), invitation = secondRoom(f), before = readFileSync(file(f));
  let calls = 0;
  saveConnection({ ...saved, apiBase: 'https://different.example' }, f.env);
  await assert.rejects(join({ link: invitation.link, displayName: 'Selected', roomId: 'commons', env: f.env, fetchImpl: async () => { calls++; throw Error('unexpected request'); } }), /origin/);
  assert.equal(calls, 0);
  saveConnection({ ...saved, identityId: 'synthetic-unproved-identity' }, f.env);
  let redeems = 0;
  await assert.rejects(join({ link: invitation.link, displayName: 'Selected', roomId: 'commons', env: f.env, fetchImpl: (url, options) => {
    if (url.endsWith('/api/agent-invites/redeem')) redeems++;
    return fetch(url, options);
  } }), /no longer matches/);
  assert.equal(redeems, 0); assert.equal(identityCount(f), 1);
  writeFileSync(file(f), before); assert.equal(f.f.store.invites.preview(invitation.code).roomId, 'second');
});

test('two invitations race one destination: losing invitation is neither redeemed nor allowed to replace the winner', async t => {
  const f = await startRoom(t), first = f.invite(), losing = f.invite();
  let release, entered, redeems = 0;
  const arrived = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/api/agent-invites/redeem')) { redeems++; entered(); await held; }
    return response;
  };
  const firstJoin = join({ link: first.link, displayName: 'Synthetic winner', env: f.env, fetchImpl });
  try {
    await arrived;
    await assert.rejects(join({ link: losing.link, displayName: 'Synthetic losing invite', env: f.env, fetchImpl }), /Another join/);
    assert.equal(redeems, 1); assert.equal(f.f.store.invites.preview(losing.code).roomId, 'commons');
  } finally { release(); }
  await firstJoin; const bytes = readFileSync(file(f));
  await assert.rejects(join({ link: losing.link, displayName: 'Synthetic losing invite', env: f.env }), /already saved/);
  assert.equal(identityCount(f), 1); assert.deepEqual(readFileSync(file(f)), bytes);
});

for (const fault of ['lost-response', 'failed-save']) test(`unresolved ${fault} reserves the destination across retries and keeps a different invite unburned`, async t => {
  const f = await startRoom(t), first = f.invite(), losing = f.invite(); let redeems = 0;
  const fetchImpl = async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/api/agent-invites/redeem') && ++redeems === 1) {
      if (fault === 'lost-response') throw Error('synthetic lost successful response');
      mkdirSync(file(f));
    }
    return response;
  };
  const request = { link: first.link, displayName: 'Synthetic interrupted original', env: f.env, fetchImpl };
  await assert.rejects(join(request));
  if (fault === 'failed-save') rmSync(file(f), { recursive: true });
  const original = operation(f, value => value.displayName === request.displayName).value;
  await assert.rejects(join({ link: losing.link, displayName: 'Synthetic unrelated invitation', env: f.env }), /unresolved outcome/);
  assert.equal(f.f.store.invites.preview(losing.code).roomId, 'commons'); assert.equal(identityCount(f), 1);
  const recovered = await join(request), after = operation(f, value => value.displayName === request.displayName).value;
  assert.equal(after.requestId, original.requestId); assert.equal(after.hostId, original.hostId);
  assert.equal(after.completed.identityId, recovered.identityId); assert.equal(identityCount(f), 1);
  assert.equal(loadConnection({}, f.env).identityId, recovered.identityId);
});

test('selected identity cannot change during an interrupted save; original selection resumes without another redemption', async t => {
  const f = await startRoom(t), saved = await enroll(f), originalBytes = readFileSync(file(f)), invitation = secondRoom(f);
  let redeems = 0;
  const request = { link: invitation.link, displayName: 'Synthetic selected interruption', roomId: 'commons', env: f.env,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith('/api/agent-invites/redeem')) { redeems++; mkdirSync(file(f, 'second')); }
      return response;
    } };
  await assert.rejects(join(request)); assert.equal(redeems, 1);
  const stored = operation(f, value => value.displayName === request.displayName).value;
  rmSync(file(f, 'second'), { recursive: true });
  saveConnection({ ...saved, identityId: 'synthetic-other-selection' }, f.env);
  await assert.rejects(join(request), /Saved invitation setup differs/); assert.equal(redeems, 1);
  writeFileSync(file(f), originalBytes);
  const recovered = await join(request);
  assert.equal(recovered.identityId, saved.identityId); assert.equal(identityCount(f), 1); assert.equal(redeems, 1);
  assert.equal(operation(f, value => value.displayName === request.displayName).value.requestId, stored.requestId);
});

test('changed actual redemption identity or destination never gets saved despite an earlier valid preview', async t => {
  const f = await startRoom(t); await enroll(f);
  const originalBytes = readFileSync(file(f)), invitation = secondRoom(f);
  let changed = false;
  await assert.rejects(join({ link: invitation.link, displayName: 'Synthetic wrong response', roomId: 'commons', env: f.env,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith('/api/agent-invites/redeem')) {
        const body = await response.json(); changed = true;
        return Response.json({ ...body, identityId: 'synthetic-unexpected-principal', roomId: 'unexpected-room' }, { status: response.status });
      }
      return response;
    } }), /another Room identity or destination/);
  assert.equal(changed, true); assert.equal(loadConnection({ roomId: 'second' }, f.env), null);
  assert.deepEqual(readFileSync(file(f)), originalBytes); assert.equal(identityCount(f), 1);
});

test('explicit saved identity also joins a share link without minting, and keeps an existing same-room scoped credential', async t => {
  const f = await startRoom(t), saved = await enroll(f), before = readFileSync(file(f));
  const token = randomBytes(32).toString('base64url');
  f.f.store.shareLinks.create(f.ownerKey, 'commons', { requestId: randomUUID(), linkToken: token, expiresAt: Date.now() + 3600000,
    maxJoins: 2, expectedMemberRevision: f.f.store.room('commons').state.members.owner.revision }, null);
  const linked = await join({ link: f.origin + '/#join/' + token, displayName: 'Synthetic share selected', roomId: 'commons', env: f.env });
  assert.equal(linked.identityId, saved.identityId); assert.equal(identityCount(f), 1);
  assert.deepEqual(readFileSync(file(f)), before); assert.equal(linked.credential, saved.credential);
});


test('known preflight refusal can add explicit selection before any business request, keeping the original request ID', async t => {
  const f = await startRoom(t); await enroll(f); const invitation = f.invite();
  const request = { link: invitation.link, displayName: 'Synthetic explicit correction', env: f.env };
  await assert.rejects(join(request), /already saved/);
  const before = operation(f, value => value.displayName === request.displayName).value;
  assert.equal(before.mutationStarted, false);
  await assert.rejects(join({ ...request, roomId: 'commons' }), error => error.status === 409 && error.code === 'identity_already_linked');
  const after = operation(f, value => value.displayName === request.displayName).value;
  assert.equal(after.requestId, before.requestId); assert.equal(identityCount(f), 1);
  assert.equal(f.f.store.invites.preview(invitation.code).roomId, 'commons');
});

for (const fault of ['before-response', 'after-file-rename']) test(`process exit ${fault} blocks a distinct invitation and original retry reconciles without replacement`, async t => {
  const f = await startRoom(t), original = f.invite(), other = f.invite();
  const moduleUrl = new URL('../room-acp/src/join.mjs', import.meta.url).href;
  const source = fault === 'before-response'
    ? `const {join}=await import(${JSON.stringify(moduleUrl)});await join({link:${JSON.stringify(original.link)},displayName:'Synthetic process original',env:{ROOM_ACP_HOME:${JSON.stringify(f.home)}},fetchImpl:async(url,options)=>{const response=await fetch(url,options);if(url.endsWith('/api/agent-invites/redeem'))process.exit(17);return response;}});`
    : `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(to===${JSON.stringify(file(f))})process.exit(19);};syncBuiltinESMExports();const {join}=await import(${JSON.stringify(moduleUrl)});await join({link:${JSON.stringify(original.link)},displayName:'Synthetic process original',env:{ROOM_ACP_HOME:${JSON.stringify(f.home)}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), fault === 'before-response' ? 17 : 19, errors);
  const before = fault === 'after-file-rename' ? readFileSync(file(f)) : null;
  await assert.rejects(join({ link: other.link, displayName: 'Synthetic other process invitation', env: f.env }), /unresolved outcome/);
  assert.equal(f.f.store.invites.preview(other.code).roomId, 'commons');
  const saved = await join({ link: original.link, displayName: 'Synthetic process original', env: f.env });
  assert.equal(identityCount(f), 1); assert.equal(loadConnection({}, f.env).identityId, saved.identityId);
  if (before) assert.deepEqual(readFileSync(file(f)), before);
});

test('a legacy code journal with a lost response still replays its exact request and existing identity', async t => {
  const f = await startRoom(t), invitation = f.invite(); let lose = true; const wire = [];
  const request = { link: invitation.link, displayName: 'Synthetic legacy interrupted join', env: f.env, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/api/agent-invites/redeem')) { wire.push(options.body); if (lose) { lose = false; throw Error('synthetic legacy response loss'); } }
    return response;
  } };
  await assert.rejects(join(request));
  const record = operation(f, value => value.displayName === request.displayName);
  delete record.value.targetRoomId; delete record.value.selectedIdentity; delete record.value.mutationStarted;
  writeFileSync(record.path, JSON.stringify(record.value), { mode: 0o600 });
  // Reconstruct old-version private state, which had only the invite lock.
  for (const directory of readdirSync(f.home).filter(name => name.startsWith('.join-room-'))) rmSync(pathJoin(f.home, directory), { recursive: true });
  const recovered = await join(request);
  assert.equal(wire.length, 2); assert.equal(wire[0], wire[1]); assert.equal(identityCount(f), 1);
  assert.equal(loadConnection({}, f.env).identityId, recovered.identityId);
});

test('an unresolved destination cannot be claimed through a second origin sharing the same saved filename', async t => {
  const first = await startRoom(t), other = await startRoom(t), invitation = first.invite(), otherInvite = other.invite();
  let lose = true;
  const original = { link: invitation.link, displayName: 'Synthetic origin owner', env: first.env, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/api/agent-invites/redeem') && lose) { lose = false; throw Error('synthetic origin response loss'); }
    return response;
  } };
  await assert.rejects(join(original));
  await assert.rejects(join({ link: otherInvite.link, displayName: 'Synthetic other origin', env: first.env }), /unresolved outcome/);
  assert.equal(identityCount(other), 0); assert.equal(other.f.store.invites.preview(otherInvite.code).roomId, 'commons');
  await join(original); const before = readFileSync(file(first));
  await assert.rejects(join({ link: otherInvite.link, displayName: 'Synthetic other origin', env: first.env }), /already saved/);
  assert.equal(identityCount(other), 0); assert.deepEqual(readFileSync(file(first)), before);
});


test('selected new-target share refuses before membership or token rotation and preserves the saved source credential', async t => {
  const f = await startRoom(t); await enroll(f); const before = readFileSync(file(f));
  f.f.store.initialize(initialRoom('second')); const owner = f.f.store.issueAccessKey('second', 'owner');
  const linkToken = randomBytes(32).toString('base64url');
  f.f.store.shareLinks.create(owner, 'second', { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000,
    maxJoins: 2, expectedMemberRevision: f.f.store.room('second').state.members.owner.revision }, null);
  let joins = 0, rotations = 0;
  await assert.rejects(join({ link: f.origin + '/#join/' + linkToken, displayName: 'Synthetic selected share new target', roomId: 'commons', env: f.env,
    fetchImpl: (url, options) => {
      if (url.endsWith('/api/share-links/join-agent')) joins++;
      if (url.endsWith('/token/rotate')) rotations++;
      return fetch(url, options);
    } }), /single-use agent invitation/);
  assert.equal(joins, 0); assert.equal(rotations, 0); assert.equal(identityCount(f), 1);
  assert.equal(f.f.store.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='second'").get().n, 0);
  assert.equal(loadConnection({ roomId: 'second' }, f.env), null); assert.deepEqual(readFileSync(file(f)), before);
});

test('first-time share compatibility reuses its saved enrollment after a lost membership response', async t => {
  const f = await startRoom(t), linkToken = randomBytes(32).toString('base64url');
  f.f.store.shareLinks.create(f.ownerKey, 'commons', { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000,
    maxJoins: 2, expectedMemberRevision: f.f.store.room('commons').state.members.owner.revision }, null);
  let lose = true;
  const request = { link: f.origin + '/#join/' + linkToken, displayName: 'Synthetic first share compatibility', env: f.env,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith('/api/share-links/join-agent') && lose) { lose = false; throw Error('synthetic share membership response loss'); }
      return response;
    } };
  await assert.rejects(join(request)); assert.equal(identityCount(f), 1);
  const saved = await join(request), replay = await join(request);
  assert.equal(saved.identityId, replay.identityId); assert.equal(saved.memberId, replay.memberId); assert.equal(identityCount(f), 1);
});

test('selected shared target already connected elsewhere cannot silently rotate that other credential', async t => {
  const f = await startRoom(t); await enroll(f); const invitation = secondRoom(f);
  const existing = await join({ link: invitation.link, displayName: 'Synthetic remote target', roomId: 'commons', env: f.env });
  rmSync(file(f, 'second'));
  const linkToken = randomBytes(32).toString('base64url');
  f.f.store.shareLinks.create(invitation.owner, 'second', { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000,
    maxJoins: 2, expectedMemberRevision: f.f.store.room('second').state.members.owner.revision }, null);
  let rotations = 0, joins = 0;
  await assert.rejects(join({ link: f.origin + '/#join/' + linkToken, displayName: 'Synthetic remote target', roomId: 'commons', env: f.env,
    fetchImpl: (url, options) => {
      if (url.endsWith('/token/rotate')) rotations++;
      if (url.endsWith('/api/share-links/join-agent')) joins++;
      return fetch(url, options);
    } }), /single-use agent invitation/);
  assert.equal(rotations, 0); assert.equal(joins, 0);
  await new (await import('../room-acp/src/room.mjs')).RoomClient(existing).checkConnection();
  assert.equal(identityCount(f), 1);
});
