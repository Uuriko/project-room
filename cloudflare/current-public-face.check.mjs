import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('Workers-native public HTTP publication is bounded, private by default and survives cold reopen',{timeout:60000},async t=>{
 const script=(await build({entryPoints:[new URL('./current-public-face.test-fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const dir=await mkdtemp(join(tmpdir(),'current-public-face-'));
 const create=()=>new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'CurrentPublicFaceRoom',useSQLite:true}}});let mf=create();
 t.after(async()=>{await mf.dispose();await rm(dir,{recursive:true,force:true});});
 const costs=[];let lastCall,lastCode;
 for(const privateCount of [1000,5000]){
  const surface='p'+privateCount,call=async(path,{owner,body}={})=>{const url=new URL(path,'http://localhost');url.searchParams.set('surface',surface);const r=await mf.dispatchFetch(url,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{host:'localhost',...(owner?{authorization:'Bearer '+owner}:{}),...(body?{'Content-Type':'application/json'}:{})}});const text=await r.text();return{status:r.status,text,cost:JSON.parse(r.headers.get('X-Fixture-Cost')??'null'),body:r.headers.get('Content-Type')?.includes('application/json')?JSON.parse(text):null};};
  const seed=await call('/seed?privateCount='+privateCount),owner=seed.body.owner;
  const unavailable=await call('/watch');assert.equal(unavailable.status,200,unavailable.text);assert.match(unavailable.text,/No public lobby is published yet/);
  const on=await call('/api/rooms/project-room-lobby/public-face',{owner,body:{enabled:true}});assert.equal(on.status,200,on.text);
  const publish=await call('/api/rooms/project-room-lobby/commands',{owner,body:{id:'publish-reviewer-lobby',type:'room.public_page_set',data:{enabled:true}}});assert.equal(publish.status,201,publish.text);const watch=await call('/watch');assert.match(watch.text,/href="\/r\/project-room-lobby#open-tasks">View open tasks/);const room=await call('/r/project-room-lobby');assert.equal(room.status,200);assert.match(room.text,/<h2 id="open-tasks">Open tasks/);
  const page=await call('/api/public/rooms/'+on.body.publicCode);assert.equal(page.status,200,page.text);assert.equal(page.body.messages.length,8);assert.doesNotMatch(page.text,/PRIVATE HISTORY|OTHER CHANNEL|DELETED MUST/);assert.equal(page.cost.unknown,0);costs.push(page.cost);
  const feed=await call('/api/public/rooms/'+on.body.publicCode+'/feed');assert.equal(feed.status,200,feed.text);assert.equal(feed.body.messages[0].id,'public-0');
  const off=await call('/api/rooms/project-room-lobby/public-face',{owner,body:{enabled:false}});assert.equal(off.status,200);assert.equal((await call('/api/public/rooms/'+on.body.publicCode)).status,404);
  lastCall=call;lastCode=(await call('/api/rooms/project-room-lobby/public-face',{owner,body:{enabled:true}})).body.publicCode;
 }
 assert.ok(costs[1].rowsRead<costs[0].rowsRead*2,JSON.stringify(costs));assert.ok(costs[1].returnedSqlTextBytes<costs[0].returnedSqlTextBytes*2,JSON.stringify(costs));
 await mf.dispose();mf=create();const cold=await lastCall('/api/public/rooms/'+lastCode);assert.equal(cold.status,200,cold.text);assert.equal(cold.body.messages.length,8);
 t.diagnostic(JSON.stringify({privateCounts:[1000,5000],costs}));
});
