import test from 'node:test';
import assert from 'node:assert/strict';
import { directDraftKey, directDraftPeer, directMessagePeer, ConversationDrafts, DraftRecovery } from '../src/conversation.js';
import { draftCommand } from '../src/client.js';

test('direct conversations select only the two participants, never public mentions or another pair', () => {
  assert.equal(directMessagePeer({ authorId: 'me', toMemberId: 'alice' }, 'me'), 'alice');
  assert.equal(directMessagePeer({ authorId: 'alice', toMemberId: 'me' }, 'me'), 'alice');
  assert.equal(directMessagePeer({ authorId: 'alice', toMemberId: 'bob' }, 'me'), null);
  assert.equal(directMessagePeer({ authorId: 'alice', body: '@me hello' }, 'me'), null);
});

test('public and two private drafts keep independent text, attachments, and exact retry commands', () => {
  const drafts = new ConversationDrafts(), a = directDraftKey('alice'), b = directDraftKey('bob');
  const data = { messageId: 'send-a', body: 'Only Alice', toMemberId: 'alice', replyToId: null, channelId: 'general' };
  const pending = draftCommand(null, 'message.posted', data);
  drafts.save(a, { ...data, pending, files: [{ id: 'file-a', filename: 'a.txt', mediaType: 'text/plain', status: 'staged' }] });
  drafts.save(b, { body: 'Only Bob', channelId: 'general' });
  drafts.save(null, { body: 'Public thought', channelId: 'general' });
  assert.equal(drafts.get(a).pending.command.data.toMemberId, 'alice');
  assert.equal(drafts.get(b).toMemberId, 'bob');
  assert.equal(drafts.get(b).replyToId, null);
  assert.equal(drafts.get(null).toMemberId, '');
  const memory = new Map();
  const recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
  const state = { members: { alice: {}, bob: {} }, messages: [], channels: {} };
  recovery.write('same-session', drafts, null, a);
  const restored = recovery.read('same-session', state);
  assert.equal(restored.directMemberId, 'alice');
  assert.equal(restored.threadId, null);
  assert.deepEqual(restored.drafts.get(a).pending, pending);
  assert.equal(restored.drafts.get(a).files[0].id, 'file-a');
  assert.equal(restored.drafts.get(b).body, 'Only Bob');
  assert.equal(restored.drafts.get(null).body, 'Public thought');
  const tampered = JSON.parse(memory.get(recovery.key));
  tampered.entries.find(([id]) => id === a)[1].toMemberId = 'bob';
  memory.set(recovery.key, JSON.stringify(tampered));
  assert.equal(recovery.read('same-session', state).drafts.entries.has(a), false);
});

test('legacy private channel drafts recover into their private conversation, never the public composer', () => {
  const memory = new Map();
  const recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
  const drafts = new ConversationDrafts();
  drafts.save(null, { body: 'Unsent private text', toMemberId: 'alice', channelId: 'general' });
  recovery.write('scope', drafts, null);
  const restored = recovery.read('scope', { members: { alice: {} }, messages: [] });
  assert.equal(restored.directMemberId, 'alice');
  assert.equal(restored.drafts.get(directDraftKey('alice')).body, 'Unsent private text');
  assert.equal(restored.drafts.get(null).body, '');
  assert.equal(directDraftPeer('message-id'), null);
  assert.equal(directDraftPeer('["direct", ""]'), null);
});

test('recovery never moves a removed recipient draft into the public conversation or another session', () => {
  for (const members of [{}, { alice: { active: false } }, { alice: { identityRevoked: true } }]) {
    const memory = new Map();
    const recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
    const drafts = new ConversationDrafts(), privateKey = directDraftKey('alice');
    drafts.save(privateKey, { body: 'Private draft must not become public', channelId: 'general' });
    drafts.save(null, { body: 'Independent public draft', channelId: 'general' });
    recovery.write('account-one', drafts, null, privateKey);
    const restored = recovery.read('account-one', { members, messages: [] });
    assert.equal(restored.drafts.entries.has(privateKey), false);
    assert.equal(restored.directMemberId, null);
    assert.equal(restored.drafts.get(null).body, 'Independent public draft');
    recovery.write('account-one', drafts, null, privateKey);
    assert.equal(recovery.read('account-two', { members: { alice: {} }, messages: [] }), null);
  }
});

test('private recovery rejects public or different-pair reply targets and inherited recipients', () => {
  for (const reply of [
    { id: 'reply', authorId: 'alice', toMemberId: null },
    { id: 'reply', authorId: 'me', toMemberId: 'bob' },
  ]) {
    const memory = new Map();
    const recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
    const drafts = new ConversationDrafts(), key = directDraftKey('alice');
    drafts.save(key, { body: 'Private reply', replyToId: 'reply', channelId: 'general' });
    recovery.write('scope', drafts, null, key);
    assert.equal(recovery.read('scope', { members: { alice: {}, bob: {} }, messages: [reply] }).drafts.entries.has(key), false);
  }
  const memory = new Map();
  const recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
  const drafts = new ConversationDrafts(), key = directDraftKey('constructor');
  drafts.save(key, { body: 'Never restore an inherited property as a member', channelId: 'general' });
  recovery.write('scope', drafts, null, key);
  assert.equal(recovery.read('scope', { members: {}, messages: [] }).drafts.entries.has(key), false);
});


test('empty selected conversation survives reload only in the same scope with a current recipient', () => {
  for (const [members, expected] of [[{ alice: {} }, 'alice'], [{}, null], [{ alice: { active: false } }, null], [{ alice: { identityRevoked: true } }, null], [Object.create({ alice: {} }), null]]) {
    const memory = new Map();
    const recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
    const drafts = new ConversationDrafts(), key = directDraftKey('alice');
    recovery.write('account-one', drafts, null, key);
    const restored = recovery.read('account-one', { members, messages: [] });
    assert.equal(restored.directMemberId, expected);
    if (expected) {
      assert.equal(restored.drafts.get(key).body, '');
      assert.equal(restored.drafts.get(key).toMemberId, 'alice');
    }
    assert.equal(recovery.read('account-two', { members, messages: [] }), null);
  }
});


test('legacy private draft migration validates the normalized pair before keeping a reply', () => {
  for (const [reply, expected] of [
    [{ id: 'reply', authorId: 'alice', toMemberId: null }, false],
    [{ id: 'reply', authorId: 'me', toMemberId: 'bob' }, false],
    [{ id: 'reply', authorId: 'alice', toMemberId: 'me' }, true],
  ]) {
    const memory = new Map();
    const recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
    const drafts = new ConversationDrafts();
    drafts.save(null, { body: 'Old private reply', toMemberId: 'alice', replyToId: 'reply', channelId: 'general' });
    recovery.write('scope', drafts, null);
    const restored = recovery.read('scope', { members: { alice: {}, bob: {} }, messages: [reply] });
    assert.equal(restored.drafts.entries.has(directDraftKey('alice')), expected);
  }
});
