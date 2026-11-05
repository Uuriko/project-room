import test from 'node:test';
import assert from 'node:assert/strict';
import {createWork,claimWork,updateWork,delegateWork,reassignWork,requestApproval,decideApproval,recordReview} from '../../../server/work-claims.mjs';
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
