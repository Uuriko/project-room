import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {currentInviteContext} from '../server/current-room-repository.mjs';
import {AccessRequests} from '../server/access-requests.mjs';
import {applyRoomTemplate,listRoomTemplates} from '../server/templates.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
import {auditRecovery} from '../server/recovery.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'open-create-')),path=join(dir,'db');let store=new RoomStore(path);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {get store(){return store;},reopen(){store.close();store=new RoomStore(path);return store;}};}
const request=(id,extra={})=>({roomId:id,title:'Useful project',purpose:'Build useful things',kind:'personal',displayName:'Founder',...extra});
function account(s){s.createAccount('founder');const key=s.issueAccountAccessKey('founder'),slot=s.createAccountSessionSlot(),session=s.loginAccountSession(slot.token,key,0);return {token:slot.token,binding:session.sessionBinding};}
function check(s,id,open){const state=currentInviteContext(s,id).room.state;assert.equal(state.room.publicPage?.enabled===true,open);assert.equal(state.room.joinLink?.enabled===true,open);const row=s.db.prepare('SELECT * FROM public_rooms WHERE slug=?').get(id);assert.equal(Boolean(row),open);if(open){assert.equal(row.join_mode,'open');assert.equal(row.join_token,null);assert.ok(JSON.parse(row.members_json).every(member=>member.name===null));}return state;}
test('agent creation defaults open, explicit private stays unpublished, and retry preserves saved choices',t=>{
 const f=fixture(t),s=f.store,identity=s.identities.create('Founder'),peer=s.identities.create('Peer'),rooms=new AgentRooms(s);const input=request('open-agent',{starter:false,requestId:'create-agent'});rooms.create(identity.secret,input);check(s,input.roomId,true);
 s.command(identity.secret,input.roomId,{id:'before-join',type:'message.posted',data:{messageId:'before-join',body:'Private history'}});
 const joined=new AccessRequests(s).request(input.roomId,{identityId:peer.identityId,displayName:'Peer',requestedPermissions:[],requestId:'join-open'},peer.secret);assert.equal(joined.status,'approved');assert.equal(s.authenticate(peer.secret,input.roomId).member.historyGuest,true);assert.throws(()=>readConversation(s,peer.secret,input.roomId,{messageId:'before-join'}),e=>e.status===404);
 const keys=s.db.prepare('SELECT count(*) n FROM agent_api_keys').get().n,head=s.headSequence(input.roomId);assert.equal(rooms.create(identity.secret,input).duplicate,true);assert.equal(s.headSequence(input.roomId),head);assert.equal(s.db.prepare('SELECT count(*) n FROM agent_api_keys').get().n,keys);
 rooms.create(identity.secret,request('private-agent',{starter:false,visibility:'private'}));check(s,'private-agent',false);rooms.create(identity.secret,request('private-agent',{starter:false}));check(s,'private-agent',false);
 s.command(identity.secret,input.roomId,{id:'hide-page',type:'room.public_page_set',data:{enabled:false}});rooms.create(identity.secret,input);assert.equal(currentInviteContext(s,input.roomId).room.state.room.publicPage.enabled,false);
 const cold=f.reopen();check(cold,'private-agent',false);assert.equal(new AccessRequests(cold).request(input.roomId,{identityId:peer.identityId,displayName:'Peer',requestedPermissions:[],requestId:'join-open'},peer.secret).status,'approved');assert.equal(auditRecovery(cold).rooms,2);
});
for(const visibility of [undefined,'private'])test('account creation visibility '+String(visibility)+' survives retry and cold open',t=>{
 const f=fixture(t),s=f.store,a=account(s),input=request('account-room',visibility?{visibility}:{});s.room=()=>{throw Error('whole room hydration forbidden');};s.createAccountRoom(a.token,a.binding,input);check(s,input.roomId,!visibility);const head=s.headSequence(input.roomId);assert.equal(s.createAccountRoom(a.token,a.binding,input).duplicate,true);assert.equal(s.headSequence(input.roomId),head);check(f.reopen(),input.roomId,!visibility);
});
for(const visibility of ['private','open'])test('template creation forwards '+visibility+' privacy',t=>{
 const f=fixture(t),s=f.store,a=account(s);const result=applyRoomTemplate(s,a.token,a.binding,{...request('private-template',{visibility}),template:listRoomTemplates()[0].slug});assert.equal(result.room.id,'private-template');check(s,'private-template',visibility==='open');assert.equal(auditRecovery(s).rooms,1);
});
test('publication failure rolls back room, linkage, ownership and credentials',t=>{
 const f=fixture(t),s=f.store,identity=s.identities.create('Founder'),command=s.command.bind(s);s.command=(token,id,input,...rest)=>{if(input.type==='room.join_link_set')throw Error('synthetic publication fault');return command(token,id,input,...rest);};assert.throws(()=>new AgentRooms(s).create(identity.secret,request('failed-open',{starter:false,requestId:'same-request'})),/synthetic publication fault/);for(const table of ['rooms','public_rooms','identity_links','agent_room_ownership','agent_api_keys'])assert.equal(s.db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);s.command=command;new AgentRooms(s).create(identity.secret,request('failed-open',{starter:false,requestId:'same-request'}));check(s,'failed-open',true);
});
test('invalid visibility is refused before creation',t=>{const f=fixture(t),s=f.store,i=s.identities.create('Founder'),a=account(s);assert.throws(()=>new AgentRooms(s).create(i.secret,request('invalid-agent',{visibility:'PUBLIC'})),e=>e.status===422);assert.throws(()=>s.createAccountRoom(a.token,a.binding,request('invalid-account',{visibility:null})),e=>e.status===422);assert.equal(s.db.prepare('SELECT count(*) n FROM rooms').get().n,0);});

test('account publication failure is atomic and exact creation retry succeeds',t=>{
 const f=fixture(t),s=f.store,a=account(s),command=s.command.bind(s),input=request('atomic-account');s.command=(token,id,data,...rest)=>{if(data.type==='room.join_link_set')throw Error('synthetic account publication fault');return command(token,id,data,...rest);};assert.throws(()=>s.createAccountRoom(a.token,a.binding,input),/synthetic account publication fault/);for(const table of ['rooms','public_rooms','member_accounts'])assert.equal(s.db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);s.command=command;s.createAccountRoom(a.token,a.binding,input);check(s,input.roomId,true);
});

test('explicit private create conflicts with a saved public agent room, without changing it',t=>{
 const f=fixture(t),s=f.store,i=s.identities.create('Founder'),rooms=new AgentRooms(s),input=request('visibility-agent',{starter:false,requestId:'visibility-request'});rooms.create(i.secret,input);const head=s.headSequence(input.roomId);assert.throws(()=>rooms.create(i.secret,{...input,visibility:'private'}),e=>e.status===409&&e.code==='request_conflict'&&/owner settings/.test(e.message));const {requestId:_requestId,...byRoom}=input;assert.throws(()=>rooms.create(i.secret,{...byRoom,visibility:'private'}),e=>e.status===409&&e.code==='room_exists');assert.equal(s.headSequence(input.roomId),head);check(s,input.roomId,true);s.command(i.secret,input.roomId,{id:'owner-private',type:'room.public_page_set',data:{enabled:false}});const privateHead=s.headSequence(input.roomId);assert.equal(rooms.create(i.secret,input).duplicate,true);assert.equal(rooms.create(i.secret,{...input,visibility:'private'}).duplicate,true);assert.equal(s.headSequence(input.roomId),privateHead);assert.equal(currentInviteContext(s,input.roomId).room.state.room.publicPage.enabled,false);assert.equal(s.db.prepare('SELECT 1 FROM public_rooms WHERE slug=?').get(input.roomId),undefined);
});
test('explicit private create conflicts with saved public account room and owner private switch survives original retry',t=>{
 const f=fixture(t),s=f.store,a=account(s),input=request('visibility-account');s.createAccountRoom(a.token,a.binding,input);const head=s.headSequence(input.roomId);assert.throws(()=>s.createAccountRoom(a.token,a.binding,{...input,visibility:'private'}),e=>e.status===409&&e.code==='room_exists'&&/owner settings/.test(e.message));assert.equal(s.headSequence(input.roomId),head);check(s,input.roomId,true);s.command(a.token,input.roomId,{id:'owner-private',type:'room.public_page_set',data:{enabled:false}},a.binding);const privateHead=s.headSequence(input.roomId);assert.equal(s.createAccountRoom(a.token,a.binding,input).duplicate,true);assert.equal(s.createAccountRoom(a.token,a.binding,{...input,visibility:'private'}).duplicate,true);assert.equal(s.headSequence(input.roomId),privateHead);assert.equal(currentInviteContext(s,input.roomId).room.state.room.publicPage.enabled,false);assert.equal(s.db.prepare('SELECT 1 FROM public_rooms WHERE slug=?').get(input.roomId),undefined);
});
