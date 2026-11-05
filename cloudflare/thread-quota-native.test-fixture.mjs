import entry,{DurableCoverageRoom as Base} from './durable-coverage-native.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
export class DurableCoverageRoom extends Base {
 async fetch(request) {
  if(new URL(request.url).pathname==='/__quota-seed') {
   const s=this.store;s.initialize(initialRoom(),{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','owner');
   let clock=Date.now();s.now=()=>clock;
   const post=(id,data={})=>{clock+=2001;return s.command(key,'commons',{id,type:'message.posted',data:{messageId:id,body:'Context',...data}});};
   post('quota-root');for(let i=0;i<24;i++)post('quota-child-'+i,{replyToId:'quota-root',body:'x'.repeat(8192)});
   post('small-root');return Response.json({key});
  }
  this.store.room=()=>{throw Error('Whole-room hydration forbidden');};
  return super.fetch(request);
 }
}
export default entry;
