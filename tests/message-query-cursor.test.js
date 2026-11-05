import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {cursorFixture,cursorResults} from './helpers/message-query-cursor-fixture.mjs';

test('archive cursor pages preserve ordering, ties, retained values, deletion and visibility',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const f=cursorFixture(db),r=cursorResults(f), expected=f.expected;
  assert.deepEqual(r.ascending,expected);assert.deepEqual(r.descending,[...expected].reverse());
  assert.deepEqual(r.after,expected.slice(256));assert.deepEqual(r.before,expected.slice(0,256).reverse());
  assert.deepEqual(r.visible,expected.filter(m=>!m.toMemberId||m.authorId==='viewer'||m.toMemberId==='viewer'));
  assert.deepEqual(r.sinceJoin,expected.filter(m=>!m.toMemberId && (m.createdAt>'2026-10-27T00:00:30.000Z'||m.createdAt==='2026-10-27T00:00:30.000Z'&&!['m000030','m000150'].includes(m.id))));
  assert.deepEqual(r.recent,expected.filter(f.visible).slice(-100));
  assert.equal(r.count,expected.filter(f.visible).length);
  const first=new Map();for(const m of expected){const time=Date.parse(m.createdAt);if(!first.has(m.authorId)||time<first.get(m.authorId))first.set(m.authorId,time);}
  assert.deepEqual(new Map(r.first),first);
 }finally{db.close();}
});


test('working-set messages beyond the certified archive remain ordered and visible',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const f=cursorFixture(db);
  const newer=JSON.parse(db.prepare("SELECT record_json FROM messages WHERE message_id='m001024'").get().record_json);
  f.state.messages.push(newer);
  const expected=[...f.expected,newer];
  assert.deepEqual([...f.queries.records()],expected);
  assert.deepEqual([...f.queries.records({descending:true})],[...expected].reverse());
  assert.deepEqual([...f.queries.records({afterId:newer.id})],[]);
  assert.deepEqual([...f.queries.records({afterId:newer.id,descending:true})],[...f.expected].reverse());
  assert.equal(f.queries.countMetadata(),expected.length);
 }finally{db.close();}
});

// Sequence cursors belong to /messages; unlike ID cursors they also work
// when the cursor points between posts or at an invisible message.
test('descending sequence seeks preserve privacy, history floors and retained records',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const f=cursorFixture(db);
  const visibility={viewerId:'viewer',floor:{at:'2026-10-27T00:00:30.000Z',sameInstant:new Set(['m000030','m000150'])}};
  const expected=f.expected.filter(m=>Number(m.id.slice(1))<600
   &&(!m.toMemberId||m.authorId==='viewer'||m.toMemberId==='viewer')
   &&(m.createdAt>visibility.floor.at||m.createdAt===visibility.floor.at&&!visibility.floor.sameInstant.has(m.id))).reverse();
  assert.deepEqual([...f.queries.records({descending:true,beforeSequence:300,visibility})],expected);
  assert.deepEqual([...f.queries.records({descending:true,beforeSequence:0})],[]);
  assert.throws(()=>[...f.queries.records({beforeSequence:1})],TypeError);
 }finally{db.close();}
});
