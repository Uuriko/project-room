import test from 'node:test';
import assert from 'node:assert/strict';
import {sponsorTransferContents} from '../server/agent-sponsor-transfer.mjs';

test('saved sponsorship consent cannot be rebound to a different human requester',()=>{
 const consent={version:1,kind:'agent-sponsor-transfer',accountId:'account',memberId:'agent',humanMemberId:'human',identityId:'identity',identityEpoch:'epoch',accountEpoch:0,memberRevision:0,humanRevision:0,ownershipRevision:0,permissions:['accept_work']};
 const row={identity_id:'member:human',requested_permissions:JSON.stringify(consent)};
 assert.deepEqual(sponsorTransferContents(row),consent);
 assert.throws(()=>sponsorTransferContents({...row,identity_id:'member:other-human'}),error=>error.status===409&&error.code==='invalid_request');
 assert.throws(()=>sponsorTransferContents({...row,requested_permissions:JSON.stringify({...consent,humanRevision:-1})}),error=>error.status===409&&error.code==='invalid_request');
});
test('ordinary permission requests are not interpreted as sponsorship consent',()=>{
 assert.equal(sponsorTransferContents({identity_id:'member:human',requested_permissions:JSON.stringify(['accept_work'])}),null);
});
