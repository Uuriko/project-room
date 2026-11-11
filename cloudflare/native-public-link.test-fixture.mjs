import {CurrentEventsRoom} from './current-events-worker.test-fixture.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {publicRoomView} from '../server/public-rooms.mjs';
import {AccessRequests} from '../server/access-requests.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {createHostedRoomMcp} from '../server/mcp-room-profile.mjs';
export class NativePublicRoom extends CurrentEventsRoom {
 async fetch(request){const path=new URL(request.url).pathname,s=this.store;try{
  if(path==='/seed'){const owner=s.identities.create('Native founder'),peer=s.identities.create('Native collaborator'),mcpPeer=s.identities.create('Native MCP collaborator');new AgentRooms(s).create(owner.secret,{roomId:'native-public',title:'Native public project',purpose:'Share useful work',starter:false,visibility:'private'});s.command(owner.secret,'native-public',{id:'before',type:'message.posted',data:{messageId:'before',body:'PRIVATE BEFORE JOIN'}});await this.ctx.storage.put('saved',{owner,peer,mcpPeer});return Response.json({ok:true});}
  const {owner,peer,mcpPeer}=await this.ctx.storage.get('saved');s.shareLinks.personalInvite=()=>{throw Error('Native publication must not mint link');};s.room=()=>{throw Error('Whole room hydration forbidden');};
  if(path==='/defaults'){
   const rooms=new AgentRooms(s);rooms.create(owner.secret,{roomId:'default-open',title:'New open project',purpose:'Useful work',starter:false});rooms.create(owner.secret,{roomId:'explicit-private',title:'Private project',purpose:'Private work',starter:false,visibility:'private'});
   if(publicRoomView(s,'default-open').document.join.mode!=='open')throw Error('creation default is not open');
   if(s.db.prepare('SELECT 1 FROM public_rooms WHERE slug=?').get('explicit-private'))throw Error('private creation published');
   const joined=new AccessRequests(s).request('default-open',{identityId:peer.identityId,displayName:'Native collaborator',requestedPermissions:[],requestId:'default-join'},peer.secret);if(joined.status!=='approved'||s.authenticate(peer.secret,'default-open').member.historyGuest!==true)throw Error('default guest admission failed');
   return Response.json({ok:true});
  }
  if(path==='/open'){
   const original=s.db.prepare.bind(s.db);let injected=false;s.db.prepare=sql=>{const st=original(sql);if(!sql.startsWith('INSERT INTO public_rooms'))return st;return new Proxy(st,{get(target,key){const v=Reflect.get(target,key,target);if(key!=='run')return typeof v==='function'?v.bind(target):v;return(...args)=>{v.apply(target,args);injected=true;throw Error('synthetic publication save failure');};}});};
   try{s.command(owner.secret,'native-public',{id:'public-on',type:'room.public_page_set',data:{enabled:true}});throw Error('fault not reached');}catch(e){if(e.message!=='synthetic publication save failure')throw e;}finally{s.db.prepare=original;}
   if(!injected||s.db.prepare('SELECT count(*) n FROM public_rooms').get().n!==0)throw Error('publication rollback differs');
   s.command(owner.secret,'native-public',{id:'public-on',type:'room.public_page_set',data:{enabled:true}});
   if(publicRoomView(s,'native-public').document.join.mode!=='request')throw Error('showcase widened admission');
   s.command(owner.secret,'native-public',{id:'link-on',type:'room.join_link_set',data:{enabled:true}});const page=publicRoomView(s,'native-public').document;
   if(page.join.mode!=='open'||page.agentJoin.admission!=='open')throw Error('native page not open');
   new AccessRequests(s).request('native-public',{identityId:peer.identityId,displayName:'Native collaborator',requestedPermissions:[],requestId:'native-public-join'},peer.secret);
   return Response.json({ok:true,counts:publicRoomView(s,'native-public').document.counts,coverage:page.coverage,tasks:page.tasks});
  }
  if(path==='/mcp'){
   const call=createHostedRoomMcp(s),message={jsonrpc:'2.0',id:'public-join',method:'tools/call',params:{name:'room_join',arguments:{roomId:'native-public'}}};
   const joined=await call(message,{authorization:'Bearer '+mcpPeer.secret});
   if(joined.result?.isError||joined.result?.structuredContent?.status!=='approved'||joined.result.structuredContent.memberId!==mcpPeer.identityId)throw Error('Native MCP admission failed');
   const seq=s.headSequence('native-public');await call(message,{authorization:'Bearer '+mcpPeer.secret});
   if(s.headSequence('native-public')!==seq)throw Error('Native MCP retry advanced');
   try{readConversation(s,mcpPeer.secret,'native-public',{messageId:'before'});throw Error('MCP prejoin disclosure');}catch(e){if(e.status!==404)throw e;}
   return Response.json({ok:true,counts:publicRoomView(s,'native-public').document.counts});
  }
  if(path==='/cold'){const seq=s.headSequence('native-public'),retry=new AccessRequests(s).request('native-public',{identityId:peer.identityId,displayName:'Native collaborator',requestedPermissions:[],requestId:'native-public-join'},peer.secret);if(retry.status!=='approved'||s.headSequence('native-public')!==seq)throw Error('retry advanced');
  try{readConversation(s,peer.secret,'native-public',{messageId:'before'});throw Error('prejoin disclosure');}catch(e){if(e.status!==404)throw e;}
  const before={...this.stats};s.command(peer.secret,'native-public',{id:'welcome',type:'message.posted',data:{messageId:'welcome',body:'Native useful welcome'}});const cost=Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]]));auditRecovery(s);return Response.json({ok:true,counts:publicRoomView(s,'native-public').document.counts,cost});}
  throw Error('Unknown test path');
 }catch(e){return Response.json({code:e.code,message:e.message},{status:e.status??500});}}
}
export default{fetch:(request,env)=>env.ROOM.getByName('native-public').fetch(request)};
