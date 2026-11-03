import {MessageMitigationRoom} from './message-mitigation-native.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {withCurrentRoomWriter} from '../server/current-room-repository.mjs';
export class LargeMessageInputRoom extends MessageMitigationRoom {
  async fetch(request) {
    const url = new URL(request.url), s = this.store;
    if (url.pathname === '/__large-seed') {
      const count = Number(url.searchParams.get('count') ?? 0), kind = url.searchParams.get('kind');
      const body = kind === 'cjk' ? '界'.repeat(65536) : kind === 'control' ? '\u0001'.repeat(65536) : kind === 'astral' ? '😀'.repeat(32768) : 'x'.repeat(65536);
      const events = initialRoom(), base = Date.now() - (count + 100) * 1000;
      const add = (type, data) => events.push(event({roomId: 'commons', actorId: 'owner', type, data, at: new Date(base + events.length * 1000).toISOString()}));
      events.forEach((entry, index) => { entry.at = new Date(base + index * 1000).toISOString(); });
      for (const memberId of ['party', 'other']) add('member.added', {memberId, displayName: memberId, kind: 'agent', permissions: []});
      add('room.history_visibility_set', {historyVisibility: 'since_join'});
      for (let i = 0; i < count; i++) add('message.posted', {messageId: 'unrelated-' + i, body: 'Unrelated public history'});
      if (url.searchParams.get('empty') !== '1') for (const messageId of ['edit', 'delete', 'private']) add('message.posted', {messageId, body, ...(messageId === 'private' ? {toMemberId: 'party'} : {})});
      add('member.added', {memberId: 'late', displayName: 'Late', kind: 'agent', permissions: []});
      s.initialize(events, {representation: 'normalized-current-v1'});
      return Response.json(Object.fromEntries(['owner', 'other', 'late'].map(id => [id, s.issueAccessKey('commons', id)])));
    }
    if (url.pathname === '/__large-cost') return Response.json(this.lastCost);
    if (url.pathname === '/__large-tamper') {
      const mode = url.searchParams.get('mode');
      s.transaction(() => withCurrentRoomWriter(s.db, 'commons', () => {
        if (mode === 'hash') s.db.prepare("UPDATE messages SET entity_hash=? WHERE room_id='commons' AND message_id='private'").run('0'.repeat(64));
        else if (mode === 'body') s.db.prepare("UPDATE messages SET body='Changed' WHERE room_id='commons' AND message_id='private'").run();
        else if (mode === 'witness') s.db.prepare("DELETE FROM current_room_records WHERE room_id='commons' AND domain='messageWitness' AND record_key='private'").run();
        else throw Error('Unknown synthetic tamper');
      }));
      return Response.json({ok: true});
    }
    const sql = this.ctx.storage.sql, exec = sql.exec.bind(sql), rows = [];
    const size = value => value == null ? 0 : typeof value === 'string' ? Buffer.byteLength(value) : value instanceof ArrayBuffer ? value.byteLength : ArrayBuffer.isView(value) ? value.byteLength : Buffer.byteLength(JSON.stringify(value));
    sql.exec = (text, ...args) => {
      const cursor = exec(text, ...args), row = {cursor, sqlBytes: size(text), boundBytes: args.reduce((n, v) => n + size(v), 0), returnedBytes: 0};
      rows.push(row);
      const observed = value => { row.returnedBytes += size(JSON.stringify(value)); return value; };
      return new Proxy(cursor, {get(target, key) {
        if (key === 'toArray') return () => target.toArray().map(observed);
        if (key === Symbol.iterator) return function* () { for (const value of target) yield observed(value); };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      }});
    };
    try { return await super.fetch(request); }
    finally {
      sql.exec = exec;
      this.lastCost = {statements: rows.length, reads: 0, writes: 0, unknown: 0, sqlBytes: 0, boundBytes: 0, returnedBytes: 0};
      for (const row of rows) {
        for (const key of ['sqlBytes', 'boundBytes', 'returnedBytes']) this.lastCost[key] += row[key];
        for (const [field, key] of [['rowsRead', 'reads'], ['rowsWritten', 'writes']]) {
          if (Number.isSafeInteger(row.cursor[field])) this.lastCost[key] += row.cursor[field]; else this.lastCost.unknown++;
        }
      }
    }
  }
}
export default {fetch(request, env) {
  const url = new URL(request.url), surface = url.searchParams.get('surface'); url.searchParams.delete('surface');
  const headers = new Headers(request.headers); headers.set('Host', 'room.example.test'); headers.set('x-room-visitor-ip', '192.0.2.1');
  return env.ROOM.getByName(surface).fetch(new Request(url, new Request(request, {headers})));
}};
