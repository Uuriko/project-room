import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {linkWithProof,mintHolderLinkCode} from './helpers/link-with-proof.mjs';
function fixture(t,{inactive=false,members=1}={}){
 const dir=mkdtempSync(join(tmpdir(),'current-identity-link-')),path=join(dir,'room.sqlite');let store=new RoomStore(path);const identity=store.identities.create('Independent existing agent'),events=initialRoom();
 for(let i=1;i<members;i++)events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'member-'+i,displayName:'Existing member '+i,kind:'agent',permissions:[]}}));
 if(inactive){events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:identity.identityId,displayName:identity.displayName,identityId:identity.identityId,kind:'agent',permissions:['accept_work','complete_work']}}));events.push(event({roomId:'commons',actorId:'owner',type:'member.access_changed',data:{memberId:identity.identityId,expectedMemberRevision:0,active:false,permissions:['accept_work','complete_work']}}));}
 store.initialize(events,{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','owner');
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {get store(){return store;},identity,key,reopen(){store.close();store=new RoomStore(path);}};
}
test('existing identity links into normalized room with holder consent and exact grants, surviving cold restart',t=>{
 const f=fixture(t),s=f.store,before=s.db.prepare('SELECT secret_hash FROM agent_identities WHERE identity_id=?').get(f.identity.identityId);
 s.room=()=>{throw Error('Forbidden whole-room hydration');};
 const linked=linkWithProof(s,f.key,'commons',f.identity,{permissions:['accept_work']});assert.equal(linked.memberId,f.identity.identityId);
 assert.equal(s.authenticate(f.identity.secret,'commons').member.id,f.identity.identityId);assert.deepEqual(s.authenticate(f.identity.secret,'commons').member.permissions,['accept_work']);
 assert.deepEqual(s.db.prepare('SELECT secret_hash FROM agent_identities WHERE identity_id=?').get(f.identity.identityId),before);assert.equal(s.db.prepare('SELECT count(*) n FROM identity_links WHERE identity_id=?').get(f.identity.identityId).n,1);
 assert.throws(()=>linkWithProof(s,f.key,'commons',f.identity,{permissions:[]}),e=>e.code==='identity_already_linked');f.reopen();assert.equal(f.store.authenticate(f.identity.secret,'commons').member.id,f.identity.identityId);
});
test('normalized link proof/save faults roll back member, link, event and code consumption; exact input retries safely',t=>{
 const {store:s,key,identity}=fixture(t),linkCode=mintHolderLinkCode(s,identity,'commons'),input={identityId:identity.identityId,permissions:[],identityLinkCode:linkCode},before=s.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
 assert.throws(()=>s.identities.link(key,'commons',{...input,identityLinkCode:'invalid'}),e=>e.code==='identity_link_proof_required');
 assert.equal(s.db.prepare('SELECT count(*) n FROM identity_links WHERE identity_id=?').get(identity.identityId).n,0);
 const original=s.identities.requireLinkHolderProof.bind(s.identities);s.identities.requireLinkHolderProof=(...args)=>{original(...args);throw Error('Injected after-holder-proof save fault');};
 assert.throws(()=>s.identities.link(key,'commons',input),/Injected after-holder-proof/);s.identities.requireLinkHolderProof=original;
 assert.equal(s.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence,before);assert.equal(s.roomAuthority('commons').members[identity.identityId],undefined);
 assert.equal(s.identities.link(key,'commons',input).memberId,identity.identityId);
});
test('normalized relink reactivates the same member and uses current narrow permissions',t=>{
 const {store:s,key,identity}=fixture(t,{inactive:true});s.room=()=>{throw Error('Forbidden whole-room hydration');};
 assert.equal(linkWithProof(s,key,'commons',identity,{permissions:['accept_work']}).relinked,true);
 const member=s.authenticate(identity.secret,'commons').member;assert.equal(member.active,true);assert.equal(member.revision,2);assert.deepEqual(member.permissions,['accept_work']);
});
test('normalized link admits the 100th member and retains capacity refusal for the 101st',t=>{
 const admitted=fixture(t,{members:99});linkWithProof(admitted.store,admitted.key,'commons',admitted.identity,{permissions:[]});assert.equal(admitted.store.authenticate(admitted.identity.secret,'commons').member.id,admitted.identity.identityId);assert.equal(admitted.store.db.prepare("SELECT count(*) n FROM current_room_records WHERE domain='members' AND room_id='commons'").get().n,100);
 const {store:s,key,identity}=fixture(t,{members:100});assert.throws(()=>linkWithProof(s,key,'commons',identity,{permissions:[]}),e=>/capacity|limit/i.test(e.message));assert.equal(s.db.prepare('SELECT count(*) n FROM identity_links WHERE identity_id=?').get(identity.identityId).n,0);
});

test('normalized direct link preserves membership authority and reserved-name refusal',t=>{
 const {store:s,key,identity}=fixture(t);const linkCode=mintHolderLinkCode(s,identity,'commons');
 assert.throws(()=>s.identities.link(key,'commons',{identityId:identity.identityId,permissions:[],displayName:'System',identityLinkCode:linkCode}),e=>e.status===422);
 s.identities.link(key,'commons',{identityId:identity.identityId,permissions:[],identityLinkCode:linkCode});
 const next=s.identities.create('Another independent agent'),nextCode=mintHolderLinkCode(s,next,'commons');
 assert.throws(()=>s.identities.link(identity.secret,'commons',{identityId:next.identityId,permissions:[],identityLinkCode:nextCode}),e=>e.status===403&&e.code==='access_denied');
 assert.equal(s.db.prepare('SELECT count(*) n FROM identity_links WHERE identity_id=?').get(next.identityId).n,0);
});
