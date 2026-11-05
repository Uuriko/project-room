// Disposable local Worker data; synthetic backlog cloned from a real producer row.
import { DurableObject } from 'cloudflare:workers';
import { WAKE_INDEXES, WAKE_INDEX_RECEIPT, forgetWakeIndexState, wakeIndexState } from '../server/wake-delivery-window.mjs';
import { operatorWakeIndex } from '../server/operator-wake-index.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
export class WorkWakeBudgetProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.db = new DurableDatabase(ctx.storage);
    this.at = 1770000000000;
    this.store = new RoomStore(null, { database: this.db, storagePlatform: durableStorage, now: () => this.at });
  }
  async fetch(request) {
    const s = this.store, db = this.db, { count, kind } = await request.json();
    if (new URL(request.url).pathname === '/reinstall') {
      const original = db.prepare('SELECT counts_json FROM operator_actions WHERE id=?').get(WAKE_INDEX_RECEIPT).counts_json;
      for (const index of WAKE_INDEXES) db.exec('DROP INDEX ' + index.name); forgetWakeIndexState(db);
      const reason = 'Synthetic explicit Worker reinstall';
      const plan = operatorWakeIndex(s, { reason, reinstall: true });
      const input = { reason, reinstall: true, requestId: 'reinstall', planHash: plan.planHash };
      db.exec("CREATE TRIGGER reject_reinstall BEFORE INSERT ON operator_actions WHEN NEW.action='wake_delivery_indexes_reinstall' BEGIN SELECT RAISE(ABORT,'synthetic repair interruption'); END");
      let interrupted = false; try { operatorWakeIndex(s, input, true); } catch (error) { interrupted = String(error.message).includes('synthetic repair interruption'); }
      const rolledBack = wakeIndexState(db) === 'absent'; db.exec('DROP TRIGGER reject_reinstall');
      const first = operatorWakeIndex(s, input, true), retry = operatorWakeIndex(s, input, true);
      const saved = JSON.parse(original);
      const originalRetry = operatorWakeIndex(s, { reason: 'Synthetic Worker qualification', requestId: 'install', planHash: saved.receipt.planHash }, true);
      return Response.json({ interrupted, rolledBack, installed: first.result.installed, repairDuplicate: retry.duplicate,
        originalDuplicate: originalRetry.duplicate, originalUnchanged: db.prepare('SELECT counts_json FROM operator_actions WHERE id=?').get(WAKE_INDEX_RECEIPT).counts_json === original,
        repairRetryUnchanged: JSON.stringify({ ...retry, duplicate: false }) === JSON.stringify(first) });
    }
    if (['/read', '/oversize'].includes(new URL(request.url).pathname)) {
      const identityId = s.identities.identityIdForMember('commons', 'worker');
      if (new URL(request.url).pathname === '/oversize') s.transaction(() => db.prepare("UPDATE agent_work_wakes SET pointer=? WHERE signal_id=(SELECT signal_id FROM agent_work_wakes WHERE agent_id=? ORDER BY created_at,signal_id LIMIT 1)").run('x'.repeat(8193), identityId));
      const catalogRows = db.prepare('SELECT count(*) n FROM sqlite_master').get().n;
      let payloadReads = 0; const prepare = db.prepare.bind(db);
      db.prepare = sql => { if (/FROM agent_work_wakes WHERE rowid=/.test(sql)) payloadReads++; return prepare(sql); };
      const start = db.rowsRead;
      try {
        const page = s.transaction(() => s.agentHeartbeats.pendingWakePage(identityId, { hostId: 'host' }));
        return Response.json({ page, rowsRead: db.rowsRead - start, catalogRows, payloadReads });
      } catch (error) { return Response.json({ code: error.code ?? null, payloadReads }, { status: error.status ?? 500 }); }
    }
    s.initialize(initialRoom()); s.initialize(initialRoom('other'));
    const owner = s.issueAccessKey('commons', 'owner');
    const identity = s.identities.create('Synthetic work-wake agent');
    const { linkCode } = s.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: 'commons' });
    s.identities.link(owner, 'commons', { identityId: identity.identityId, identityLinkCode: linkCode, memberId: 'worker', displayName: 'Worker', permissions: ['accept_work'] });
    s.transaction(() => s.workWakes.setHost(identity.identityId, 'host', true, 'commons'));
    s.command(owner, 'commons', { id: 'producer', type: 'work.proposed', data: { workItemId: 'task', title: 'Synthetic task', definitionOfDone: 'Synthetic control', mode: 'read', accountableMemberId: 'worker' } });
    const original = db.prepare('SELECT * FROM agent_work_wakes WHERE agent_id=?').get(identity.identityId);
    if (!original) throw Error('real producer did not create a row');
    s.transaction(() => {
      const put = db.prepare('INSERT INTO agent_work_wakes VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)');
      const messages = db.prepare("INSERT INTO agent_wake_signals VALUES(?,?,'mention','other',?,?,NULL)");
      for (let n = 0; n < count; n++) {
        if (kind === 'messages') messages.run('message-' + String(n).padStart(5, '0'), identity.identityId, 'synthetic-message-' + n, this.at - 100);
        else put.run('ww_backlog_' + String(n).padStart(5, '0'), identity.identityId,
          kind === 'opted-out' ? 'other' : 'commons', 'worker', 'task', kind === 'stale' ? -1 : original.work_revision,
          'synthetic-backlog-' + n, original.actor_id, original.pointer, this.at - 100);
      }
    });
    if (kind === 'inactive') {
      const catalogRows = db.prepare('SELECT count(*) n FROM sqlite_master').get().n;
      const polls = []; let catalogReads = 0, catalogStatements = 0;
      const prepare = db.prepare.bind(db);
      db.prepare = sql => {
        const statement = prepare(sql);
        if (/sqlite_master/.test(sql)) for (const method of ['all', 'get']) {
          const original = statement[method].bind(statement);
          statement[method] = (...args) => { const before = db.rowsRead; const value = original(...args); catalogStatements++; catalogReads += db.rowsRead - before; return value; };
        }
        return statement;
      };
      for (let n = 0; n < 3; n++) {
        const before = db.rowsRead, beforeCatalog = catalogReads, beforeStatements = catalogStatements;
        const page = s.transaction(() => s.agentHeartbeats.pendingWakePage(identity.identityId, { hostId: 'host' }));
        polls.push({ rowsRead: db.rowsRead - before, catalogReads: catalogReads - beforeCatalog,
          catalogStatements: catalogStatements - beforeStatements, page });
      }
      db.prepare = prepare;
      return Response.json({ catalogRows, polls });
    }
    const installation = { rowsRead: 0, rowsWritten: 0, statements: 0, unknownWriteCounters: 0 };
    db.observeStatement = () => result => { installation.statements++; installation.rowsRead += result.rowsRead ?? 0; installation.rowsWritten += result.rowsWritten ?? 0; if (result.rowsWritten === null) installation.unknownWriteCounters++; };
    const plan = operatorWakeIndex(s, { reason: 'Synthetic Worker qualification' });
    operatorWakeIndex(s, { reason: 'Synthetic Worker qualification', requestId: 'install', planHash: plan.planHash }, true);
    db.observeStatement = null;
    let selected = 0, reads = 0, roomReads = 0;
    const prepare = db.prepare.bind(db), room = s.room.bind(s);
    db.prepare = sql => {
      const statement = prepare(sql);
      if (/FROM agent_(?:work_wakes|wake_signals) INDEXED BY/.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = (...args) => { const start = db.rowsRead, rows = all(...args); reads += db.rowsRead - start; selected += rows.length; return rows; };
      }
      return statement;
    };
    s.room = (...args) => { roomReads++; return room(...args); };
    const drain = () => {
      let cursor = null; const signals = [], perPage = []; let page;
      for (let n = 0; n < 200; n++) {
        const before = db.rowsRead; selected = 0; reads = 0; roomReads = 0;
        page = s.transaction(() => s.agentHeartbeats.pendingWakePage(identity.identityId, { hostId: 'host', cursor, roomId: kind === 'messages' ? 'commons' : null }));
        perPage.push({ selected, candidateRowsRead: reads, totalRowsRead: db.rowsRead - before, roomReads, more: page.more, signals: page.signals.length });
        signals.push(...page.signals); if (!page.more) return { signals, more: false, nextCursor: null, perPage };
        if (!page.nextCursor || page.nextCursor === cursor) throw Error('non-progressing continuation'); cursor = page.nextCursor;
      }
      throw Error('window traversal did not finish');
    };
    const plans = WAKE_INDEXES.map(index => db.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM ${index.table} INDEXED BY ${index.name} WHERE agent_id=?${index.scoped ? ' AND room_id=?' : ''} AND delivered_at IS NULL${index.table === 'agent_work_wakes' ? ' AND invalidated_at IS NULL' : ''} AND (created_at,signal_id)>(?,?) ORDER BY created_at,signal_id LIMIT 129`).all(identity.identityId, ...(index.scoped ? ['commons'] : []), 0, '').map(row => row.detail));
    const page = drain();
    const measured = { selected: Math.max(...page.perPage.map(p => p.selected)), reads: Math.max(...page.perPage.map(p => p.candidateRowsRead)),
      totalRowsRead: Math.max(...page.perPage.map(p => p.totalRowsRead)), roomReads: Math.max(...page.perPage.map(p => p.roomReads)) };
    let controls = null;
    if (count === 1000 && kind === 'stale') {
      const pending = () => drain().signals.length;
      s.transaction(() => s.workWakes.setHost(identity.identityId, 'host', false, 'commons'));
      const optedOut = pending();
      s.transaction(() => s.workWakes.setHost(identity.identityId, 'host', true, 'commons'));
      s.wakeQueue.pause(identity.secret, 'commons', { requestId: 'pause', reason: 'Synthetic control' });
      const paused = pending(); s.wakeQueue.resume(identity.secret, 'commons', { requestId: 'resume' });
      const minute = Math.floor(this.at / 60000) % 1440;
      s.attention.mutate(identity.secret, 'commons', { requestId: 'quiet', quietStart: minute, quietEnd: (minute + 2) % 1440, delivery: 'immediate', digestHour: null });
      const quiet = pending();
      s.attention.mutate(identity.secret, 'commons', { requestId: 'unquiet', quietStart: null, quietEnd: null, delivery: 'immediate', digestHour: null });
      const restored = pending();
      s.command(owner, 'commons', { id: 'remove', type: 'member.access_changed', data: { memberId: 'worker', expectedMemberRevision: 0, active: false, permissions: [] } });
      const removed = pending(); controls = { optedOut, paused, quiet, restored, removed };
    }
    return Response.json({ count, kind, controls, installation, plans, pages: page.perPage.length, emptyMorePages: page.perPage.filter(p => p.more && p.signals === 0).length, selected: measured.selected, candidateRowsRead: measured.reads, totalRowsRead: measured.totalRowsRead, roomReads: measured.roomReads,
      signals: page.signals.map(w => ({ kind: w.kind, workItemId: w.workItemId, workRevision: w.workRevision, action: w.action, nextRead: w.nextRead })),
      more: page.more, nextCursor: page.nextCursor });
  }
}
export default { fetch(request, env) { return env.ROOM.get(env.ROOM.idFromName(new URL(request.url).searchParams.get('fixture') ?? new URL(request.url).pathname)).fetch(request); } };
