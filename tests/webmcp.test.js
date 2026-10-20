import test from 'node:test';
import assert from 'node:assert/strict';
import { installRoomWebMCP } from '../src/webmcp.js';
function fixture({ confirm = async () => true, respond = () => ({}) } = {}) {
  let session = { roomId: 'one', member: { id: 'human' }, authMode: 'account', sessionBinding: 'private-binding', csrf: 'private-csrf' };
  let state = { room: { id: 'one', name: 'First room' }, members: { human: { active: true } } };
  const tools = new Map(), calls = [], signals = [];
  const client = { generation: 1, ownsAccountSession: () => Boolean(session), refresh: async () => {} };
  const document = { modelContext: { registerTool(tool, {signal}) { tools.set(tool.name, tool); signals.push(signal); signal.addEventListener('abort', () => tools.delete(tool.name)); } } };
  const api = installRoomWebMCP({ document, client, getState: () => state, getSession: () => session, confirm,
    fetcher: async (url, options) => { calls.push({url, ...options}); const value=await respond(url, options); return value instanceof Response ? value : Response.json(value); } });
  api.sync();
  return {api, tools, calls, signals, client, run: (name, args = {}, options = {}) => tools.get(name).execute(args, options),
    switchRoom() { session = {...session, roomId: 'two', member: {id: 'other'}}; state = {room: {id:'two', name:'Second'}, members: {other:{active:true}}}; client.generation++; api.sync(); },
    logout() {session = null; api.sync();} };
}
test('seven byte-identical definitions across users/rooms; teardown aborts old registration', () => {
  const f=fixture(), definitions=()=>JSON.stringify([...f.tools.values()].map(({execute,...tool})=>tool));
  assert.equal(f.tools.size,7); const first=definitions(), old=f.signals[0]; f.switchRoom(); assert.equal(definitions(),first); assert.equal(old.aborted,true); f.logout(); assert.equal(f.tools.size,0);
});
test('unsupported browser does not read session or alter UI',()=>{
  const api=installRoomWebMCP({document:{}, getSession(){throw Error('must not run');}});api.sync();api.stop();
});
test('read and search preserve server cursors and search kind past 50',async()=>{
  let count=0;const f=fixture({respond:()=>({messages:[{id:`m${++count}`,authorId:'human',body:'match'}],total:70,nextCursor:`page-${count}`})});
  await f.run('room_read',{cursor:'older',limit:2});
  assert.equal(new URL(f.calls[0].url,'https://room.test').searchParams.get('cursor'),'older');
  let cursor;for(let i=0;i<14;i++){const r=await f.run('room_search',{query:'match',limit:5,...(cursor?{cursor}: {})});cursor=r.nextCursor;assert.equal(r.total,70);}
  assert.match(f.calls.at(-1).url,/before=page-14/);assert.match(f.calls.at(-1).url,/kind=messages/);
});
test('claims listing reads Board endpoint, not legacy work projection',async()=>{
  const f=fixture({respond:()=>({claims:[{id:'starter',title:'Start',state:'unclaimed',owner:null}],nextCursor:'next'})});
  const r=await f.run('room_list_work',{cursor:'previous'});assert.equal(r.claims[0].id,'starter');assert.equal(r.nextCursor,'next');assert.match(f.calls[0].url,/work-claims\?limit=5&cursor=previous/);
});
test('post waits for confirmation; cancel has no request; successful post uses human session only',async()=>{
  let accept;const f=fixture({confirm:()=>new Promise(resolve=>{accept=resolve;})});
  const pending=f.run('room_post',{body:'Exact text'});await Promise.resolve();assert.equal(f.calls.length,0);
  assert.equal((await f.run('room_post',{body:'Other'})).code,'confirmation_pending');accept(false);assert.equal((await pending).status,'cancelled');assert.equal(f.calls.length,0);
  const second=f.run('room_post',{body:'Exact text'});await Promise.resolve();accept(true);assert.equal((await second).status,'recorded');
  assert.equal(f.calls.length,1);const call=f.calls[0];assert.equal(call.method,'POST');assert.equal(call.headers['X-Session-Binding'],'private-binding');assert.equal(JSON.parse(call.body).data.body,'Exact text');
});
for(const name of ['room_claim','room_release'])test(`${name} uses Board route and release round fence`,async()=>{
  const f=fixture({respond:()=>({id:'task',title:'Task',owner:'human',claimedAt:'round',history:[{}],historyOmitted:3})});
  assert.equal((await f.run(name,{id:'task'})).status,'recorded');assert.equal(f.calls[0].method,'GET');assert.match(f.calls[1].url,new RegExp('/work-claims/task/'+(name==='room_claim'?'claim':'release')+'$'));
  if(name==='room_release')assert.deepEqual(JSON.parse(f.calls[1].body),{expectedClaimedAt:'round',expectedHistoryLength:4});
});
for (const owner of ['another-member', null, undefined]) test(`release refuses a claim not owned by the signed-in user (${owner})`,async()=>{
  let confirmations=0;
  const f=fixture({confirm:async()=>{confirmations++;return true;},respond:()=>({id:'task',title:'Task',owner,claimedAt:'round',history:[{}]})});
  assert.equal((await f.run('room_release',{id:'task'})).code,'not_claim_owner');
  assert.equal(confirmations,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
});
test('batch maps message/file reads and supports excerpt continuation',async()=>{
  const f=fixture({respond:url=>url.includes('/files/')?{attachment:{id:'f',state:'committed',mimeType:'text/plain',data:btoa('file body')}}:{messages:[{id:'m',body:'message body'}]}});
  const r=await f.run('room_read_many',{items:[{kind:'message',id:'m',offset:8},{kind:'file',id:'f'}]});assert.equal(r.items[0].text,'body');assert.equal(r.items[1].text,'file body');assert.match(f.calls[0].url,/messageId=m/);assert.match(f.calls[1].url,/files\/f/);
});
test('room switch while confirmation awaits cannot write into either room',async()=>{
  let accept;const f=fixture({confirm:()=>new Promise(r=>{accept=r;})});const p=f.run('room_post',{body:'old room'});await Promise.resolve();f.switchRoom();accept(true);assert.equal((await p).code,'context_changed');assert.equal(f.calls.length,0);
});
test('old read result is discarded after room switch; abort reaches fetch',async()=>{
  let done;const f=fixture({respond:()=>new Promise(r=>{done=r;})});const p=f.run('room_read');f.switchRoom();assert.equal(f.calls[0].signal.aborted,true);done({messages:[{id:'private',body:'old room'}]});assert.equal((await p).code,'context_changed');
});
test('invalid inputs cannot choose arbitrary endpoints or bypass schema',async()=>{
 const f=fixture();for(const [name,args] of [['room_post',{body:'x',roomId:'other'}],['room_read',{limit:51}],['room_search',{query:''}],['room_read_many',{items:[]}]] ) assert.equal((await f.run(name,args)).code,'invalid_input');assert.equal(f.calls.length,0);
});
test('recorded mutation with failed refresh is not reported as retryable failure',async()=>{
 const f=fixture();f.client.refresh=async()=>{throw Error('private diagnostic');};assert.deepEqual(await f.run('room_post',{body:'hello'}),{status:'recorded',refresh:'pending'});
});

test('server permission denial stays a refusal and never exposes server diagnostics',async()=>{
 const f=fixture({respond:()=>Response.json({error:{message:'private diagnostic'}},{status:403})});
 const result=await f.run('room_post',{body:'hello'});assert.equal(result.code,'access_denied');assert.equal(JSON.stringify(result).includes('private'),false);
});

test('open legacy work is available separately without hiding Board claims',async()=>{
 const f=fixture({respond:()=>({state:{workItems:{a:{id:'a',title:'First',state:'accepted'},b:{id:'b',title:'Second',state:'working',claim:{holderId:'worker'}},c:{id:'c',state:'completed'}}}})});
 const first=await f.run('room_list_work',{kind:'work',limit:1});assert.equal(first.work[0].id,'a');assert.equal(first.nextCursor,'a');
 const next=await f.run('room_list_work',{kind:'work',cursor:first.nextCursor});assert.equal(next.work[0].id,'b');assert.equal(next.work[0].owner,'worker');assert.equal(next.nextCursor,null);assert.match(f.calls[0].url,/\?view=work$/);
});
