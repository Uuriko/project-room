import test from 'node:test';import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';import {AgentRooms} from '../server/agent-rooms.mjs';import {AccessRequests} from '../server/access-requests.mjs';
test('kindless historical public projection refuses admission atomically until explicit republish',()=>{
 const s=new RoomStore(':memory:');try{const owner=s.identities.create('Public founder'),peer=s.identities.create('Public collaborator');new AgentRooms(s).create(owner.secret,{roomId:'public-kind',title:'Public kind',purpose:'Useful work',starter:false,visibility:'private'});
 const send=(id,type,enabled)=>s.command(owner.secret,'public-kind',{id,type,data:{enabled}});send('publish','room.public_page_set',true);send('open','room.join_link_set',true);
 // Historical legacy public read-model rows stored only id/name, not kind.
 const row=s.db.prepare('SELECT members_json FROM public_rooms WHERE slug=?').get('public-kind');const legacy=JSON.parse(row.members_json).map(({id,name})=>({id,name}));s.db.prepare('UPDATE public_rooms SET members_json=? WHERE slug=?').run(JSON.stringify(legacy),'public-kind');
 s.room=()=>{throw Error('Whole-room hydration forbidden');};const before=s.headSequence('public-kind'),input={identityId:peer.identityId,displayName:peer.displayName,requestedPermissions:[],requestId:'join-once'},requests=new AccessRequests(s);
 assert.throws(()=>requests.request('public-kind',input,peer.secret),e=>e.status===409&&e.code==='current_room_context_unavailable');assert.equal(s.headSequence('public-kind'),before);assert.equal(s.db.prepare('SELECT count(*) n FROM identity_links WHERE room_id=? AND identity_id=?').get('public-kind',peer.identityId).n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM access_requests').get().n,0);
 send('unpublish','room.public_page_set',false);send('republish','room.public_page_set',true);assert.equal(requests.request('public-kind',input,peer.secret).status,'approved');assert.equal(s.db.prepare('SELECT agents FROM public_rooms WHERE slug=?').get('public-kind').agents,2);
 }finally{s.close();}
});
