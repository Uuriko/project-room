import test from 'node:test';import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {readCurrentWorkItem} from '../server/current-room-repository.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
function store(t){const s=new RoomStore(':memory:');t.after(()=>s.close());return s;}
test('account intent creates one native task and duplicate/list preserve title without legacy guide',t=>{
 const s=store(t);s.createAccount('native-owner');const key=s.issueAccountAccessKey('native-owner'),slot=s.createAccountSessionSlot(),session=s.loginAccountSession(slot.token,key,0);
 const args={roomId:'native-account',title:'First task',purpose:'Useful coordinated work',kind:'personal',displayName:'Human owner',intent:'bug'};
 const first=s.createAccountRoom(slot.token,session.sessionBinding,args);assert.equal(first.room.title,'Fix a bug');assert.equal(first.starter.nextRead.arguments.workItemId,'native-starter');
 assert.ok(s.db.prepare("SELECT 1 FROM current_room_head WHERE room_id='native-account'").get());
 assert.equal(readCurrentWorkItem(s.db,'native-account','native-starter').title,'Fix a bug');
 s.room=()=>{throw Error('unexpected whole-room creation read');};
 const again=s.createAccountRoom(slot.token,session.sessionBinding,args);assert.equal(again.duplicate,true);assert.equal(again.room.title,'Fix a bug');
 assert.equal(s.accountRooms(slot.token,session.sessionBinding).rooms[0].title,'Fix a bug');
 assert.equal(s.db.prepare("SELECT count(*) n FROM current_room_records WHERE room_id='native-account' AND domain='workItems'").get().n,1);
 assert.equal(s.db.prepare("SELECT count(*) n FROM work_claims WHERE room_id='native-account'").get().n,0);
 assert.equal(s.db.prepare("SELECT count(*) n FROM current_room_records WHERE room_id='native-account' AND domain='members' AND record_key='room-guide'").get().n,0);
});
test('agent default starter is real accepted native work; retry returns same pointer and listed title',t=>{
 const s=store(t),identity=s.identities.create('Maker'),rooms=new AgentRooms(s);
 const args={roomId:'native-agent',title:'Agent work',purpose:'A useful task',kind:'personal',displayName:'Maker',requestId:'create-native',starter:true};
 const first=rooms.create(identity.secret,args);assert.equal(first.starter.workItemId,'starter');assert.equal(first.starter.state,'accepted');
 assert.ok(first.next.every(action=>!action.path?.includes('work-claims')));
 const start=first.next.find(action=>action.action==='start-work');
 s.command(identity.secret,first.roomId,{...start.body,id:'start-real-native-task'});
 assert.equal(readCurrentWorkItem(s.db,first.roomId,'starter').state,'working');
 s.room=()=>{throw Error('unexpected whole-room creation read');};
 const again=rooms.create(identity.secret,args);assert.equal(again.duplicate,true);assert.equal(again.starter.workItemId,first.starter.workItemId);assert.equal(again.starter.state,'working');
 assert.equal(rooms.list(identity.secret).rooms[0].title,'Agent work');
 assert.equal(s.db.prepare("SELECT count(*) n FROM work_claims WHERE room_id='native-agent'").get().n,0);
});
