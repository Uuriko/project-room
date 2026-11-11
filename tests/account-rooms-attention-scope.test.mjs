import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {parse} from 'acorn';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {ownerOverview} from '../server/owner-overview.mjs';
import {createRoomServer} from '../server/http.mjs';
import {attentionReport} from '../server/owner-attention.mjs';import {createNeedsAttentionCard} from '../src/needs-attention.js';
const app=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
function productionFunction(name){const ast=parse(app,{ecmaVersion:'latest',sourceType:'module'});let node;function visit(value){if(!value||typeof value!=='object')return;if(value.type==='FunctionDeclaration'&&value.id.name===name)node=value;for(const child of Object.values(value))if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child);}visit(ast);assert.ok(node);return app.slice(node.start,node.end);}
class Element{constructor(){this.children=[];this.dataset={};this.hidden=false;this.events={};this.textContent='';this.classList={toggle(){}};}replaceChildren(...rows){this.children=rows;}append(...rows){this.children.push(...rows);}setAttribute(){}addEventListener(name,fn){this.events[name]=fn;}querySelectorAll(){return [];}focus(){}}
test('actual Rooms loader performs no overview request and opens selected room normally',async()=>{
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};let overview=0;const opened=[];
 const ctx={roomListVersion:0,roomListCursor:null,accountClient:{session:{authenticated:true},rooms:async()=>({rooms:[{id:'native',title:'Current project',kind:'personal'}],nextCursor:null})},ownerCockpit:{refresh(){overview++;}},$:get,document:{createElement:()=>new Element()},roomKindLabel:()=> 'Personal',openAccountRoom:id=>opened.push(id),filterAccountRooms(){},startRoomIntent:false,startRoomFlight:false,nameThenEnsureDefaultRoom(){throw Error('Unexpected extra room creation');},endAccountAccess(){throw Error('Unexpected account invalidation');},uiText:()=> 'Open a room to see what needs you.'};
 await vm.runInNewContext(productionFunction('loadAccountRooms')+';loadAccountRooms();',ctx);
 assert.doesNotMatch(readFileSync(new URL('../index.html',import.meta.url),'utf8'),/id="owner-cockpit"/);assert.equal(overview,0);assert.equal(get('#account-rooms-list').children.length,1);get('#account-rooms-list').children[0].events.click();assert.deepEqual(opened,['native']);assert.equal(get('#account-rooms-status').textContent,'');assert.match(get('#account-attention-scope').textContent,/Open a room to see what needs you/);
 let started=0;ctx.accountClient.rooms=async()=>({rooms:[],nextCursor:null});ctx.nameThenEnsureDefaultRoom=()=>{started++;};await vm.runInNewContext(productionFunction('loadAccountRooms')+';loadAccountRooms();',ctx);assert.equal(started,1);assert.equal(overview,0);
});
test('normalized actual owner receives explicit unavailable overview, not false forbidden or empty totals',async t=>{
 const s=new RoomStore(':memory:');try{s.initialize(initialRoom(),{representation:'normalized-current-v1'});s.createAccount('account');s.bindHumanAccount('commons','owner','account');const key=s.issueAccountAccessKey('account'),slot=s.createAccountSessionSlot(),auth=s.loginAccountSession(slot.token,key,0);
 s.room=()=>{throw Error('Whole room hydration forbidden');};
 assert.throws(()=>ownerOverview({store:s,accessRequests:{list:()=>[]}},slot.token,auth.sessionBinding),e=>e.status===409&&e.code==='current_room_context_required');
 const server=createRoomServer({store:s});t.after(()=>{server.closeAllConnections();server.close();});await new Promise(r=>server.listen(0,'127.0.0.1',r));const res=await fetch(`http://127.0.0.1:${server.address().port}/api/owner/overview`,{headers:{Cookie:`account_session=${slot.token}`,'X-Session-Binding':auth.sessionBinding}});assert.equal(res.status,409);assert.equal((await res.json()).error.code,'current_room_context_required');
 }finally{s.close();}
});
test('selected normalized room keeps actual paged owner Needs you control',async t=>{
 const old=globalThis.document;globalThis.document={activeElement:null};t.after(()=>{if(old===undefined)delete globalThis.document;else globalThis.document=old;});
 const s=new RoomStore(':memory:');t.after(()=>s.close());s.initialize(initialRoom(),{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','owner');
 s.command(key,'commons',{id:'native-work',type:'work.proposed',data:{workItemId:'task',title:'Current useful task',definitionOfDone:'Saved useful result',accountableMemberId:'owner'}});
 const viewer=s.authenticate(key,'commons').member,state={room:{id:'commons',ownerId:'owner'},members:{owner:viewer}},parts=new Map();const section={hidden:true,querySelector(sel){if(!parts.has(sel))parts.set(sel,new Element());return parts.get(sel);}};
 let selected=0;const client={session:{roomId:'commons',member:viewer},generation:1,sequence:s.headSequence('commons'),path:p=>'/api/rooms/commons'+p,ownsAccountSession:()=>true,needsAttention:async()=>{selected++;return attentionReport({store:s,accessRequests:{list:()=>[]}},key,'commons');},request:async()=>({roomId:'commons',requests:[]}),handleFailure:e=>{throw e;}};
 const card=createNeedsAttentionCard({client,section,getState:()=>state});await card.refresh();assert.equal(selected,1);assert.equal(section.hidden,false);assert.match(section.querySelector('#attention-list').innerHTML,/Current useful task/);
});
