import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {fileURLToPath} from 'node:url';
test('actual Worker selected attachment reads stay flat against retained irrelevant metadata',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-attachments-worker.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const directory=await mkdtemp(join(tmpdir(),'current-files-'));
 const create=()=>new Miniflare({durableObjectsPersist:directory,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'CurrentAttachmentsRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path);const body=await r.json();if(!(process.env.CURRENT_EVENTS_BASELINE==='1'&&r.status===409&&path.includes('after=')))assert.equal(r.status,200,JSON.stringify(body));return body;};
 const samples=[];
 try{
  for(const [surface,count]of [['small',1000],['large',5000]]){
   await call(`/seed?surface=${surface}&count=${count}`);
   const cold=await call(`/read?surface=${surface}`),warm=await call(`/read?surface=${surface}`),plan=await call(`/explain?surface=${surface}`);
   const files=[...warm.page.files];let page=warm.page,calls=1;
   while(page.page.hasMore){page=(await call(`/read?surface=${surface}&cursor=${encodeURIComponent(page.page.nextCursor)}`)).page;files.push(...page.files);calls++;assert.ok(calls<5);}
   const denied=await mf.dispatchFetch('http://local/private?surface='+surface);assert.equal(denied.status,404);
   samples.push({count,cold:cold.cost,warm:warm.cost,plan:plan.plan,calls,files:files.length});
  }
  await mf.dispose();mf=create();
  for(const [i,surface]of ['small','large'].entries()){const cold=await call(`/read?surface=${surface}`),warm=await call(`/read?surface=${surface}`);samples[i].restartCold=cold.cost;samples[i].restartWarm=warm.cost;}
  console.log('CURRENT_ATTACHMENTS_WORKER '+JSON.stringify({samples,source:'legal retained terminal metadata, eighteen committed selected files'}));
  for(const s of samples){assert.equal(s.files,18);assert.equal(s.calls,3);assert.ok(s.plan.some(x=>/SEARCH room_attachments USING COVERING INDEX current_room_attachments_message/.test(x.detail)));assert.equal(s.warm.rowsWritten,0);assert.equal(s.warm.rawRuntime.rowsWritten,2);assert.equal(s.warm.unknown,0);}
  assert.equal(samples[1].warm.rowsRead,samples[0].warm.rowsRead);assert.equal(samples[1].warm.returnedSqlTextBytes,samples[0].warm.returnedSqlTextBytes);

 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
