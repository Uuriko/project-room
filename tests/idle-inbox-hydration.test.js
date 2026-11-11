import {conversationCursorCodec} from '../server/conversation-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';

test('cold idle inbox does not hydrate unrelated public conversation or work', t => {
  let now = Date.now();
  const store = new RoomStore(':memory:', { now: () => now });
  t.after(() => store.close());
  const owner = store.identities.create('Owen'), ada = store.identities.create('Ada');
  new AgentRooms(store).create(owner.secret, { roomId: 'idle-inbox', title: 'Inbox', purpose: 'Synthetic profile', kind: 'personal' });
  linkWithProof(store, owner.secret, 'idle-inbox', ada, { displayName: 'Ada', permissions: [] });
  for (let i = 0; i < 30; i++) {
    now += 10000;
    store.command(owner.secret, 'idle-inbox', { id: `public-${i}`, type: 'message.posted', data: { body: 'public '.repeat(2000) } });
  }
  const before = store.agentInbox(ada.secret, 'idle-inbox');
  store._dropProjectionCache();
  let hydrations = 0;
  const read = store._readProjection.bind(store);
  store._readProjection = (...args) => { hydrations++;return read(...args); };
  const after = store.agentInbox(ada.secret, 'idle-inbox');
  // Random authenticated encryption intentionally changes token bytes. Compare
  // every decoded binding/source position, then consume both real tokens.
  const codec=conversationCursorCodec(store),semantic=value=>{
    if(Array.isArray(value))return value.map(semantic);
    if(!value||typeof value!=='object')return value;
    return Object.fromEntries(Object.entries(value).map(([key,item])=>{
      if(key!=='olderCursor')return[key,semantic(item)];
      const decoded=codec.decode(item);assert.equal(decoded.roomId,'idle-inbox');assert.equal(decoded.memberId,ada.identityId);assert.equal(decoded.kind,'native_inbox_older_v1');assert.equal(decoded.limit,4);
      return[key,{authenticatedCursor:decoded}];
    }));
  };
  assert.deepEqual(semantic(after),semantic(before));
  const drain=first=>{const pages=[first],positions=new Set();let page=first;
    for(let n=0;page.older.hasMore;n++){
      assert.ok(n<30,'finite retained source must complete');const next=page.older.nextRead,decoded=codec.decode(next.arguments.olderCursor),position=JSON.stringify([decoded.before,decoded.beforeId]);assert.ok(!positions.has(position),'older source position never repeats');positions.add(position);
      const previous=decoded.before;page=store.agentInbox(ada.secret,'idle-inbox',next.arguments);pages.push(page);assert.ok(page.coverage.conversation.examined<=4);
      if(page.older.hasMore)assert.ok(codec.decode(page.older.nextRead.arguments.olderCursor).before<previous,'source cursor advances through examined ground');
    }
    assert.equal(page.older.nextRead,null);assert.equal(pages.reduce((n,p)=>n+p.coverage.conversation.examined,0),30,'both chains examine every original message once');return pages.map(semantic);
  };
  assert.deepEqual(drain(before),drain(after),'both independently issued continuations traverse the same complete source');
  assert.deepEqual(after.directMessages, []);
  assert.deepEqual(after.directMentions, []);
  assert.equal(hydrations, 0);
  // A subsequent real addressed request still uses the canonical repository.
  now += 10000;
  store.command(owner.secret, 'idle-inbox', { id: 'request', type: 'message.posted', data: { messageId: 'request', body: 'Please reply', toMemberId: ada.identityId, requestKind: 'reply' } });
  store._dropProjectionCache();hydrations = 0;
  const canonicalIds=new Set(),prepare=store.db.prepare.bind(store.db);
  store.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('entity_hash FROM messages WHERE room_id=? AND message_id=?')){const get=statement.get.bind(statement);statement.get=(...args)=>{canonicalIds.add(args[1]);return get(...args);};}return statement;};
  let active;try{active=store.agentInbox(ada.secret,'idle-inbox');}finally{store.db.prepare=prepare;}

  assert.equal(active.directMessages[0].body, 'Please reply');
  assert.ok(active.next.some(row => row.action === 'read-request' && row.required === true));
  assert.equal(hydrations,0,'active normalized inbox also avoids blob hydration');
  assert.ok(canonicalIds.has('request'),'real addressed request reads its protected canonical message');
});
