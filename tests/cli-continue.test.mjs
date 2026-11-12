import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { continueCommand } from '../cli/commands/continue.mjs';
import { createWorkBrief } from '../client/work-brief.mjs';
import { createWorkContinuation, workContinuationMarkdown } from '../src/work-continuation.js';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { rmSync } from 'node:fs';

test('continuation reads authenticated selected work without writes; revocation denies export',async t=>{
 const store=new RoomStore(':memory:');store.initialize(initialRoom());
 const token=store.issueAccessKey('commons','owner');
 store.command(token,'commons',{id:'propose',type:'work.proposed',data:{workItemId:'one',title:'Selected work',definitionOfDone:'Preserve current state',mode:'read',accountableMemberId:'owner'}});
 const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
 const conn={origin:`http://127.0.0.1:${server.address().port}`,roomId:'commons',secret:token};
 const methods=[];let outputs=[];
 const io={connection:async()=>conn,out:s=>outputs.push(s),fetchImpl:(url,options)=>{methods.push(options?.method??'GET');return fetch(url,options);}};
 await continueCommand(['one'],io);const value=JSON.parse(outputs[0]);
 assert.equal(value.sections.objective.title,'Selected work');assert.equal(value.scope.roomId,'commons');
 assert.equal(value.sections.authority.assignment.accountableMemberId,'owner');
 assert.equal(value.sections.evidence.externalEvidenceRetrieved,false);assert.equal(value.sections.evidence.verificationStatus,'unknown');
 assert.equal(outputs[0].includes(token),false);assert.equal(Object.hasOwn(value.scope,'viewerSessionBinding'),false);
 const context=store.workContext(token,'commons','one',{includeSource:false});
 const expected=createWorkContinuation(await createWorkBrief(context));
 assert.deepEqual(value.sections,expected.sections);
 outputs=[];await continueCommand(['one','--markdown'],io);
 assert.ok(outputs[0].startsWith('# Work continuation'));assert.ok(outputs[0].includes('Selected work'));
 assert.ok(methods.every(m=>m==='GET'));
 store.revoke(token);outputs=[];await assert.rejects(()=>continueCommand(['one'],io));assert.deepEqual(outputs,[]);
});

test('renderer distinguishes claimed and stale verification and validates scope and size',()=>{
 const brief={contractVersion:1,scope:{roomId:'room',workItemId:'work',viewerId:'viewer',viewerSessionBinding:'secret'},version:'a'.repeat(64),observed:{workRevision:3,evaluatedThrough:5},sections:{objective:{title:'<script>\n# override\n```'},progress:{},evidence:{receipt:{eventId:'current',evidenceVersion:'head2'},verification:{result:'pass',completionEventId:'old',evidenceVersion:'head1'}}},nextReads:[{tool:'room_read_work',arguments:{roomId:'room',workItemId:'work'}}],omitted:[]};
 const value=createWorkContinuation(brief);assert.equal(value.sections.evidence.verificationStatus,'stale_or_unmatched');
 const md=workContinuationMarkdown(value);assert.equal(md.includes('\n# override'),false);assert.equal(md.includes('secret'),false);
 brief.sections.evidence.verification={result:'pass',completionEventId:'current',evidenceVersion:'head2'};
 assert.equal(createWorkContinuation(brief).sections.evidence.verificationStatus,'recorded_pass_for_current_result');
 brief.sections.evidence.receipt={};brief.sections.evidence.verification={result:'pass'};
 assert.equal(createWorkContinuation(brief).sections.evidence.verificationStatus,'stale_or_unmatched');
 brief.nextReads[0].arguments.roomId='other';assert.throws(()=>createWorkContinuation(brief),/different scope/);
 brief.nextReads=[];brief.sections.objective.title='x'.repeat(40000);assert.throws(()=>createWorkContinuation(brief),/32 KiB/);
});

test('invalid CLI input fails before connection resolution',async()=>{
 let connected=false;const io={connection:()=>{connected=true;throw Error('unexpected');}};
 await assert.rejects(()=>continueCommand(['one','--write'],io),/Use room continue/);
 await assert.rejects(()=>continueCommand(['../escape'],io),/Use room continue/);
 assert.equal(connected,false);
});

test('saved agent identity cannot be substituted by a different accepted credential',async t=>{
 const f=createAcceptanceFixture(),server=createRoomServer({store:f.store});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const base={origin:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'producer'};
 let output=[];
 const io={connection:async()=>({...base,secret:f.keys.producer}),out:s=>output.push(s)};
 await continueCommand(['test-handoff'],io);
 assert.equal(JSON.parse(output[0]).scope.viewerId,'producer');
 output=[];
 await assert.rejects(()=>continueCommand(['test-handoff'],{...io,connection:async()=>({...base,secret:f.keys.owner})}),/configured agent|identity|member/i);
 assert.deepEqual(output,[],'a mismatched identity never produces continuation text');
});
