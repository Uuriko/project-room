// The original pure reducer over explicit previously-folded replay records.
// This is an early dependency plan; callers MUST retain the full oracle until
// checkpoint seeding and every retained event/global expansion are qualified.
import {isDeepStrictEqual} from 'node:util';
import {applyEvent,emptyRoomState,messageChannelId,EVENT_TYPES,RETIRED_REPLAY_EVENT_TYPES} from '../src/events.js';
import {recoveryReplayOrderKey} from './recovery-replay-order.mjs';
import {bindCurrentRecordContext} from '../src/current-record-context.js';
import {replyContextOwners} from '../src/reply-requests.js';
const supported=new Set(['room.created','member.added','member.access_changed','room.history_visibility_set','pair.requested','pair.approved','pair.denied','message.posted','work.proposed','work.accepted','work.started','work.completed','work_claim.updated']);
// These handlers read only addressed member/work/channel records and room scalars.
for(const name of ['ROOM_CHARTER_UPDATED','ROOM_POLICY_SET','ROOM_SPEND_ALLOWANCE_SET','ROOM_SPEND_PRICING_SET','ROOM_DEVELOPMENT_ACCESS_SET','ROOM_TRUST_SET','ROOM_PUBLIC_RECEIPTS_SET','ROOM_PUBLIC_PAGE_SET','ROOM_JOIN_LINK_SET','MEMBER_PUBLIC_NAME_SET','WORK_PUBLIC_SET','ROOM_ARCHIVED','OWNERSHIP_TRANSFERRED','MEMBER_STATUS_UPDATED','NOTIFICATION_PREFERENCES_SET','MEMBER_MUTE_SET','CAPABILITIES_ADVERTISED','ACCESS_REQUESTED','LAND_UPDATED','ROOM_STARTER_SEEDED','AGENT_INVITE_MINTED','ROOM_EXPORTED','DM_CONSENT_CHANGED','DM_POSTED','REFERRAL_COMPLETED','DECISION_RECORDED'])supported.add(EVENT_TYPES[name]);
supported.add(RETIRED_REPLAY_EVENT_TYPES.MESSAGE_REACTION_SET);
for(const type of ['claim.acquired','claim.released','claim.renewed','work.blocked','work.blocker_resolved','work.superseded','verification.recorded','owner.decision_recorded','session.started','session.status_changed','session.stop_requested','session.stopped'])supported.add(type);
const memberFields=['memberId','toMemberId','accountableMemberId','verifierMemberId','humanDecisionMakerId','accountableHumanId','referredBy','producerId','referrerMemberId','refereeMemberId'];
const workMemberFields=['accountableMemberId','verifierMemberId','humanDecisionMakerId','proposedById'];
const messageFields=['replyToId','sourceMessageId','progressMessageId','evidenceMessageId'];
const own=(object,key)=>Object.hasOwn(object,key);
const set=(object,key,value)=>Object.defineProperty(object,key,{value,enumerable:true,writable:true,configurable:true});
export function applyRecoveryReplayStep(reader,incoming,counts,{claimOverlaps}={}){
 if(incoming?.type==='claim.acquired'&&typeof claimOverlaps!=='function')return{supported:false,reason:'claim_overlap_census_incomplete'};
 if(!supported.has(incoming?.type))return{supported:false,reason:'event_dependency_plan_incomplete'};
 if(incoming.type==='member.added'&&[1,2].includes(incoming.data?.displayNamePolicyVersion))return{supported:false,reason:'member_name_census_incomplete'};
 if(!counts||!['members','channels','workItems','replyRequests'].every(key=>Number.isSafeInteger(counts[key])&&counts[key]>=0))throw Error('Invalid independently folded replay counts');
 if(counts.replyRequestsPresent!==undefined&&typeof counts.replyRequestsPresent!=='boolean')throw Error('Invalid replay map presence');
 if(counts.messages!==undefined&&(!Number.isSafeInteger(counts.messages)||counts.messages<0))throw Error('Invalid independently folded replay message count');
 let active=true;
 const cache=new Map(),read=(domain,key)=>{
  if(!active)throw Error('Replay read scope expired');if(typeof key!=='string'||!key)return undefined;
  const address=JSON.stringify([domain,key]);if(cache.has(address))return cache.get(address);
  const value=reader(domain,key);if(typeof value?.then==='function')throw Error('Replay reader must remain synchronous');cache.set(address,value);return value;
 };
 try{
  const state=emptyRoomState(),loaded={members:new Map(),channels:new Map(),workItems:new Map(),replyRequests:new Map(),messages:new Map()},data=incoming.data??{};
  const room=read('metadata','room');state.room=room??null;
  if(counts.replyRequests>0||counts.replyRequestsPresent===true)state.replyRequests={};
  const load=(domain,key)=>{if(typeof key!=='string'||!key||loaded[domain].has(key))return;const value=read(domain,key);loaded[domain].set(key,value);if(value!==undefined){if(domain==='messages')state.messages.push(value);else set(state[domain]??={},key,value);}};
  const workIds=[data.workItemId,data.supersededByWorkItemId];for(const id of workIds)load('workItems',id);
  const members=new Set([incoming.actorId,state.room?.ownerId,...memberFields.map(key=>data[key])]);
  for(const item of loaded.workItems.values())if(item){for(const key of workMemberFields)members.add(item[key]);members.add(item.receipt?.producerId);members.add(item.claim?.holderId);}
  for(const id of members)load('members',id);
  // Accountable human links are explicit stored member references, never an
  // inferred relationship between matching providers, labels or identities.
  for(const member of [...loaded.members.values()])if(member)load('members',member.accountableHumanId);
  for(const key of messageFields)load('messages',data[key]);
  if(incoming.type==='message.posted'){const id=data.messageId||incoming.id;load('messages',id);load('messages',id+':channel');}
  const requestIds=new Set([data.responseToRequestId,data.requestMessageId]);
  for(const [id,message]of loaded.messages)if(message){const owner=read('messageOwner',id);if(owner===undefined)throw Error('Missing independently folded reply owner');if(owner!==null)requestIds.add(owner);}
  for(const id of requestIds)load('replyRequests',id);
  const channels=new Set(['general',data.channelId]);for(const[id,message]of loaded.messages)if(message){channels.add(message.channelId);const channel=read('messageRootChannel',id);if(typeof channel!=='string'||!channel)throw Error('Missing independently folded root channel');channels.add(channel);}
  for(const id of channels)load('channels',id);
  // Only current incoming/known earlier bookkeeping is needed by this pure
  // application. The adapter supplies exact previously-folded values.
  const seen=read('seenEvents',incoming.id);if(seen!==undefined)set(state.seenEvents,incoming.id,seen);
  const earlier=read('seenIdempotencyKeys',incoming.idempotencyKey);if(earlier!==undefined){set(state.seenIdempotencyKeys,incoming.idempotencyKey,earlier);const fingerprint=read('seenEvents',earlier);if(fingerprint!==undefined)set(state.seenEvents,earlier,fingerprint);}
  bindCurrentRecordContext(state,{replyRequestCount:counts.replyRequests,claimOverlaps:claimOverlaps?((...args)=>{if(!active)throw Error('Replay read scope expired');return claimOverlaps(...args);}):undefined,
   replyOwner:id=>{const value=read('messageOwner',id);if(value===undefined&&read('messages',id)!==undefined)throw Error('Missing independently folded reply owner');return value;},
   replyRootChannel:id=>{const value=read('messageRootChannel',id);if(value===undefined&&read('messages',id)!==undefined)throw Error('Missing independently folded root channel');return value;}});
  const next=applyEvent(state,incoming),patches=[],nextCounts={...counts,messages:counts.messages??0,replyRequestsPresent:Object.hasOwn(next,'replyRequests')},put=(domain,key,value)=>patches.push({domain,key,value});
  if(!isDeepStrictEqual(next.room,room??null))put('metadata','room',next.room);
  for(const domain of ['members','channels','workItems','replyRequests']){
   for(const[key,value]of Object.entries(next[domain]??{}))if(!isDeepStrictEqual(value,loaded[domain].get(key))){put(domain,key,value);if(loaded[domain].get(key)===undefined){put('replayOrder',JSON.stringify([domain,nextCounts[domain]]),key);if(domain==='workItems')put('workOrder',recoveryReplayOrderKey(key,nextCounts[domain]),key);nextCounts[domain]++;}}
   for(const[key,value]of loaded[domain])if(value!==undefined&&!own(next[domain]??{},key))throw Error('Replay map deletion needs explicit expansion');
  }
  const owners=replyContextOwners(next);
  for(const message of next.messages)if(!isDeepStrictEqual(message,loaded.messages.get(message.id))){put('messages',message.id,message);if(loaded.messages.get(message.id)===undefined){put('replayOrder',JSON.stringify(['messages',nextCounts.messages]),message.id);nextCounts.messages++;}put('messageOwner',message.id,owners.get(message.id)??null);put('messageRootChannel',message.id,messageChannelId(message));}
  for(const[key,value]of Object.entries(next.seenEvents))if(value!==read('seenEvents',key))put('seenEvents',key,value);
  for(const[key,value]of Object.entries(next.seenIdempotencyKeys))if(value!==read('seenIdempotencyKeys',key))put('seenIdempotencyKeys',key,value);
  return{supported:true,patches,counts:nextCounts,applied:next.eventLog.length===1,reads:cache.size};
 }finally{active=false;cache.clear();}
}
