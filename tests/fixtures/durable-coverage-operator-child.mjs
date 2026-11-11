import {readFileSync} from 'node:fs';
import {RoomStore} from '../../server/store.mjs';
import {operatorRestoreResponse} from '../../server/restore-ndjson.mjs';
const [filename,input,mode='committed']=process.argv.slice(2),store=new RoomStore(filename),body=readFileSync(input,'utf8'),token='synthetic-durable-restore-00000000000000';
if(mode==='before-commit'){const prepare=store.db.prepare.bind(store.db);store.db.prepare=sql=>{const statement=prepare(sql);if(!/^UPDATE current_restore_admission SET phase=/.test(sql))return statement;return new Proxy(statement,{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{fn.apply(target,args);console.log(JSON.stringify({phase:'after-update-before-commit'}));process.exit(77);};}});};}
const response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body}),token,store);console.log(JSON.stringify({status:response.status,result:await response.json(),phase:'after-committed-response'}));process.exit(77);
