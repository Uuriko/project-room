import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureDefaultChannelState} from '../src/default-channel-state.js';
test('shared retained checkpoint default preserves original null timestamp and no-op semantics',()=>{
 for(const state of [null,{}, {room:null}])assert.equal(ensureDefaultChannelState(state),false);
 const state={room:{ownerId:'owner'}};assert.equal(ensureDefaultChannelState(state),true);assert.deepEqual(state.channels.general,{id:'general',name:'general',createdBy:'owner',createdAt:null,archivedAt:null});const held=state.channels.general;assert.equal(ensureDefaultChannelState(state),false);assert.equal(state.channels.general,held);
 const dated={room:{ownerId:'owner',createdAt:'original-created-at'},channels:{custom:{id:'custom'}}};assert.equal(ensureDefaultChannelState(dated),true);assert.equal(dated.channels.general.createdAt,'original-created-at');assert.deepEqual(dated.channels.custom,{id:'custom'});
});
