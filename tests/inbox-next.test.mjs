import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxNext} from '../server/inbox-next.mjs';
test('empty conversation still discovers work and open formal requests without accepting either',()=>{
 const steps=inboxNext('room',[],[],[]);
 assert.ok(steps.some(step=>step.action==='list-my-work'&&step.nextRead.arguments.focus==='needs_me'));
 assert.ok(steps.some(step=>step.action==='list-open-requests'&&step.required===false));
 assert.ok(steps.every(step=>step.required!==true));
});
test('only currently open formal requests produce required reply actions',()=>{
 const mention={state:'timed_out',nextRead:{tool:'room_read_request',arguments:{requestMessageId:'request'}}};
 for(const status of ['open','answered','cancelled']) {
  const steps=inboxNext('room',[],[],[],[mention],[],[],{request:{status}});
  const step=steps.find(item=>item.action==='read-request');
  assert.equal(step.required,status==='open');assert.equal(step.requestStatus,status);
 }
});
