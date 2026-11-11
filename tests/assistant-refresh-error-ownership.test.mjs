import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Execute the production refresh closure with its DOM/transport boundary
// supplied, so polling/error ownership is checked without another browser lane.
const source=readFileSync(new URL('../src/human-experience.js',import.meta.url),'utf8');
const start=source.indexOf('  async function refresh() {');
const end=source.indexOf('  async function invoke(',start);
assert.ok(start>0&&end>start);
function fixture(request){
  const context=vm.createContext({request,Date,document:{hidden:false},uiText:key=>key});
  vm.runInContext(`
    let error='',readError='',projection={assistant:{coordinatorMemberId:'agent',availability:'connected',name:'Room'},runs:[]};
    let reading=false,lastRead=0,roomMoved=true,boundary='same';
    const client={request:(...args)=>request(...args)},human=()=>true,getState=()=>({room:{id:'fresh'}}),key=()=>boundary,path=()=>'/assistant';
    const CLOSED=['done','failed','cancelled'];
    const node={textContent:''},$=()=>node,paint=()=>{if(projection)node.textContent=error||readError;},refreshTranscript=()=>{};
    ${source.slice(start,end)}
    globalThis.run=()=>{roomMoved=true;lastRead=0;return refresh();};
    globalThis.state=()=>({error,readError,display:node.textContent,reading});
    globalThis.writeFailure=value=>{error=value;};
    globalThis.move=()=>{boundary='other';};
    globalThis.noProjection=()=>{projection=null;};
  `,context);
  return context;
}
const healthy=()=>({assistant:{coordinatorMemberId:'agent',availability:'connected',name:'Room'},runs:[]});

test('assistant refresh recovery clears only the owned read failure',async()=>{
  let calls=0;
  const f=fixture(async()=>{if(++calls===1)throw new Error('Temporary read failure');return healthy();});
  await f.run(); assert.equal(f.state().display,'Temporary read failure');
  await f.run(); assert.equal(f.state().display,'');
  assert.equal(f.state().reading,false);
});

test('successful or failed polls do not replace an uncertain write recovery message',async()=>{
  let calls=0;
  const f=fixture(async()=>{if(++calls===1)throw new Error('Temporary read failure');return healthy();});
  f.writeFailure('Assistant request not confirmed. Retry the original request.');
  await f.run(); assert.equal(f.state().display,'Assistant request not confirmed. Retry the original request.');
  await f.run(); assert.equal(f.state().display,'Assistant request not confirmed. Retry the original request.');
});

test('a canceled old-room read cannot publish an error into the new boundary',async()=>{
  let reject;
  const f=fixture(()=>new Promise((_,no)=>{reject=no;}));
  const pending=f.run();f.move();reject(new DOMException('This operation was aborted','AbortError'));await pending;
  assert.equal(f.state().display,'');assert.equal(f.state().error,'');assert.equal(f.state().readError,'');
});

const invokeEnd=source.indexOf("  $('#assistant-retry').onclick",end);
assert.ok(invokeEnd>end);
function invocation(request){
  const context=vm.createContext({request});
  vm.runInContext(`
    const original={action:'invoke',requestId:'persisted-before-send',runId:'ask',sourceMessageId:'opening'};
    let operation=original,rejectedOperation=null,error='',contribution=null,lastRead=1,boundary='same',saved=[];
    const client={request:(...args)=>request(...args)},getState=()=>({room:{id:'fresh'}}),key=()=>boundary,path=()=>'/assistant';
    const paint=()=>{},persistOperation=()=>saved.push(operation),refresh=async()=>{};
    ${source.slice(end,invokeEnd)}
    globalThis.run=()=>invoke();globalThis.state=()=>({operation,rejectedOperation,error,saved});
    globalThis.original=original;
  `,context);
  return context;
}

test('assistant timeout retains the same pending operation for exact recovery; a successful poll cannot discard it',async()=>{
  const requests=[];
  const f=invocation(async(_path,{data})=>{
    requests.push(data);
    if(requests.length===1)throw Object.assign(new Error('The request timed out before confirmation. Please try again.'),{name:'AbortError',code:'request_timeout'});
    return {duplicate:true,result:{id:'ask'}};
  });
  await f.run();assert.equal(f.state().operation,f.original);assert.equal(f.state().rejectedOperation,null);
  assert.match(f.state().error,/not confirmed/);assert.equal(f.state().saved.length,0);
  await f.run();assert.equal(requests[0],requests[1]);assert.equal(requests[1].requestId,'persisted-before-send');
  assert.equal(f.state().operation,null);assert.equal(f.state().error,'');
});

test('a real assistant rejection remains a rejected operation needing explicit review',async()=>{
  const f=invocation(async()=>{throw Object.assign(new Error('The request is stale'),{status:409,code:'revision_conflict'});});
  await f.run();assert.equal(f.state().operation,null);assert.equal(f.state().rejectedOperation,f.original);
  assert.match(f.state().error,/was rejected: The request is stale/);
});


test('an initial assistant read failure remains visible before any projection is loaded',async()=>{
  const f=fixture(async()=>{throw new Error('Service unavailable');});
  f.noProjection();await f.run();assert.equal(f.state().display,'Service unavailable');
});
