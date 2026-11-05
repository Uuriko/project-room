import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {uiText} from '../src/strings.js';
const source=readFileSync(new URL('../src/agent-connections.js',import.meta.url),'utf8'),start=source.indexOf('  const enrollmentKey ='),end=source.indexOf('  existingButton.addEventListener',start);
assert.ok(start>0&&end>start);
function fixture(request,{storage=new Map(),confirm=true}={}){
 const confirmations=[],context=vm.createContext({uiText,crypto,request,storage,confirmChoice:confirm,confirmations});
 vm.runInContext(`
   const owner={account:{id:'john',authEpoch:0},roomId:'target',member:{id:'owner'}};
   let flow=0,busy=false,pending=null,setup=null,existingPending=null,statusText='';
   const member=()=>({revision:0}),owns=()=>true,render=()=>{},load=async()=>{},status=text=>{statusText=text;};
   const existingSelect={value:'a'.repeat(64)},$=()=>({value:'collaborate'});
   const existingChoices=[{choiceId:'a'.repeat(64),sourceRoomId:'source',sourceMemberId:'claude',identityId:'existing-identity',memberId:'claude',displayName:'Existing Claude'}];
   const existingProfiles={collaborate:['steer','accept_work','complete_work','verify']};
   const client={path:value=>'/api/rooms/target'+value,request:(...args)=>request(...args)};
   const sessionStorage={setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)??null,removeItem:k=>storage.delete(k)};
   const window={confirm:text=>{confirmations.push(text);return confirmChoice;}};
   ${source.slice(start,end)}
   globalThis.run=enrollExisting;globalThis.state=()=>({existingPending,statusText,busy});
   globalThis.restore=()=>{existingPending=JSON.parse(sessionStorage.getItem(enrollmentKey())||'null');};
 `,context);
 return {context,storage,confirmations};
}
test('existing-agent UI requires exact owner confirmation and saves an uncertain request before sending',async()=>{
 const storage=new Map(),sent=[];
 const first=fixture(async(path,{data})=>{sent.push(JSON.stringify(data));assert.equal([...storage.values()][0],JSON.stringify(data));throw new TypeError('Connection interrupted');},{storage});
 await first.context.run();assert.equal(first.confirmations.length,1);
 for(const text of ['Existing Claude','existing-identity','target','steer, accept_work, complete_work, verify'])assert.ok(first.confirmations[0].includes(text));
 assert.match(first.context.state().statusText,/not confirmed/);assert.ok(first.context.state().existingPending);
 const resumed=fixture(async(path,{data})=>{sent.push(JSON.stringify(data));return{enrolledExisting:true,identityId:data.identityId,receipt:{roomId:'target',memberId:'claude',requestId:data.requestId}};},{storage});
 resumed.context.restore();await resumed.context.run();assert.equal(resumed.confirmations.length,0);assert.equal(sent[1],sent[0]);
 assert.equal(resumed.context.state().existingPending,null);assert.equal(storage.size,0);assert.match(resumed.context.state().statusText,/OAuth/);
});
test('canceling owner consent performs no enrollment and saves no pending request',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;},{confirm:false});await f.context.run();assert.equal(calls,0);assert.equal(f.storage.size,0);
});
