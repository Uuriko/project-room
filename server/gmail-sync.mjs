import { randomUUID } from 'node:crypto';
import { gmailImportToken } from './gmail-import-authority.mjs';
import { normalizeGmailMessage } from './channel-adapters/gmail.mjs';
import { ServiceError } from './store.mjs';
const api = 'https://gmail.googleapis.com/gmail/v1/users/me';
const fail = code => { throw new ServiceError(409, code, 'Gmail sync will retry.'); };
// A bounded history tick, usable without a browser session. Only existing
// encrypted grants confer this authority; it cannot send email or change Gmail.
export class GmailSync {
  constructor(mailbox) { this.mailbox = mailbox; this.store = mailbox.store; }
  async mailboxTick(accountId, mailboxId, ownerCheck = () => {}) {
    const m = this.mailbox, auth = { account: this.store.account(accountId) }, record = m.record(auth, mailboxId);
    if (!record?.usable || record.reconnectRequired) return { imported: 0, skipped: true };
    const connection = this.store.connections.connection(accountId, mailboxId), initialHistory = record.historyId ?? null;
    const check = () => {
      ownerCheck(); const account = this.store.account(accountId), latest = m.record({ account }, mailboxId);
      const c = this.store.connections.connection(accountId, mailboxId);
      if (!latest?.usable || latest.refreshToken !== record.refreshToken || account.authEpoch !== auth.account.authEpoch || c?.profile.revision !== connection.profile.revision) fail('gmail_session_changed');
    };
    const token = gmailImportToken(this.store, accountId, mailboxId, check);
    const tokens = await m.exchange({ refresh_token: record.refreshToken, grant_type: 'refresh_token' }); check();
    if (!tokens.access_token) fail('gmail_reconnect_required');
    const get = async path => { check(); const value = await m.json(api + path, { headers: { Authorization: 'Bearer ' + tokens.access_token } }); check(); return value; };
    let reset = !initialHistory, historyId = initialHistory, ids = new Set(), nextPageToken = record.historyPage ?? null;
    if (!reset) {
      try {
        const query = new URLSearchParams({ startHistoryId: initialHistory, maxResults: '50' });
        if (nextPageToken) query.set('pageToken', nextPageToken);
        const page = await get('/history?' + query);
        for (const row of page.history ?? []) for (const key of ['messages', 'messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
          for (const item of row[key] ?? []) ids.add(item.message?.id ?? item.id);
        }
        nextPageToken = page.nextPageToken ?? null;
        historyId = nextPageToken ? initialHistory : page.historyId ?? initialHistory;
        if (ids.size > 200 || (this.store.connections.folder(accountId, mailboxId, 'INBOX')?.members.length ?? 0) > 900) reset = true;
      } catch (error) { if (error.code === 'gmail_not_found') reset = true; else throw error; }
    }
    if (reset) {
      // Capture history before listing; later mutations are replayed on the next tick.
      const profile = await get('/profile'); historyId = profile.historyId ?? null; nextPageToken = null;
      const page = await get('/messages?labelIds=INBOX&maxResults=50');
      ids = new Set((page.messages ?? []).map(v => v.id));
    }
    if (ids.size > 200 || [...ids].some(id => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id))) fail('gmail_invalid_response');
    const observations = [];
    for (const id of ids) {
      let message;
      try { message = await get('/messages/' + id + '?format=full'); }
      catch (error) { if (error.code !== 'gmail_not_found') throw error; }
      if (!message || !message.labelIds?.includes('INBOX')) observations.push({ kind: 'absent', messageId: id });
      else {
        const envelope = normalizeGmailMessage(connection.profile, message);
        observations.push({ kind: 'message', envelope, expectedSourceRevision: 0 });
      }
    }
    return this.store.transaction(() => {
      check(); const latest = m.record({ account: this.store.account(accountId) }, mailboxId);
      if ((latest.historyId ?? null) !== initialHistory || (latest.historyPage ?? null) !== (record.historyPage ?? null)) fail('gmail_sync_changed');
      // No-op history ticks create no immutable import-journal entry.
      if (observations.length || reset) {
        const batches = observations.length ? Array.from({ length: Math.ceil(observations.length / 50) }, (_, i) => observations.slice(i * 50, (i + 1) * 50)) : [[]];
        for (let i = 0; i < batches.length; i++) {
          for (const o of batches[i]) if (o.kind === 'message') o.expectedSourceRevision = this.store.db.prepare('SELECT revision FROM private_inbox_sources WHERE account_id=? AND id=?').get(accountId, o.envelope.sourceId)?.revision ?? 0;
          const folder = this.store.connections.folder(accountId, mailboxId, 'INBOX'), changed = !folder || folder.connectionRevision !== connection.profile.revision;
          this.store.connections.apply(token, { action: 'page.apply', requestId: randomUUID(), connectionId: mailboxId, connectionRevision: connection.profile.revision,
            folderId: 'INBOX', expectedRevision: folder?.revision ?? 0, expectedCursor: changed ? null : folder.cursor, cursor: 'gmail-history:' + randomUUID(), complete: i === batches.length - 1, reset: i === 0 && (reset || changed), observations: batches[i] }, null);
        }
      }
      m.save(auth, { ...latest, usable: undefined, historyId, historyPage: nextPageToken, syncedAt: new Date(this.store.now()).toISOString(), syncError: null, nextSyncAt: this.store.now() + (nextPageToken ? 1000 : 60000), syncFailures: 0 });
      return { imported: observations.filter(o => o.kind === 'message').length };
    });
  }
  async tick() {
    const accountIds = this.store.db.prepare('SELECT account_id FROM gmail_mailboxes UNION SELECT account_id FROM gmail_linked_mailboxes').all();
    const due = [];
    for (const row of accountIds) {
      const account = this.store.account(row.account_id); if (!account.active) continue;
      try { for (const r of this.mailbox.records({ account })) if (r.usable && !r.reconnectRequired && (r.nextSyncAt ?? 0) <= this.store.now()) due.push({ account, record: r }); }
      catch { /* An unreadable grant requires owner reconnection, not log output. */ }
    }
    due.sort((a, b) => (a.record.nextSyncAt ?? 0) - (b.record.nextSyncAt ?? 0));
    let completed = 0;
    for (const { account, record } of due.slice(0, 10)) {
      try { await this.mailboxTick(account.id, record.connectionId); completed++; }
      catch (error) {
        const latest = this.mailbox.record({ account: this.store.account(account.id) }, record.connectionId);
        if (latest?.usable && latest.refreshToken === record.refreshToken) {
          const failures = (latest.syncFailures ?? 0) + 1;
          this.mailbox.save({ account }, { ...latest, usable: undefined, syncError: error.code === 'gmail_reconnect_required' ? 'reconnect_required' : 'sync_delayed', reconnectRequired: error.code === 'gmail_reconnect_required', syncFailures: failures, nextSyncAt: this.store.now() + Math.min(3600000, 60000 * 2 ** Math.min(failures, 6)) });
        }
      }
    }
    return { completed, pending: Math.max(0, due.length - 10) };
  }
}
export function startGmailSync(mailbox, intervalMs = 60000) {
  const worker = new GmailSync(mailbox); let running = false;
  const tick = async () => { if (running) return; running = true; try { await worker.tick(); } catch { /* Next timer retries; never emit mailbox data. */ } finally { running = false; } };
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
