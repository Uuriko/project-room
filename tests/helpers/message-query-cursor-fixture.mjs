import { messageQueries } from '../../server/message-queries.mjs';

export function cursorFixture(db, count = 1024) {
  db.exec(`CREATE TABLE messages(room_id TEXT,message_id TEXT,seq INTEGER,author_id TEXT,to_member_id TEXT,channel_id TEXT,created_at TEXT,deleted_at TEXT,record_json TEXT,body TEXT,PRIMARY KEY(room_id,message_id));
    CREATE INDEX messages_room_seq ON messages(room_id,seq);`);
  const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)');
  const all = [];
  for (let i=0;i<count+2;i++) {
    const id=`m${String(i).padStart(6,'0')}`, deleted=i%19===0;
    const message={id,authorId:i%3===0?'viewer':'other',toMemberId:i%7===0?'private':null,
      channelId:'general',createdAt:`2026-10-27T00:00:${String(i%60).padStart(2,'0')}.000Z`,
      deletedAt:deleted?'2026-10-27T01:00:00.000Z':null,body:deleted?null:`body ${i}`};
    insert.run('room',id,Math.floor(i/2),message.authorId,message.toMemberId,message.channelId,message.createdAt,message.deletedAt,JSON.stringify(message),message.body);
    if(i<count)all.push(message);
  }
  // Certified archive excludes retained working-set messages, whose latest values win.
  const retained=[all[5],all[513]].map(m=>({...m,body:'current retained value'}));
  const expected=all.map(m=>retained.find(r=>r.id===m.id)??m);
  const marker={throughSeq:Math.floor((count-1)/2),retainedJson:JSON.stringify(retained.map(m=>m.id))};
  const state={messages:retained};
  const queries=messageQueries({db},'room',state,marker);
  const visible=m=>!m.deletedAt && (!m.toMemberId||m.toMemberId==='viewer'||m.authorId==='viewer');
  return {queries,expected,visible,state};
}

export function cursorResults(fixture) {
  const {queries,visible}=fixture;
  return {
    ascending:[...queries.records()], descending:[...queries.records({descending:true})],
    after:[...queries.records({afterId:'m000255'})], before:[...queries.records({afterId:'m000256',descending:true})],
    visible:[...queries.records({visibility:{viewerId:'viewer'}})],
    sinceJoin:[...queries.records({visibility:{viewerId:'viewer',channelId:'general',floor:{at:'2026-10-27T00:00:30.000Z',sameInstant:new Set(['m000030','m000150'])}}})],
    recent:queries.recent(100,visible), count:queries.countMetadata(visible), first:[...queries.firstPostedAtByAuthor()]
  };
}
