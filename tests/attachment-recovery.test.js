import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationDrafts, DraftRecovery } from '../src/conversation.js';
import { RoomClient, draftCommand } from '../src/client.js';

const hash = 'a'.repeat(64);
const state = { messages: [], members: { owner: { active: true } } };
const item = () => ({ id: 'upload', file: new File(['abc'], 'notes.txt', { type: 'text/plain' }),
  state: 'ready', receipt: { sha256: hash } });
function fixture(pending = false) {
  const memory = new Map(), recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 100);
  const drafts = new ConversationDrafts();
  const command = draftCommand(null, 'message.posted', { messageId: 'message', body: '', toMemberId: null, replyToId: null, attachmentIds: ['upload'] });
  drafts.save(null, { body: '', files: [item()], ...(pending ? { pending: command } : {}) });
  assert.equal(recovery.write('scope', drafts, null), true);
  return { memory, recovery, command, mutate(fn) { const data = JSON.parse(memory.get(recovery.key)); fn(data); memory.set(recovery.key, JSON.stringify(data)); } };
}
test('file-only recovery saves metadata, never bytes or trusted ready state', () => {
  const f = fixture(), raw = f.memory.get(f.recovery.key);
  assert.equal(raw.includes('"ready"'), false);
  const saved = JSON.parse(raw).entries[0][1].files[0];
  assert.deepEqual(Object.keys(saved).sort(), ['id','name','sha256','size','type']);
  const restored = f.recovery.read('scope', state).drafts.get(null);
  assert.equal(restored.body, ''); assert.equal(restored.files[0].state, 'checking');
  assert.equal(restored.files[0].expectedSha256, hash);
  assert.equal(restored.files[0].file instanceof Blob, false);
});
test('uncertain file send preserves exact command and message identities', () => {
  const f = fixture(true), restored = f.recovery.read('scope', state).drafts.get(null);
  assert.deepEqual(restored.pending, f.command);
  assert.equal(restored.files[0].state, 'checking');
});
test('tampered file metadata or retry payload cannot become a new send', () => {
  for (const change of [d => d.entries[0][1].files[0].name = '../bad',
    d => d.entries[0][1].files[0].size = 1048577,
    d => d.entries[0][1].files[0].sha256 = 'bad',
    d => d.entries[0][1].files[0].extra = 'secret',
    d => d.entries[0][1].files.push(d.entries[0][1].files[0]),
    d => d.entries[0][1].pending.contents = '{}']) {
    const f = fixture(true); f.mutate(change);
    assert.equal(f.recovery.read('scope', state).drafts.entries.size, 0);
  }
});
test('file recovery rejects different identity scope and expired records', () => {
  const a = fixture(); assert.equal(a.recovery.read('other', state), null); assert.equal(a.memory.size, 0);
  const b = fixture(); b.mutate(d => d.expires = 99); assert.equal(b.recovery.read('scope', state), null);
});
const receipt = { id: 'upload', roomId: 'room', uploaderId: 'owner', filename: 'notes.txt', byteLength: 3, mediaType: 'text/plain', sha256: hash, state: 'staged' };
function client(result) {
  const c = new RoomClient({ fetcher: async () => Response.json(result) });
  c.session = { roomId: 'room', member: { id: 'owner' } }; return c;
}
test('restoration verifies server ownership, metadata and expected digest', async () => {
  assert.deepEqual(await client(receipt).restoreAttachment({ ...item(), expectedSha256: hash }), receipt);
  for (const change of [{ roomId: 'other' }, { uploaderId: 'other' }, { filename: 'other' }, { byteLength: 4 }, { sha256: 'b'.repeat(64) }, { mediaType: 'text/html' }])
    await assert.rejects(client({ ...receipt, ...change }).restoreAttachment({ ...item(), expectedSha256: hash }), /verified/);
});
test('already committed or deleted files can only resolve their exact pending message', async () => {
  for (const status of ['committed', 'deleted']) {
    const r = { ...receipt, state: status, messageId: 'message' };
    assert.deepEqual(await client(r).restoreAttachment(item(), 'message'), r);
    await assert.rejects(client(r).restoreAttachment(item(), 'other'), /unavailable/);
    await assert.rejects(client(r).restoreAttachment(item()), /unavailable/);
  }
  for (const status of ['expired', 'discarded']) await assert.rejects(client({ ...receipt, state: status }).restoreAttachment(item()), /unavailable/);
});
test('late restoration cannot enter a replacement session', async () => {
  let resolve;
  const c = client(receipt); c.fetcher = () => new Promise(done => { resolve = done; });
  const operation = c.restoreAttachment(item());
  c.session = { ...c.session, roomId: 'other' }; resolve(Response.json(receipt));
  await assert.rejects(operation, { name: 'AbortError' });
});
