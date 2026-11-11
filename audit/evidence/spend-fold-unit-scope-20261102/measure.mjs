// Reproducible local measurement; no live data or provider calls.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=resolve(process.argv[2]??fileURLToPath(new URL('../../../',import.meta.url)));
const moduleAt=name=>import(pathToFileURL(resolve(root,'server',name)).href);
const {RoomStore}=await moduleAt('store.mjs'),{initialRoom}=await moduleAt('bootstrap.mjs'),{operatorNormalization}=await moduleAt('operator-normalization.mjs'),{setTier}=await moduleAt('autonomy-tiers.mjs');
const {setSpendAllowance,spendAllowanceReport,spendAuthorityRoom,spendAllowanceForRoom}=await moduleAt('spend-allowance.mjs');
// Fixture function copied byte-exact from0477; SHA256 194560b345307fea09d527b212f716a06e5b9089ec9b6548da7a5b4bb928862c
function fixture(t,{extra=0}={}){const now=Date.now(),s=new RoomStore(':memory:',{now:()=>now});s.initialize(initialRoom());t.after(()=>s.close());const owner=s.issueAccessKey('commons','owner'),send=(type,data,token=owner)=>s.command(token,'commons',{id:randomUUID(),type,data});send('member.added',{memberId:'agent',displayName:'Vega',kind:'agent',permissions:['accept_work','complete_work'],accountableHumanId:'owner'});const agent=s.issueAccessKey('commons','agent');setTier(s.db,'commons','agent','t2_standard',{updatedBy:'owner',nowMs:s.now()});
 const work=(id)=>send('work.proposed',{workItemId:id,title:'Spend '+id,definitionOfDone:'Save result',accountableMemberId:'agent',mode:'read'}),revision=id=>s.room('commons').state.workItems[id].revision;
 for(const [id,cap,outcome,spend]of [['spent',80,'done',40],['held',50,'failed',null],['live',30,null,null]]){work(id);send('session.started',{workItemId:id,expectedRevision:revision(id),budget:{maxSpendCents:cap}},agent);if(outcome)send('session.stopped',{workItemId:id,expectedRevision:revision(id),status:outcome,...(spend===null?{}:{spendCents:spend})},agent);}
 for(let i=0;i<extra;i++)work('extra-'+String(i).padStart(3,'0'));
 setSpendAllowance(s,owner,'commons',{allowanceCents:140,periodDays:30,requestId:'source-allowance'});const expected=spendAllowanceReport(s.room('commons').state,s.now());const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'spend-adoption',reason:'Synthetic exact spend accounting'},true);s.room=()=>{throw Error('forbidden whole-room spend hydration');};return{s,owner,agent,expected};}

const samples=[];
for(const extra of [0,40,497]){
 const closers=[],fixtureStart=performance.now(),f=fixture({after:fn=>closers.push(fn)},{extra}),fixtureMs=performance.now()-fixtureStart;
 const authority=spendAuthorityRoom(f.s,'commons',['agent']),original=f.s.db.prepare.bind(f.s.db);let counts;
 f.s.db.prepare=sql=>{const st=original(sql);return new Proxy(st,{get(target,k){const value=Reflect.get(target,k,target);if(!['get','all','run'].includes(k))return typeof value==='function'?value.bind(target):value;return(...args)=>{counts[k]++;const result=value.apply(target,args);if(k==='all')counts.returnedRows+=result.length;else if(k==='get'&&result!==undefined)counts.returnedRows++;if(result!==undefined)counts.serializedResultBytes+=Buffer.byteLength(JSON.stringify(result));if(sql.startsWith('SELECT revision,digest,body FROM work_entities'))counts.workBodyReads++;if(sql.includes('FROM sqlite_master WHERE'))counts.catalogCalls++;return result;};}});};
 const measured=[];for(let n=0;n<2;n++){counts={get:0,all:0,run:0,returnedRows:0,serializedResultBytes:0,workBodyReads:0,catalogCalls:0};const start=performance.now(),result=spendAllowanceForRoom(f.s,'commons',authority,f.s.now());const elapsedMs=performance.now()-start;assert.equal(result.committedCents,120);assert.equal(counts.workBodyReads,extra+3);measured.push({elapsedMs,...counts,committedCents:result.committedCents});}
 f.s.db.prepare=original;samples.push({workItems:extra+3,fixtureMsExcluded:fixtureMs,measured});for(const close of closers)close();
}
console.log('SPEND_LEDGER_MEASURE '+JSON.stringify({runtime:'Node SQLite',clock:'wall-only; not CPU',scope:'ledger fold only, excludes fixture creation/auth/authority/priced dispatch',rowMetric:'returned rows, not physical SQLite engine rows',bytesMetric:'JSON-serialized statement results, not physical IO or bind bytes',samples}));
