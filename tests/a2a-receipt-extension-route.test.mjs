import test from 'node:test';
import assert from 'node:assert/strict';
import {agentCard,discoveryDoc} from '../server/agent-discovery.mjs';
import {ROUTES} from '../server/routes/table.mjs';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
const path='/extensions/work-receipt/v1';

test('advertised optional work receipt URI resolves to an accurate declarative specification',()=>{
 const extension=agentCard().capabilities.extensions.find(x=>new URL(x.uri).pathname===path);
 assert.equal(extension.required,false);
 const doc=discoveryDoc(path);assert.ok(doc);assert.deepEqual(ROUTES.filter(row=>row.path===path).map(row=>row.method),['GET','HEAD']);
 assert.equal(doc.type,'text/markdown; charset=utf-8');
 assert.match(doc.body,/declarative only/i);assert.match(doc.body,/project-room-receipt\/1/);
 assert.match(doc.body,/Message\.metadata/);assert.match(doc.body,/no RPC methods/i);
 assert.match(doc.body,/unsigned/);assert.match(doc.body,/project-room-public-receipt\/1/);
 assert.ok(doc.body.includes(extension.params.spec_url));
 assert.doesNotMatch(doc.body,/issues signed public work/);
 assert.equal(discoveryDoc('/extensions/work-receipt/v2'),null);
});
test('Node serves public spec GET and HEAD without a room read or write',async t=>{
 const store=new RoomStore(':memory:');const server=createRoomServer({store});
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
 store.room=()=>{throw Error('spec must not hydrate a room');};
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const before=store.db.prepare('SELECT count(*) n FROM events').get().n;
 const response=await fetch(origin+path);assert.equal(response.status,200);const text=await response.text();
 assert.equal(text,discoveryDoc(path).body);assert.match(response.headers.get('content-type'),/text\/markdown/);
 const head=await fetch(origin+path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 assert.equal(head.headers.get('content-length'),String(Buffer.byteLength(text)));
 const denied=await fetch(origin+path,{method:'POST'});assert.ok(denied.status>=400);
 assert.equal(store.db.prepare('SELECT count(*) n FROM events').get().n,before);
});
