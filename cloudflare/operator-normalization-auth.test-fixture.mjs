// Local synthetic qualification only. These provisioning/fault doors are not exported by production.
import {ProjectRoom} from './room.mjs';
import {seedNormalizationAuth,normalizationAuthSnapshot,normalizationAuthFacts} from '../tests/helpers/operator-normalization-auth-source.mjs';
import {auditRecovery} from '../server/recovery.mjs';
export class NormalizationAuthRoom extends ProjectRoom {
 async fetch(request){
  const path=new URL(request.url).pathname,s=this.store;
  if(path==='/__seed'){const f=seedNormalizationAuth(s);await this.ctx.storage.put('auth-fixture',f);return Response.json({owner:f.owner,human:f.human.token,hash:normalizationAuthSnapshot(s),facts:normalizationAuthFacts(s,f)});}
  const f=await this.ctx.storage.get('auth-fixture');if(f)s.now=()=>f.baseNow+2000;
  if(path==='/__facts'){auditRecovery(s);return Response.json({hash:normalizationAuthSnapshot(s),facts:normalizationAuthFacts(s,f,{refresh:new URL(request.url).searchParams.has('refresh')})});}
  if(request.headers.get('x-fixture-fault')==='1'){
   const original=s.db.prepare.bind(s.db);let fired=false;
   s.db.prepare=sql=>{const st=original(sql);if(!sql.startsWith('INSERT INTO operator_actions')||!sql.includes('request_id'))return st;return new Proxy(st,{get(target,key){if(key==='run')return(...args)=>{if(args.includes('operator_normalization_adopt')){fired=true;throw Error('injected publication receipt fault');}return target.run(...args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
   try{const response=await super.fetch(request),headers=new Headers(response.headers);headers.set('x-fixture-fired',String(fired));return new Response(response.body,{status:response.status,headers});}finally{s.db.prepare=original;}
  }
  return super.fetch(request);
 }
}
export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('auth').fetch(new Request(request,{headers}));}};
