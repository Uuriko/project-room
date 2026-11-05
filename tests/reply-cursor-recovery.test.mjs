import test from 'node:test';
import assert from 'node:assert/strict';
import {replyRefusal} from '../client/reply-actions.mjs';

test('expired reply cursor gives explicit recovery without silently resetting context',()=>{
  for(const name of ['room_list_requests','room_read_request','room_request_history']) {
    const refusal=replyRefusal({status:409,code:'invalid_reply_cursor',message:'untrusted server detail'}, {name,args:{cursor:'private-cursor'}});
    assert.equal(refusal.outcome,'read_failed');
    assert.match(refusal.message,/service restart can expire/);
    assert.match(refusal.message,/reconcile earlier pages and checkpoints/);
    assert.match(refusal.message,/do not answer from partial context/);
    assert.deepEqual(refusal.next,[]);
    assert.doesNotMatch(JSON.stringify(refusal),/private-cursor|untrusted server detail/);
  }
});
