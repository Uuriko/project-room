import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RoomStore} from '../server/store.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress,supportsSealedRestoreSource} from '../server/restore-admission.mjs';
import {validateRestoreResultMetadata} from '../server/restore-result-envelope.mjs';
import {completeOperatorRestore} from './helpers/complete-operator-restore.mjs';

// Use a real deployed v45 writer/exporter, never relabel a v46 snapshot.
test('genuine v45 snapshot retains its source identity through bounded v46 recovery',async t=>{
 const root=mkdtempSync(join(tmpdir(),'restore-source-v45-'));
 const archive=execFileSync('git',['archive','2075f27e897c9843048012559f457bf11607d884'],{maxBuffer:128*1024*1024});
 execFileSync('tar',['-xf','-','-C',root],{input:archive});
 symlinkSync(realpathSync('node_modules'),join(root,'node_modules'));
 const {RoomStore:OldStore}=await import(pathToFileURL(join(root,'server/store.mjs')));
 const {initialRoom}=await import(pathToFileURL(join(root,'server/bootstrap.mjs')));
 const {exportNdjsonText}=await import(pathToFileURL(join(root,'server/room-export.mjs')));
 const source=new OldStore(':memory:'),target=new RoomStore(':memory:');
 t.after(()=>{source.close();target.close();rmSync(root,{recursive:true,force:true});});
 source.initialize(initialRoom());const key=source.issueAccessKey('commons','owner');
 source.command(key,'commons',{id:'v45-message',type:'message.posted',data:{messageId:'v45-message',body:'Existing history remains readable'}});
 const text=exportNdjsonText(source.db);assert.equal(JSON.parse(text.split('\n')[0]).sourceSchemaVersion,45);
 const token='synthetic-v45-restore-token';
 const initial=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/x-ndjson'},body:text}),token,target);
 assert.equal(initial.status,202,await initial.clone().text());
 const seal=restoreProgress(target.db).seal;assert.equal(seal.sourceSchemaVersion,45);
 assert.throws(()=>validateRestoreResultMetadata({...seal.resultMetadata,writeProofs:{...seal.resultMetadata.writeProofs,sourceSchemaVersion:46}},seal),/metadata/);
 const result=await completeOperatorRestore(initial,token,target);assert.equal(result.status,200);
 assert.equal((await result.json()).writeProofs.sourceSchemaVersion,45);
 assert.equal(target.authenticate(key,'commons').member.id,'owner');
 assert.equal(target.db.prepare("SELECT count(*) n FROM messages WHERE message_id='v45-message'").get().n,1);
});
test('sealed restore admits only explicitly qualified source schemas',()=>{
 for(const version of [45,46])assert.equal(supportsSealedRestoreSource(version),true);
 for(const version of [44,47,null,'46',NaN])assert.equal(supportsSealedRestoreSource(version),false);
});
