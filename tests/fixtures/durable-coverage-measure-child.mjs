// Test-only returned-cell metrics; not SQLite physical reads or CPU accounting.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [root,mode,filename,input]=process.argv.slice(2);
const {RoomStore}=await import(pathToFileURL(join(root,'server/store.mjs')));
const {createBackupReplaySession,operatorRestoreResponse}=await import(pathToFileURL(join(root,'server/restore-ndjson.mjs')));
const began=performance.now(),store=new RoomStore(filename),body=readFileSync(input,'utf8'),prepare=store.db.prepare.bind(store.db);
const metrics={inputBytes:Buffer.byteLength(body),payloadRows:0,payloadTextBlobBytes:0,metadataRows:0,metadataTextBlobBytes:0};
let verification=false,verifiedRows=0;const prefix=[];
const bytes=row=>Object.values(row).reduce((n,v)=>n+(typeof v==='string'?Buffer.byteLength(v):ArrayBuffer.isView(v)?v.byteLength:v instanceof ArrayBuffer?v.byteLength:0),0);
const emit=extra=>{console.log(JSON.stringify({...extra,metrics,elapsedMs:Number((performance.now()-began).toFixed(3)),clockOnly:true}));process.exit(77);};
store.db.prepare=sql=>{
 if(sql==='SELECT count(*) AS n FROM "accounts"')verification=true;
 const statement=prepare(sql),select=/^SELECT /i.test(sql),payload=select&&!/sqlite_master|sqlite_schema|current_restore_admission|count\(|length\(|^SELECT (?:1|rowid AS)/i.test(sql);
 return new Proxy(statement,{get(target,key){const fn=Reflect.get(target,key,target);if(!select||!['get','all','iterate'].includes(key))return typeof fn==='function'?fn.bind(target):fn;
 const note=row=>{if(!row)return;metrics[payload?'payloadRows':'metadataRows']++;metrics[payload?'payloadTextBlobBytes':'metadataTextBlobBytes']+=bytes(row);if(mode==='old-budget'&&verification&&/^SELECT \* FROM "[a-z_]+" (?:WHERE|ORDER BY)/.test(sql)){verifiedRows++;if(prefix.length<5)prefix.push({table:/FROM "([a-z_]+)"/.exec(sql)[1],sha256:createHash('sha256').update(JSON.stringify(row)).digest('hex')});if(verifiedRows===128)emit({phase:'interrupted-uncommitted-coverage',verifiedRows,prefix,admission:prepare('SELECT state,restore_id FROM current_restore_admission').get()});}};
 return(...args)=>{const result=fn.apply(target,args);if(key==='get')note(result);else if(key==='all')result.forEach(note);else return(function*(){for(const row of result){note(row);yield row;}})();return result;};}});
};
if(mode==='partial'){const session=createBackupReplaySession(store);session.writeText(body);emit({phase:'partial',pending:store.restoreStatus().pending});}
if(mode==='old-budget'){const session=createBackupReplaySession(store,{resume:true});session.writeText(body);session.finish();throw Error('old budget seam missing');}
const token='synthetic-durable-restore-00000000000000',json=mode==='step'||mode==='warmsteps';
const steps=[];let wire=body,result,status;
for(let n=0;n<(mode==='warmsteps'?3:1);n++){
 const before={...metrics},started=performance.now();
 const response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore'+(json?'':'?resume=1'),{method:'POST',headers:{Authorization:'Bearer '+token,...(json?{'Content-Type':'application/json'}:{})},body:wire}),token,store);
 status=response.status;result=await response.json();
 steps.push({status,elapsedMs:Number((performance.now()-started).toFixed(3)),rows:result.progress?.rows,metrics:Object.fromEntries(Object.keys(metrics).filter(key=>key!=='inputBytes').map(key=>[key,metrics[key]-before[key]]))});
 if(status!==202)break;
 wire=JSON.stringify({restoreId:result.restoreId,sourceSeal:result.sourceSeal,expectedRevision:result.revision,requestId:'warm_'+n});
}
emit({status,result,steps});
