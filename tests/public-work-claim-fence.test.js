import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createWork } from '../server/work-claims.mjs';
import { createDurableWorkClaimRegistry } from '../server/work-claim-sqlite.mjs';
import { verifyPublicWorkClaimFence, withPublicWorkClaimWriter } from '../server/public-work-claim-fence.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-claim-fence-'));
  const file = join(dir, 'room.sqlite');
  const store = new RoomStore(file); store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const offerId = 'public-fence';
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId, reviewerMemberIds: ['owner'],
    terms: { repositoryUrl: 'https://github.com/Uuriko/project-room', kind: 'project', title: 'Fence proof',
      summary: 'Disposable public task', acceptanceCriteria: ['Return an artifact'], reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', offerId, 'publish', { requestId: 'publish', expectedRevision: 1 });
  const registry = createDurableWorkClaimRegistry(store.db);
  const task = store.publicWorkClaims.enable('commons', 'owner', offerId, {
    requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/public-proof.js'] });
  return { store, file, registry, task };
}

test('cached registry writes keep private behavior but cannot insert, rewrite, move or delete public namespace rows', t => {
  const { store, registry, task } = fixture(t);
  registry.set('commons', createWork({ id: 'private', title: 'Private unchanged' }));
  registry.configure('commons', { defaultLeaseHours: 2 });
  assert.equal(registry.get('commons', 'private').title, 'Private unchanged');
  assert.equal(registry.configFor('commons').defaultLeaseHours, 2);
  const namespace = task.namespaceId;
  const before = store.db.prepare('SELECT * FROM work_claims WHERE room_id=?').all(namespace);
  assert.throws(() => registry.set(namespace, createWork({ id: 'unauthorized', title: 'No permit' })), /unsupported public claim writer/);
  assert.throws(() => registry.set(namespace, { ...registry.get(namespace, task.taskId), title: 'Changed' }), /unsupported public claim writer/);
  assert.throws(() => registry.configure(namespace, { defaultLeaseHours: 4 }), /unsupported public claim writer/);
  withPublicWorkClaimWriter(store, () => registry.configure(namespace, { defaultLeaseHours: 1 }));
  for (const table of ['work_claims', 'work_claim_config']) {
    assert.throws(() => store.db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(namespace), /unsupported public claim writer/);
    assert.throws(() => store.db.prepare(`UPDATE ${table} SET room_id=? WHERE room_id=?`).run('escape-private', namespace), /unsupported public claim writer/);
    assert.throws(() => store.db.prepare(`UPDATE ${table} SET room_id=? WHERE room_id=?`).run(namespace, 'commons'), /unsupported public claim writer/);
  }
  assert.deepEqual(store.db.prepare('SELECT * FROM work_claims WHERE room_id=?').all(namespace), before);
  assert.equal(verifyPublicWorkClaimFence(store.db), true);
});

test('synchronous failure and thenable rejection roll back permit and public writes before reopen', t => {
  const { store, file, registry, task } = fixture(t);
  const before = registry.get(task.namespaceId, task.taskId);
  for (const asynchronous of [false, true]) {
    assert.throws(() => withPublicWorkClaimWriter(store, () => {
      registry.set(task.namespaceId, { ...before, title: 'Must roll back' });
      if (asynchronous) return { then() {} };
      throw new Error('Injected transaction failure');
    }), asynchronous ? /remain synchronous/ : /Injected transaction failure/);
    assert.deepEqual(registry.get(task.namespaceId, task.taskId), before);
    assert.equal(verifyPublicWorkClaimFence(store.db), true);
  }
  const reopened = new RoomStore(file);
  try {
    assert.deepEqual(reopened.publicWorkClaims.read(task.taskId), task);
    assert.equal(verifyPublicWorkClaimFence(reopened.db), true);
  } finally { reopened.close(); }
});

test('tampered guard or a permit left open is refused without silently repairing storage', t => {
  const { store, file } = fixture(t);
  store.db.exec('UPDATE public_work_claim_writer_permit SET enabled=1');
  assert.throws(() => new RoomStore(file), /permit must be closed at rest/);
  assert.equal(store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled, 1);
  store.db.exec('UPDATE public_work_claim_writer_permit SET enabled=0; DROP TRIGGER public_claim_guard_work_claims_delete;');
  assert.throws(() => new RoomStore(file), /requires operator reconciliation/);
  assert.equal(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='public_claim_guard_work_claims_delete'").get(), undefined);
  store.db.exec('CREATE TRIGGER public_claim_guard_work_claims_delete BEFORE DELETE ON work_claims BEGIN SELECT 1; END;');
  assert.throws(() => new RoomStore(file), /requires operator reconciliation/);
  assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='public_claim_guard_work_claims_delete'").get().sql, /SELECT 1/);
});

test('process death inside a public writer transaction recovers original rows and a closed permit', t => {
  const { store, file, registry, task } = fixture(t);
  const before = registry.get(task.namespaceId, task.taskId);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { RoomStore } from ${JSON.stringify(new URL('../server/store.mjs', import.meta.url).href)};
    import { withPublicWorkClaimWriter } from ${JSON.stringify(new URL('../server/public-work-claim-fence.mjs', import.meta.url).href)};
    const store = new RoomStore(${JSON.stringify(file)});
    withPublicWorkClaimWriter(store, () => {
      const namespace = ${JSON.stringify(task.namespaceId)};
      const item = store.workClaims.get(namespace, ${JSON.stringify(task.taskId)});
      store.workClaims.set(namespace, { ...item, title: 'Uncommitted crash' });
      process.kill(process.pid, 'SIGKILL');
    });
  `], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const reopened = new RoomStore(file);
  try {
    assert.deepEqual(reopened.workClaims.get(task.namespaceId, task.taskId), before);
    assert.equal(verifyPublicWorkClaimFence(reopened.db), true);
    assert.equal(verifyPublicWorkClaimFence(store.db), true);
  } finally { reopened.close(); }
});
