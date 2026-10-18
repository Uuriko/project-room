// Ordered, explicitly requested queries over the transitional message store.
// This module never hydrates full history into the room projection.
import { archiveMarker } from './messages-store.mjs';

export function decodeMessageRecord(row) {
  const record = JSON.parse(row.record_json);
  if (!record || typeof record !== 'object' || record.id !== row.message_id) throw new Error('Invalid archived message record');
  return { ...record, body: row.body };
}

export function messageQueries(store, roomId, state, marker = state.messagesArchive ? archiveMarker(store.db, roomId) : null) {
  const live = state.messages ?? [];
  const archived = 'room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))';
  const params = marker ? [roomId, marker.throughSeq, marker.retainedJson] : [];
  function* records({ bodyPrefix = null, descending = false } = {}) {
    if (bodyPrefix !== null && typeof bodyPrefix !== 'string') throw new TypeError('Message prefix must be text');
    const matches = m => bodyPrefix === null || typeof m.body === 'string' && m.body.startsWith(bodyPrefix);
    if (!marker) {
      if (descending) { for (let i = live.length - 1; i >= 0; i--) if (matches(live[i])) yield live[i]; }
      else { for (const m of live) if (matches(m)) yield m; }
      return;
    }
    const seqs = new Map();
    const ids = live.map(m => m.id);
    for (let start = 0; start < ids.length; start += 256) {
      for (const row of store.db.prepare('SELECT message_id,seq FROM messages WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))').all(roomId, JSON.stringify(ids.slice(start,start+256)))) seqs.set(row.message_id,row.seq);
    }
    const order = (a,b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const retained = live.filter(matches).map(message => {
      if (!seqs.has(message.id)) throw new Error('Working-set message has no posting sequence');
      return {seq:seqs.get(message.id),id:message.id,message};
    }).sort((a,b)=>descending ? -order(a,b) : order(a,b));
    const direction = descending ? 'DESC' : 'ASC', compare = descending ? '<' : '>';
    let sequence = descending ? Number.MAX_SAFE_INTEGER : -1, id = '', offset = 0;
    for (;;) {
      const rows = store.db.prepare(`SELECT message_id,seq,record_json,body FROM messages WHERE ${archived}
        AND (seq ${compare} ? OR (seq=? AND message_id ${compare} ?))
        ${bodyPrefix === null ? '' : 'AND substr(body,1,length(?))=?'} ORDER BY seq ${direction},message_id ${direction} LIMIT 128`)
        .all(...params, sequence, sequence, id, ...(bodyPrefix === null ? [] : [bodyPrefix,bodyPrefix]));
      if (!rows.length) break;
      for (const row of rows) {
        const key = {seq:row.seq,id:row.message_id};
        while (offset < retained.length && (descending ? order(retained[offset],key)>=0 : order(retained[offset],key)<=0)) yield retained[offset++].message;
        yield decodeMessageRecord(row);
      }
      const last=rows.at(-1);sequence=last.seq;id=last.message_id;
    }
    while (offset < retained.length) yield retained[offset++].message;
  }
  return {
    records,
    recent(limit, visible = () => true) {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new RangeError('Recent-message limit must be 0 to 1000');
      const out=[];if(!limit)return out;
      for(const m of records({descending:true})) if(visible(m)){out.push(m);if(out.length===limit)break;}
      return out.reverse();
    },
    firstPostedAtByAuthor() {
      const result=new Map();
      const add=(author,at)=>{const time=Date.parse(at);if(author && Number.isFinite(time) && (!result.has(author)||time<result.get(author)))result.set(author,time);};
      if(marker) {
        let sequence=-1,id='';
        for (;;) {
          const rows=store.db.prepare(`SELECT seq,message_id,author_id,created_at FROM messages WHERE ${archived}
            AND (seq>? OR (seq=? AND message_id>?)) ORDER BY seq,message_id LIMIT 256`).all(...params,sequence,sequence,id);
          if(!rows.length)break;
          for(const row of rows)add(row.author_id,row.created_at);
          const last=rows.at(-1);sequence=last.seq;id=last.message_id;
        }
      }
      for(const m of live)add(m.authorId,m.createdAt);
      return result;
    }
  };
}
