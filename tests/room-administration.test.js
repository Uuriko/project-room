import test from 'node:test';
import assert from 'node:assert/strict';
import { canAdministerRoom } from '../src/room-administration.js';

test('routine admin authority requires live owner or an authorized membership admin', () => {
  const state = {room:{ownerId:'owner'},members:{
    owner:{kind:'human',active:true,permissions:[]},
    human:{kind:'human',active:true,permissions:['manage_members']},
    agent:{kind:'agent',active:true,permissions:['manage_members'],delegatedAdmin:true},
    ordinary:{kind:'human',active:true,permissions:['steer']},
    unstamped:{kind:'agent',active:true,permissions:['manage_members']}
  }};
  for(const id of ['owner','human','agent']) assert.equal(canAdministerRoom(state,id),true,id);
  for(const id of ['ordinary','unstamped','missing']) assert.equal(canAdministerRoom(state,id),false,id);
  state.members.agent.permissions=[];
  assert.equal(canAdministerRoom(state,'agent'),false,'stale delegation marker grants nothing');
  state.members.human.active=false;
  state.members.owner.active=false;
  assert.equal(canAdministerRoom(state,'human'),false);
  assert.equal(canAdministerRoom(state,'owner'),false);
});
