// The starter work item on invite redeem, in a normalized (current-format)
// room: the proposal is persisted with its proofs, survives recovery audit,
// and the join still succeeds when the inviter can no longer propose.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {createLegacyInviteJourney,initializeCurrentInviteJourney} from './helpers/current-agent-invite-journey.mjs';
function fixture(t){
 const legacy=new RoomStore(':memory:');t.after(()=>legacy.close());
 const snapshot=createLegacyInviteJourney(legacy,{});
 const s=new RoomStore(':memory:');t.after(()=>s.close());
 return{s,...initializeCurrentInviteJourney(s,snapshot)};
}
const STARTER={title:'Say hello and pick one item',definitionOfDone:'One message naming what you will take.'};
const itemRow=(s,id)=>{const row=s.db.prepare('SELECT body FROM work_entities WHERE work_id=?').get(id);return row&&JSON.parse(row.body);};
test('starter work is proposed to the new member in a current-format room and passes recovery audit',t=>{
 const{s,ownerKey}=fixture(t);
 const issued=s.invites.create(ownerKey,'commons',{profile:'contribute',displayName:'Starter agent',starterWork:STARTER});
 assert.deepEqual(issued.starterWork,STARTER);
 const joined=s.invites.redeem(issued.code,{displayName:'Starter agent',requestId:'starter-current'});
 assert.match(joined.starterWorkItemId,/^starter-[a-f0-9]{8}$/);
 const item=itemRow(s,joined.starterWorkItemId);
 assert.ok(item,'starter item persisted in work_entities');
 assert.equal(item.accountableMemberId,joined.memberId);
 assert.equal(item.title,STARTER.title);
 assert.equal(item.state,'proposed');
 assert.equal(item.proposedById,'owner');
 assert.doesNotThrow(()=>auditRecovery(s));
 // The new member takes it with the grants the profile carries.
 s.command(joined.identitySecret,'commons',{id:'take-starter',type:'work.accepted',data:{workItemId:joined.starterWorkItemId,expectedRevision:0}});
 assert.equal(itemRow(s,joined.starterWorkItemId).state,'accepted');
 assert.doesNotThrow(()=>auditRecovery(s));
});
test('a refused starter proposal (room requires independent review) never undoes the join',t=>{
 const{s,ownerKey}=fixture(t);
 const issued=s.invites.create(ownerKey,'commons',{profile:'contribute',displayName:'No starter',starterWork:STARTER});
 // The starter names no verifier, so the review policy refuses the proposal.
 s.command(ownerKey,'commons',{id:'policy',type:'room.policy_set',data:{requireIndependentReview:true,requireOwnerDecision:false}});
 const joined=s.invites.redeem(issued.code,{displayName:'No starter',requestId:'starter-refused'});
 assert.ok(joined.memberId);
 assert.equal(joined.starterWorkItemId,undefined);
 assert.equal(s.authenticate(joined.identitySecret,'commons').member.active,true);
 assert.equal(itemRow(s,`starter-${issued.inviteId}`),undefined);
 assert.doesNotThrow(()=>auditRecovery(s));
});
