import { createHash } from 'node:crypto';
import { initialRoom } from './bootstrap.mjs';
import { ServiceError } from './store.mjs';
import { applyEvent, event, EVENT_TYPES as T } from '../src/events.js';
import { providerAccountId } from './operator-account-id.mjs';
import { accountsMatchOperator } from './production-gates.mjs';

export const STARTER_ROOM_ID = 'welcome';
const HOST_ID = 'welcome-host';
const BOOTSTRAP_ID = 'provider-welcome-v1';

// Server-owned admission, never an HTTP command or a credential for the host.
// Called inside the account/session transaction so a failed login leaves no join.
function joinWelcome(store, accountId, memberId, provenance) {
  if (!store.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(STARTER_ROOM_ID)) {
    const events = initialRoom(STARTER_ROOM_ID, HOST_ID);
    events[0].id = BOOTSTRAP_ID;
    events[0].data.title = 'Welcome';
    events[0].data.purpose = 'Say hello. Everyone starts here.';
    events[1].data.displayName = 'Room host';
    store.initialize(events);
  }
  const room = store.room(STARTER_ROOM_ID);
  const bootstrap = store.db.prepare('SELECT id FROM events WHERE room_id=? AND sequence=1').get(STARTER_ROOM_ID);
  // Never turn an unrelated existing room into a public room by name alone.
  if (bootstrap?.id !== BOOTSTRAP_ID || room.state.room.ownerId !== HOST_ID) fail(409, 'provider_room_conflict');
  if (room.sequence >= 10000 || Object.keys(room.state.members).length >= 100) fail(409, 'pilot_limit');
  const incoming = event({ type: T.MEMBER_ADDED, roomId: STARTER_ROOM_ID, actorId: HOST_ID,
    at: new Date(store.now()).toISOString(), data: { memberId, displayName: `Member ${memberId.slice(-6)}`, kind: 'human', permissions: [] } });
  const next = applyEvent(room.state, incoming);
  const projection = JSON.stringify({ ...next, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
  if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, 'pilot_limit');
  store.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(STARTER_ROOM_ID, room.sequence + 1, incoming.id, JSON.stringify(incoming));
  store.db.prepare('UPDATE rooms SET sequence=?,projection=? WHERE id=?').run(room.sequence + 1, projection, STARTER_ROOM_ID);
  store.ensureHumanAccountBinding(STARTER_ROOM_ID, memberId, accountId, provenance);
}

function maybeGrantOperator(store, accountId, memberId, roomId, operatorAccountId) {
  if (!accountsMatchOperator(accountId, memberId, operatorAccountId) || roomId !== STARTER_ROOM_ID) return;
  const room = store.room(STARTER_ROOM_ID);
  const member = room.state.members[memberId];
  if (!member?.active || member.permissions.includes('manage_members')) return;
  const incoming = event({
    type: T.MEMBER_ACCESS_CHANGED, roomId: STARTER_ROOM_ID, actorId: HOST_ID,
    at: new Date(store.now()).toISOString(),
    data: { memberId, expectedMemberRevision: member.revision, active: true, permissions: ['manage_members'] }
  });
  const next = applyEvent(room.state, incoming);
  const projection = JSON.stringify({ ...next, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
  store.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(STARTER_ROOM_ID, room.sequence + 1, incoming.id, JSON.stringify(incoming));
  store.db.prepare('UPDATE rooms SET sequence=?,projection=? WHERE id=?').run(room.sequence + 1, projection, STARTER_ROOM_ID);
}

const fail = (status, code) => { throw new ServiceError(status, code, 'Sign-in could not be completed'); };
// Renewal keeps browser identity/generation stable without extending any shared
// credential. No access key is accepted or returned.
export async function refreshWithProvider(store, { token, verify, issuer, slotToken, binding }) {
  if (typeof token !== 'string' || !token || token.length > 16384 || typeof verify !== 'function'
    || typeof issuer !== 'string' || issuer.length > 256) fail(422, 'invalid_provider_login');
  try { if (new URL(issuer).origin !== issuer || !issuer.startsWith('https://')) fail(422, 'invalid_provider_login'); }
  catch { fail(422, 'invalid_provider_login'); }
  const claims = await verify(token);
  if (claims?.iss !== issuer || !/^user_[A-Za-z0-9]{1,100}$/.test(claims.sub ?? '')
    || !/^sess_[A-Za-z0-9]{1,100}$/.test(claims.sid ?? '')
    || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= store.now()) fail(401, 'invalid_provider_identity');
  const accountId = providerAccountId(issuer, claims.sub);
  const provenance = `clerk:${createHash('sha256').update(issuer).digest('hex')}`;
  return store.transaction(() => {
    const current = store.authenticateAccountSession(slotToken, null, binding);
    if (current.account.id !== accountId || store.db.prepare('SELECT origin FROM accounts WHERE id=?').get(accountId)?.origin !== provenance)
      fail(403, 'provider_identity_changed');
    const slot = store.db.prepare('SELECT * FROM account_session_slots WHERE hash=?').get(current.credentialHash);
    // Never shorten a current assertion when responses arrive out of order.
    const expiry = Math.max(current.expiresAt, Math.min(claims.exp * 1000, store.now() + 15 * 60000, slot.expires_at));
    // Reclaim only expired, unreferenced credentials of this verified account.
    // Other browser slots retain their original expiry and revocation parent.
    store.db.prepare(`DELETE FROM account_credentials WHERE account_id=? AND expires_at<=?
      AND NOT EXISTS (SELECT 1 FROM account_session_slots WHERE parent_credential_hash=account_credentials.hash)`).run(accountId, store.now());
    const credential = store.insertAccountCredential(accountId, expiry);
    const access = store.authenticateAccountAccessKey(credential);
    store.db.prepare('UPDATE account_session_slots SET authenticated_until=?,parent_credential_hash=? WHERE hash=?')
      .run(expiry, access.credentialHash, current.credentialHash);
    return store.authenticateAccountSession(slotToken, null, binding);
  });
}
// Called only after server-side provider verification, never with browser profile
// fields. The verifier must authenticate signature, issuer, audience/authorized
// party, expiry and session identity. Email is deliberately not an account key.
export async function loginWithProvider(store, { token, verify, issuer, slotToken, expectedRevision, revokeRoomToken = null, operatorAccountId = null }) {
  if (typeof token !== 'string' || token.length > 16384 || !token || typeof verify !== 'function'
    || typeof issuer !== 'string' || issuer.length > 256 || new URL(issuer).protocol !== 'https:') fail(422, 'invalid_provider_login');
  const claims = await verify(token);
  if (claims?.iss !== issuer || typeof claims.sub !== 'string' || !/^user_[A-Za-z0-9]{1,100}$/.test(claims.sub)
    || typeof claims.sid !== 'string' || !/^sess_[A-Za-z0-9]{1,100}$/.test(claims.sid)
    || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= store.now()) fail(401, 'invalid_provider_identity');
  const accountId = providerAccountId(issuer, claims.sub);
  const digest = accountId.slice(4);
  let roomId = STARTER_ROOM_ID, memberId = `member-${digest.slice(0, 48)}`;
  const provenance = `clerk:${createHash('sha256').update(issuer).digest('hex')}`;
  return store.transaction(() => {
    // Check the browser generation before provisioning anything. The same check
    // repeats when committing the login, within this transaction.
    const slot = store.accountSessionSlot(slotToken);
    if (slot.sessionRevision !== expectedRevision) fail(409, 'stale_session_revision');
    let account = store.db.prepare('SELECT id,origin,active FROM accounts WHERE id=?').get(accountId);
    if (account && (account.origin !== provenance || account.active !== 1)) fail(403, 'provider_account_unavailable');
    if (!account) {
      if (store.db.prepare('SELECT count(*) AS n FROM accounts').get().n >= 10000) fail(409, 'pilot_limit');
      store.createAccount(accountId, provenance);
      joinWelcome(store, accountId, memberId, provenance);
    } else if (!store.db.prepare('SELECT 1 FROM member_accounts WHERE room_id=? AND account_id=?').get(roomId, accountId)) {
      // Preserve the private starter room of accounts created before shared
      // onboarding. Never silently publish their history or recreate membership.
      roomId = `room-${digest}`;
      memberId = 'owner';
    }
    // No email-based linking, membership restoration or replacement starter room
    // on later logins. Existing account/room revocation remains authoritative.
    const binding = store.db.prepare('SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?').get(roomId, memberId);
    if (binding?.account_id !== accountId) fail(403, 'provider_room_unavailable');
    const member = store.room(roomId).state.members[memberId];
    if (!member?.active) fail(403, 'provider_room_unavailable');
    maybeGrantOperator(store, accountId, memberId, roomId, operatorAccountId);
    // Match the verified assertion lifetime. Refresh is a new verified exchange,
    // never an unverified extension of an external session.
    const credential = store.insertAccountCredential(accountId, Math.min(claims.exp * 1000, store.now() + 15 * 60000));
    const session = store.loginAccountSession(slotToken, credential, expectedRevision, { revokeRoomToken });
    return { session, roomId };
  });
}

export function grantNamedOperator(store, accountId, operatorAccountId) {
  if (!accountId || !operatorAccountId) return;
  const rows = store.db.prepare('SELECT room_id, member_id FROM member_accounts WHERE account_id=?').all(accountId);
  for (const row of rows) maybeGrantOperator(store, accountId, row.member_id, row.room_id, operatorAccountId);
}
