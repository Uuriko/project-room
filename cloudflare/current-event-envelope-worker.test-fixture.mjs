import { httpServerHandler } from 'cloudflare:node';
import { CurrentEventsRoom } from './current-events-worker.test-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';

export class EventEnvelopeRoom extends CurrentEventsRoom {
  constructor(ctx, env) {
    super(ctx, env);
    this.sourceAtoms = [];
    this.envelopeStats = { rawEventSourceBytes: 0, projectedEventBytesReturned: 0, historicalSqlPayloads: 0 };
    const prepare = this.db.prepare.bind(this.db);
    this.db.prepare = sql => new Proxy(prepare(sql), {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key !== 'get') return value.bind(target);
        return (...args) => {
          const row = value.apply(target, args);
          // The query binds the immutable candidate's raw size and admits the
          // envelope only when SQLite confirms equality; raw body stays in SQL.
          if (sql.includes('projected AS MATERIALIZED') && typeof row?.envelope === 'string') {
            this.envelopeStats.rawEventSourceBytes += args[2];
            this.sourceAtoms.push({ id: row.id, sequence: args[1], rawBytes: args[2], envelopeBytes: row.envelopeBytes });
          }
          if (typeof row?.envelope === 'string') this.envelopeStats.projectedEventBytesReturned += Buffer.byteLength(row.envelope);
          for (const text of Object.values(row ?? {})) if (typeof text === 'string'
            && (text.includes('界'.repeat(64)) || text.includes('🪷'.repeat(64)) || text.includes('\\u0001'.repeat(64)))) this.envelopeStats.historicalSqlPayloads++;
          return row;
        };
      }
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/seed') {
      const kind = url.searchParams.get('kind');
      const body = kind === 'CJK' ? '界'.repeat(65536) : kind === 'astral' ? '界' + '🪷'.repeat(32767) + '界' : '\u0001'.repeat(65536);
      const events = initialRoom();
      for (const id of ['recipient', 'unrelated']) events.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
        data: { memberId: id, displayName: id, kind: 'agent', permissions: [] } }));
      this.store.initialize(events, { representation: 'normalized-current-v1' });
      const owner = this.store.issueAccessKey('commons', 'owner'), unrelated = this.store.issueAccessKey('commons', 'unrelated');
      const posted = this.store.command(owner, 'commons', { id: 'large-opening', type: 'message.posted',
        data: { messageId: 'large-private', toMemberId: 'recipient', body } });
      const later = this.store.command(owner, 'commons', { id: 'later-opening', type: 'message.posted',
        data: { messageId: 'later-visible', toMemberId: 'unrelated', body: 'Later unrelated obligation' } });
      await this.ctx.storage.put('unrelated', unrelated);
      const rawBytes = this.db.prepare('SELECT length(CAST(body AS BLOB)) bytes FROM events WHERE room_id=? AND sequence=?').get('commons', posted.sequence).bytes;
      const atom = sequence => ({ sequence, ...this.db.prepare('SELECT id,length(CAST(body AS BLOB)) AS rawBytes FROM events WHERE room_id=? AND sequence=?').get('commons', sequence) });
      return Response.json({ openingSequence: posted.sequence, rawBytes, openingAtom: atom(posted.sequence), laterAtom: atom(later.sequence) });
    }
    const atomsBefore = this.sourceAtoms.length;
    const before = { ...this.stats }, envelopeBefore = { ...this.envelopeStats }, rawBefore = { ...this.raw };
    this.http ??= httpServerHandler(createRoomServer({ store: this.store, origin: 'http://localhost',
      assetRoot: new URL('https://assets.invalid/'), loadAsset: async () => { throw Error('No fixture assets'); } }));
    const response = await this.http.fetch(new Request(`http://localhost/api/rooms/commons/agent-inbox?limit=4&after=${url.searchParams.get('after')}`,
      { headers: { host: 'localhost', authorization: 'Bearer ' + await this.ctx.storage.get('unrelated') } }));
    return Response.json({ status: response.status, page: await response.json(),
      cost: { sourceAtoms: this.sourceAtoms.slice(atomsBefore), ...Object.fromEntries(Object.keys(before).map(k => [k, this.stats[k] - before[k]])),
        ...Object.fromEntries(Object.keys(envelopeBefore).map(k => [k, this.envelopeStats[k] - envelopeBefore[k]])),
        rawRuntimeRowsWritten: this.raw.rowsWritten - rawBefore.rowsWritten } });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName(new URL(request.url).searchParams.get('kind') ?? 'CJK').fetch(request); } };
