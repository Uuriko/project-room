// Private Native fixture; no live state, runtime patches or guard bypasses.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [root]=process.argv.slice(2);assert.equal(process.argv.length,3);
const git=process.env.LOCAL_LAB_GIT??'git';
const pin=execFileSync(git,['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(pin,'ff3350cb8d2be1d1c7278677211eeea3282b7c75');execFileSync(git,['-C',root,'diff','--quiet','HEAD','--']);
const require=createRequire(root+'/cloudflare/package.json');
const {build}=await import(pathToFileURL(require.resolve('esbuild')));
const {Miniflare}=await import(pathToFileURL(require.resolve('miniflare')));
const fixture=`
import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createHash} from 'node:crypto';
const tables=['messages','current_room_head','current_room_records','current_room_record_proofs','events','commands','messages_backfill_cursor'];
const snapshot=s=>createHash('sha256').update(JSON.stringify(tables.map(t=>[t,s.db.prepare("SELECT * FROM "+t+" WHERE room_id LIKE 'a-native-%' ORDER BY rowid").all()]))).digest('hex');
export class MixedMaintenanceRoom extends ProjectRoom {
 async fetch(request){
  const url=new URL(request.url),s=this.store;
  if(url.pathname==='/__seed'){
   const count=Number(url.searchParams.get('count'));if(![1,40].includes(count))throw Error('invalid count');
   for(let i=0;i<count;i++){
    const id='a-native-'+String(i).padStart(3,'0');
    s.initialize(initialRoom(id),{representation:'normalized-current-v1'});
    const key=s.issueAccessKey(id,'owner');
    s.command(key,id,{id:'post-'+id,type:'message.posted',data:{messageId:'message-'+id,body:'Preserved '+id}});
   }
   s.initialize(initialRoom('z-legacy'),{representation:null});
   const key=s.issueAccessKey('z-legacy','owner');
   s.command(key,'z-legacy',{id:'post-legacy',type:'message.posted',data:{messageId:'message-legacy',body:'Legacy message'}});
   await this.ctx.storage.put('baseline',{count,hash:snapshot(s)});
   return Response.json({seeded:count});
  }
  const baseline=await this.ctx.storage.get('baseline');if(!baseline)throw Error('missing fixture');
  if(url.pathname==='/__cold')return Response.json({count:baseline.count,unchanged:snapshot(s)===baseline.hash,nativeHeads:s.db.prepare('SELECT count(*) n FROM current_room_head').get().n,nativeCursors:s.db.prepare("SELECT count(*) n FROM messages_backfill_cursor WHERE room_id LIKE 'a-native-%'").get().n});
  const prepare=s.db.prepare.bind(s.db);let nativeHeadReads=0,nativeRecordReads=0,selectedCandidates=0;
  s.db.prepare=sql=>{
   const st=prepare(sql);
   if(/FROM current_room_head WHERE room_id=/.test(sql)){
    const get=st.get.bind(st);st.get=(...args)=>{if(String(args[0]).startsWith('a-native-'))nativeHeadReads++;return get(...args);};
   }
   if(/FROM current_room_records WHERE/.test(sql))nativeRecordReads++;
   if(sql.includes('SELECT r.id AS id, r.sequence AS sequence')){
    const get=st.get.bind(st);st.get=(...args)=>{const row=get(...args);if(row)selectedCandidates++;return row;};
   }
   return st;
  };
  const beforeRows=s.db.rowsRead;let result,parity,iterations=0;
  try{
   for(;iterations<10;iterations++){result=s.backfillMessages({limit:100});if(result.done){iterations++;break;}}
   parity=s.checkMessagesParity();
  }finally{s.db.prepare=prepare;}
  const rowsRead=s.db.rowsRead-beforeRows;
  let explicitRefusal,oldWriterRefusal;
  try{s.checkMessagesParity({roomId:'a-native-000'});}catch(e){explicitRefusal={status:e.status,message:e.message};}
  try{s.db.prepare("UPDATE messages SET body='old writer' WHERE room_id='a-native-000'").run();}catch(e){oldWriterRefusal=e.message;}
  return Response.json({count:baseline.count,result,parity,iterations,rowsRead,nativeHeadReads,nativeRecordReads,selectedCandidates,explicitRefusal,oldWriterRefusal,unchanged:snapshot(s)===baseline.hash,nativeCursors:s.db.prepare("SELECT count(*) n FROM messages_backfill_cursor WHERE room_id LIKE 'a-native-%'").get().n});
 }
}
export default {fetch(request,env){return env.ROOM.getByName('mixed').fetch(request);}};
`;
const script=(await build({stdin:{contents:fixture,resolveDir:root+'/cloudflare',sourcefile:'mixed-maintenance-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
const observations=[];
for(const count of [1,40]){
 const dir=await mkdtemp(join(tmpdir(),'native-mixed-maintenance-'));let mf;
 const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'MixedMaintenanceRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example'},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});
 const request=async path=>{const r=await mf.dispatchFetch('https://room.example/'+path);assert.equal(r.status,200,await r.clone().text());return r.json();};
 try{
  mf=create();assert.deepEqual(await request('__seed?count='+count),{seeded:count});
  const facts=await request('__maintain');
  assert.equal(facts.result.done,true);assert.deepEqual(facts.result.failed,[]);
  assert.equal(facts.parity.ok,true);assert.equal(facts.parity.roomId,'z-legacy');
  assert.equal(facts.unchanged,true);assert.equal(facts.nativeCursors,0);
  assert.equal(facts.nativeHeadReads,0);assert.equal(facts.nativeRecordReads,0);assert.equal(facts.selectedCandidates,1);
  assert.equal(facts.explicitRefusal.status,409);assert.match(facts.explicitRefusal.message,/independent current-record integrity audit/);
  assert.match(facts.oldWriterRefusal,/unsupported current room writer/);
  await mf.dispose();mf=undefined;mf=create();
  const cold=await request('__cold');assert.deepEqual(cold,{count,unchanged:true,nativeHeads:count,nativeCursors:0});
  observations.push({facts,cold});
 }finally{if(mf)await mf.dispose();await rm(dir,{recursive:true,force:true});}
}
execFileSync(git,['-C',root,'diff','--quiet','HEAD','--']);
console.log(JSON.stringify({schema:'member2-native-mixed-maintenance-v1',pass:true,pin,node:process.version,compatibilityDate:'2026-07-30',bundleSha256:createHash('sha256').update(script).digest('hex'),observations,limits:'Private synthetic local data. SQL anti-join may scan excluded room IDs; zero JS hydration does not prove constant physical rows or time. No production/release qualification.'},null,2));
