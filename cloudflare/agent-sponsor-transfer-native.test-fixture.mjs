// Synthetic local qualification doors; production entrypoint does not expose them.
import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {AccessRequests} from '../server/access-requests.mjs';
import {linkWithProof} from '../tests/helpers/link-with-proof.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {createHash} from 'node:crypto';
import {createOAuthProvider} from '../server/oauth-provider.mjs';
import {createMcpInviteOAuth,inviteOAuthDatabase} from '../server/mcp-invite-oauth.mjs';
const tokenTables=['oauth_provider_codes','oauth_provider_access_tokens','oauth_provider_refresh_tokens','oauth_invite_codes','oauth_invite_access_tokens','oauth_invite_refresh_tokens','oauth_invite_grants'];
export class AgentAdoptionRoom extends ProjectRoom {
 async fetch(request){
  const path=new URL(request.url).pathname,store=this.store;
  if(path==='/__seed'){
   const identity=store.identities.create('Existing Claude'),events=initialRoom('commons');events[1].data.kind='agent';
   events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'john',displayName:'John',kind:'human',permissions:[]}}));
   events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'claude',identityId:identity.identityId,displayName:'Existing Claude',kind:'agent',permissions:['accept_work']}}));
   store.initialize(events,{representation:'normalized-current-v1'});const owner=store.issueAccessKey('commons','owner');linkWithProof(store,owner,'commons',identity,{memberId:'claude',permissions:['accept_work']});
   const account=store.bindHumanAccount('commons','john'),slot=store.createAccountSessionSlot(),auth=store.loginAccountSession(slot.token,store.issueAccountAccessKey(account.id),0);
   await this.ctx.storage.put('test-owner',owner);
   return Response.json({slot:slot.token,csrf:auth.csrf,identityId:identity.identityId});
  }
  if(path==='/__approve'){
   const started=performance.now(),beforeRows=store.db.rowsRead;
   const row=store.db.prepare("SELECT request_id FROM access_requests WHERE room_id='commons' AND status='pending_upgrade'").get();
   try{
    if(new URL(request.url).searchParams.has('fault'))store.db.exec("CREATE TRIGGER fail_adoption_save BEFORE UPDATE OF status ON access_requests WHEN NEW.status='approved' BEGIN SELECT RAISE(ABORT,'injected save failure');END");
    const result=new AccessRequests(store).decide(await this.ctx.storage.get('test-owner'),'commons',row.request_id,{decision:'approve'});return Response.json({...result,cost:{rowsRead:store.db.rowsRead-beforeRows,clockMs:Math.round(performance.now()-started)}});
   }catch(error){return Response.json({error:error.code??'fault',message:error.message},{status:422});}
   finally{if(new URL(request.url).searchParams.has('fault'))store.db.exec('DROP TRIGGER fail_adoption_save');}
  }
  if(path==='/__token-noise'){
   const rows=Number(new URL(request.url).searchParams.get('rows'));if(![0,4096].includes(rows))throw Error('invalid synthetic size');
   const client={clientId:'noise',name:'Unrelated synthetic history',redirectUris:['https://client.example/callback']};
   createMcpInviteOAuth({store,clients:[client],resource:'https://room.example/mcp'});
   for(const db of [store.db,inviteOAuthDatabase(store.db)]){
    const provider=createOAuthProvider({db,clock:()=>store.now()});provider.registerClient(client);
    const verifier='x'.repeat(43),code=provider.issueCode({clientId:client.clientId,userId:'unrelated-history',redirectUri:client.redirectUris[0],scopes:['chat:read'],codeChallenge:createHash('sha256').update(verifier).digest('base64url')}).code;
    provider.exchangeCode({code,clientId:client.clientId,redirectUri:client.redirectUris[0],codeVerifier:verifier});
   }
   store.transaction(()=>{
    store.db.prepare('INSERT INTO oauth_invite_grants(id,room_id,identity_id,member_id,identity_epoch,invite_hash,sponsor_member_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run('noise-base','unrelated-room','unrelated-identity','unrelated-member','a'.repeat(64),'b'.repeat(64),'unrelated-sponsor',store.now(),store.now()+86400000);
    for(const table of tokenTables){
     const columns=store.db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name),key=columns[0],source=store.db.prepare(`SELECT "${key}" value FROM ${table} LIMIT 1`).get().value;
     const insert=store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ?,${columns.slice(1).join(',')} FROM ${table} WHERE "${key}"=?`);
     for(let index=0;index<rows;index++)insert.run('noise-'+index,source);
    }
   });return Response.json({additionalUnrelatedRows:rows*tokenTables.length});
  }
  if(path==='/__token-facts'){
   const facts=[];for(const table of tokenTables){
    const key=store.db.prepare(`PRAGMA table_info(${table})`).all()[0].name,hash=createHash('sha256');let after=null,count=0;
    for(;;){const rows=store.db.prepare(`SELECT * FROM ${table}${after===null?'':` WHERE "${key}">?`} ORDER BY "${key}" LIMIT 64`).all(...(after===null?[]:[after]));if(!rows.length)break;
     for(const row of rows){hash.update(JSON.stringify(row)+'\n');count++;}after=rows.at(-1)[key];}
    facts.push({table,count,sha256:hash.digest('hex')});
   }return Response.json(facts);
  }
  if(path==='/__facts'){
   const state=store.agentSponsorAuthority('commons',['john','claude']);auditRecovery(store);
   return Response.json({ownerId:state.ownerId,agent:state.members.claude,requests:store.db.prepare('SELECT request_id,status FROM access_requests').all(),identityCount:store.db.prepare('SELECT count(*) n FROM agent_identities').get().n});
  }
  return super.fetch(request);
 }
}
export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('adoption').fetch(new Request(request,{headers}));}};
