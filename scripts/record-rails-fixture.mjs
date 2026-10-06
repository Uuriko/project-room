// Synthetic qualification helpers use the real event and durable rail authority.
import {randomUUID} from 'node:crypto';
import {generateReceiptKeyPair,issueVettingReceipt} from '../server/vetting-receipts.mjs';
export function addRailMember(store,id,kind='human',ownerKey=null){
 if(store.room('commons').state.members[id])return;
 store.command(ownerKey??store.issueAccessKey('commons','owner'),'commons',{id:randomUUID(),type:'member.added',data:{memberId:id,displayName:id,kind,permissions:kind==='agent'?['accept_work']:[]}});
}
export function submittedTrial(store,{id='trial-abc123',candidateId='worker',buyerId='owner',criterion='c1'}={}){
 addRailMember(store,candidateId);
 const task=store.trialTasks.apply('commons','owner',{action:'create',requestId:`create-${id}`,taskId:id,candidateId,buyerId,demigodReqId:'demigod-req-42',title:'Synthetic trial',trialScope:{hoursMax:'40',deliverableShape:'code-pr'},vettingRubric:[{criterion,weightBps:'10000'}],feePolicyRef:'demigod-placement/1',budgetRecord:{note:'Hypothetical budget only'}});
 store.trialTasks.apply('commons',candidateId,{action:'claim',requestId:`claim-${id}`,taskId:id,expectedRevision:task.revision});
 return store.trialTasks.apply('commons',candidateId,{action:'submit',requestId:`submit-${id}`,taskId:id,expectedRevision:1,deliverableRef:'https://example.com/delivery'});
}
export function acceptedReceipt(store,{id='trial-abc123',candidateId='worker',contractId=null}={}){
 const task=submittedTrial(store,{id,candidateId});
 const keys=generateReceiptKeyPair();
 store.trialTasks.apply('commons','owner',{action:'configure',requestId:`key-${id}`,expectedRevision:0,pubkey:keys.pubkeyHex});
 store.buyerSignoff.create('commons','owner',{requestId:`loop-${id}`,loopId:`loop-${id}`,trialTaskId:id,buyerId:'owner',...(contractId?{contractId}:{maxRounds:2})});
 store.buyerSignoff.submit('commons',candidateId,`loop-${id}`,{requestId:`delivery-${id}`,deliverableRef:task.deliverableRef,sha256:'a'.repeat(64),summary:'Synthetic delivery',candidateId});
 store.buyerSignoff.review('commons','owner',`loop-${id}`,{requestId:`review-${id}`,decision:'accept'});
 const rubricScores=[{criterion:'c1',scoreBps:'10000'}],receipt=issueVettingReceipt({trialTaskId:id,demigodReqId:task.demigodReqId,candidateId,scope:task.trialScope,rubricScores,verdict:'pass',evaluator:{kind:'human',id:'owner'},issuedAt:new Date(store.now()).toISOString(),now:store.now()},keys);
 store.trialTasks.apply('commons','owner',{action:'verdict',requestId:`verdict-${id}`,taskId:id,expectedRevision:2,rubricScores,verdict:'pass',receipt});
 return receipt;
}
export function seedRecordRails(store,ownerKey=null,candidateId="rail-worker",offerRef=null){
 addRailMember(store,candidateId,'human',ownerKey);
 if(!offerRef) store.projectOffers.create('commons','owner',{requestId:'rail-offer',offerId:'rail-offer',reviewerMemberIds:['owner'],terms:{repositoryUrl:'https://github.com/Uuriko/project-room',kind:'project',title:'Synthetic record-only offer',summary:'No payment configured',acceptanceCriteria:['Bound receipt'],reward:{kind:'cash',unit:'USD',amountMinor:'1000'},approvalPolicy:{mode:'human'}}});
 store.demigodOffers.create('commons','owner',{requestId:'rail-profile',profileId:'rail-profile',offerRef:offerRef??'rail-offer',demigodReqId:'demigod-req-42',buyerId:'owner',trialScope:{hours:'40',deliverableShape:'code-pr'},vettingRubric:[{criterionId:'c1',description:'Bound evidence',maxScore:'5.00'}],priceType:'fixed',priceMilli:'1000000',timeline:{estimateDays:'2',deadline:'2026-11-01T00:00:00Z'},revisionTerms:{maxRounds:2,turnaroundDays:'1'}});
 store.demigodOffers.present('commons','owner','rail-profile',{requestId:'rail-present',expectedRevision:1});
 store.demigodOffers.accept('commons','owner','rail-profile',{requestId:'rail-accept',expectedRevision:2});
 store.demigodContracts.create('commons','owner',{requestId:'rail-contract',contractId:'rail-contract',offerProfileId:'rail-profile',expectedRevision:3,workerId:candidateId});
 store.demigodContracts.acknowledge('commons',candidateId,'rail-contract',{requestId:'rail-ack'});
 const receipt=acceptedReceipt(store,{id:'rail-trial',candidateId,contractId:'rail-contract'});
 const completed=store.demigodContracts.complete('commons','owner','rail-contract',{requestId:'rail-complete',trialTaskId:'rail-trial',receiptRef:receipt.receiptId});
 return {receipt,completed};
}
