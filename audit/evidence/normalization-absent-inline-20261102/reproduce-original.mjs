// Run from this repository root. All data is a disposable in-memory fixture.
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const file=path=>pathToFileURL(process.cwd()+'/'+path).href;
const {RoomStore}=await import(file('server/store.mjs'));
const {initialRoom}=await import(file('server/bootstrap.mjs'));
const {withCurrentRoomWriter}=await import(file('server/current-room-repository.mjs'));
const base='1f9dfb90f6d0391873f62e4f579d746929edac4f';
const origin=file('server/messages-store.mjs');
const source=execFileSync('git',['show',base+':server/messages-store.mjs'],{encoding:'utf8'}).replace(/from (["'])(\.[^"']+)\1/g,(_,q,p)=>'from '+q+new URL(p,origin).href+q);
const original=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const s=new RoomStore(':memory:');
try{
 s.initialize(initialRoom());const key=s.issueAccessKey('commons','owner');
 s.command(key,'commons',{id:'legacy-proof-source',type:'message.posted',data:{messageId:'legacy-proof-source',body:'Disposable independent inline source'}});
 s.db.prepare('UPDATE messages SET entity_hash=NULL').run();const state=s.room('commons').state;
 assert.throws(()=>s.transaction(()=>withCurrentRoomWriter(s.db,'commons',()=>original.materializeCurrentMessageRows(s.db,'commons',state,{adoptAbsentInlineProofs:true}))),error=>{
  console.log(JSON.stringify({base,actualBeforeError:error.message,missingProofs:s.db.prepare('SELECT count(*) n FROM messages WHERE entity_hash IS NULL').get().n}));
  return error.message==='projection_corrupt: canonical adoption message proof differs';
 });
}finally{s.close();}
