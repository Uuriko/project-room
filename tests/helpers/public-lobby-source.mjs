import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
export function seedPublicLobby(store,{roomId='project-room-lobby',privateCount=1000}={}){
 const events=initialRoom(roomId),add=(type,data,actorId='owner')=>events.push(event({roomId,actorId,type,data}));
 for(const id of ['alice','bob'])add('member.added',{memberId:id,displayName:id,kind:'agent',permissions:[]});
 add('channel.created',{channelId:'other',name:'Other'});
 for(let i=0;i<privateCount;i++)add('message.posted',{messageId:'private-'+i,toMemberId:'owner',body:'PRIVATE HISTORY '+i},'alice');
 add('message.posted',{messageId:'other-channel',channelId:'other',body:'OTHER CHANNEL MUST NOT PUBLISH'},'bob');
 for(let i=0;i<18;i++)add('message.posted',{messageId:'public-'+i,body:i===17?'Useful <public> result':'Public work '+i},'alice');
 add('message.posted',{messageId:'deleted',body:'DELETED MUST NOT PUBLISH'},'alice');
 add('message.deleted',{messageId:'deleted',expectedMessageRevision:0},'alice');
 store.initialize(events,{representation:'normalized-current-v1'});
 const owner=store.issueAccessKey(roomId,'owner'),alice=store.issueAccessKey(roomId,'alice');
 return {roomId,owner,alice};
}
