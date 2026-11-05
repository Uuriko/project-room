import entry,{DurableCoverageRoom as Base} from './durable-coverage-native.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {linkWithProof} from '../tests/helpers/link-with-proof.mjs';
export class DurableCoverageRoom extends Base {
 async fetch(request){
  if(new URL(request.url).pathname==='/__reply-seed'){
   const identity=this.store.identities.create('Fixture reader'),events=initialRoom(),add=(type,data)=>events.push(event({roomId:'commons',actorId:'owner',type,data}));
   add('member.added',{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[],identityId:identity.identityId});
   for(let i=0;i<3;i++)add('message.posted',{messageId:'q'+i,toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1,body:'Question'});
   this.store.initialize(events,{representation:'normalized-current-v1'});
   linkWithProof(this.store,this.store.issueAccessKey('commons','owner'),'commons',identity,{memberId:'reader',permissions:[]});
   return Response.json({token:identity.secret});
  }
  return super.fetch(request);
 }
}
export default entry;
