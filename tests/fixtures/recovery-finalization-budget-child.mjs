// Actual durable operator protocol. External exits occur either after a committed
// response or at an injected checkpoint save inside its real transaction.
import {readFileSync,writeFileSync,writeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {RoomStore} from '../../server/store.mjs';
import {operatorRestoreResponse} from '../../server/restore-ndjson.mjs';
import {restoreProgress} from '../../server/restore-admission.mjs';
const [action,filename,source]=process.argv.slice(2),store=new RoomStore(filename);
const token=['synthetic','finalization','operator'].join('-'),hash=value=>createHash('sha256').update(value).digest('hex');
const finish=value=>{writeSync(1,JSON.stringify(value)+'\n');process.exit(77);};
const before=restoreProgress(store.db),input=action==='retry'?JSON.parse(readFileSync(filename+'.pending.json','utf8')):{restoreId:before.restore_id,sourceSeal:before.seal?.id,expectedRevision:before.revision,requestId:'operator-'+before.revision};
if(action==='lost-ack')writeFileSync(filename+'.pending.json',JSON.stringify(input),{mode:0o600});
const prepare=store.db.prepare.bind(store.db);let rows=0,bytes=0;const prefix=[];
store.db.prepare=sql=>{
 const statement=prepare(sql),checkpoint=sql.startsWith('UPDATE current_restore_admission SET phase=?,revision=revision+1');
 const addressed=/^SELECT .* FROM "([a-z_]+)" WHERE rowid=\?$/.exec(sql);
 if(!addressed&&!(checkpoint&&action==='interrupted-save'))return statement;
 return new Proxy(statement,{get(target,key){const fn=Reflect.get(target,key,target);if(typeof fn!=='function')return fn;
  if(checkpoint&&key==='run')return(...args)=>{fn.apply(target,args);finish({phase:'interrupted-save',beforeRevision:before.revision,insideTransaction:store.db.isTransaction});};
  if(addressed&&key==='get')return(...args)=>{const row=fn.apply(target,args);if(row){rows++;bytes+=Object.values(row).reduce((n,v)=>n+(typeof v==='string'?Buffer.byteLength(v):0),0);if(prefix.length<5)prefix.push({table:addressed[1],rowSha256:hash(JSON.stringify(row))});}return row;};
  return fn.bind(target);
 }});
};
const ingest=action==='ingest',response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+token,...(!ingest?{'content-type':'application/json'}:{})},body:ingest?readFileSync(source,'utf8'):JSON.stringify(input)}),token,store);
const wire=await response.text(),result=JSON.parse(wire),state=restoreProgress(store.db);
if(![200,202].includes(response.status))throw Error(JSON.stringify({status:response.status,result}));
if(action==='lost-ack')writeFileSync(filename+'.server-result.sha',hash(wire),{mode:0o600});
if(action==='retry'&&readFileSync(filename+'.server-result.sha','utf8')!==hash(wire))throw Error('exact retry changed response bytes');
finish({phase:action,status:response.status,pending:result.pending,verified:result.verified,revision:state.revision,restoreId:state.restore_id,frontier:{phase:state.phase,table:state.progress?.tableIndex,after:state.progress?.after,rows:state.progress?.rows,audit:state.progress?.audit?.stage},rows,bytes,prefix,events:prepare('SELECT count(*) n FROM events').get().n,operatorActions:prepare('SELECT count(*) n FROM operator_actions').get().n,exactRetry:action==='retry'});
