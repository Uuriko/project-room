import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event,PERMISSIONS} from '../src/events.js';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {accessReviewReport} from '../server/access-review.mjs';
import {operatorNormalization} from '../server/operator-normalization.mjs';
import {seedNormalizationAuth,normalizationAuthSnapshot} from './helpers/operator-normalization-auth-source.mjs';

function roomStore(t){const s=new RoomStore(':memory:');t.after(()=>s.close());return s;}
test('normalized owner admin reads and share administration preserve grants without whole-room hydration',t=>{
 const s=roomStore(t),owner=s.identities.create('Olive'),peer=s.identities.create('Parker');
 new AgentRooms(s).create(owner.secret,{roomId:'admin-room',title:'Admin room',purpose:'Coordinate',starter:false});
 const invite=s.invites.create(owner.secret,'admin-room',{profile:'chat'});s.invites.redeem(invite.code,{identitySecret:peer.secret});
 s.room=()=>{throw Error('unexpected admin blob hydration');};
 const review=accessReviewReport(s,owner.secret,'admin-room');assert.equal(review.ownerId,owner.identityId);assert.equal(review.roomTitle,'Admin room');assert.equal(review.members.length,2);assert.ok(review.members.some(m=>m.memberId===peer.identityId));
 assert.deepEqual(s.agentConnections.list(owner.secret,'admin-room').connections,[]);
 const data={requestId:'share-link',linkToken:randomBytes(32).toString('base64url'),expiresAt:Date.now()+3600000,maxJoins:5,expectedMemberRevision:0};
 const made=s.shareLinks.create(owner.secret,'admin-room',data);assert.equal(made.link.status,'active');assert.equal(s.shareLinks.create(owner.secret,'admin-room',data).duplicate,true);assert.equal(s.shareLinks.list(owner.secret,'admin-room').links.length,1);s.shareLinks.cancel(owner.secret,'admin-room',made.link.id);assert.equal(s.shareLinks.list(owner.secret,'admin-room').links[0].status,'cancelled');
 assert.throws(()=>s.guestInvites.ownerGate(owner.secret,'admin-room'),e=>e.code==='guest_invite_account_session_required');
 for(const read of [()=>accessReviewReport(s,peer.secret,'admin-room'),()=>s.agentConnections.list(peer.secret,'admin-room'),()=>s.shareLinks.list(peer.secret,'admin-room'),()=>s.guestAgentLinks.owner(peer.secret,'admin-room')])assert.throws(read,e=>e.status===403);
 const serialized=JSON.stringify(review);assert.ok(!serialized.includes(owner.secret));assert.ok(!serialized.includes(peer.secret));assert.ok(!serialized.includes(invite.code));
});
test('access review preserves complete legal 100-member roster across direct adoption',t=>{
 const s=roomStore(t),events=initialRoom();for(let i=0;i<99;i++)events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'member'+i,displayName:'Member '+i,kind:'agent',permissions:['accept_work']}}));s.initialize(events);const key=s.issueAccessKey('commons','owner');
 const before=accessReviewReport(s,key,'commons');const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'adopt',reason:'Synthetic admin census'},true);
 s.room=()=>{throw Error('unexpected roster blob hydration');};const after=accessReviewReport(s,key,'commons');assert.equal(after.members.length,100);assert.deepEqual(Object.fromEntries(after.members.map(m=>[m.memberId,m])),Object.fromEntries(before.members.map(m=>[m.memberId,m])));assert.deepEqual(after.counts,before.counts);assert.deepEqual(after.members.find(m=>m.memberId==='owner').permissions,[...PERMISSIONS]);
});

test('access review and connection list preserve nonempty sponsored, expired and revoked records after adoption',t=>{
 const s=roomStore(t),f=seedNormalizationAuth(s),session=s.createSession(f.owner);
 const before=accessReviewReport(s,f.owner,'commons'),connections=s.agentConnections.list(session.token,'commons',session.session.sessionBinding),auth=normalizationAuthSnapshot(s);
 const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'adopt-sponsored',reason:'Synthetic sponsored admin records'},true);
 s.room=()=>{throw Error('unexpected sponsored admin blob hydration');};
 const after=accessReviewReport(s,f.owner,'commons');assert.deepEqual(after.agentConnections,before.agentConnections);assert.deepEqual(after.guests,before.guests);assert.deepEqual(after.counts,before.counts);
 assert.deepEqual(s.agentConnections.list(session.token,'commons',session.session.sessionBinding),connections);assert.equal(normalizationAuthSnapshot(s),auth);
 assert.ok(after.agentConnections.some(row=>row.status==='revoked'));assert.ok(after.agentConnections.some(row=>row.status==='expired'));assert.ok(after.agentConnections.some(row=>row.status==='disconnected'));
});
