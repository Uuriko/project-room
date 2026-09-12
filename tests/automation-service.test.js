import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { createRuntimePackage } from '../scripts/runtime-package.mjs';
import { replay } from '../src/events.js';

const definition = { title: 'Daily check', prompt: 'Summarize our next step', recipientId: 'agent', trigger: { kind: 'manual' }, maxRuns: 10, maxRuntimeMs: 10000, maxOutputBytes: 4096 };
const command = (action, revision, extra = {}) => ({ id: `${action}-${revision}`, type: `automation.${action}`, data: { automationId: 'daily', expectedRevision: revision, ...extra } });
function setup(store) {
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  for (const memberId of ['agent', 'peer']) store.command(owner, 'commons', { id: memberId, type: 'member.added', data: { memberId, displayName: memberId, kind: 'agent', permissions: [] } });
  return { owner, agent: store.issueAccessKey('commons', 'agent'), peer: store.issueAccessKey('commons', 'peer') };
}

test('automation definitions persist, consent is identity-bound and exact retries survive pause and restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'automation-service-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'room.sqlite'), store = new RoomStore(filename), f = setup(store);
  const send = (key, action, revision, extra) => store.command(key, 'commons', command(action, revision, extra));
  const created = send(f.peer, 'created', 0, { definition });
  assert.throws(() => send(f.owner, 'enabled', 1));
  send(f.peer, 'enabled', 1);
  assert.throws(() => send(f.peer, 'accepted', 2));
  send(f.agent, 'accepted', 2);
  assert.equal(store.room('commons').state.automations.daily.recipientAccepted, true);
  send(f.owner, 'paused', 3);
  assert.throws(() => send(f.owner, 'paused', 4));
  assert.equal(send(f.peer, 'created', 0, { definition }).event.id, created.event.id);
  assert.throws(() => send(f.peer, 'updated', 4, { definition: { ...definition, execute: 'shell' } }));
  send(f.peer, 'updated', 4, { definition: { ...definition, prompt: 'New scope' } });
  const state = store.room('commons').state;
  assert.equal(state.automations.daily.ownerEnabled, false);
  assert.equal(state.automations.daily.recipientAccepted, false);
  assert.deepEqual(state.workItems, {});
  assert.deepEqual(state.messages, []);
  const events = store.db.prepare('SELECT body FROM events ORDER BY sequence').all().map(row => JSON.parse(row.body));
  assert.deepEqual({ ...replay(events), eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} }, state);
  assert.equal(auditRecovery(store).schemaVersion, 33);
  store.close();
  const reopened = new RoomStore(filename); t.after(() => reopened.close());
  assert.deepEqual(reopened.room('commons').state, state);
  assert.equal(reopened.command(f.peer, 'commons', command('created', 0, { definition })).duplicate, true);
  reopened.revoke(f.peer);
  assert.throws(() => reopened.command(f.peer, 'commons', command('created', 0, { definition })), { status: 401 });
});

test('human creator and agent recipient consent cannot be supplied by forged fields', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close()); const f = setup(store);
  store.command(f.owner, 'commons', command('created', 0, { definition }));
  assert.throws(() => store.command(f.agent, 'commons', command('accepted', 1, { actorId: 'owner' })), { code: 'invalid_command' });
  assert.throws(() => store.command(f.agent, 'commons', command('accepted', 0)));
  store.command(f.agent, 'commons', command('accepted', 1));
  store.command(f.owner, 'commons', command('enabled', 2));
  store.command(f.agent, 'commons', command('paused', 3));
  assert.equal(store.room('commons').state.automations.daily.ownerEnabled, false);
  assert.throws(() => store.command(f.owner, 'commons', { id: 'dispatch', type: 'automation.dispatched', data: {} }), { code: 'invalid_command' });
});

test('genuine31 migration preserves data and blocks an already-open old writer', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'automation-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const destination = join(directory, 'old');
  createRuntimePackage({ repository: process.cwd(), commit: '0e3f824471b5e69f93a8e325a8c490d02c81029f', destination });
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, 'server/store.mjs')));
  const filename = join(directory, 'room.sqlite'), old = new OldStore(filename); t.after(() => old.close());
  const f = setup(old), before = old.room('commons');
  assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 31);
  const cached = old.db.prepare('UPDATE rooms SET projection=projection WHERE id=?');
  const current = new RoomStore(filename); t.after(() => current.close());
  assert.deepEqual(current.room('commons'), before);
  assert.throws(() => cached.run('commons'), /writer_v33|unsupported database writer/);
  current.command(f.owner, 'commons', command('created', 0, { definition }));
  assert.equal(auditRecovery(current).schemaVersion, 33);
});

test('pilot capacity still permits one authorized pause but no repeated cleanup writes', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close()); const f = setup(store);
  store.command(f.owner, 'commons', command('created', 0, { definition }));
  store.command(f.owner, 'commons', command('enabled', 1));
  // Synthetic capacity boundary: only testing the command admission gate here.
  store.db.prepare('UPDATE rooms SET sequence=10000 WHERE id=?').run('commons');
  assert.throws(() => store.command(f.agent, 'commons', command('accepted', 2)), { code: 'pilot_limit' });
  assert.throws(() => store.command(f.peer, 'commons', command('paused', 2)));
  store.command(f.agent, 'commons', command('paused', 2));
  assert.equal(store.room('commons').state.automations.daily.ownerEnabled, false);
  assert.throws(() => store.command(f.agent, 'commons', command('paused', 3)), { code: 'pilot_limit' });
});

test('revoking then restoring membership cannot revive prior automation consent', t => {
  const store = new RoomStore(':memory:'); t.after(() => store.close()); const f = setup(store);
  store.command(f.owner, 'commons', command('created', 0, { definition }));
  store.command(f.owner, 'commons', command('enabled', 1));
  store.command(f.agent, 'commons', command('accepted', 2));
  for (const [expectedMemberRevision, active] of [[0, false], [1, true]]) store.command(f.owner, 'commons', {
    id: `access-${expectedMemberRevision}`, type: 'member.access_changed', data: { memberId: 'agent', expectedMemberRevision, active, permissions: [] }
  });
  const automation = store.room('commons').state.automations.daily;
  assert.equal(automation.revision, 4);
  assert.equal(automation.ownerEnabled, false);
  assert.equal(automation.recipientAccepted, false);
  assert.throws(() => store.command(f.owner, 'commons', command('enabled', 3)));
  assert.equal(auditRecovery(store).schemaVersion, 33);
});

test('legacy automation projection and event fields fail migration without modifying schema', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'automation-collision-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const destination = join(directory, 'old');
  createRuntimePackage({ repository: process.cwd(), commit: '0e3f824471b5e69f93a8e325a8c490d02c81029f', destination });
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, 'server/store.mjs')));
  for (const field of ['projection', 'automationId', 'automationRevision', 'automationSlot']) {
    const filename = join(directory, `${field}.sqlite`), old = new OldStore(filename); t.after(() => old.close()); setup(old);
    if (field === 'projection') old.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.automations',json('null'))").run();
    else old.db.prepare(`UPDATE events SET body=json_set(body,'$.data.${field}',json('null')) WHERE sequence=1`).run();
    assert.throws(() => new RoomStore(filename), /Legacy automation (dispatch )?fields/);
    assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 31);
    assert.equal(old.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'writer_v33_%'").get().n, 0);
  }
});

test('genuine32 refuses legacy dispatch metadata while preserving the old database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-collision-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const destination = join(directory, 'old');
  createRuntimePackage({ repository: process.cwd(), commit: '51564ad22681569753d0479cebe12f798d9352ec', destination });
  const { RoomStore: OldStore } = await import(pathToFileURL(join(destination, 'server/store.mjs')));
  for (const field of ['projection', 'automationId', 'automationRevision', 'automationSlot']) {
    const filename = join(directory, `${field}.sqlite`), old = new OldStore(filename); t.after(() => old.close()); const f = setup(old);
    old.command(f.owner, 'commons', { id: 'q', type: 'message.posted', data: { messageId: 'q', body: 'Question', requestKind: 'reply', toMemberId: 'agent' } });
    if (field === 'projection') old.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.replyRequests.q.automation',json('null'))").run();
    else old.db.prepare(`UPDATE events SET body=json_set(body,'$.data.${field}',json('null')) WHERE json_extract(body,'$.type')='message.posted'`).run();
    assert.throws(() => new RoomStore(filename), /Legacy automation dispatch fields/);
    assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 32);
    assert.equal(old.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'writer_v33_%'").get().n, 0);
  }
});
