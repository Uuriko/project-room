import test from 'node:test';import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';
import {installGuideCommandHook,flushRoomGuide} from '../server/room-guide.mjs';import {generateVapidKeys} from '../server/web-push.mjs';
test('archived queued Guide work is retired before projection load',()=>{
 class QueueStore{command(){return {};}}
 const s=new QueueStore();let archived=false,loads=0;
 s.db={prepare:sql=>({get:()=>sql.includes('archived_at')?{archived_at:archived?'2026-11-02':null}:undefined})};
 s.transaction=fn=>fn();s.room=()=>{loads++;throw Error('pending guide fixture failure');};s.now=()=>0;
 const log=console.error;console.error=()=>{};
 try{installGuideCommandHook(s);s.command('x','r',{});assert.equal(loads,1);archived=true;flushRoomGuide(s);flushRoomGuide(s);assert.equal(loads,1);}finally{console.error=log;}
});
test('pending human push checks archived SQL before loading old room',async()=>{
 const s=new RoomStore(':memory:');try{
 s.initialize(initialRoom());const key=s.issueAccessKey('commons','owner');
 s.command(key,'commons',{id:'add-human',type:'member.added',data:{memberId:'maya',displayName:'Maya',kind:'human',permissions:['steer']}});
 const human=s.issueAccessKey('commons','maya'),keys=await generateVapidKeys();let sent=0,loads=0;
 s.humanPush.configure({vapid:{...keys,subject:'mailto:test@example.com'},fetchImpl:async()=>{sent++;return {status:201};}});
 s.humanPush.save(human,'commons',{endpoint:'https://fcm.googleapis.com/fcm/send/synthetic',expirationTime:null,keys:{p256dh:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'tBHItJI5svbpez7KI4CCXg'}});
 s.command(key,'commons',{id:'push-post',type:'message.posted',data:{messageId:'push-post',body:'@Maya pending'}});
 assert.equal(s.humanPush.inflight.size,1);
 s.command(key,'commons',{id:'archive',type:'room.archived',data:{}});
 s.room=()=>{loads++;throw Error('Old projection hydration forbidden');};
 await s.humanPush.flush();assert.equal(sent,0);assert.equal(loads,0);assert.equal(s.humanPush.inflight.size,0);
 }finally{s.close();}
});
