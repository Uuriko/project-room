import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, randomBytes} from 'node:crypto';
import {startRoom, FAKE_AGENT} from './room-acp-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {PERMISSIONS} from '../src/events.js';
import {join} from '../room-acp/src/join.mjs';
import {RoomClient} from '../room-acp/src/room.mjs';
import {SessionMap} from '../room-acp/src/sessions.mjs';
import {loadConnection} from '../room-acp/src/credentials.mjs';
import {Bridge, mayTalk} from '../room-acp/src/bridge.mjs';
import {parseArgs} from '../room-acp/src/args.mjs';

test('Muse shared invitation joins with full access and survives saved ACP sessions', async t=>{
 const f=await startRoom(t);f.f.store.initialize(initialRoom('muse-room'));
 const key=f.f.store.issueAccessKey('muse-room','owner');
 f.f.store.command(key,'muse-room',{id:randomUUID(),type:'room.development_access_set',data:{enabled:true}});
 const linkToken=randomBytes(32).toString('base64url');
 f.f.store.shareLinks.create(key,'muse-room',{requestId:randomUUID(),linkToken,expiresAt:Date.now()+3600000,maxJoins:1,expectedMemberRevision:0,access:'co_owner'},null,{emailVerificationUnachievable:true});
 const c=await join({link:f.origin+'/#join/'+linkToken,displayName:'Friend agent',env:f.env});
 assert.deepEqual(c.permissions,PERMISSIONS);
 const client=new RoomClient({...c,credential:c.credential});
 assert.equal((await client.room()).state.members[c.memberId].active,true);
 new SessionMap({roomId:c.roomId,hostId:c.hostId,env:f.env}).set('thread','session');
 assert.equal(loadConnection({},f.env).memberId,c.memberId);
 const minted=f.f.store.invites.create(c.credential,'muse-room',{});
 assert.deepEqual(minted.permissions,PERMISSIONS);
 const peer=f.f.store.invites.redeem(minted.code,{displayName:'Next collaborator'});
 assert.equal(f.f.store.talkPolicy(key,'muse-room',peer.memberId).policy,'room');
 assert.doesNotThrow(()=>f.f.store.setTalkPolicy(c.credential,'muse-room',peer.memberId,{policy:'room'}));
 const bridge=new Bridge({connection:c,candidate:{id:'fake',label:'Fake',command:process.execPath,args:[FAKE_AGENT]},env:f.env,waitMs:1000});
 const done=bridge.run();t.after(async()=>{bridge.stop();await done;});
 const waitFor=async check=>{const end=Date.now()+15000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,30));}throw Error('bridge did not respond');};
 await waitFor(()=>bridge.fencingToken);
 f.f.store.command(key,'muse-room',{id:randomUUID(),type:'member.added',data:{memberId:'john',displayName:'John',kind:'human',permissions:PERMISSIONS}});
 const johnKey=f.f.store.issueAccessKey('muse-room','john');

 f.f.store.command(johnKey,'muse-room',{id:randomUUID(),type:'message.posted',data:{messageId:'john-task',body:'@Friend agent please do this task'}});
 await waitFor(()=>bridge.stats.posted>0);
 assert.ok(f.f.store.room('muse-room').state.messages.some(m=>m.authorId===c.memberId && m.body.includes('please do this task')));
 f.f.store.command(peer.identitySecret,'muse-room',{id:randomUUID(),type:'message.posted',data:{messageId:'agent-task',body:'@Friend agent collaborate on the next task'}});
 await waitFor(()=>bridge.stats.posted>1);
 assert.ok(f.f.store.room('muse-room').state.messages.some(m=>m.authorId===c.memberId && m.body.includes('collaborate on the next task')));
});

test('bridge private replies keep their recipient', async t=>{
 const f=await startRoom(t);const c=await join({link:f.invite().link,displayName:'Private coder',env:f.env});
 const root='dm-'+randomUUID();
 f.f.store.command(f.ownerKey,'commons',{id:randomUUID(),type:'message.posted',data:{messageId:root,body:'private task',toMemberId:c.memberId}});
 const client=new RoomClient({...c});
 const result=await client.post({body:'private result',replyToId:root});
 const message=f.messages().find(m=>m.id===result.messageId);
 assert.equal(message.toMemberId,'owner');
});

test('bridge defaults to room participation and retries a temporarily unreadable wake', async()=>{
 assert.equal(parseArgs([]).respondTo,'anyone');
 assert.equal(mayTalk({authorId:'missing',members:{},me:{id:'me'},respondTo:'anyone'}),false);
 const b=new Bridge({connection:{apiBase:'http://localhost',roomId:'muse-room',memberId:'me',hostId:'test'},host:{},persistSessions:false});
 let calls=0;b.room.thread=async()=>{calls++;throw Error('temporary');};
 const wake={signalId:'s1',messageId:'m1',kind:'mention'};
 await assert.rejects(b.accept(wake));await assert.rejects(b.accept(wake));assert.equal(calls,2);
});
