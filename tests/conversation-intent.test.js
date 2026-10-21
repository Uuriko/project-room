import test from 'node:test';
import assert from 'node:assert/strict';
import { addressesAssistant, conversationIntent } from '../src/conversation-intent.js';

const assistant = { coordinatorMemberId: 'agent', name: 'Room', availability: 'connected' };
const source = { id: 'question', authorId: 'alice', channelId: 'general' };
const run = { id: 'run', sourceMessageId: source.id, initiatorId: 'alice', status: 'working', revision: 7, inputs: [{ sourceMessageId: source.id }] };
const route = (content = {}, overrides = {}) => conversationIntent({ content: { body: 'Use the shorter version', ...content }, messages: [source], runs: [run], assistant, selfId: 'bob', ownerId: 'owner', ...overrides });

test('explicit mentions start work without requiring a separate composer mode', () => {
  assert.equal(route(), null);
  assert.deepEqual(route({ body: '@Room compare these' }), { action: 'invoke' });
  assert.deepEqual(route({ body: 'Can you compare these, @Room?' }), { action: 'invoke' });
  assert.equal(route({ body: 'I asked Room yesterday' }), null);
  assert.equal(route({ body: 'someone@Room.example' }), null);
  assert.equal(route({ body: '@Roommate compare these' }), null);
  assert.equal(addressesAssistant('  @Research+AI: compare these', 'Research+AI'), true);
  assert.equal(addressesAssistant('@ResearchAI compare these', 'Research+AI'), false);
});

test('a second person can continue recorded work with an exact revision', () => {
  assert.deepEqual(route({ replyToId: source.id }), { action: 'contribute', runId: 'run', expectedRevision: 7 });
  const addition = { id: 'addition', authorId: 'bob' };
  assert.deepEqual(route({ replyToId: addition.id }, { messages: [source, addition], runs: [{ ...run, inputs: [...run.inputs, { sourceMessageId: addition.id }] }] }), { action: 'contribute', runId: 'run', expectedRevision: 7 });
});

test('unrelated replies and ambiguous run links do not infer execution', () => {
  assert.equal(route({ replyToId: 'other' }, { messages: [{ id: 'other' }] }), null);
  assert.equal(route({ replyToId: source.id }, { runs: [run, { ...run, id: 'other-run' }] }), null);
});

test('private, deleted, unloaded and cross-channel targets never continue work', () => {
  assert.equal(route({ replyToId: source.id, toMemberId: 'alice' }), null);
  for (const target of [{ ...source, deletedAt: 1 }, { ...source, toMemberId: 'alice' }, { ...source, channelId: 'private' }]) {
    assert.equal(route({ body: '@Room continue', replyToId: source.id }, { messages: [target] }), null);
  }
  assert.equal(route({ body: '@Room continue', replyToId: 'unloaded' }), null);
  assert.equal(route({ replyToId: source.id }, { runs: [{ ...run, sourceDeleted: true }] }), null);
});

test('closed results start new work and stopping work cannot be revived by a reply', () => {
  const result = { id: 'result', authorId: 'agent' };
  assert.deepEqual(route({ replyToId: result.id }, { messages: [source, result], runs: [{ ...run, status: 'done', resultMessageId: result.id }] }), { action: 'invoke' });
  assert.equal(route({ replyToId: source.id }, { runs: [{ ...run, status: 'cancel_requested' }] }), null);
});

test('scope resolution is offered only to the requester or room owner', () => {
  const overrides = { runs: [{ ...run, status: 'needs_input' }] };
  assert.equal(route({ replyToId: source.id }, overrides), null);
  for (const selfId of ['alice', 'owner']) assert.deepEqual(route({ replyToId: source.id }, { ...overrides, selfId }), { action: 'resolve', runId: 'run', expectedRevision: 7 });
});

test('unconfigured agents do not intercept ordinary messages', () => {
  for (const unavailable of [null, {}, { ...assistant, availability: 'not_connected' }]) assert.equal(route({ body: '@Room help' }, { assistant: unavailable }), null);
  for (const availability of ['paused', 'awaiting_host']) assert.deepEqual(route({ body: '@Room help' }, { assistant: { ...assistant, availability } }), { action: 'invoke' });
});


test('a participant without steering permission can discuss a finished result without an implicit invocation', () => {
  const result = { id: 'result', authorId: 'agent' };
  const context = { messages: [source, result], runs: [{ ...run, status: 'done', resultMessageId: result.id }], canInvoke: false };
  assert.equal(route({ replyToId: result.id }, context), null);
  assert.deepEqual(route({ body: '@Room revise', replyToId: result.id }, context), { action: 'invoke' }, 'explicit requests still receive the server permission decision');
});
