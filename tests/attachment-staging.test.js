import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { attachmentLimits } from '../server/attachments.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

function setup(t) {
  let now = Date.now();
  const store = new RoomStore(':memory:', { now: () => now });
  t.after(() => store.close());
  store.initialize(initialRoom('files'));
  store.initialize(initialRoom('other'));
  const owner = store.issueAccessKey('files', 'owner'), other = store.issueAccessKey('other', 'owner');
  store.command(owner, 'files', { id: randomUUID(), type: 'member.added', data: { memberId: 'guest', displayName: 'Guest', kind: 'human', permissions: [] } });
  const guest = store.issueAccessKey('files', 'guest');
  const files = store.attachments;
  const input = (id = randomUUID(), bytes = new Uint8Array([0, 255, 12])) => ({ id, filename: 'notes.txt', mediaType: 'text/plain', bytes });
  return { store, files, owner, guest, other, input, advance: ms => { now += ms; } };
}

test('staged uploads preserve exact bytes, stable retries and private ownership', t => {
  const f = setup(t), input = f.input();
  const result = f.files.stage(f.owner, 'files', input);
  assert.deepEqual(f.files.stage(f.owner, 'files', input), result);
  assert.deepEqual(f.files.readStaged(f.owner, 'files', input.id).bytes, input.bytes);
  assert.throws(() => f.files.readStaged(f.guest, 'files', input.id), { status: 404 });
  assert.throws(() => f.files.readStaged(f.other, 'other', input.id), { status: 404 });
  assert.throws(() => f.files.stage(f.owner, 'files', { ...input, bytes: new Uint8Array([1]) }), { code: 'attachment_conflict' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 1);
});

test('discard is idempotent, removes bytes and never resurrects on upload retry', t => {
  const f = setup(t), input = f.input(); f.files.stage(f.owner, 'files', input);
  assert.throws(() => f.files.discard(f.guest, 'files', input.id), { status: 404 });
  const receipt = f.files.discard(f.owner, 'files', input.id);
  assert.equal(receipt.state, 'discarded');
  assert.deepEqual(f.files.discard(f.owner, 'files', input.id), receipt);
  assert.equal(f.store.db.prepare('SELECT bytes FROM room_attachments').get().bytes, null);
  assert.throws(() => f.files.stage(f.owner, 'files', input), { status: 410 });
});

test('expiry prevents reads without mutating them; next staging write reclaims bytes', t => {
  const f = setup(t), input = f.input(); f.files.stage(f.owner, 'files', input);
  f.advance(attachmentLimits.lifetimeMs);
  assert.throws(() => f.files.readStaged(f.owner, 'files', input.id), { status: 404 });
  assert.equal(f.store.db.prepare('SELECT state FROM room_attachments').get().state, 'staged');
  f.files.stage(f.owner, 'files', f.input());
  assert.equal(f.store.db.prepare('SELECT state FROM room_attachments WHERE id=?').get(input.id).state, 'expired');
  assert.throws(() => f.files.stage(f.owner, 'files', input), { status: 410 });
});

test('file and member byte caps reject atomically; exact retry still works at capacity', t => {
  const f = setup(t);
  assert.throws(() => f.files.stage(f.owner, 'files', f.input('oversized', new Uint8Array(attachmentLimits.fileBytes + 1))), { status: 413 });
  let last;
  for (let n = 0; n < 8; n++) { last = f.input('file-' + n, new Uint8Array(attachmentLimits.fileBytes)); f.files.stage(f.owner, 'files', last); }
  assert.throws(() => f.files.stage(f.owner, 'files', f.input()), { code: 'attachment_capacity' });
  assert.equal(f.files.stage(f.owner, 'files', last).id, last.id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 8);
});

test('unsafe names and malformed media types do not persist; current access is required', t => {
  const f = setup(t);
  for (const filename of ['../a', 'a\\b', 'a\r\nb', '\u202eevil', ' ', '..'])
    assert.throws(() => f.files.stage(f.owner, 'files', { ...f.input(), filename }), { status: 422 });
  assert.throws(() => f.files.stage(f.owner, 'files', { ...f.input(), mediaType: 'text/html\r\nInjected: x' }), { status: 422 });
  const input = f.input(); f.files.stage(f.guest, 'files', input);
  f.store.command(f.owner, 'files', { id: randomUUID(), type: 'member.access_changed', data: { memberId: 'guest', expectedMemberRevision: 0, active: false, permissions: [] } });
  assert.throws(() => f.files.readStaged(f.guest, 'files', input.id), { status: 401 });
  assert.throws(() => f.files.discard(f.guest, 'files', input.id), { status: 401 });
  assert.throws(() => f.files.stage(f.guest, 'files', f.input()), { status: 401 });
  assert.equal(f.store.db.prepare('SELECT bytes FROM room_attachments WHERE id=?').get(input.id).bytes, null);
  assert.equal(f.store.db.prepare('SELECT state FROM room_attachments WHERE id=?').get(input.id).state, 'discarded');
});

test('sliced input persists only its view, and corrupted storage is never served', t => {
  const f = setup(t), whole = new Uint8Array([9, 8, 0, 255, 7, 6]);
  const input = f.input('slice', whole.subarray(2, 4));
  f.files.stage(f.owner, 'files', input);
  whole.fill(3);
  assert.deepEqual(f.files.readStaged(f.owner, 'files', input.id).bytes, new Uint8Array([0, 255]));
  f.store.transaction(() => f.store.db.prepare('UPDATE room_attachments SET bytes=? WHERE id=?').run(new Uint8Array([1, 2]), input.id));
  assert.throws(() => f.files.readStaged(f.owner, 'files', input.id), { code: 'attachment_corrupt' });
});

test('outer rollback leaves no upload; wrong browser binding cannot stage or read', t => {
  const f = setup(t), input = f.input();
  assert.throws(() => f.store.transaction(() => { f.files.stage(f.owner, 'files', input); throw new Error('abort'); }), /abort/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_attachments').get().n, 0);
  const session = f.store.createSession(f.owner);
  assert.throws(() => f.files.stage(session.token, 'files', input, 'wrong'), { code: 'session_binding_changed' });
  const binding = session.session.sessionBinding;
  f.files.stage(session.token, 'files', input, binding);
  assert.throws(() => f.files.readStaged(session.token, 'files', input.id, 'wrong'), { code: 'session_binding_changed' });
});

test('zero-byte uploads cannot bypass the staging count cap', t => {
  const f = setup(t);
  for (let n = 0; n < attachmentLimits.stagedPerMember; n++)
    f.files.stage(f.owner, 'files', f.input('empty-' + n, new Uint8Array()));
  assert.throws(() => f.files.stage(f.owner, 'files', f.input('extra', new Uint8Array())), { code: 'attachment_capacity' });
});

test('recovery includes verified attachment bytes and tombstones without leaking content', t => {
  const f = setup(t), input = f.input();
  const before = auditRecovery(f.store);
  f.files.stage(f.owner, 'files', input);
  const staged = auditRecovery(f.store);
  assert.notEqual(staged.dataSha256, before.dataSha256);
  assert.equal(staged.tables.find(row => row.table === 'room_attachments').rows, 1);
  assert.deepEqual(auditRecovery(f.store), staged, 'audit does not mutate the database');
  f.store.transaction(() => f.store.db.prepare('UPDATE room_attachments SET bytes=? WHERE id=?').run(new Uint8Array([1, 2, 3]), input.id));
  assert.throws(() => auditRecovery(f.store), /Attachment data/);
  f.store.transaction(() => f.store.db.prepare('UPDATE room_attachments SET bytes=? WHERE id=?').run(input.bytes, input.id));
  f.files.discard(f.owner, 'files', input.id);
  const discarded = auditRecovery(f.store);
  assert.notEqual(discarded.dataSha256, staged.dataSha256);
  assert.equal(discarded.tables.find(row => row.table === 'room_attachments').rows, 1);
});

test('retirement cleanup shares the access transaction and account retirement reclaims bytes', t => {
  const f = setup(t), input = f.input(); f.files.stage(f.guest, 'files', input);
  assert.throws(() => f.store.transaction(() => {
    f.store.command(f.owner, 'files', { id: randomUUID(), type: 'member.access_changed', data: { memberId: 'guest', expectedMemberRevision: 0, active: false, permissions: [] } });
    throw new Error('rollback retirement');
  }), /rollback retirement/);
  assert.deepEqual(f.files.readStaged(f.guest, 'files', input.id).bytes, input.bytes);
  const account = f.store.accountForMember('files', 'guest');
  f.store.changeAccountAccess(account.id, { expectedRevision: account.revision, active: false, reason: 'Synthetic suspension' });
  assert.equal(f.store.db.prepare('SELECT bytes FROM room_attachments WHERE id=?').get(input.id).bytes, null);
});

test('schema verification refuses a missing attachment ownership index', t => {
  const f = setup(t);
  f.store.transaction(() => f.store.db.exec('DROP INDEX room_attachments_owner'));
  assert.throws(() => f.files.verify(), /Attachment index/);
});

test('sponsor account retirement also reclaims managed-agent staged bytes', t => {
  const f = setup(t), session = f.store.createSession(f.owner);
  const token = randomBytes(32).toString('base64url');
  f.store.agentConnections.apply(session.token, 'files', { action: 'create', requestId: randomUUID(), memberId: 'managed',
    displayName: 'Managed test agent', access: 'chat', keyHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  const input = f.input(); f.files.stage(token, 'files', input);
  assert.throws(() => f.files.readStaged(f.owner, 'files', input.id), { status: 404 });
  const account = f.store.accountForMember('files', 'owner');
  f.store.changeAccountAccess(account.id, { expectedRevision: account.revision, active: false, reason: 'Synthetic sponsor suspension' });
  assert.equal(f.store.db.prepare('SELECT bytes FROM room_attachments WHERE id=?').get(input.id).bytes, null);
});

test('shared-memory mutation cannot separate the stored bytes from their digest', async t => {
  const f = setup(t), shared = new SharedArrayBuffer(1048576);
  const worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');
    const bytes=new Uint8Array(workerData); parentPort.postMessage('ready');
    while(true) { bytes.fill(17); bytes.fill(239); }`, { eval: true, workerData: shared });
  t.after(() => worker.terminate());
  await once(worker, 'message');
  for (let n = 0; n < 8; n++) {
    const input = f.input('shared-' + n, new Uint8Array(shared));
    f.files.stage(f.owner, 'files', input);
    assert.equal(f.files.readStaged(f.owner, 'files', input.id).bytes.byteLength, shared.byteLength);
    f.files.discard(f.owner, 'files', input.id);
  }
});
