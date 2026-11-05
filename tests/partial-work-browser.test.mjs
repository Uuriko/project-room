import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';import {createRoomServer} from '../server/http.mjs';import {RoomClient} from '../src/client.js';

test('real room-cookie browser session reads normalized selected native work absent from its snapshot',async t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();for(let i=0;i<9;i++)events.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:`task-${i}`,title:`Task ${i}`,definitionOfDone:`Exact definition ${i}`,accountableMemberId:'owner'}}));store.initialize(events,{representation:'normalized-current-v1'});
 const created=store.createSession(store.issueAccessKey('commons','owner')),server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`,seen=[];const client=new RoomClient({onSnapshot:s=>seen.push(s),fetcher:(path,options)=>fetch(origin+path,{...options,headers:{...options.headers,Cookie:'room_session='+created.token}})});
 client.session={...created.session,authMode:'room',csrf:null};await client.refresh();
 assert.equal(seen[0].snapshotVersion,2);assert.equal(Object.hasOwn(seen[0].state.workItems,'task-8'),false);
 const read=await client.workContext('task-8');assert.equal(read.work.definitionOfDone,'Exact definition 8');assert.equal(read.viewerId,'owner');assert.notEqual(client.session,null);client.disconnect();

});
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
function harness({held={}}={}){
 const calls=[],card={querySelector:()=>({open:false})},ctx={structuredClone,calls,card,partialWorkSnapshot:true,inspectedWorkRecord:null,state:{room:{id:'commons'},members:{owner:{id:'owner',active:true}},workItems:held},session:{roomId:'commons',member:{id:'owner'}},client:{generation:1,workContext:async id=>{calls.push(['read',id]);return {roomId:'commons',viewerId:'owner',work:{id,title:'Full title',definitionOfDone:'Complete selected definition',revision:1},viewerSessionBinding:'bound'};},ownsResponse:()=>true},busy:false,activeWorkNavigationId:null,activeWorkNavigation:null,workNavigationEpoch:1,location:{href:'http://localhost/#pr-record/work/late'},CSS:{escape:x=>x},SOURCE_UNAVAILABLE_NOTICE:'unavailable'};
 vm.createContext(ctx);const start=source.indexOf('// JDOT-COH-NAV begin\nfunction revealWork('),end=source.indexOf('function workNavigationContext()',start);assert.ok(start>=0&&end>start);
 vm.runInContext(`var revealClaimRecord=id=>calls.push(['legacy-board',id]);var workRecord=()=>card;var revealWorkTimeline=id=>{calls.push(['mount',id]);return card;};var focusRecord=()=>{};var syncWorkReturnControl=()=>{};var notice=text=>calls.push(['notice',text]);var workNavigationContext=()=>session&&state?client.generation+'|'+session.roomId+'|'+session.member.id:null;${source.slice(start,end)}this.reveal=revealWork;`,ctx);return ctx;
}
test('normalized missing native id reads and mounts the selected record instead of opening a legacy claim board',async()=>{
 const h=harness();await h.reveal('late',true);assert.deepEqual(h.calls.map(x=>Array.from(x)),[['read','late'],['mount','late']]);assert.equal(h.state.workItems.late.definitionOfDone,'Complete selected definition');
});
test('normalized held thin summary also needs full selected details before rendering',async()=>{
 const h=harness({held:{late:{id:'late',title:'Summary',revision:1}}});await h.reveal('late',true);assert.equal(h.calls[0][0],'read');assert.equal(h.state.workItems.late.definitionOfDone,'Complete selected definition');
});
test('late selected work never mounts after navigation, snapshot replacement, or session replacement',async()=>{
 for(const change of [h=>h.workNavigationEpoch++,h=>h.state={...h.state},h=>h.session={...h.session},h=>h.location.href+='-elsewhere',h=>h.client.generation++]){
  const h=harness();let resolve;h.client.workContext=()=>new Promise(done=>resolve=done);const pending=h.reveal('late',true);change(h);
  resolve({roomId:'commons',viewerId:'owner',work:{id:'late',title:'Late private work',definitionOfDone:'Must not mount',revision:1}});await pending;
  assert.equal(h.state.workItems.late,undefined);assert.equal(h.calls.some(([kind])=>kind==='mount'||kind==='notice'),false);
 }
});
test('mismatched and unavailable selected responses preserve summaries without a legacy fallback',async()=>{
 for(const value of [null,{roomId:'elsewhere',viewerId:'owner',work:{id:'late',title:'Wrong',definitionOfDone:'No',revision:1}},{roomId:'commons',viewerId:'intruder',work:{id:'late',title:'Wrong',definitionOfDone:'No',revision:1}},{roomId:'commons',viewerId:'owner',work:{id:'other',title:'Wrong',definitionOfDone:'No',revision:1}},{roomId:'commons',viewerId:'owner',work:{id:'late',title:'Thin',revision:1}}]){
  const h=harness({held:{late:{id:'late',title:'Held summary',revision:1}}});h.client.workContext=async()=>value;await h.reveal('late',true);
  assert.equal(h.state.workItems.late.title,'Held summary');assert.equal(h.calls.some(([kind])=>kind==='mount'||kind==='legacy-board'),false);assert.equal(h.calls.at(-1)[0],'notice');
 }
});
test('a selected response older than the already held summary cannot replace it',async()=>{
 const h=harness({held:{late:{id:'late',title:'Revision2 summary',revision:2}}});await h.reveal('late',true);assert.equal(h.state.workItems.late.revision,2);assert.equal(h.calls.some(([kind])=>kind==='mount'),false);
});
test('legacy missing records still use the existing board fallback',async()=>{
 const h=harness();h.partialWorkSnapshot=false;await h.reveal('legacy-claim');assert.deepEqual(h.calls.map(x=>Array.from(x)),[['legacy-board','legacy-claim']]);
});
test('partial timeline renders a summary link until the full selected record is mounted',async()=>{
 const h=harness({held:{late:{id:'late',title:'Summary',revision:1}}});class Element{constructor(tag){this.tag=tag;this.dataset={};this.children=[];}append(child){this.children.push(child);}get outerHTML(){return JSON.stringify(this);}}
 Object.assign(h,{document:{createElement:tag=>new Element(tag)},DEFAULT_CHANNEL_ID:'general',esc:String,workHref:id=>'#work-'+id,messageChannelId:()=> 'general',workCard:item=>{assert.equal(typeof item.definitionOfDone,'string');return 'FULL:'+item.definitionOfDone;}});h.state.messages=[];
 const start=source.indexOf('function workSummaryCard(item)'),end=source.indexOf('function makeTimelineWorkNode',start);vm.runInContext(source.slice(start,end)+'this.timeline=timelineWorkEntries;',h);
 assert.equal(JSON.parse(h.timeline('late')[0].html).children[0].children[0].dataset.openWork,'late');assert.doesNotMatch(h.timeline('late')[0].html,/FULL:/);
 await h.reveal('late',true);assert.equal(h.timeline('late')[0].html,'FULL:Complete selected definition');
});
test('selected work preserves account-session ownership refusal before any request',async()=>{
 let requests=0,ended=0;const client=new RoomClient({fetcher:async()=>{requests++;throw Error('must not request');},onAccessEnded:()=>ended++});client.session={authMode:'account',account:{id:'account-owner',authEpoch:0},member:{id:'owner'},roomId:'commons',sessionBinding:'old-binding'};
 assert.equal(await client.workContext('task-8'),null);assert.equal(requests,0);assert.equal(ended,1);assert.equal(client.session,null);
});

test('actual accountless agent join-cookie session reads selected normalized work',async t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize([...initialRoom(),event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'joined-agent',displayName:'Joined agent',kind:'agent',permissions:[]}}),event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'joined-task',title:'Useful task',definitionOfDone:'Saved output',accountableMemberId:'owner'}})],{representation:'normalized-current-v1'});
 const server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const origin=`http://127.0.0.1:${server.address().port}`,joined=store.createJoinSession('commons','joined-agent'),joinedAuth=store.authenticate(joined.token,'commons');assert.equal(joinedAuth.account,null);
 const client=new RoomClient({fetcher:(path,options)=>fetch(origin+path,{...options,headers:{...options.headers,Cookie:'room_session='+joined.token}})});client.session={...joinedAuth,authMode:'room',csrf:null};
 assert.equal((await client.workContext('joined-task')).work.definitionOfDone,'Saved output');assert.notEqual(client.session,null);client.disconnect();
});
test('actual work navigation accepts an unheld normalized ID and runs the selected reader on the destination',async()=>{
 const h=harness();Object.assign(h,{URL,crypto:{randomUUID:()=> 'navigation-ticket'},updatesUi:null,workNavigationOrigins:new Map(),workHistoryReplayKey:null,conversation:{byId:new Map()}});
 h.location={href:'http://localhost/#pr-view/rooms',hash:'#pr-view/rooms'};h.history={state:null,replaceState(value){this.state=value;},pushState(value,_unused,target){this.state=value;h.location.href=new URL(target,h.location.href).href;h.location.hash=new URL(h.location.href).hash;}};
 const show=source.slice(source.indexOf('function showWorkDestination('),source.indexOf('// #3795: open the board',source.indexOf('function showWorkDestination(')));
 const navStart=source.indexOf('function navigateWorkRecord('),navEnd=source.indexOf('// #3795: navigate to a board claim',navStart);
 vm.runInContext(`var $=()=>({open:false});var recordHref=(kind,id)=>'#pr-record/'+kind+'/'+id;var captureWorkOrigin=()=>({type:'conversation'});var currentWorkOrigin=()=>null;var workHistoryState=()=>({});var sameWorkOrigin=()=>false;${show}${source.slice(navStart,navEnd)}this.navigate=navigateWorkRecord;`,h);
 assert.equal(h.navigate('work','late',{presentation:'details'}),true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.history.state.roomWorkTarget,'navigation-ticket');assert.equal(h.state.workItems.late.definitionOfDone,'Complete selected definition');assert.equal(h.calls.some(([kind])=>kind==='legacy-board'),false);
});
test('a later direct native work selection wins even when an older read completes first',async()=>{
 const h=harness(),resolvers={};h.client.workContext=id=>new Promise(resolve=>resolvers[id]=resolve);
 const first=h.reveal('first',true),second=h.reveal('second',true);
 for(const id of ['first','second']){resolvers[id]({roomId:'commons',viewerId:'owner',work:{id,title:id,definitionOfDone:id,revision:1}});await(id==='first'?first:second);}
 assert.equal(h.state.workItems.first,undefined);assert.equal(h.state.workItems.second.definitionOfDone,'second');assert.equal(h.activeWorkNavigationId,'second');
});
