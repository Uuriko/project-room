import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readTalkPolicy, writeTalkPolicy } from '../server/agent-talk-policy.mjs';

test('agent code records the actual human issuer sponsor, not the unrelated room owner', t => {
  const s = new RoomStore(':memory:'); t.after(() => s.close()); s.initialize(initialRoom());
  const key = s.issueAccessKey('commons', 'owner');
  s.command(key, 'commons', { id: randomUUID(), type: 'member.added', data: {memberId:'friend',displayName:'Friend',kind:'human',permissions:['invite_member']} });
  const friend = s.issueAccessKey('commons', 'friend');
  const invite = s.invites.create(friend, 'commons', {profile:'collaborate'});
  const joined = s.invites.redeem(invite.code, {displayName:'Friends assistant'});
  assert.equal(s.room('commons').state.members[joined.memberId].accountableHumanId, 'friend');
  assert.equal(readTalkPolicy(s.db,'commons',joined.memberId).policy,'owner');
});

test('share admission seeds owner policy and duplicate join preserves explicit choice', t => {
  const s = new RoomStore(':memory:'); t.after(() => s.close()); s.initialize(initialRoom());
  const key = s.issueAccessKey('commons','owner'), token=randomBytes(32).toString('base64url');
  s.shareLinks.create(key,'commons',{requestId:randomUUID(),linkToken:token,expiresAt:Date.now()+3600000,maxJoins:2,expectedMemberRevision:0,access:'member'},null);
  const identity=s.identities.create('Friend assistant');
  const joined=s.shareLinks.joinAgent(identity.secret,token,'Friend assistant');
  assert.deepEqual(readTalkPolicy(s.db,'commons',joined.memberId),{policy:'owner',allowed:[],explicit:true});
  writeTalkPolicy(s.db,s.room('commons').state,{roomId:'commons',actorId:'owner',memberId:joined.memberId,policy:'nobody'},Date.now(),()=>assert.fail());
  assert.equal(s.shareLinks.joinAgent(identity.secret,token,'Friend assistant').duplicate,true);
  assert.equal(readTalkPolicy(s.db,'commons',joined.memberId).policy,'nobody');
});
