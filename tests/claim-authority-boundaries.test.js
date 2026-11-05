import test from 'node:test';
import assert from 'node:assert/strict';
import {createWork,claimWork,updateWork,delegateWork,reassignWork,requestApproval,decideApproval,recordReview} from '../server/work-claims.mjs';
const now=1800000000000;
const held=()=>claimWork(createWork({id:'synthetic',title:'Synthetic'},{agentId:'lead',now}),'lead',{now});
test('previous delegate loses write authority on reassignment',()=>{
 const d=delegateWork(held(),'lead','worker',{now});const r=reassignWork(d,'lead','replacement',{now:now+1});
 assert.throws(()=>updateWork(r,'worker',{state:'in_progress',now:now+2}));
});
test('denied approval cannot deliver until approved again',()=>{
 const w=updateWork(held(),'lead',{state:'in_progress',now});
 const h=requestApproval(w,'lead',{approverId:'boss',step:'Synthetic approval',now});
 const d=decideApproval(h,'boss',{decision:'deny',now});
 assert.throws(()=>updateWork(d,'lead',{state:'delivered',now}));
});
test('delegate cannot approve its own work as distinct reviewer',()=>{
 const d=delegateWork(held(),'lead','worker',{now});
 const w=updateWork(d,'worker',{state:'in_progress',now});
 assert.throws(()=>recordReview(w,'worker',{verdict:'approve',summary:'Own work',now}));
});

import {releaseExpired,releaseWork,closeWhenLive,claimHistoryLength} from '../server/work-claims.mjs';
import {recordPullOutcome} from '../server/claim-coordination.mjs';
for(const path of ['release','expire']) test(`delegate cannot survive ${path} and fresh claim`,()=>{
 let task=delegateWork(held(),'lead','worker',{now});
 task=path==='release'?releaseWork(task,'lead',{expectedClaimedAt:task.claimedAt,expectedHistoryLength:claimHistoryLength(task),now:now+1}):releaseExpired([{...task,leaseExpiresAt:new Date(now+1).toISOString()}],now+2)[0];
 task=claimWork(task,'replacement',{now:now+3});
 assert.throws(()=>updateWork(task,'worker',{state:'in_progress',now:now+4}));
});
test('automatic live close honors pending and denied approval; approved control closes',()=>{
 const pr='https://github.com/Uuriko/project-room/pull/123';
 let task=claimWork(createWork({id:'live',title:'Synthetic',kind:'land',revision:'rev-live',pullRequest:pr},{now,agentId:'lead'}),'lead',{now});
 task=recordPullOutcome(task,pr,'merged',now);
 task=requestApproval(task,'lead',{approverId:'boss',step:'Synthetic',now});
 assert.equal(closeWhenLive(task,'rev-live',now),null);
 assert.equal(closeWhenLive(decideApproval(task,'boss',{decision:'deny',now}),'rev-live',now),null);
 assert.equal(closeWhenLive(decideApproval(task,'boss',{decision:'approve',now}),'rev-live',now).state,'done');
});
