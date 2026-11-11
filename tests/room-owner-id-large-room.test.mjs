// Regression + design guard: owner-only checks must not load the full member
// census. store.roomAuthority(roomId) with no {memberId} reads every member
// record plus its witness receipt inside the shared 200-record/256KiB current
// read budget and 409s (current_room_context_unavailable) once a room has
// ~20+ members. store.roomOwnerId() reads only the head and room record.
import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNeedsMeRoom} from './helpers/canonical-needs-me-room.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {callHostedStdioTool} from '../server/mcp-full-profile.mjs';
import {countUnaddressed, problems, scan, BASELINE} from '../scripts/room-authority-lint.mjs';

function bigRoom(t, members = 95) {
  const f = canonicalNeedsMeRoom(t), {store, owner, roomId} = f;
  for (let n = 0; n < members; n++) {
    const id = store.identities.create('Member ' + n);
    linkWithProof(store, owner.secret, roomId, id, {displayName: ('Member ' + n + ' ').padEnd(80, 'x'), permissions: ['accept_work']});
  }
  return f;
}

test('roomOwnerId returns the owner in a 95-member room where the full census exceeds the read budget', t => {
  const {store, owner, worker, roomId} = bigRoom(t);
  const addressed = store.roomAuthority(roomId, {memberId: worker.identityId});
  assert.equal(store.roomOwnerId(roomId), addressed.ownerId);
  assert.equal(store.roomOwnerId(roomId), owner.identityId);
  // Documents why: the unaddressed census is what 409s at this size.
  assert.throws(() => store.roomAuthority(roomId), e => e.status === 409 && e.code === 'current_room_context_unavailable');
});

test('roomOwnerId matches roomAuthority in a small room', t => {
  const {store, worker, roomId} = canonicalNeedsMeRoom(t);
  assert.equal(store.roomOwnerId(roomId), store.roomAuthority(roomId).ownerId);
  assert.notEqual(store.roomOwnerId(roomId), worker.identityId);
});

test('room_list_requests (reply-requests owner check) works in a 95-member room', async t => {
  const {store, owner, worker, roomId, send} = bigRoom(t);
  send(owner, 'message.posted', {messageId: 'ask-1', body: 'Please confirm', toMemberId: worker.identityId, requestKind: 'reply'});
  for (const who of [worker, owner]) {
    const {value, isError} = await callHostedStdioTool(store, who.secret, 'room_list_requests', {roomId, direction: 'both', status: 'open'});
    assert.equal(isError, false);
    assert.ok(Array.isArray(value.requests));
    assert.ok(Number.isSafeInteger(value.evaluatedThrough));
  }
  const listed = (await callHostedStdioTool(store, worker.secret, 'room_list_requests', {roomId, direction: 'incoming', status: 'open'})).value;
  assert.equal(listed.requests.length, 1);
  const requestMessageId = listed.requests[0].requestMessageId ?? listed.requests[0].id;
  const read = await callHostedStdioTool(store, worker.secret, 'room_read_request', {roomId, requestMessageId});
  assert.equal(read.isError, false);
  assert.equal(read.value.request.requesterId, owner.identityId);
  assert.ok(read.value.request.recipientId === worker.identityId);
});

test('lint counts only unaddressed calls and ignores comments', () => {
  assert.equal(countUnaddressed('store.roomAuthority(roomId).ownerId'), 1);
  assert.equal(countUnaddressed('this.store.roomAuthority( room_id )'), 1);
  assert.equal(countUnaddressed('store.roomAuthority(roomId,{memberId})'), 0);
  assert.equal(countUnaddressed('store.roomAuthority(roomId, { includeHistory: true })'), 0);
  assert.equal(countUnaddressed('// store.roomAuthority(roomId)\n/* roomAuthority(x) */'), 0);
  assert.equal(countUnaddressed('store.roomOwnerId(roomId)'), 0);
  assert.equal(countUnaddressed('currentRoomAuthority(db,roomId)'), 1);
  assert.equal(countUnaddressed('currentRoomAuthority(db,roomId,{memberId})'), 0);
});

test('lint ratchet: repo is clean, a new call fails, a removed call demands a lower baseline', () => {
  assert.deepEqual(problems(), []);
  assert.deepEqual(problems(scan(), BASELINE), []);
  assert.match(problems({'new.mjs': 1}, {}).join('\n'), /new\.mjs: 1 unaddressed/);
  assert.match(problems({}, {'old.mjs': 2}).join('\n'), /lower .*baseline/);
  // Fixed owner-only callers stay off the list.
  for (const file of ['owner-attention.mjs', 'reply-requests.mjs', 'room-lifecycle.mjs', 'routes/board-views.mjs', 'inbox-collab-store.mjs', 'account-deletion.mjs', 'current-reply-reader.mjs'])
    assert.equal(BASELINE[file], undefined, file);
});

test('roomOwnerIdOf prefers store.roomOwnerId and falls back for stub stores', async () => {
  const { roomOwnerIdOf } = await import('../server/room-owner.mjs');
  assert.equal(roomOwnerIdOf({ roomOwnerId: () => 'o1', roomAuthority: () => { throw new Error('census'); } }, 'r'), 'o1');
  assert.equal(roomOwnerIdOf({ roomAuthority: () => ({ ownerId: 'o2' }) }, 'r'), 'o2');
});
