import {initialRoom} from '../../server/bootstrap.mjs';
import {event} from '../../src/events.js';
import {auditRecovery} from '../../server/recovery.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages,advanceCurrentRoomConversion} from '../../server/replay-cutover.mjs';
export function seedRecoveryReminderSource(store,{receipts=150,current=true}={}){
 let now=Date.now();store.now=()=>now;
 const history=[...initialRoom(),event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'agent',displayName:'Reminder agent',kind:'agent',permissions:[]}})];
 for(const id of ['active','cancelled','resolved','gap'])history.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:id,title:id,definitionOfDone:'Keep exact private reminder',accountableMemberId:'owner'}}));
 store.initialize(history);store.bindHumanAccount('commons','owner','reminder-account');
 const owner=store.issueAccessKey('commons','owner'),agent=store.issueAccessKey('commons','agent');
 const save=(key,work,revision,action,requestId)=>store.reminders.mutate(key,'commons',{requestId,workItemId:work,expectedRevision:revision,action,...(action==='schedule'?{dueAt:now+3600000}:{})});
 for(let n=0;n<receipts;n++){if(n%2)now-=1;save(owner,'active',n,'schedule','schedule-'+String(receipts-n).padStart(4,'0'));}
 save(owner,'cancelled',0,'schedule','schedule-cancelled');save(owner,'cancelled',1,'cancel','cancel-cancelled');
 save(agent,'resolved',0,'schedule','schedule-resolved');store.transaction(()=>store.reminders.retireMember('commons','agent'));
 save(agent,'gap',0,'schedule','schedule-gap');store.transaction(()=>store.reminders.retireMember('commons','agent'));save(agent,'gap',2,'schedule','reschedule-gap');
 auditRecovery(store);
 if(current){
  store.db.exec(replayCutoverSchema({durable:!!store.db.storage}));
  const capture=captureReplayWitness(store,{roomId:'commons',requestId:'reminder-capture',expectedHead:store.headSequence('commons'),reason:'Reminder recovery qualification'}),base={roomId:'commons',generation:capture.generation};
  const run=(initial,advance,done)=>{let p=initial;for(let step=0;step<500;step++){p=advance(p,step);if(done(p))return p;}throw Error('Fixture conversion did not complete');};
  run({bytes:0},(p,n)=>advanceReplayWitness(store,{...base,requestId:'hash-'+n,expectedBytes:p.bytes}),p=>p.phase==='witness_verified');
  run({bytes:0},(p,n)=>partitionReplayWitness(store,{...base,requestId:'codec-'+n,expectedBytes:p.bytes}),p=>p.phase==='codec_partitioned');
  run({workCount:0},(p,n)=>qualifyReplayHWork(store,{...base,requestId:'work-'+n,expectedWorkCount:p.workCount}),p=>p.workDefaultsQualified);
  run({hMessageSteps:0},(p,n)=>qualifyReplayHMessages(store,{...base,requestId:'messages-'+n,expectedSteps:p.hMessageSteps}),p=>p.hMessagesQualified);
  run({currentSteps:0},(p,n)=>advanceCurrentRoomConversion(store,{...base,requestId:'convert-'+n,expectedSteps:p.currentSteps}),p=>p.phase==='current_serving');
  auditRecovery(store);
 }
 return{receipts:receipts+5,reminders:4,owner,agent};
}
