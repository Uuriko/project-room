import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {auditRecovery} from '../server/recovery.mjs';
function login(s,id){s.createAccount(id);const key=s.issueAccountAccessKey(id),slot=s.createAccountSessionSlot(),session=s.loginAccountSession(slot.token,key,0);return{token:slot.token,binding:session.sessionBinding};}
test('normalized owner issues human invitation; preview, acceptance, cold retry and scope remain exact',t=>{
 const dir=mkdtempSync(join(tmpdir(),'native-human-invite-')),path=join(dir,'room.sqlite');let s=new RoomStore(path);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
 const identity=s.identities.create('Founder');new AgentRooms(s).create(identity.secret,{roomId:'human-invite',title:'Invite human',purpose:'Coordinate',starter:false});
 const target=login(s,'target'),other=login(s,'other'),token=randomBytes(32).toString('base64url');
 const details={requestId:'human-invite',token,intendedAccountId:'target',intendedMemberId:'human',displayName:'Human collaborator',role:'member',expiresAt:Date.now()+3600000,expectedIssuerMemberRevision:0};
 s.room=()=>{throw Error('unexpected whole-room invitation read');};
 const issued=s.issueInvitation(identity.secret,'human-invite',details);assert.equal(s.issueInvitation(identity.secret,'human-invite',details).duplicate,true);
 assert.equal(s.previewInvitation(token).status,'pending');assert.equal(s.invitationStats(identity.secret,'human-invite').pending,1);
 const request={redemptionId:randomUUID(),expectedRevision:0,expectedSessionBinding:target.binding};
 assert.throws(()=>s.acceptInvitation(other.token,token,{...request,expectedSessionBinding:other.binding}),e=>e.code==='invitation_account_mismatch');
 const prepare=s.db.prepare.bind(s.db);let fault=false;
 s.db.prepare=sql=>{const statement=prepare(sql);if(!sql.includes('INSERT INTO member_accounts(room_id,member_id,account_id,origin)'))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);if(key!=='run')return typeof value==='function'?value.bind(target):value;return(...args)=>{value.apply(target,args);fault=true;throw Error('injected invitation binding save fault');};}});};
 assert.throws(()=>s.acceptInvitation(target.token,token,request),/injected invitation binding/);s.db.prepare=prepare;assert.equal(fault,true);assert.equal(s.previewInvitation(token).status,'pending');assert.equal(s.db.prepare("SELECT count(*) n FROM member_accounts WHERE room_id='human-invite' AND member_id='human'").get().n,0);
 const accepted=s.acceptInvitation(target.token,token,request);assert.equal(accepted.duplicate,false);assert.equal(accepted.event.type,'member.joined_via_invitation');assert.equal(s.authenticateAccountSession(target.token,'human-invite',target.binding).member.id,'human');
 s.close();s=new RoomStore(path);assert.equal(s.acceptInvitation(target.token,token,request).duplicate,true);assert.doesNotThrow(()=>s.verifyInvitationRecord(issued.invitation.id));assert.equal(s.previewInvitation(token).status,'accepted');assert.equal(auditRecovery(s).rooms,1);
 assert.ok(s.db.prepare("SELECT octet_length(projection) n FROM rooms WHERE id='human-invite'").get().n<512);
});
