import { constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TwilioConnectionRegistry } from './twilio-connection-registry.mjs';
import { createTwilioConnections } from './twilio-connections.mjs';
const names=['ROOM_TWILIO_REGISTRY_FILE','ROOM_TWILIO_KEY_FILE','ROOM_TWILIO_ACCOUNT_ID','ROOM_TWILIO_CONNECTION_ID'];
const fail=()=>{const e=new Error('Messaging private configuration is invalid');e.code='twilio_private_configuration_invalid';throw e;};

// Opt-in account controls only. Opens existing private stores, creates no grant
// or session, starts no webhook listener, and makes no provider/network calls.
export function createTwilioRuntime({env=process.env,store,sourceRoot=fileURLToPath(new URL('../',import.meta.url))}) {
  if(names.every(n=>!env[n]))return null;
  let db,registry,key;
  try {
    if(names.some(n=>!env[n]))fail();
    const paths=names.slice(0,2).map(n=>env[n]),root=realpathSync(sourceRoot);
    if(new Set(paths).size!==2)fail();
    for(const path of paths) {
      const rel=relative(root,path);
      if(!isAbsolute(path)||realpathSync(path)!==path||!(rel==='..'||rel.startsWith('../')||isAbsolute(rel)))fail();
      const parent=lstatSync(dirname(path)),stat=lstatSync(path);
      if(!parent.isDirectory()||parent.uid!==process.getuid()||(parent.mode&0o077)
        ||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077))fail();
    }
    const fd=openSync(paths[1],constants.O_RDONLY|constants.O_NOFOLLOW);
    try {if(fstatSync(fd).size!==32)fail();key=readFileSync(fd);}finally{closeSync(fd);}
    const check=new DatabaseSync(paths[0],{readOnly:true});
    try {const tables=check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if(tables.length!==1||tables[0].name!=='twilio_connections_v1')fail();
    }finally{check.close();}
    const account=store.account(env.ROOM_TWILIO_ACCOUNT_ID);if(!account?.active)fail();
    const binding={accountId:account.id,connectionId:env.ROOM_TWILIO_CONNECTION_ID,authEpoch:account.authEpoch};
    db=new DatabaseSync(paths[0]);registry=new TwilioConnectionRegistry({db,key});
    const state=registry.status(binding);if(!['active','disconnected'].includes(state.state))fail();
    if(state.state==='active')registry.withGrant({...binding,expectedRevision:state.revision},()=>null);
    const row=db.prepare('SELECT address FROM twilio_connections_v1 WHERE account_id=? AND connection_id=?').get(binding.accountId,binding.connectionId);
    if(!/^(?:whatsapp:)?\+[1-9][0-9]{6,14}$/.test(row?.address))fail();
    const provider=row.address.startsWith('whatsapp:')?'whatsapp':'sms';
    const connections=createTwilioConnections({store,registry,connections:[{...binding,provider}]});let closed=false;
    return {connections,close(){if(closed)return;closed=true;registry.close();db.close();}};
  }catch {registry?.close();db?.close();fail();}
  finally{key?.fill(0);}
}
