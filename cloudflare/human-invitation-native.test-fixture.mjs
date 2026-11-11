// Synthetic local-only fixture doors; never part of production routing.
import {createHash,randomBytes} from 'node:crypto';
import {ProjectRoom} from './room.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {auditRecovery} from '../server/recovery.mjs';
const digest=s=>createHash('sha256').update(JSON.stringify(['agent_identities','identity_links','agent_connections','member_accounts','membership_invitations','membership_invitation_events','membership_invitation_journal','events','commands','credentials','current_room_head','current_room_records','current_room_record_proofs'].map(table=>[table,s.db.prepare('SELECT * FROM '+table).all().map(JSON.stringify).sort()]))).digest('hex');
function login(s,id){s.createAccount(id);const key=s.issueAccountAccessKey(id),slot=s.createAccountSessionSlot(),session=s.loginAccountSession(slot.token,key,0),auth=s.authenticateAccountSession(slot.token);return{token:slot.token,binding:session.sessionBinding,csrf:auth.csrf};}
export class HumanInvitationRoom extends ProjectRoom {
 async fetch(request){
  const s=this.store,path=new URL(request.url).pathname;
  if(path==='/__seed'){
   const owner=s.identities.create('Founder');new AgentRooms(s).create(owner.secret,{roomId:'human-invite',title:'Invite human',purpose:'Coordinate',starter:false});
   const target=login(s,'target'),other=login(s,'other'),invitationToken=randomBytes(32).toString('base64url');
   const f={owner,target,other,invitationToken};await this.ctx.storage.put('fixture',f);return Response.json(f);
  }
  const f=await this.ctx.storage.get('fixture');s.room=()=>{throw Error('unexpected whole-room invitation hydration');};
  if(path==='/__facts'){
   const authority=s.roomAuthority('human-invite'),invitation=s.previewInvitation(f.invitationToken),member=s.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='human-invite' AND member_id='human'").get();
   if(new URL(request.url).searchParams.has('audit'))auditRecovery(s);
   return Response.json({digest:digest(s),ownerId:authority.ownerId,members:Object.keys(authority.members).sort(),invitation:invitation.status,account:member?.account_id??null,ownerAuthenticated:s.authenticate(f.owner.secret,'human-invite').member.id,stats:s.invitationStats(f.owner.secret,'human-invite'),projectionBytes:s.db.prepare("SELECT octet_length(projection) n FROM rooms WHERE id='human-invite'").get().n});
  }
  if(request.headers.get('x-fixture-fault')==='1'){
   const original=s.db.prepare.bind(s.db);let fired=false;
   s.db.prepare=sql=>{const st=original(sql);if(!sql.includes('INSERT INTO member_accounts(room_id,member_id,account_id,origin)'))return st;return new Proxy(st,{get(target,key){const value=Reflect.get(target,key,target);if(key!=='run')return typeof value==='function'?value.bind(target):value;return(...args)=>{value.apply(target,args);fired=true;throw Error('injected invitation binding save fault');};}});};
   try{const r=await super.fetch(request),headers=new Headers(r.headers);headers.set('x-fixture-fired',String(fired));return new Response(r.body,{status:r.status,headers});}finally{s.db.prepare=original;}
  }
  return super.fetch(request);
 }
}
export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('human-invitation').fetch(new Request(request,{headers}));}};
