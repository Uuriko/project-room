import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repository=fileURLToPath(new URL('../',import.meta.url));
import { execFileSync } from 'node:child_process';
const BASELINE='2075f27e897c9843048012559f457bf11607d884';
const quote=JSON.stringify;

test('actual v45 Native storage cold-upgrades, preserves connections and refuses an old cached adapter', {timeout:120000}, async()=>{
 const temp=await mkdtemp(join(tmpdir(),'claim-native-upgrade-'));
 let mf;
 try {
  const old=join(temp,'prior');await mkdir(old);
  const archive=join(temp,'prior.tar');
  execFileSync('git',['archive','--format=tar','--output',archive,BASELINE],{cwd:repository});
  execFileSync('tar',['-xf',archive,'-C',old]);
  const fixture=(root,upgraded)=>`
import {DurableObject} from 'cloudflare:workers';
import {RoomStore} from ${quote(join(root,'server/store.mjs'))};
import {initialRoom} from ${quote(join(root,'server/bootstrap.mjs'))};
import {DurableDatabase,durableStorage} from ${quote(join(root,'cloudflare/storage.mjs'))};
import {createWork,claimWork${upgraded?',delegateWork,requestApproval':''}} from ${quote(join(root,'server/work-claims.mjs'))};
${upgraded?`import {DurableDatabase as PriorDatabase,durableStorage as priorStorage} from ${quote(join(old,'cloudflare/storage.mjs'))};`:''}
export class UpgradeRoom extends DurableObject {
 fetch(request){
 ${upgraded?`const earlier=new PriorDatabase(this.ctx.storage);const priorVersion=priorStorage.version(earlier);`:''}
 const db=new DurableDatabase(this.ctx.storage);const store=new RoomStore(null,{database:db,storagePlatform:durableStorage,integrity:'deferred'});
 ${!upgraded?`
 store.initialize(initialRoom('kept-room'));store.createAccount('kept-account');
 const key=store.issueAccessKey('kept-room','owner');const identity=store.identities.create('Kept identity');
 store.workClaims.set('kept-room',claimWork(createWork({id:'kept-work',title:'Kept work'},{agentId:'owner'}),'owner'));
 return Response.json({key,identitySecret:identity.secret,identityId:identity.identityId,version:durableStorage.version(db)});
 `:`
 const body=JSON.parse(request.headers.get('x-fixture-context'));
 const member=store.authenticate(body.key,'kept-room').member.id;
 const identityId=store.identities.resolveGlobalIdentitySecret(body.identitySecret).identityId;
 let work=store.workClaims.get('kept-room','kept-work');
 if(!work.delegate){work=requestApproval(delegateWork(work,'owner','worker'),'owner',{approverId:'boss',step:'Synthetic'});store.workClaims.set('kept-room',work);}
 let refused=false;
 try{priorStorage.transaction(earlier,()=>earlier.prepare("UPDATE work_claims SET item_json='{}' WHERE claim_id='kept-work'").run());}catch{refused=true;}
 const persisted=store.workClaims.get('kept-room','kept-work');
 return Response.json({priorVersion,version:durableStorage.version(db),member,identityId,account:store.account('kept-account').active,refused,delegate:persisted.delegate,approval:persisted.approvalHold.status,initializationMs:store.initializationMs});
 `}
 }
}
export default {fetch(request,env){return env.ROOM.getByName('same-storage').fetch(request);}};`;
  const bundle=async(root,upgraded)=>{
   const entry=join(temp,upgraded?'after.mjs':'before.mjs');await writeFile(entry,fixture(root,upgraded));
   return (await build({entryPoints:[entry],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
  };
  const before=await bundle(old,false),after=await bundle(repository,true);
  const options=script=>({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:join(temp,'persist'),durableObjects:{ROOM:{className:'UpgradeRoom',useSQLite:true}}});
  mf=new Miniflare(options(before));
  let response=await mf.dispatchFetch('https://room.example/seed');assert.equal(response.status,200,await response.clone().text());const seeded=await response.json();assert.equal(seeded.version,45);
  await mf.dispose();mf=new Miniflare(options(after));
  for(let pass=0;pass<2;pass++){
   response=await mf.dispatchFetch('https://room.example/prove',{headers:{'x-fixture-context':JSON.stringify(seeded)}});assert.equal(response.status,200,await response.clone().text());const facts=await response.json();
   assert.equal(facts.version,46);assert.equal(facts.member,'owner');assert.equal(facts.identityId,seeded.identityId);assert.equal(facts.account,true);assert.equal(facts.refused,true);assert.equal(facts.delegate,'worker');assert.equal(facts.approval,'pending');
   console.log(JSON.stringify({phase:pass?'cold46-reopen':'45-to46-upgrade',priorVersion:facts.priorVersion,version:facts.version,initializationMs:facts.initializationMs,oldWriterRefused:facts.refused,connectionPreserved:true}));
   await mf.dispose();mf=new Miniflare(options(after));
  }
 }finally{await mf?.dispose();await rm(temp,{recursive:true,force:true});}
});
