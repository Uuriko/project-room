import { constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TelegramConnectionRegistry } from './telegram-connection-registry.mjs';
import { TelegramReceiveQueue } from './telegram-receive-queue.mjs';
import { createTelegramConnections } from './telegram-connections.mjs';
import { MessagingReceiveGrants,assertMessagingReceiveSchema } from './messaging-receive-grants.mjs';
const names=['ROOM_TELEGRAM_REGISTRY_FILE','ROOM_TELEGRAM_QUEUE_FILE','ROOM_TELEGRAM_KEY_FILE','ROOM_TELEGRAM_ACCOUNT_ID','ROOM_TELEGRAM_CONNECTION_ID'];
const fail=()=>{const error=new Error('Telegram private configuration is invalid');error.code='telegram_private_configuration_invalid';throw error;};
const outside=(root,path)=>{const r=relative(root,path);return r==='..'||r.startsWith('../')||isAbsolute(r);};

// Opt-in: opens preprovisioned stores only, creates no keys/grants, makes no calls.
export function createTelegramRuntime({env=process.env,store,fetchImpl=fetch,sourceRoot=fileURLToPath(new URL('../',import.meta.url))}) {
  if(names.every(n=>!env[n])&&!env.ROOM_TELEGRAM_RECEIVE_GRANTS_FILE)return null;
  let rdb,qdb,gdb,registry,queue,receiveGrants,key;
  try {
    if(names.some(n=>!env[n]))fail();
    const paths=names.slice(0,3).map(n=>env[n]),root=realpathSync(sourceRoot);
    if(env.ROOM_TELEGRAM_RECEIVE_GRANTS_FILE)paths.push(env.ROOM_TELEGRAM_RECEIVE_GRANTS_FILE);
    if(new Set(paths).size!==paths.length)fail();
    for(const path of paths) {
      if(!isAbsolute(path)||realpathSync(path)!==path||!outside(root,path))fail();
      const parent=lstatSync(dirname(path)),stat=lstatSync(path);
      if(!parent.isDirectory()||parent.uid!==process.getuid()||(parent.mode&0o077)
        ||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077))fail();
    }
    const fd=openSync(paths[2],constants.O_RDONLY|constants.O_NOFOLLOW);
    try{if(fstatSync(fd).size!==32)fail();key=readFileSync(fd);}finally{closeSync(fd);}
    const checkSchema=(path,allowed)=>{
      const db=new DatabaseSync(path,{readOnly:true});
      try{const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name).sort();
        if(JSON.stringify(names)!==JSON.stringify([...allowed].sort()))fail();
      }finally{db.close();}
    };
    checkSchema(paths[0],['telegram_connections_v1']);
    checkSchema(paths[1],['telegram_queue_meta','telegram_queue_pages','telegram_queue_lease']);
    if(paths[3]){
      const probe=new DatabaseSync(paths[3],{readOnly:true});
      try{assertMessagingReceiveSchema(probe);}finally{probe.close();}
    }
    const account=store.account(env.ROOM_TELEGRAM_ACCOUNT_ID);
    if(!account?.active)fail();
    const binding={accountId:account.id,authEpoch:account.authEpoch,connectionId:env.ROOM_TELEGRAM_CONNECTION_ID};
    rdb=new DatabaseSync(paths[0]);registry=new TelegramConnectionRegistry({db:rdb,key});
    const state=registry.status(binding);if(!['active','disconnected'].includes(state.state))fail();
    if(state.state==='active')registry.grant(binding); // authenticate encrypted key/config before queue use
    qdb=new DatabaseSync(paths[1]);queue=new TelegramReceiveQueue({db:qdb,key,...binding});queue.pending();
    if(paths[3]){gdb=new DatabaseSync(paths[3]);receiveGrants=new MessagingReceiveGrants({db:gdb,store});}
    const connections=createTelegramConnections({store,registry,connections:[{...binding,queue}],fetchImpl,receiveGrants});
    let closed=false;
    return {connections,close(){if(closed)return;closed=true;receiveGrants?.close();gdb?.close();queue.key.fill(0);registry.close();qdb.close();rdb.close();}};
  }catch{receiveGrants?.close();gdb?.close();queue?.key.fill(0);registry?.close();qdb?.close();rdb?.close();fail();}
  finally{key?.fill(0);}
}
