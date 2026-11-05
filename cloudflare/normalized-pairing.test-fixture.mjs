import {ProjectRoom} from './room.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {createHash} from 'node:crypto';
const tables=['agent_identities','identity_links','agent_member_keys','agent_key_registry','credentials','pairs','events','commands','current_room_head','current_room_records','current_room_record_proofs'];
function digest(s){return createHash('sha256').update(JSON.stringify(tables.map(table=>[table,s.db.prepare('SELECT * FROM '+table).all().map(row=>{if(table==='agent_identities'){const {last_used_at,last_used_ua,mcp_legacy_uses,...authority}=row;return authority;}return row;}).map(JSON.stringify).sort()]))).digest('hex');}
export class NormalizedPairingRoom extends ProjectRoom {
 async fetch(request){
  const s=this.store,path=new URL(request.url).pathname;
  if(path==='/__seed'){
   const owner=s.identities.create('Rowan Hale'),agent=s.identities.create('Kit Arden');
   new AgentRooms(s).create(owner.secret,{roomId:'native-pair',title:'Pairing',purpose:'Same existing identity',starter:false,visibility:'private'});
   const f={owner,agent,now:Date.now()};await this.ctx.storage.put('fixture',f);return Response.json(f);
  }
  const f=await this.ctx.storage.get('fixture');s.now=()=>f.now;
  s.room=()=>{throw Error('native pairing must not hydrate room');};
  if(path==='/__advance'){f.now+=4000;await this.ctx.storage.put('fixture',f);return Response.json({now:f.now});}
  if(path==='/__facts'){
   if(new URL(request.url).searchParams.has('audit'))auditRecovery(s);
   const authority=s.roomAuthority('native-pair');
   return Response.json({digest:digest(s),members:authority.members,identityLinks:s.db.prepare('SELECT count(*) n FROM identity_links WHERE room_id=? AND identity_id=?').get('native-pair',f.agent.identityId).n});
  }
  if(request.headers.get('x-fixture-fault')==='1'){
   const prepare=s.db.prepare.bind(s.db);let fired=false;
   s.db.prepare=sql=>{const q=prepare(sql);if(!sql.includes("UPDATE pairs SET status='approved'"))return q;return new Proxy(q,{get(target,key){const value=target[key];if(key==='run')return(...args)=>{target.run(...args);fired=true;throw Error('injected pair credential save');};return typeof value==='function'?value.bind(target):value;}});};
   try{const response=await super.fetch(request),headers=new Headers(response.headers);headers.set('x-fixture-fired',String(fired));return new Response(response.body,{status:response.status,headers});}finally{s.db.prepare=prepare;}
  }
  return super.fetch(request);
 }
}
export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('normalized-pairing').fetch(new Request(request,{headers}));}};
