import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { publicRoomView } from '../server/public-rooms.mjs';

test('public room links to lobby conversation only when owner publishes its face', t => {
  const store=new RoomStore(':memory:'); t.after(()=>store.close());
  for(const room of ['project-room-lobby','another-public-room']) {
    store.initialize(initialRoom(room),{representation:"normalized-current-v1"}); const owner=store.issueAccessKey(room,'owner');
    store.command(owner,room,{id:`publish-${room}`,type:'room.public_page_set',data:{enabled:true}});
  }
  const get=room=>publicRoomView(store,room);
  assert.ok(!get('project-room-lobby').html.includes('href="/watch"'));
  assert.equal(get('project-room-lobby').document.agentJoin.publicConversation,undefined);
  store.command(store.issueAccessKey('project-room-lobby','owner'),'project-room-lobby',{id:'open-lobby',type:'room.join_link_set',data:{enabled:true}});
  store.publicFace.enable('project-room-lobby','owner');
  assert.match(get('project-room-lobby').html,/<a href="\/watch">See the public conversation<\/a>/);
  assert.match(get('project-room-lobby').html,/<summary>Connect an agent<\/summary>/);
  assert.match(get('project-room-lobby').html,/Room members: 1 person · 0 agents\. Membership does not indicate who is available now\./);
  assert.match(get('project-room-lobby').html,/<a href="\/docs\/agents\/paste\?room=project-room-lobby">Connection guide<\/a>/);
  assert.doesNotMatch(get('project-room-lobby').html,/>Join with your agent<|>Join with your AI</);
  assert.match(get('project-room-lobby').html,/<textarea id="room-setup-prompt" readonly/);
  assert.equal(get('project-room-lobby').document.agentJoin.publicConversation,'/watch');
  assert.equal(get('project-room-lobby').document.join.href,'/docs/agents/paste?room=project-room-lobby');
  assert.match(get('project-room-lobby').document.agentJoin.setupPrompt,/no invitation or Room account is required/);
  assert.match(get('project-room-lobby').document.agentJoin.setupPrompt,/offer of help/);
  store.publicFace.enable('another-public-room','owner');
  assert.ok(!get('another-public-room').html.includes('href="/watch"'));
  assert.match(get('another-public-room').html,/>Join with your AI</);
  assert.equal(get('another-public-room').document.agentJoin.publicConversation,undefined);
  store.publicFace.disable('project-room-lobby','owner');
  assert.ok(!get('project-room-lobby').html.includes('href="/watch"'));
  assert.equal(get('project-room-lobby').document.agentJoin.publicConversation,undefined);
});
