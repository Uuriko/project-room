import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {publicRoomView,PUBLIC_ROOM_SETUP_CSP} from '../server/public-rooms.mjs';
function fixture(t,model=true){const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom('public-test'),{representation:'normalized-current-v1'});const key=s.issueAccessKey('public-test','owner');s.command(key,'public-test',{id:'publish',type:'room.public_page_set',data:{enabled:true}});const page=publicRoomView(s,'public-test');const script=page.html.match(/<script>([\s\S]*?)<\/script>/)[1];const registered=[];let calls=[];const elements={'copy-room-setup':{addEventListener(){}},'room-setup-prompt':{},'room-setup-copy-status':{}};const doc={getElementById:id=>elements[id],...(model?{modelContext:{registerTool:x=>registered.push(x)}}:{})};const context={document:doc,location:{origin:'https://example.test',pathname:'/r/public-test',search:'?ref=ignore'},URL,URLSearchParams,Promise,fetch:async(url,opts)=>{calls.push({url:String(url),opts});const after=new URL(url).searchParams.get('workAfter')||'';const v=publicRoomView(s,'public-test',{workAfter:after});return v?{ok:true,json:async()=>({...v.document,secret:'not exported'})}:{ok:false,status:404}}};runInNewContext(script,context);return{s,key,script,registered,calls};}
test('registers a current public read tool with matching CSP and no credentials',async t=>{const f=fixture(t);assert.equal(f.registered.length,1);const tool=f.registered[0];assert.equal(tool.name,'get_public_room');assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.untrustedContentHint,true);assert.ok(PUBLIC_ROOM_SETUP_CSP.includes("'sha256-"+createHash('sha256').update(f.script).digest('base64')+"'"));assert.match(PUBLIC_ROOM_SETUP_CSP,/connect-src 'self'/);const result=await tool.execute({});assert.equal(result.title,'Project Room Commons');assert.equal(result.untrusted,true);assert.equal(result.secret,undefined);assert.equal(f.calls[0].url,'https://example.test/r/public-test.json');assert.equal(f.calls[0].opts.credentials,'omit');assert.equal(f.calls[0].opts.cache,'no-store');assert.equal(f.calls[0].opts.redirect,'error');});
test('a previously discovered tool does not return stale content after owner unpublishes',async t=>{const f=fixture(t);await f.registered[0].execute({});f.s.command(f.key,'public-test',{id:'unpublish',type:'room.public_page_set',data:{enabled:false}});const result=await f.registered[0].execute({});assert.equal(result.error,'public_room_unavailable');assert.equal(result.tasks,undefined);});
test('unsupported browsers keep the normal page without a tool',t=>{const f=fixture(t,false);assert.equal(f.registered.length,0);});

test('a synchronous WebMCP registration failure does not break the page script',t=>{
 const f=fixture(t,false),elements={'copy-room-setup':{addEventListener(){}},'room-setup-prompt':{},'room-setup-copy-status':{}};
 const context={document:{getElementById:id=>elements[id],modelContext:{registerTool(){throw new Error('registration unavailable');}}},Promise};
 assert.doesNotThrow(()=>runInNewContext(f.script,context));
});
test('a rejected WebMCP registration does not break the page script',async t=>{
 const f=fixture(t,false),elements={'copy-room-setup':{addEventListener(){}},'room-setup-prompt':{},'room-setup-copy-status':{}};
 const context={document:{getElementById:id=>elements[id],modelContext:{registerTool(){return Promise.reject(new Error('registration unavailable'));}}},Promise};
 assert.doesNotThrow(()=>runInNewContext(f.script,context));
 await new Promise(resolve=>setImmediate(resolve));
});
test('an incompatible public response returns an actionable tool error',async t=>{
 const f=fixture(t,false),registered=[],elements={'copy-room-setup':{addEventListener(){}},'room-setup-prompt':{},'room-setup-copy-status':{}};
 const context={document:{getElementById:id=>elements[id],modelContext:{registerTool:x=>registered.push(x)}},location:{origin:'https://example.test',pathname:'/r/public-test',search:''},URL,URLSearchParams,Promise,fetch:async()=>({ok:true,json:async()=>({schema:'unknown'})})};
 runInNewContext(f.script,context);
 const result=await registered[0].execute({});assert.equal(result.error,'unexpected_public_room_response');assert.match(result.message,/Try again/);
});

test('join guidance follows current owner admission without exposing a token',async t=>{
 const f=fixture(t),tool=f.registered[0];
 const before=await tool.execute({});assert.equal(before.roomId,'public-test');assert.equal(before.admission,'approval_required');assert.equal(before.joinAction,null);assert.equal(before.executionGranted,false);
 f.s.command(f.key,'public-test',{id:'open-join',type:'room.join_link_set',data:{enabled:true}});
 const open=await tool.execute({});assert.equal(open.admission,'open');assert.equal(open.joinAction.tool,'room_join');assert.equal(open.joinAction.arguments.roomId,'public-test');assert.equal(open.executionGranted,false);
 f.s.command(f.key,'public-test',{id:'close-join',type:'room.join_link_set',data:{enabled:false}});
 const closed=await tool.execute({});assert.equal(closed.admission,'approval_required');assert.equal(closed.joinAction,null);assert.equal(JSON.stringify(closed).includes('/#join/'),false);
});

test('tool forwards cancellation to the public fetch',async t=>{const f=fixture(t),controller=new AbortController();await f.registered[0].execute({}, {signal:controller.signal});assert.equal(f.calls[0].opts.signal,controller.signal);});

test('cancelling an in-flight public read closes its network request',async t=>{
 const f=fixture(t);let arrived,closed;
 const requestArrived=new Promise(resolve=>{arrived=resolve;});
 const requestClosed=new Promise(resolve=>{closed=resolve;});
 const server=createServer((_req,res)=>{res.on('close',closed);arrived();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const registered=[],elements={'copy-room-setup':{addEventListener(){}},'room-setup-prompt':{},'room-setup-copy-status':{}};
 const context={document:{getElementById:id=>elements[id],modelContext:{registerTool:x=>registered.push(x)}},location:{origin:`http://127.0.0.1:${server.address().port}`,pathname:'/r/public-test',search:''},URL,URLSearchParams,Promise,fetch};
 runInNewContext(f.script,context);
 const controller=new AbortController(),pending=registered[0].execute({}, {signal:controller.signal});
 await requestArrived;controller.abort();
 await assert.rejects(pending,error=>error.name==='AbortError');
 await requestClosed;
});

test('WebMCP cursor pages return all published tasks and no private tasks',async t=>{const f=fixture(t);for(let i=0;i<7;i++){for(const visibility of ['public','private']){const id=visibility+'-'+i;f.s.command(f.key,'public-test',{id:'propose-'+id,type:'work.proposed',data:{workItemId:id,title:id,definitionOfDone:'task',accountableMemberId:'owner',mode:'read',ownerDecisionRequired:false,independentVerificationRequired:false}});if(visibility==='public')f.s.command(f.key,'public-test',{id:'publish-'+id,type:'work.public_set',data:{workItemId:id,enabled:true}});}}const tool=f.registered[0],ids=[];let after;do{const value=await tool.execute(after?{after}:{});ids.push(...value.tasks.map(x=>x.id));after=value.coverage.tasks.nextAfter;}while(after);assert.deepEqual(ids,Array.from({length:7},(_,i)=>'public-'+i));const invalid=await tool.execute({after:'x'.repeat(2049)});assert.equal(invalid.error,'invalid_cursor');assert.match(invalid.message,/omit after/);});
