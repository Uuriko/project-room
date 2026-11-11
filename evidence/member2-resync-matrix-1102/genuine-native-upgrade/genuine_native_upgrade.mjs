// Two actual runtime bundles, one disposable Native persistence directory.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [oldRoot,newRoot]=process.argv.slice(2);
assert.ok(oldRoot&&newRoot&&process.argv.length===4,'Supply pinned old and new checkouts');
const git=process.env.LOCAL_LAB_GIT??'git';
const pins=[oldRoot,newRoot].map(root=>{
 execFileSync(git,['-C',root,'diff','--quiet','HEAD','--']);
 return execFileSync(git,['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
});
assert.deepEqual(pins,['8e65a6e73ae191ffa7fc89c2e88fa382ad2ac000','2ebce68b3c556f313476716afdae84f2a2b33e6d']);
const require=createRequire(newRoot+'/cloudflare/package.json');
const {build}=await import(pathToFileURL(require.resolve('esbuild')));
const {Miniflare}=await import(pathToFileURL(require.resolve('miniflare')));
const fixture=`
import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createHash} from 'node:crypto';
const authTables=['credentials','accounts','account_credentials','account_session_slots'];
const authSnapshot=s=>createHash('sha256').update(JSON.stringify(authTables.map(table=>[table,s.db.prepare('SELECT * FROM '+table).all().map(row=>JSON.stringify(row)).sort()]))).digest('hex');
export class GenuineUpgradeRoom extends ProjectRoom {
 async fetch(request){
  const s=this.store,path=new URL(request.url).pathname;
  if(path==='/__seed'){
   s.initialize(initialRoom('legacy-preserved'),{representation:null});
   s.createAccount('kept-account');
   const key=s.issueAccessKey('legacy-preserved','owner');
   const accountKey=s.issueAccountAccessKey('kept-account');
   const slot=s.createAccountSessionSlot();
   const login=s.loginAccountSession(slot.token,accountKey,0);
   await this.ctx.storage.put('fixture',{key,slot:slot.token,binding:login.sessionBinding});
  }
  const f=await this.ctx.storage.get('fixture');
  if(!f)throw Error('Missing original persisted fixture');
  const guard=s.db.prepare("SELECT sql FROM sqlite_master WHERE name='current_room_permit_update'").get().sql;
  return Response.json({snapshot:authSnapshot(s),
   rooms:s.db.prepare('SELECT * FROM rooms ORDER BY id').all(),
   member:s.authenticate(f.key,'legacy-preserved').member.id,
   account:s.authenticateAccountSession(f.slot,null,f.binding).account.id,
   pending:s.restoreStatus().pending,
   heads:s.db.prepare('SELECT count(*) n FROM current_room_head').get().n,
   guardFormat:guard.includes('normalized-current-v1-native-work-5')?5:guard.includes('normalized-current-v1-native-work-6')?6:null});
 }
}
export default {fetch(request,env){return env.ROOM.getByName('genuine-upgrade').fetch(request);}};
`;
const scripts=await Promise.all([oldRoot,newRoot].map(async root=>(await build({stdin:{contents:fixture,resolveDir:root+'/cloudflare',sourcefile:'genuine-upgrade-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text));
const directory=await mkdtemp(join(tmpdir(),'genuine-native-upgrade-'));
let mf;
const observations=[];
const create=script=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'GenuineUpgradeRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example'},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});
const request=async(path,phase)=>{
 const response=await mf.dispatchFetch('https://room.example/'+path);
 assert.equal(response.status,200,await response.clone().text());
 const facts=await response.json();
 assert.equal(facts.member,'owner');assert.equal(facts.account,'kept-account');
 assert.equal(facts.pending,false);assert.equal(facts.heads,0);
 observations.push({phase,guardFormat:facts.guardFormat,preservedAuthSnapshot:facts.snapshot,roomsSha256:createHash('sha256').update(JSON.stringify(facts.rooms)).digest('hex')});
 return facts;
};
const started=performance.now();
try{
 mf=create(scripts[0]);const before=await request('__seed','genuine-old-seed');assert.equal(before.guardFormat,5);
 await mf.dispose();mf=undefined;
 mf=create(scripts[1]);const after=await request('__facts','first-new-cold-open');assert.equal(after.guardFormat,6);
 assert.deepEqual({...after,guardFormat:5},before);
 await mf.dispose();mf=undefined;
 mf=create(scripts[1]);const retried=await request('__facts','second-new-cold-open');assert.deepEqual(retried,after);
 console.log(JSON.stringify({schema:'member2-genuine-native-upgrade-v1',pass:true,pins,node:process.version,compatibilityDate:'2026-07-30',bundleSha256:scripts.map(s=>createHash('sha256').update(s).digest('hex')),observations,wallSeconds:(performance.now()-started)/1000,limits:'Synthetic local legacy data only; no populated-format migration, production state, or current composition qualification. No guard SQL relabeling or schema stamp deletion.'},null,2));
}finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
