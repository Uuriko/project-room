import assert from 'node:assert/strict';
import {WakeCoalescer} from '../../../server/wake-adapters.mjs';
let now=0;const c=new WakeCoalescer(()=>now);const signal=id=>({roomId:'synthetic-room',signalId:id,reason:'mention'});
assert.equal(c.offer('synthetic-agent',signal('old')).send,true);
for(now=300000;now<=600000;now+=300000){const due=c.dueRewakes();assert.equal(due.length,1);console.log(JSON.stringify({phase:'old-rewake',now,attempt:due[0].attempt}));}
now=600001;const offered=c.offer('synthetic-agent',signal('new'));console.log(JSON.stringify({phase:'new-arrival',now,...offered}));
now=900001;const due=c.dueRewakes();console.log(JSON.stringify({phase:'new-due',now,due}));
// Separate positive control: the same new arrival outside the old burst window sends.
now=930001;const control=c.offer('synthetic-agent',signal('outside-window'));assert.equal(control.send,true);console.log(JSON.stringify({phase:'outside-window-control',...control}));
assert.ok(offered.send||due.some(x=>x.signal.signalId==='new'),'a newly coalesced signal must remain eligible for a later adapter delivery after the old signal exhausted its retries');
