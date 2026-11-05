import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';
import {deriveRequestState} from '../server/request-states.mjs';
import {buildReplyCommand, validReplyArguments, replyTools} from '../client/reply-actions.mjs';

// The recipient of a formal request can say where it stands, so the asker
// sees acknowledged / working / needs_input / error without polling chat.
function fixture(t, representation) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const es = initialRoom();
  for (const id of ['asker', 'helper', 'other']) es.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: id, displayName: id, kind: 'agent', permissions: ['accept_work', 'complete_work']}}));
  s.initialize(es, representation ? {representation} : undefined);
  const keys = Object.fromEntries(['owner', 'asker', 'helper', 'other'].map(id => [id, s.issueAccessKey('commons', id)]));
  const cmd = (who, id, type, data) => s.command(keys[who], 'commons', {id, type, data});
  cmd('asker', 'ask', 'message.posted', {messageId: 'ask', toMemberId: 'helper', requestKind: 'reply', body: 'Can you check the deploy?'});
  const list = who => s.replyRequests.list(keys[who], 'commons', {direction: 'both', status: 'all'}).requests.find(r => r.id === 'ask');
  const progress = (who, id, extra) => cmd(who, id, 'reply_request.progressed', {requestMessageId: 'ask', expectedRequestRevision: 0, ...extra});
  return {s, keys, cmd, list, progress};
}

for (const representation of [null, 'normalized-current-v1']) test(`recipient progress is recorded and shown to the asker (${representation ?? 'legacy'})`, t => {
  const {s, cmd, list, progress} = fixture(t, representation);
  assert.equal('progress' in list('asker'), false, 'no progress key until one is reported');
  assert.throws(() => progress('asker', 'p-wrong', {progress: 'working'}), /recipient/);
  assert.throws(() => progress('other', 'p-other', {progress: 'working'}), /recipient|participant|not/i);
  assert.throws(() => progress('helper', 'p-bad', {progress: 'done'}), /Progress must/);
  assert.throws(() => progress('helper', 'p-stale', {progress: 'working', expectedRequestRevision: 3}), /revision/i);
  progress('helper', 'p1', {progress: 'needs_input', note: 'Which environment?'});
  const asked = list('asker');
  assert.equal(asked.status, 'open'); assert.equal(asked.revision, 0, 'progress never bumps the revision');
  assert.deepEqual([asked.progress.state, asked.progress.note], ['needs_input', 'Which environment?']);
  progress('helper', 'p2', {progress: 'working'});
  assert.equal(list('asker').progress.state, 'working');
  // The answer still uses the revision the recipient read.
  cmd('helper', 'answer', 'message.posted', {messageId: 'answer', replyToId: 'ask', responseToRequestId: 'ask', expectedRequestRevision: 0, responseOutcome: 'answered',
    toMemberId: 'asker', body: 'Deploy is green', ...contextOf(s, representation)});
  assert.equal(list('asker').status, 'answered');
  assert.throws(() => progress('helper', 'p-closed', {progress: 'working'}), /open|revision|closed/i);
  assert.doesNotThrow(() => auditRecovery(s));
});

function contextOf(s, representation) {
  const row = s.db.prepare("SELECT id, sequence FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')='ask'").get();
  void representation;
  return {contextEventId: JSON.parse(s.db.prepare("SELECT body FROM events WHERE room_id='commons' AND sequence=?").get(row.sequence).body).id, contextSequence: row.sequence, workItemId: null};
}

test('derived lifecycle follows recorded progress', () => {
  const base = {status: 'open', createdAt: '2026-11-05T00:00:00.000Z'};
  const now = Date.parse('2026-11-05T00:05:00.000Z');
  assert.equal(deriveRequestState(base, {now}).unresponsive, true);
  assert.equal(deriveRequestState({...base, acknowledgedAt: '2026-11-05T00:00:05.000Z', needsInputAt: '2026-11-05T00:01:00.000Z'}, {now}).state, 'needs_input');
  assert.equal(deriveRequestState({...base, acknowledgedAt: '2026-11-05T00:00:05.000Z', lastActivityAt: '2026-11-05T00:04:00.000Z'}, {now}).state, 'active');
});

test('room_progress_request builds a reply_request.progressed command', () => {
  const args = {requestId: 'progress-1', requestMessageId: 'ask', expectedRequestRevision: 0, progress: 'working', note: 'On it'};
  assert.equal(validReplyArguments('room_progress_request', args), true);
  assert.equal(validReplyArguments('room_progress_request', {...args, progress: 'done'}), false);
  const command = buildReplyCommand({roomId: 'commons', memberId: 'helper'}, 'room_progress_request', args);
  assert.equal(command.type, 'reply_request.progressed');
  assert.deepEqual(command.data, {requestMessageId: 'ask', expectedRequestRevision: 0, progress: 'working', note: 'On it'});
});

test('a progress note is private to the request parties', t => {
  const {s, keys, progress} = fixture(t, 'normalized-current-v1');
  progress('helper', 'p-private', {progress: 'needs_input', note: 'PRIVATE-NOTE'});
  const seen = who => JSON.stringify(s.eventsAfter(keys[who], 'commons', 0, 100));
  assert.ok(seen('asker').includes('PRIVATE-NOTE'));
  assert.ok(seen('helper').includes('PRIVATE-NOTE'));
  for (const outsider of ['other', 'owner']) assert.equal(seen(outsider).includes('PRIVATE-NOTE'), false, outsider);
  assert.equal(s.replyRequests.list(keys.other, 'commons', {direction: 'both', status: 'all'}).requests.some(r => r.id === 'ask'), false);
});

test('room_progress_request is not marked destructive', () => {
  const tool = replyTools.find(entry => entry.name === 'room_progress_request');
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.readOnlyHint, false);
});
