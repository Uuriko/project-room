import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { OutsideAgents } from '../server/outside-agents.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { messageRepository } from '../server/message-repository.mjs';

function setup(t) {
 const s=new RoomStore(':memory:');s.initialize(initialRoom());s.roomFlood={consume(){}};t.after(()=>s.close());
 const token=s.issueAccessKey('commons','owner');
 const command=(type,data)=>s.command(token,'commons',{id:randomUUID(),type,data});
 const post=(id,body,extra={})=>command('message.posted',{messageId:id,body,...extra});
 const certify=()=>{while(!s.backfillMessages({limit:1000}).done){}assert.equal(s.checkMessagesParity().ok,true);};
 return {s,token,command,post,certify,repo:()=>messageRepository(s,'commons')};
}

test('ordered repository scans merge archive and retained exceptions across multiple pages',t=>{
 const f=setup(t);
 for(let i=0;i<270;i++)f.post(`record-${i}`,i%10===0?`typed.v1\n${i}`:`Text ${i}`);
 f.command('message.pinned',{messageId:'record-3'});
 const before=[...f.repo().records()];const ids=before.map(m=>m.id);
 const first=f.repo().firstPostedAtByAuthor();f.certify();
 assert.equal(f.s.archiveMessages('commons',{keepNewest:3,dryRun:false}).ok,true);
 const repo=f.repo();
 assert.deepEqual([...repo.records()].map(m=>m.id),ids);
 assert.deepEqual([...repo.records({descending:true})].map(m=>m.id),[...ids].reverse());
 assert.deepEqual([...repo.records({bodyPrefix:'typed.v1\n'})].map(m=>m.id),before.filter(m=>m.body?.startsWith('typed.v1\n')).map(m=>m.id));
 assert.deepEqual(repo.recent(40,m=>Number(m.id.split('-')[1])%2===0).map(m=>m.id),before.filter(m=>Number(m.id.split('-')[1])%2===0).slice(-40).map(m=>m.id));
 assert.deepEqual(repo.firstPostedAtByAuthor(),first);
 assert.deepEqual(repo.recent(0),[]);assert.throws(()=>repo.recent(1001),RangeError);
});

test('outside-agent identity facts and idempotency survive message compaction',t=>{
 const f=setup(t);
 f.s.outsideAgents=new OutsideAgents(f.s);
 const input={externalRef:'remote-agent',displayName:'Remote agent',origin:'host'};
 f.s.outsideAgents.record(f.token,'commons',input);
 for(let i=0;i<12;i++)f.post(`tail-${i}`,'Settled public record.');
 f.certify();const before=f.s.outsideAgents.list(f.token,'commons');
 assert.equal(f.s.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);
 assert.deepEqual(f.s.outsideAgents.list(f.token,'commons'),before);
 const head=f.s.headSequence('commons');
 assert.equal(f.s.outsideAgents.record(f.token,'commons',input).recorded,'replay');
 assert.equal(f.s.headSequence('commons'),head);
});

test('assistant requests remain visible and controllable when their source leaves the working set',async t=>{
 const { RoomAssistant }=await import('../server/room-assistant.mjs');
 const f=setup(t);const assistant=new RoomAssistant(f.s);
 f.command('member.added',{memberId:'worker',displayName:'Worker',kind:'agent',permissions:['accept_work']});
 const authorize=()=>f.s.authenticate(f.token,'commons');
 const apply=input=>assistant.apply('commons',{requestId:randomUUID(),...input},authorize,f.token);
 apply({action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'worker'});
 f.post('assistant-source','A settled request.');
 apply({action:'invoke',runId:'archived-run',sourceMessageId:'assistant-source'});
 for(let i=0;i<12;i++)f.post(`assistant-tail-${i}`,'Unrelated settled record.');
 f.certify();const before=assistant.list('commons',authorize);
 assert.equal(f.s.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);
 assert.equal(f.s.room('commons').state.messages.some(m=>m.id==='assistant-source'),false);
 assert.deepEqual(assistant.list('commons',authorize),before);
 assert.equal(apply({action:'pause',runId:'archived-run',expectedRevision:0}).result.status,'paused');
});
