// Codex2 review finding: invalid saved room values reached fetch or URI errors
// before the selected-scope refusal. Validate only the poll boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomClient,RoomError} from '../room-acp/src/room.mjs';
import {validId} from '../src/events.js';
const invalid=[['missing',undefined],['null',null],['empty',''],['number',17],['symbol',Symbol('room')],['lone surrogate','\ud800'],['spaces','room name'],['query delimiter','room&scope=other'],['reserved constructor','constructor'],['reserved prototype','prototype'],['reserved proto','__proto__'],['underscore first','_room'],['oversized','a'.repeat(65)],['unicode','café'],['uncoercible object',{toString(){throw Error('must not coerce saved room');}}]];
for(const [name,roomId]of invalid)test('invalid saved room '+name+' is a controlled refusal before any fetch',async()=>{let calls=0;const room=new RoomClient({apiBase:'https://room.example.test',roomId,fetchImpl:async()=>{calls++;return Response.json({roomId:'r',pendingWakes:[]});}});await assert.rejects(()=>room.poll({hostId:'h',waitMs:0}),error=>error instanceof RoomError&&error.status===409&&error.code==='wake_scope_unavailable');assert.equal(calls,0);});
test('poll preflight matches actual server room ID acceptance and preserves valid configured scope',async()=>{
 const values=['r','0','room-1','room_fafdae','a.b:c-d_e','A'.repeat(64),...invalid.map(([,value])=>value)];
 for(const roomId of values){let calls=0,url;const accepted=typeof roomId==='string'&&validId(roomId)&&roomId.length<=64;const room=new RoomClient({apiBase:'https://room.example.test',roomId,fetchImpl:async input=>{calls++;url=new URL(input);return Response.json({roomId,pendingWakes:[]});}});if(accepted){const page=await room.poll({hostId:'host',waitMs:0,cursor:'opaque /cursor'});assert.equal(page.roomId,roomId);assert.equal(url.searchParams.get('roomId'),roomId);assert.equal(url.searchParams.get('cursor'),'opaque /cursor');assert.equal(calls,1);}else{await assert.rejects(()=>room.poll({hostId:'host',waitMs:0}),e=>e instanceof RoomError&&e.status===409&&e.code==='wake_scope_unavailable');assert.equal(calls,0);}}
});
