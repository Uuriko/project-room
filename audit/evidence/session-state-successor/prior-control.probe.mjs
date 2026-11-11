import test from 'node:test';
import assert from 'node:assert/strict';
import {createWork,claimWork,updateWork,stampClaimHistory,summarizeClaimHistory,MAX_CLAIM_HISTORY} from '../../../server/work-claims.mjs';
import {agentSessionOf} from '../../../server/agent-session-state.mjs';
import {buildWorkClaimPage} from '../../../server/work-claim-routes.mjs';
const start=Date.parse('2026-11-04T00:00:00Z'),now=start+3600000;
function seed(){let c=claimWork(createWork({id:'cap-control'},{now:start,agentId:'owner-a'}),'owner-a',{now:start,leaseHours:null});return updateWork(c,'owner-a',{state:'in_progress',now:start+60000});}
for(const count of [3,MAX_CLAIM_HISTORY]) test(`owner activity remains stale after ${count} other-agent stamps`,()=>{
 let c=seed();assert.equal(agentSessionOf(c,now).state,'stale');
 for(let i=0;i<count;i++)c=stampClaimHistory(c,'other-b',{action:'note',note:'synthetic',now:start+3420000+i*500});
 const prior=process.env.ROOM_AGENT_SESSION_STATES;process.env.ROOM_AGENT_SESSION_STATES='1';
 let page;try{page=buildWorkClaimPage([c],'commons','owner-a',new URLSearchParams(),now);}finally{if(prior===undefined)delete process.env.ROOM_AGENT_SESSION_STATES;else process.env.ROOM_AGENT_SESSION_STATES=prior;}
 const report={count,storedHistory:c.history.length,omitted:c.historyOmitted??0,storedState:agentSessionOf(c,now).state,cappedState:agentSessionOf(summarizeClaimHistory(c,3),now).state,routeState:page.claims[0].agentSession};console.log(JSON.stringify(report));
 assert.equal(report.storedState,'stale','non-owner activity cannot make stored claim active');
 assert.equal(report.cappedState,'stale','list truncation cannot make owner active');
 assert.equal(report.routeState,'stale','actual route projection must retain stale state');
});
