import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {fileURLToPath} from 'node:url';

test('Native integration and delegation doors remain off without feature configuration',async()=>{
 const script=(await build({entryPoints:[fileURLToPath(new URL('./http-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'HttpTestRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example'},serviceBindings:{ASSETS:async()=>new Response(null,{status:404})}});
 try{
  const seeded=await mf.dispatchFetch('https://room.example/__test-provision');assert.equal(seeded.status,200);const {ownerKey}=await seeded.json();
  const get=()=>mf.dispatchFetch('https://room.example/api/rooms/commons?messages=recent',{headers:{Authorization:`Bearer ${ownerKey}`}});
  const before=await (await get()).json();
  for(const [path,data] of [['inbound-hooks',{target:'owner'}],['automations',{template:'post-deploy-check'}],['board-views',{list:true}],['work-claims/absent/delegate',{delegate:null}],['work-claims/absent/approval',{action:'request',approver:'owner',step:'Synthetic'}]]){
   const response=await mf.dispatchFetch('https://room.example/api/rooms/commons/'+path,{method:'POST',headers:{Authorization:`Bearer ${ownerKey}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
   assert.equal(response.status,404,`${path}: ${await response.text()}`);
  }
  const after=await (await get()).json();assert.equal(after.sequence,before.sequence);
 }finally{await mf.dispose();}
});

test('Native opt-in planning and saved view survive a cold restart',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=await mkdtemp(join(tmpdir(),'board-native-roundtrip-'));
 const script=(await build({entryPoints:[fileURLToPath(new URL('./http-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'HttpTestRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example',ROOM_BOARD_PLANNING_FIELDS:'1',ROOM_BOARD_PROJECTS:'1',ROOM_BOARD_VIEWS:'1',ROOM_AGENT_SESSION_STATES:'1'},serviceBindings:{ASSETS:async()=>new Response(null,{status:404})}});
 let mf=create();
 try{
  const seeded=await mf.dispatchFetch('https://room.example/__test-provision');assert.equal(seeded.status,200);const {ownerKey}=await seeded.json();
  const call=async(path,data,status=200)=>{const response=await mf.dispatchFetch('https://room.example/api/rooms/commons/'+path,{method:data?'POST':'GET',headers:{Authorization:`Bearer ${ownerKey}`,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});assert.equal(response.status,status,`${path}: ${await response.clone().text()}`);return response.json();};
  await call('work-claims',{id:'native-plan',title:'Native plan',priority:1,projectId:'native-project',assignee:'owner'},201);
  const updated=await call('work-claims/native-plan/update',{priority:3});assert.equal(updated.planning.priority,3);
  const view=await call('board-views',{create:{name:'Native view',query:{projectId:'native-project',sort:'priority'}}},201);
  const path='work-claims?savedView='+encodeURIComponent(view.view.viewId);
  const before=await call(path);assert.deepEqual(before.claims.map(c=>c.id),['native-plan']);assert.equal(before.claims[0].planning.priority,3);assert.equal(before.claims[0].agentSession,'pending');
  await call('work-claims?sort=priority&state=invalid',null,422);
  await mf.dispose();mf=create();
  const after=await call(path);assert.deepEqual(after.claims.map(c=>c.id),['native-plan']);assert.deepEqual(after.claims[0].planning,{priority:3,projectId:'native-project'});assert.equal(after.claims[0].agentSession,'pending');
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
