import { constants,openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TwilioConnectionRegistry } from './twilio-connection-registry.mjs';
import { createTwilioConnections } from './twilio-connections.mjs';
import { MessagingReceiveGrants, assertMessagingReceiveSchema } from './messaging-receive-grants.mjs';
import { createTwilioWebhookServer } from './twilio-webhook.mjs';
const names=['ROOM_TWILIO_REGISTRY_FILE','ROOM_TWILIO_KEY_FILE','ROOM_TWILIO_ACCOUNT_ID','ROOM_TWILIO_CONNECTION_ID'];
const fail=()=>{const e=new Error('Messaging private configuration is invalid');e.code='twilio_private_configuration_invalid';throw e;};
export function twilioWebhookPort(env=process.env){
  const value=env.ROOM_TWILIO_WEBHOOK_PORT;
  if(!value)return null;
  if(typeof value!=='string'||!/^\d{4,5}$/.test(value)||Number(value)<1024||Number(value)>65535
    ||!env.ROOM_TWILIO_RECEIVE_GRANTS_FILE||!env.ROOM_TWILIO_WEBHOOK_PATH)fail();
  return Number(value);
}

// Opt-in account controls only. Opens existing private stores, creates no grant
// or session, starts no webhook listener, and makes no provider/network calls.
export function createTwilioRuntime({env=process.env,store,sourceRoot=fileURLToPath(new URL('../',import.meta.url))}) {
  const receiveFile=env.ROOM_TWILIO_RECEIVE_GRANTS_FILE,webhookPath=env.ROOM_TWILIO_WEBHOOK_PATH;
  twilioWebhookPort(env);
  if(names.every(n=>!env[n])&&!receiveFile&&!webhookPath)return null;
  let db,registry,key,grantDb,grants,webhook;
  try {
    if(names.some(n=>!env[n]))fail();
    if(Boolean(receiveFile)!==Boolean(webhookPath)||webhookPath&&!/^\/webhooks\/twilio\/[A-Za-z0-9_-]{1,128}$/.test(webhookPath))fail();
    const paths=[...names.slice(0,2).map(n=>env[n]),...(receiveFile?[receiveFile]:[])],root=realpathSync(sourceRoot);
    if(new Set(paths).size!==paths.length)fail();
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
    if(receiveFile){
      const check=new DatabaseSync(receiveFile,{readOnly:true});
      try{assertMessagingReceiveSchema(check);}finally{check.close();}
      grantDb=new DatabaseSync(receiveFile);grants=new MessagingReceiveGrants({db:grantDb,store});
      const getBinding=()=>{
        const current=store.account(binding.accountId),b={...binding,authEpoch:current.authEpoch};
        const status=registry.status(b);
        return registry.withGrant({...b,expectedRevision:status.revision},connection=>{
          const url=new URL(connection.webhookUrl);
          if(url.pathname!==webhookPath||url.search)fail();
          return grants.currentBinding({accountId:b.accountId,connectionId:b.connectionId,provider,connectionRevision:status.revision});
        });
      };
      // Validate active provider URL now, but do not require or create a grant.
      if(state.state==='active')registry.withGrant({...binding,expectedRevision:state.revision},connection=>{
        const url=new URL(connection.webhookUrl);if(url.pathname!==webhookPath||url.search)fail();
      });
      webhook=createTwilioWebhookServer({store,routes:[{path:webhookPath,background:{registry,grants,getBinding}}]});
    }
    const connections=createTwilioConnections({store,registry,receiveGrants:grants,connections:[{...binding,provider}]});let closed=false;
    return {connections,webhook,close(){if(closed)return;closed=true;webhook?.closeAllConnections();webhook?.close();grants?.close();grantDb?.close();registry.close();db.close();}};
  }catch {webhook?.close();grants?.close();grantDb?.close();registry?.close();db?.close();fail();}
  finally{key?.fill(0);}
}
