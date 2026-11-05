// Synthetic local qualification only; these fixture routes are never deployed.
import {createHash,randomBytes} from 'node:crypto';
import {NormalizationAuthRoom} from './operator-normalization-auth.test-fixture.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {normalizationAuthFacts} from '../tests/helpers/operator-normalization-auth-source.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const snapshot=s=>hash(JSON.stringify(['credentials','identity_links','agent_connections','agent_connection_operations','events','commands','current_room_head','current_room_records','current_room_record_proofs','operator_actions'].map(t=>[t,s.db.prepare('SELECT * FROM '+t).all()])));
export class ConnectionLifecycleRoom extends NormalizationAuthRoom {
 async fetch(request){
  const s=this.store,path=new URL(request.url).pathname;
  if(path==='/__seed'){
   const base=await super.fetch(request);if(base.status!==200)return base;
   const f=await this.ctx.storage.get('auth-fixture'),slot=s.createAccountSessionSlot(),session=s.loginAccountSession(slot.token,s.issueAccountAccessKey(f.ownerAccount),0),auth=s.authenticateAccountSession(slot.token),identity=s.identities.create('Sirius Native'),proof=s.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'commons'});
   const v={session:{token:slot.token,binding:session.sessionBinding,csrf:auth.csrf},identity,first:randomBytes(32).toString('base64url'),next:randomBytes(32).toString('base64url')};await this.ctx.storage.put('connection-fixture',v);
   return Response.json({session:v.session,create:{action:'create',requestId:'native-create',memberId:'native-new',displayName:'Sirius Native',access:'contribute',keyHash:hash(v.first),expiresAt:s.now()+3600000,expectedOwnerRevision:0,identityId:identity.identityId,identityLinkCode:proof.linkCode},rotate:{action:'rotate',requestId:'native-rotate',memberId:'native-new',expectedOwnerRevision:0,expectedGeneration:1,expectedMemberRevision:0,keyHash:hash(v.next),expiresAt:s.now()+3600000}});
  }
  const f=await this.ctx.storage.get('auth-fixture'),v=await this.ctx.storage.get('connection-fixture');s.now=()=>f.baseNow+2000;if(!path.startsWith('/api/operator/normalization/'))s.room=()=>{throw Error('forbidden whole-room connection hydration');};
  if(path==='/__connection-facts'){
   auditRecovery(s);const attempt = credential => {
    try { return s.authenticate(credential,'commons').member.id; }
    catch { return null; }
   };
   return Response.json({digest:snapshot(s),first:attempt(v.first),next:attempt(v.next),identity:attempt(v.identity.secret),connections:s.agentConnections.list(v.session.token,'commons',v.session.binding),preserved:normalizationAuthFacts(s,f)});
  }
  if(request.headers.get('x-connection-fault')==='1'){
   const original=s.db.prepare.bind(s.db);let fired=false;s.db.prepare=sql=>{const st=original(sql);if(!sql.startsWith('UPDATE agent_connections SET'))return st;return new Proxy(st,{get(target,key){const value=Reflect.get(target,key,target);if(key!=='run')return typeof value==='function'?value.bind(target):value;return(...args)=>{value.apply(target,args);fired=true;throw Error('injected Native rotation save fault');};}});};
   try{const r=await super.fetch(request),headers=new Headers(r.headers);headers.set('x-connection-fired',String(fired));return new Response(r.body,{status:r.status,headers});}finally{s.db.prepare=original;}
  }
  return super.fetch(request);
 }
}
export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('connections').fetch(new Request(request,{headers}));}};
