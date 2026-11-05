import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenAgentInvitation } from '../src/share-links.js';

test('agent invitation entry follows current room and invite authority', () => {
  const state = { room: { id: 'room-a', ownerId: 'owner' }, members: {
    owner: { id: 'owner', active: true, permissions: [] },
    inviter: { id: 'inviter', active: true, permissions: ['invite_member'] },
    reader: { id: 'reader', active: true, permissions: [] },
    removed: { id: 'removed', active: false, permissions: ['invite_member'] },
  } };
  const session = id => ({ roomId: 'room-a', member: { id } });
  assert.equal(canOpenAgentInvitation(state, session('owner')), true);
  assert.equal(canOpenAgentInvitation(state, session('inviter')), true);
  assert.equal(canOpenAgentInvitation(state, session('reader')), false);
  assert.equal(canOpenAgentInvitation(state, session('removed')), false);
  assert.equal(canOpenAgentInvitation(state, { ...session('owner'), roomId: 'other' }), false);
  assert.equal(canOpenAgentInvitation(state, null), false);
});
