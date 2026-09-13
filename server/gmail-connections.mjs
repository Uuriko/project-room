import { createHash, randomUUID } from 'node:crypto';
import { GmailMailReader } from './gmail-mail-reader.mjs';
import { emailConnection } from './email-envelope.mjs';

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const vaultBinding = (profile, epoch) => ({ accountId: profile.accountId, connectionId: profile.id,
  authEpoch: epoch, connectionRevision: profile.revision, provider: 'gmail', mailbox: profile.mailboxId });

// Server-side lifecycle. HTTP host must enforce CSRF on mutations and keep OAuth
// callbacks out of logs. Credentials never appear in public return values.
export class GmailConnections {
  #store; #vault; #oauth; #fetch; #pending = new Map(); #refreshing = new Map();
  constructor({ store, vault, oauth, fetchImpl = fetch }) {
    this.#store = store; this.#vault = vault; this.#oauth = oauth; this.#fetch = fetchImpl;
  }
  #auth(session) { return this.#store.inbox.auth(session.token, session.binding); }
  #current(session, id) {
    const auth = this.#auth(session);
    const connection = this.#store.email.connection(auth.account.id, id);
    if (!connection || connection.profile.provider !== 'gmail' || connection.state !== 'active'
      || connection.authEpoch !== auth.account.authEpoch) fail('gmail_reconnect_required');
    return { auth, connection };
  }
  begin(session, mailbox) {
    const auth = this.#auth(session);
    if (typeof mailbox !== 'string') fail('gmail_mailbox_required');
    mailbox = mailbox.trim().toLowerCase();
    const id = 'gmail-' + createHash('sha256').update(mailbox).digest('hex').slice(0, 32);
    const current = this.#store.email.connection(auth.account.id, id);
    const profile = emailConnection({ accountId: auth.account.id, id, revision: (current?.profile.revision ?? 0) + 1,
      provider: 'gmail', mailboxId: mailbox, identity: { name: '', address: mailbox }, aliases: [] });
    for (const [key, ticket] of this.#pending) if (ticket.expiresAt <= this.#store.now()
      || ticket.profile.accountId === profile.accountId && ticket.profile.id === profile.id) this.#pending.delete(key);
    if (this.#pending.size >= 100) fail('gmail_connection_busy');
    const context = { accountId: auth.account.id, sessionBinding: auth.sessionBinding,
      authEpoch: auth.account.authEpoch, connectionId: id, revision: profile.revision };
    const result = this.#oauth.begin({ context, mailbox });
    const state = new URL(result.authorizationUrl).searchParams.get('state');
    this.#pending.set(state, { profile, context, expiresAt: result.expiresAt,
      vaultVersion: this.#vault.status(vaultBinding(profile, auth.account.authEpoch)).version });
    return { ...result, connectionId: id };
  }
  async complete(session, callbackUrl) {
    let state;
    try { state = new URL(callbackUrl).searchParams.get('state'); } catch { fail('gmail_callback_invalid'); }
    const ticket = this.#pending.get(state);
    if (!ticket || ticket.expiresAt <= this.#store.now()) fail('gmail_state_invalid');
    const getContext = () => {
      const auth = this.#auth(session);
      const current = this.#store.email.connection(auth.account.id, ticket.profile.id);
      if (this.#pending.get(state) !== ticket) fail('gmail_state_invalid');
      return { accountId: auth.account.id, sessionBinding: auth.sessionBinding, authEpoch: auth.account.authEpoch,
        connectionId: ticket.profile.id, revision: (current?.profile.revision ?? 0) + 1 };
    };
    try {
      const result = await this.#oauth.complete({ callbackUrl, getContext });
      if (JSON.stringify(getContext()) !== JSON.stringify(ticket.context)) fail('gmail_connection_changed');
      // Synchronous writes: no await between final auth check, vault CAS and import
      // configuration. If configuration fails, the unmatched vault revision is inert.
      this.#vault.put({ binding: vaultBinding(ticket.profile, ticket.context.authEpoch), expectedVersion: ticket.vaultVersion,
        credentials: { accessToken: result.accessToken, refreshToken: result.refreshToken, scope: result.scope, expiresAt: result.expiresAt } });
      this.#store.email.apply(session.token, { action: 'connection.configure', requestId: randomUUID(),
        connectionId: ticket.profile.id, expectedRevision: ticket.profile.revision - 1, profile: ticket.profile }, session.binding);
      return { connectionId: ticket.profile.id, mailbox: ticket.profile.mailboxId, state: 'connected' };
    } finally { if (this.#pending.get(state) === ticket) this.#pending.delete(state); }
  }
  async sync(session, id) {
    const initial = this.#current(session, id);
    const profile = initial.connection.profile;
    const progress = this.#store.email.state(session.token, id, 'INBOX', session.binding);
    const reset = progress.needsReset || progress.folder?.complete === true;
    let pageToken = null;
    if (!reset) {
      try { pageToken = JSON.parse(progress.expectedCursor).pageToken; }
      catch { fail('gmail_scan_restart_required'); }
    }
    // Capture before network reads so another folder/scan cannot be overwritten by
    // stale hydrated content using a freshly observed source revision.
    const heads = new Map(this.#store.db.prepare('SELECT id,revision FROM private_inbox_sources WHERE account_id=?')
      .all(initial.auth.account.id).map(row => [row.id, row.revision]));
    const check = () => {
      const current = this.#current(session, id);
      if (current.connection.profile.revision !== profile.revision || current.auth.account.authEpoch !== initial.auth.account.authEpoch)
        fail('gmail_connection_changed');
      return current;
    };
    const authorize = async () => {
      const current = check();
      const binding = vaultBinding(profile, current.auth.account.authEpoch);
      let snapshot = this.#vault.read(binding);
      if (snapshot.credentials.expiresAt <= this.#store.now() + 60000) {
        const key = JSON.stringify([binding, snapshot.version]);
        let renewal = this.#refreshing.get(key);
        if (!renewal) {
          if (this.#refreshing.size >= 100) fail('gmail_connection_busy');
          renewal = (async () => {
            const credentials = await this.#oauth.refresh({ refreshToken: snapshot.credentials.refreshToken, scope: snapshot.credentials.scope });
            check();
            this.#vault.put({ binding, credentials, expectedVersion: snapshot.version });
          })();
          this.#refreshing.set(key, renewal);
        }
        try { await renewal; }
        finally { if (this.#refreshing.get(key) === renewal) this.#refreshing.delete(key); }
        check();
        snapshot = this.#vault.read(binding);
      }
      const { credentials } = snapshot;
      if (credentials.expiresAt <= this.#store.now()) fail('gmail_token_refresh_required');
      return { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt, scope: credentials.scope,
        accountId: profile.accountId, connectionId: id, connectionRevision: profile.revision,
        mailboxId: profile.mailboxId, authEpoch: current.auth.account.authEpoch };
    };
    const reader = new GmailMailReader({ connection: profile, authEpoch: initial.auth.account.authEpoch,
      authorize, fetchImpl: this.#fetch, now: () => this.#store.now() });
    const page = await reader.readPage({ pageToken });
    await authorize();
    const result = this.#store.email.apply(session.token, { action: 'page.apply', requestId: randomUUID(), connectionId: id,
      connectionRevision: profile.revision, folderId: 'INBOX', expectedRevision: progress.folder?.revision ?? 0,
      expectedCursor: progress.expectedCursor, cursor: JSON.stringify({ pageToken: page.nextPageToken, scan: reset ? randomUUID() : JSON.parse(progress.expectedCursor).scan }),
      reset, complete: page.complete, observations: page.observations.map(value => ({ ...value, expectedSourceRevision: heads.get(value.envelope.sourceId) ?? 0 })) }, session.binding);
    return { connectionId: id, imported: result.receipt.imports.length, complete: page.complete };
  }
  disconnect(session, id) {
    const { auth, connection } = this.#current(session, id);
    const binding = vaultBinding(connection.profile, auth.account.authEpoch);
    const version = this.#vault.status(binding).version;
    // Disable import authority first. Even if private credential removal fails,
    // subsequent reads fail closed. This does not claim Google-side revocation.
    this.#store.email.apply(session.token, { action: 'connection.disconnect', requestId: randomUUID(),
      connectionId: id, expectedRevision: connection.profile.revision }, session.binding);
    if (version) this.#vault.disconnect({ binding, expectedVersion: version });
    return { connectionId: id, state: 'disconnected', providerRevoked: false };
  }
}
