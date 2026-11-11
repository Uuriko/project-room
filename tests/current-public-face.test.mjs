import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedPublicLobby} from './helpers/public-lobby-source.mjs';
import {unpublishPublic} from '../server/legal-store.mjs';
import {readCurrentPublicFace} from '../server/current-public-face.mjs';
import {PUBLIC_LOBBY_ROOM_ID} from '../server/routes/public-lobby.mjs';

async function fixture(t){
 const store=new RoomStore(':memory:'),saved=seedPublicLobby(store,{roomId:PUBLIC_LOBBY_ROOM_ID});
 store.room=()=>{throw Error('Whole room hydration forbidden');};
 const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,{token,body}={})=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();return{status:r.status,text,body:r.headers.get('Content-Type')?.includes('application/json')?JSON.parse(text):null};};
 return{store,saved,call};
}
test('actual normalized public endpoints require owner publication and expose only bounded live General messages',async t=>{
 const {store,saved,call}=await fixture(t),route='/api/rooms/'+saved.roomId+'/public-face';
 assert.match((await call('/watch')).text,/No public lobby is published yet/);
 assert.equal((await call(route,{body:{enabled:true}})).status,401);
 assert.equal((await call(route,{token:saved.alice,body:{enabled:true}})).status,403);
 const enabled=await call(route,{token:saved.owner,body:{enabled:true}});assert.equal(enabled.status,200,enabled.text);
 const code=enabled.body.publicCode,page=await call('/api/public/rooms/'+code);
 assert.equal(page.status,200,page.text);assert.equal(page.body.messages.length,8);assert.match(page.body.messages.at(-1).body,/Useful <public> result/);
 assert.deepEqual(page.body.coverage,{channel:'general',bounded:true,limit:8});
 assert.equal(readCurrentPublicFace(store,saved.roomId,{latest:true}).messages.at(-1).id,'public-17');
 assert.doesNotMatch(page.text,/PRIVATE HISTORY|OTHER CHANNEL|DELETED MUST|identityId|permissions/);
 const html=await call('/p/'+code);assert.equal(html.status,200);assert.match(html.text,/Useful &lt;public&gt; result/);assert.match(html.text,/Only the General channel/);assert.doesNotMatch(html.text,/View open tasks/);
 assert.match((await call('/watch')).text,/No public lobby is published yet/,'an unlisted capability code is not enumerated as the official lobby');
 store.command(saved.owner,saved.roomId,{id:'publish-lobby',type:'room.public_page_set',data:{enabled:true}});
 const watch=await call('/watch');assert.equal(watch.status,200,watch.text);assert.match(watch.text,/Connect an agent/);assert.match(watch.text,/\/docs\/agents\/paste\?room=project-room-lobby/);assert.match(watch.text,/href="\/r\/project-room-lobby#open-tasks">View open tasks/);
 const lobby=await call('/r/project-room-lobby');assert.equal(lobby.status,200);assert.match(lobby.text,/<h2 id="open-tasks">Open tasks<\/h2>/);
 const ids=[];let after=null;
 for(let i=0;i<4;i++){const feed=await call('/api/public/rooms/'+code+'/feed'+(after?'?after='+after:''));assert.equal(feed.status,200,feed.text);ids.push(...feed.body.messages.map(m=>m.id));after=feed.body.next;if(!feed.body.hasMore)break;}
 assert.deepEqual(ids,Array.from({length:18},(_,i)=>'public-'+i));
 for(const id of ['private-0','other-channel','deleted','missing'])assert.equal((await call('/api/public/rooms/'+code+'/feed?after='+id)).status,422);
 const rotated=await call(route+'/rotate',{token:saved.owner,body:{}});assert.equal(rotated.status,200);assert.equal((await call('/p/'+code)).status,404);
 const off=await call(route,{token:saved.owner,body:{enabled:false}});assert.equal(off.status,200);assert.equal((await call('/p/'+rotated.body.publicCode)).status,404);assert.match((await call('/watch')).text,/No public lobby is published yet/);
});
test('normalized publication respects operator unpublish immediately',async t=>{
 const {store,saved,call}=await fixture(t),code=store.publicFace.enable(saved.roomId,'owner').publicCode;
 unpublishPublic(store.db,{kind:'room',id:saved.roomId,byAccount:'operator',now:Date.now()});
 assert.equal((await call('/p/'+code)).status,404);assert.equal((await call('/api/public/rooms/'+code+'/feed')).status,404);
});

test('archiving a published normalized room hides its public messages',async t=>{
 const {store,saved,call}=await fixture(t),code=store.publicFace.enable(saved.roomId,'owner').publicCode;
 store.command(saved.owner,saved.roomId,{id:'archive',type:'room.archived',data:{}});
 assert.equal((await call('/p/'+code)).status,404);
});
test('public lobby older pages stay bounded, preserve order and never reveal private history',async t=>{
 const {store,saved,call}=await fixture(t),route='/api/rooms/'+saved.roomId+'/public-face';
 await call(route,{token:saved.owner,body:{enabled:true}});store.command(saved.owner,saved.roomId,{id:'publish-lobby-history',type:'room.public_page_set',data:{enabled:true}});
 const first=await call('/watch');assert.equal(first.status,200,first.text);assert.match(first.text,/Older messages/);assert.doesNotMatch(first.text,/PRIVATE HISTORY|OTHER CHANNEL|DELETED MUST/);
 const match=first.text.match(/href="\?before=([^"]+)">Older messages/);assert.ok(match,first.text);const page=await call('/watch?before='+match[1]);assert.equal(page.status,200,page.text);assert.match(page.text,/Latest messages/);assert.doesNotMatch(page.text,/PRIVATE HISTORY|OTHER CHANNEL|DELETED MUST/);
 const firstData=readCurrentPublicFace(store,saved.roomId,{latest:true}),secondData=readCurrentPublicFace(store,saved.roomId,{latest:true,before:decodeURIComponent(match[1])});assert.deepEqual(firstData.messages.map(x=>x.id),Array.from({length:8},(_,i)=>'public-'+(i+10)));assert.deepEqual(secondData.messages.map(x=>x.id),Array.from({length:7},(_,i)=>'public-'+(i+3)));
 const last=await call('/watch?before=public-7');assert.equal(last.status,200);assert.doesNotMatch(last.text,/Older messages/);assert.match(last.text,/Latest messages/);store.command(saved.owner,saved.roomId,{id:'huge-private',type:'message.posted',data:{messageId:'huge-private',body:'界'.repeat(65536),toMemberId:'alice'}});for(const id of ['private-0','huge-private','other-channel','deleted','missing'])assert.equal((await call('/watch?before='+id)).status,422,id);
 await call(route,{token:saved.owner,body:{enabled:false}});const closed=await call('/watch?before='+match[1]);assert.doesNotMatch(closed.text,/Useful &lt;public&gt; result|PRIVATE HISTORY/);assert.match(closed.text,/No public lobby is published yet/);
});
test('public history preserves bounded reads with long messages',async t=>{
 const {store,saved,call}=await fixture(t),route='/api/rooms/'+saved.roomId+'/public-face';let now=Date.now()+10000;store.now=()=>now;for(let i=0;i<10;i++){now+=2001;store.command(saved.alice,saved.roomId,{id:'long-'+i,type:'message.posted',data:{messageId:'long-'+i,body:'x'.repeat(11000)}})}
 await call(route,{token:saved.owner,body:{enabled:true}});store.command(saved.owner,saved.roomId,{id:'publish-long',type:'room.public_page_set',data:{enabled:true}});
 const page=await call('/watch');assert.equal(page.status,200,page.text);const match=page.text.match(/href="\?before=([^"]+)">Older messages/);assert.ok(match);const older=await call('/watch?before='+match[1]);assert.equal(older.status,200,older.text);assert.match(older.text,/Latest messages/);
});
test('older public cursor stays stable when new public messages arrive',async t=>{
 const {store,saved,call}=await fixture(t),route='/api/rooms/'+saved.roomId+'/public-face';await call(route,{token:saved.owner,body:{enabled:true}});store.command(saved.owner,saved.roomId,{id:'publish-stable',type:'room.public_page_set',data:{enabled:true}});
 const first=await call('/watch'),cursor=first.text.match(/href="\?before=([^"]+)">Older messages/)?.[1];assert.ok(cursor);const before=readCurrentPublicFace(store,saved.roomId,{latest:true,before:cursor}).messages.map(x=>x.id);
 store.command(saved.alice,saved.roomId,{id:'newer-message',type:'message.posted',data:{messageId:'newer-message',body:'New public message'}});
 const after=readCurrentPublicFace(store,saved.roomId,{latest:true,before:cursor}).messages.map(x=>x.id);assert.deepEqual(after,before);assert.equal((await call('/watch?before='+cursor)).status,200);
});
test('old public history links respect deletion, unlisting and operator unpublish',async t=>{
 const {store,saved,call}=await fixture(t),route='/api/rooms/'+saved.roomId+'/public-face';await call(route,{token:saved.owner,body:{enabled:true}});store.command(saved.owner,saved.roomId,{id:'publish-revoke',type:'room.public_page_set',data:{enabled:true}});
 const page=await call('/watch'),cursor=page.text.match(/href="\?before=([^"]+)">Older messages/)?.[1];assert.equal(cursor,'public-10');store.command(saved.alice,saved.roomId,{id:'delete-anchor',type:'message.deleted',data:{messageId:cursor,expectedMessageRevision:0}});const old=await call('/watch?before='+cursor);assert.equal(old.status,422);assert.doesNotMatch(old.text,/Public work 10|PRIVATE HISTORY/);
 const current=await call('/watch');const fresh=current.text.match(/href="\?before=([^"]+)">Older messages/)?.[1];assert.ok(fresh);store.command(saved.owner,saved.roomId,{id:'unlist-room',type:'room.public_page_set',data:{enabled:false}});const unlisted=await call('/watch?before='+fresh);assert.match(unlisted.text,/No public lobby is published yet/);assert.doesNotMatch(unlisted.text,/Public work|PRIVATE HISTORY/);
 store.command(saved.owner,saved.roomId,{id:'relist-room',type:'room.public_page_set',data:{enabled:true}});unpublishPublic(store.db,{kind:'room',id:saved.roomId,byAccount:'operator',now:Date.now()});const revoked=await call('/watch?before='+fresh);assert.equal(revoked.status,404);assert.doesNotMatch(revoked.text,/Public work|PRIVATE HISTORY/);
});
test('invalid public history links have one safe recovery page',async t=>{
 const {store,saved,call}=await fixture(t),route='/api/rooms/'+saved.roomId+'/public-face';await call(route,{token:saved.owner,body:{enabled:true}});store.command(saved.owner,saved.roomId,{id:'publish-errors',type:'room.public_page_set',data:{enabled:true}});
 const pages=[];for(const id of ['private-0','other-channel','deleted','missing']){const r=await call('/watch?before='+id);assert.equal(r.status,422);assert.match(r.text,/This page is no longer available/);assert.match(r.text,/href="\/watch">Return to latest messages/);assert.doesNotMatch(r.text,/PRIVATE HISTORY|OTHER CHANNEL|DELETED MUST/);pages.push(r.text)}assert.ok(pages.every(x=>x===pages[0]));
});
test('owner withdrawing the room page immediately removes the watch task link and public feed',async t=>{const {store,saved,call}=await fixture(t);store.publicFace.enable(saved.roomId,'owner');store.command(saved.owner,saved.roomId,{id:'enable-room-for-watch',type:'room.public_page_set',data:{enabled:true}});const before=await call('/watch');assert.match(before.text,/View open tasks/);assert.match(before.text,/Useful &lt;public&gt; result/);store.command(saved.owner,saved.roomId,{id:'withdraw-room-for-watch',type:'room.public_page_set',data:{enabled:false}});const after=await call('/watch');assert.match(after.text,/No public lobby is published yet/);assert.doesNotMatch(after.text,/View open tasks|Useful &lt;public&gt; result|PRIVATE HISTORY/);const page=await call('/r/project-room-lobby');assert.equal(page.status,404);});
