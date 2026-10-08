// Primary real HTTP owner: authored evidence, persistence, revisions and privacy.
// These contracts have no prior owner; helpers only create real room commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomStore } from '../server/store.mjs';
import { textVersion } from '../server/text-results.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
async function setup(t){
 const f=createAcceptanceFixture(),server=createRoomServer({store:f.store});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const api=async(actor,input=null,query='',expected=200)=>{
  const res=await fetch(`${origin}/api/rooms/commons/work-fit${query}`,{method:input?'POST':'GET',headers:{authorization:`Bearer ${f.keys[actor]}`,...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify({requestId:randomUUID(),...input})}:{})});
  const body=await res.json();assert.equal(res.status,expected,JSON.stringify(body));return body;
 };
 const send=(actor,type,data)=>f.store.command(f.keys[actor],'commons',{id:randomUUID(),type,data});
 function complete(name,producerId='producer',sourceMessageId){
  send('owner','work.proposed',{workItemId:name,title:name,definitionOfDone:'Saved text',accountableMemberId:'producer',mode:'read',independentVerificationRequired:false,ownerDecisionRequired:false,...(sourceMessageId?{sourceMessageId}:{})});
  send('producer','work.accepted',{workItemId:name,expectedRevision:0});
  const post=send('producer','message.posted',{messageId:`result-${name}`,workItemId:name,body:`Result of ${name}`});
  const done=send('producer','work.completed',{workItemId:name,expectedRevision:1,evidenceKind:'room_text',evidenceMessageId:post.event.data.messageId,evidenceMessageEventId:post.event.id,evidenceVersion:textVersion(post.event.data.body),previousCompletionEventId:null,summary:'Saved',nextAction:'Review',producerId});
  return {sourceEventId:done.event.id,messageId:post.event.data.messageId,workItemId:name};
 }
 const observation=source=>({action:'record_observation',subjectMemberId:'producer',configurationId:null,category:'browser_native_qa',role:'producer',...source,expectedResult:'Flow works',reportedResult:'Caught a stale response',outcome:'met_expectation'});
 return {f,api,send,complete,observation,origin,server};
}
test('unknown workers remain eligible; preferences and configuration persist without changing room authority',async t=>{
 const {f,api,origin}=await setup(t),before=f.store.room('commons');
 const unknown=await api('producer');assert.equal(unknown.caseCount,0);assert.deepEqual(unknown.strengths,[]);
 const input={action:'update_self',requestId:'prefs-once',expectedRevision:0,preferences:{learn:['human_ui_ux']},configuration:{model:'declared model',runtime:'browser',tools:null}};
 const receipt=await api('producer',input);assert.deepEqual(await api('producer',input),receipt);
 await api('producer',{...input,preferences:{learn:[]}},'',409);
 await api('producer',{...input,requestId:'stale'},'',409);
 const client=new RoomAgentClient({origin,roomId:'commons',token:f.keys.producer});
 const profile=await client.readWorkFit();assert.equal(profile.selfRevision,1);assert.equal(profile.configuration.declared,true);assert.deepEqual(profile.preferences.learn,['human_ui_ux']);
 const pack=await client.activationPack();assert.deepEqual(pack.workFit.preferences,profile.preferences);
 assert.deepEqual(f.store.room('commons'),before);
 f.store.workFit.verify();auditRecovery(f.store);
 f.store.close();f.store=new RoomStore(join(f.directory,'room.sqlite'));
 assert.deepEqual(f.store.workFit.read('commons',{},()=>f.store.authenticate(f.keys.producer,'commons')).configuration,profile.configuration);
});
test('actual producer credit, repeated reviews, supported advice and changed assessment basis',async t=>{
 const {f,api,complete,observation}=await setup(t),s=complete('case-a');delete s.messageId;
 const first=await api('owner',observation(s));await api('reviewer',{...observation(s),reportedResult:'Independently inspected the same contribution'});
 let p=await api('producer',null,'?detail=evidence');assert.equal(p.caseCount,1);assert.equal(p.observations.length,2);
 const assessment={action:'update_assessment',subjectMemberId:'producer',expectedRevision:0,configurationId:null,category:'browser_native_qa',role:'producer',tendency:'good_fit',advice:'Useful at source-bound browser checks',caseIds:[first.eventId]};
 await api('owner',assessment);
 p=await api('producer',null,'?workItemId=case-a&categories=browser_native_qa');assert.equal(p.fit.status,'unknown');assert.equal(p.fit.advisory,true);
 await api('reviewer',assessment,'',403);
 await api('producer',{...observation(s),subjectMemberId:'owner'},'',403);
 await api('owner',{action:'amend_observation',subjectMemberId:'producer',observationId:first.eventId,expectedObservationRevision:0,reportedResult:'Finding was overturned',outcome:'not_evaluated',reason:'Actual runtime disproved it'});
 p=await api('producer',null,'?detail=evidence');assert.equal(p.strengths.length,0);assert.equal(p.observations[0].corrections[0].reason,'Actual runtime disproved it');
 await api('owner',{action:'amend_observation',subjectMemberId:'producer',observationId:first.eventId,expectedObservationRevision:0,reportedResult:'Stale edit',outcome:'needed_repair',reason:'old'},'',409);
 assert.equal(f.store.room('commons').state.workItems['case-a'].state,'completed');f.store.workFit.verify();
});
test('changing the declared configuration stops applying old task advice while preserving scoped evidence',async t=>{
 const {api,complete,observation}=await setup(t);
 await api('producer',{action:'update_self',expectedRevision:0,preferences:{},configuration:{model:'Model A',runtime:'runtime A',tools:null}});
 const first=(await api('producer')).configuration.id,s=complete('configuration-case');delete s.messageId;
 const r=await api('owner',{...observation(s),configurationId:first});
 await api('owner',{action:'update_assessment',subjectMemberId:'producer',expectedRevision:0,configurationId:first,category:'browser_native_qa',role:'producer',tendency:'good_fit',advice:'Supported for this configuration',caseIds:[r.eventId]});
 const query='?workItemId=configuration-case&categories=browser_native_qa';
 assert.equal((await api('producer',null,query)).fit.status,'good_fit');
 assert.equal((await api('producer',null,query+'&role=reviewer')).fit.status,'unknown');
 await api('producer',null,'?role=reviewer',422);
 await api('producer',{action:'update_self',expectedRevision:1,preferences:{},configuration:{model:'Model B',runtime:'runtime B',tools:null}});
 const changed=await api('producer',null,query);
 assert.equal(changed.fit.status,'unknown');assert.equal(changed.strengths[0].currentConfiguration,false);
 assert.equal(changed.strengths[0].configurationScope.model,'Model A');
 const evidence=await api('producer',null,'?detail=evidence');assert.equal(evidence.observations[0].configurationId,first);assert.equal(evidence.configurations.length,2);
});
test('disputes suppress advice, subject resolution restores it, unknown producer cannot be guessed',async t=>{
 const {api,complete,observation}=await setup(t),s=complete('case-b');delete s.messageId;
 const r=await api('owner',observation(s));
 await api('owner',{action:'update_assessment',subjectMemberId:'producer',expectedRevision:0,configurationId:null,category:'browser_native_qa',role:'producer',tendency:'needs_support',advice:'Pair for native qualification',caseIds:[r.eventId]});
 await api('producer',{action:'respond_observation',subjectMemberId:'producer',observationId:r.eventId,response:'This was a provider outage',stance:'dispute'});
 assert.equal((await api('owner',null,'?memberId=producer')).support.length,0);
 await api('producer',{action:'respond_observation',subjectMemberId:'producer',observationId:r.eventId,response:'Scope clarified',stance:'resolved'});
 assert.equal((await api('owner',null,'?memberId=producer')).support.length,1);
 const u=complete('unknown-producer',null);delete u.messageId;await api('owner',observation(u),'',403);
});
test('deleted result evidence removes text, cases, assessment and cursor without leaking old retry bodies',async t=>{
 const {api,send,complete,observation}=await setup(t),s=complete('case-private');const messageId=s.messageId;delete s.messageId;
 const input={...observation(s),requestId:'visible-then-deleted',reportedResult:'PRIVATE-CASE-SENTINEL'},r=await api('owner',input);
 await api('owner',{action:'update_assessment',subjectMemberId:'producer',expectedRevision:0,configurationId:null,category:'browser_native_qa',role:'producer',tendency:'good_fit',advice:'PRIVATE-ADVICE-SENTINEL',caseIds:[r.eventId]});
 send('producer','message.deleted',{messageId,expectedMessageRevision:0});
 const p=await api('owner',null,'?memberId=producer&detail=evidence');assert.equal(p.caseCount,0);assert.deepEqual(p.observations,[]);assert.deepEqual(p.strengths,[]);assert.ok(!JSON.stringify(p).includes('SENTINEL'));
 const retry=await api('owner',input);assert.deepEqual(retry,r);assert.ok(!JSON.stringify(retry).includes('SENTINEL'));
 await api('owner',null,`?memberId=producer&detail=evidence&cursor=${r.eventId}`,409);
});
test('malformed/forged inputs and invalid queries fail before any journal commit; append writes do not share an edit revision',async t=>{
 const {f,api,complete,observation}=await setup(t),s=complete('case-c');delete s.messageId;
 const input=observation(s);
 await api('owner',{...input,actorMemberId:'producer'},'',422);
 await api('owner',{...input,sourceEventId:'wrong'},'',403);
 await api('owner',{...input,configurationId:'unknown-config'},'',422);
 await api('owner',null,'?categories=browser_native_qa',422);
 await api('owner',null,'?detail=evidence&detail=summary',422);
 assert.equal((await api('producer')).caseCount,0);
 await Promise.all([api('owner',{...input,environmentLimit:'CI queue'}),api('reviewer',{...input,outcome:'not_evaluated'})]);
 const p=await api('producer',null,'?detail=evidence');assert.equal(p.caseCount,1);assert.equal(p.observations.length,2);assert.deepEqual(p.strengths,[]);f.store.workFit.verify();
});
test('account deletion removes authored coaching text but preserves another worker preferences and unrelated cases',async t=>{
 const {f,api,complete,observation}=await setup(t),s=complete('deletion-case');delete s.messageId;
 await api('producer',{action:'update_self',expectedRevision:0,preferences:{learn:['backend_contracts']}});
 const r=await api('guest',{...observation(s),reportedResult:'DELETED-AUTHOR-SENTINEL'});await api('reviewer',observation(s));
 await api('guest',{action:'update_self',expectedRevision:0,preferences:{learn:['research_writing']}});
 const {planAccountDeletion,executeAccountDeletion}=await import('../server/account-deletion.mjs');
 const account=f.store.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='commons' AND member_id='guest'").get().account_id;
 const plan=planAccountDeletion(f.store,account).plan;assert.ok(plan.steps.some(s=>s.category==='work_fit' && s.action==='purge'));
 executeAccountDeletion(f.store,plan);
 const p=await api('producer',null,'?detail=evidence');assert.deepEqual(p.preferences.learn,['backend_contracts']);assert.equal(p.observations.length,1);assert.equal(p.observations[0].actorMemberId,'reviewer');
 const row=f.store.db.prepare('SELECT input,value FROM agent_work_fit_events WHERE event_id=?').get(r.eventId);assert.ok(!JSON.stringify(row).includes('DELETED-AUTHOR-SENTINEL'));f.store.workFit.verify();
});
test('credentials revoked during an incomplete HTTP body cannot commit a work-fit mutation',async t=>{
 const {f,origin,server}=await setup(t),{request}=await import('node:http');
 const input=JSON.stringify({action:'update_self',requestId:'held-auth',expectedRevision:0,preferences:{learn:['research_writing']}});
 let started;const reading=new Promise(r=>started=r);server.once('request',req=>req.once('data',started));
 let write;const response=new Promise((resolve,reject)=>{
  write=request(`${origin}/api/rooms/commons/work-fit`,{method:'POST',headers:{Authorization:`Bearer ${f.keys.producer}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(input)}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});write.on('error',reject);write.write(input.slice(0,20));
 });
 await reading;f.store.revoke(f.keys.producer);write.end(input.slice(20));
 const actual=await response;assert.equal(actual.status,401,JSON.stringify(actual.body));assert.equal(f.store.workFit.profile('commons','producer').selfRevision,0);f.store.workFit.verify();
});
test('since-join readers receive no old evidence text, assessment or counts; mutation receipts expose no journal counts',async t=>{
 const {f,api,send,complete,observation}=await setup(t),s=complete('old-history');delete s.messageId;
 const r=await api('owner',{...observation(s),reportedResult:'OLD-HISTORY-SENTINEL'});
 assert.equal(Object.hasOwn(r,'revision'),false);
 await api('owner',{action:'update_assessment',subjectMemberId:'producer',expectedRevision:0,configurationId:null,category:'browser_native_qa',role:'producer',tendency:'good_fit',advice:'OLD-ADVICE-SENTINEL',caseIds:[r.eventId]});
 send('owner','room.history_visibility_set',{historyVisibility:'since_join'});
 send('owner','member.added',{memberId:'new-reader',displayName:'New reader',kind:'human',permissions:[]});f.keys.newReader=f.store.issueAccessKey('commons','new-reader');
 const p=await api('newReader',null,'?memberId=producer&detail=evidence');assert.equal(p.caseCount,0);assert.equal(p.assessmentCount,0);assert.deepEqual(p.observations,[]);assert.ok(!JSON.stringify(p).includes('SENTINEL'));
 await api('newReader',observation(s),'',403);
});
