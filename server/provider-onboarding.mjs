import { createHash } from 'node:crypto';
import { initialRoom } from './bootstrap.mjs';
import { ServiceError } from './store.mjs';

const fail = (status, code) => { throw new ServiceError(status, code, 'Sign-in could not be completed'); };
// Called only after server-side provider verification, never with browser profile
// fields. The verifier must authenticate signature, issuer, audience/authorized
// party, expiry and session identity. Email is deliberately not an account key.
export async function loginWithProvider(store, { token, verify, issuer, slotToken, expectedRevision, revokeRoomToken = null }) {
  if (typeof token !== 'string' || token.length > 16384 || !token || typeof verify !== 'function'
    || typeof issuer !== 'string' || issuer.length > 256 || new URL(issuer).protocol !== 'https:') fail(422, 'invalid_provider_login');
  const claims = await verify(token);
  if (claims?.iss !== issuer || typeof claims.sub !== 'string' || !/^user_[A-Za-z0-9]{1,100}$/.test(claims.sub)
    || typeof claims.sid !== 'string' || !/^sess_[A-Za-z0-9]{1,100}$/.test(claims.sid)
    || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= store.now()) fail(401, 'invalid_provider_identity');
  const digest = createHash('sha256').update(JSON.stringify([issuer, claims.sub])).digest('hex');
  const accountId = `idp-${digest}`, roomId = `room-${digest}`, memberId = 'owner';
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
      // A reserved deterministic room collision must not grant access to it.
      if (store.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(roomId)) fail(409, 'provider_room_conflict');
      store.createAccount(accountId, provenance);
      const events = initialRoom(roomId, memberId);
      events[0].data.title = 'My room';
      events[0].data.purpose = 'A place to start. Invite people or agents when you are ready.';
      events[1].data.displayName = 'You';
      store.initialize(events);
      store.ensureHumanAccountBinding(roomId, memberId, accountId, provenance);
    }
    // No email-based linking, membership restoration or replacement starter room
    // on later logins. Existing account/room revocation remains authoritative.
    const binding = store.db.prepare('SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?').get(roomId, memberId);
    if (binding?.account_id !== accountId) fail(403, 'provider_room_unavailable');
    const member = store.room(roomId).state.members[memberId];
    if (!member?.active) fail(403, 'provider_room_unavailable');
    // Match the verified assertion lifetime. Refresh is a new verified exchange,
    // never an unverified extension of an external session.
    const credential = store.insertAccountCredential(accountId, Math.min(claims.exp * 1000, store.now() + 15 * 60000));
    const session = store.loginAccountSession(slotToken, credential, expectedRevision, { revokeRoomToken });
    return { session, roomId };
  });
}
